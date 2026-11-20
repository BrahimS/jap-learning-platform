import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { AiCapability, ExplanationLanguage } from '../types.js';

/**
 * AI evaluation framework (§8.6, §8.7; issue #16).
 *
 * Datasets are JSONL files under evals/datasets/. Each case declares a kind,
 * an input, and deterministic `expect` checks. The runner executes cases
 * through an injected executor (wired to AiService in evals/run.ts), applies
 * checks, and emits a per-model report. An optional LLM judge covers
 * qualitative rubrics (explanation quality) — clearly labeled as judged.
 */

// ---------- dataset schema ----------

export const EVAL_KINDS = [
  'grammar',
  'quiz',
  'translation',
  'jlpt',
  'hallucination',
  'i18n',
] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];

export const evalCaseSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(EVAL_KINDS),
  description: z.string().optional(),
  input: z.record(z.string(), z.unknown()),
  expect: z.record(z.string(), z.unknown()),
});
export type EvalCase = z.infer<typeof evalCaseSchema>;

export function loadJsonlDataset(path: string): EvalCase[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l, i) => {
      try {
        return evalCaseSchema.parse(JSON.parse(l));
      } catch (e) {
        throw new Error(`Invalid eval case at ${path}:${i + 1}: ${(e as Error).message}`);
      }
    });
}

export function listDatasets(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''));
}

// ---------- checkers ----------

export interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface CaseResult {
  id: string;
  kind: EvalKind;
  pass: boolean;
  /** 'manual' = flagged for human review (e.g., user-reported regressions). */
  status: 'pass' | 'fail' | 'manual' | 'error';
  checks: CheckResult[];
  output?: unknown;
  error?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function includesCI(haystack: unknown, needle: string): boolean {
  return JSON.stringify(haystack).toLowerCase().includes(needle.toLowerCase());
}

/** Script heuristic for explanation-language checks (documented as heuristic). */
export function langScriptCheck(text: string, lang: ExplanationLanguage): boolean {
  switch (lang) {
    case 'ar':
      return /[\u0600-\u06FF]/.test(text);
    case 'fr':
      return /[àâäçéèêëîïôöùûüÿœæ]|\b(le|la|les|des|une|est|pour|avec|que|dans)\b/i.test(text);
    case 'en':
      return /\b(the|is|are|to|of|and|with|that|for|you|can)\b/i.test(text);
  }
}

function check(expect_: Record<string, unknown>, output: unknown): CheckResult[] {
  const out = asRecord(output);
  const results: CheckResult[] = [];

  if ('jlptLevel' in expect_) {
    const want = expect_.jlptLevel;
    const got = out.jlptLevel ?? null;
    results.push({
      name: 'jlptLevel',
      pass: want === null ? got === null || got === undefined : got === want,
      detail: `want=${String(want)} got=${String(got)}`,
    });
  }

  if (typeof expect_.minExamples === 'number') {
    const examples = out.examples;
    const n = Array.isArray(examples) ? examples.length : 0;
    results.push({
      name: 'minExamples',
      pass: n >= (expect_.minExamples as number),
      detail: `got ${n} examples`,
    });
  }

  if (typeof expect_.answerIncludes === 'string') {
    results.push({
      name: 'answerIncludes',
      pass: includesCI(output, expect_.answerIncludes as string),
      detail: `looked for "${expect_.answerIncludes}"`,
    });
  }

  if (typeof expect_.targetIncludes === 'string') {
    results.push({
      name: 'targetIncludes',
      pass: includesCI(out.translation ?? output, expect_.targetIncludes as string),
      detail: `looked for "${expect_.targetIncludes}" in translation`,
    });
  }

  if (typeof expect_.lang === 'string') {
    const blob = [out.meaning, out.usage, out.explanation, out.translation]
      .filter((v) => typeof v === 'string')
      .join(' ');
    results.push({
      name: 'lang',
      pass: langScriptCheck(blob, expect_.lang as ExplanationLanguage),
      detail: `expected ${expect_.lang} script/words in explanation fields`,
    });
  }

  if (Array.isArray(expect_.coverageIn)) {
    const allowed = expect_.coverageIn as string[];
    const coverage = str(out.curriculumCoverage);
    // Also accept abstention phrasing when the model omits the field.
    const blob = JSON.stringify(output).toLowerCase();
    const abstains =
      /not covered|not in (the )?curriculum|no curriculum|outside (the )?curriculum/.test(blob);
    const pass = allowed.includes(coverage) || (coverage === '' && abstains);
    results.push({
      name: 'coverage',
      pass,
      detail: `coverage=${coverage || '(unset)'} abstains=${abstains}; allowed=${allowed.join('|')}`,
    });
  }

  if (expect_.manual === true) {
    results.push({ name: 'manual', pass: true, detail: 'flagged for human review' });
  }

  return results;
}

// ---------- runner ----------

export type EvalExecutor = (evalCase: EvalCase) => Promise<unknown>;

export interface RunOptions {
  /** Pass threshold (0-1). Cases below → report.failed=true. */
  threshold?: number;
  /** Optional LLM judge for qualitative rubrics; called as judge(case, output) → {score, rationale}. */
  judge?: (evalCase: EvalCase, output: unknown) => Promise<{ score: number; rationale: string }>;
}

export interface EvalReport {
  dataset: string;
  model: string;
  provider: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  passed: number;
  passRate: number;
  threshold: number;
  failed: boolean;
  judged: boolean;
  cases: CaseResult[];
}

export async function runDataset(
  name: string,
  cases: EvalCase[],
  execute: EvalExecutor,
  opts: RunOptions & { model?: string; provider?: string } = {},
): Promise<EvalReport> {
  const startedAt = new Date().toISOString();
  const threshold = opts.threshold ?? 0.8;
  const results: CaseResult[] = [];

  for (const c of cases) {
    try {
      const output = await execute(c);
      const checks = check(c.expect, output);

      // Optional LLM judge for qualitative cases.
      if (opts.judge && (c.kind === 'i18n' || c.kind === 'translation')) {
        const verdict = await opts.judge(c, output);
        checks.push({
          name: 'llmJudge',
          pass: verdict.score >= 3,
          detail: `score=${verdict.score}/5 — ${verdict.rationale.slice(0, 160)}`,
        });
      }

      const manual = c.expect.manual === true;
      const pass = checks.every((k) => k.pass);
      results.push({
        id: c.id,
        kind: c.kind,
        pass,
        status: manual ? 'manual' : pass ? 'pass' : 'fail',
        checks,
        output,
      });
    } catch (e) {
      results.push({
        id: c.id,
        kind: c.kind,
        pass: false,
        status: 'error',
        checks: [{ name: 'execution', pass: false, detail: (e as Error).message }],
        error: (e as Error).message,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const passed = results.filter((r) => r.status === 'pass' || r.status === 'manual').length;
  const passRate = results.length === 0 ? 0 : passed / results.length;
  return {
    dataset: name,
    model: opts.model ?? 'unknown',
    provider: opts.provider ?? 'unknown',
    startedAt,
    finishedAt,
    total: results.length,
    passed,
    passRate,
    threshold,
    failed: passRate < threshold,
    judged: Boolean(opts.judge),
    cases: results,
  };
}

// ---------- reporting ----------

export function reportToJson(report: EvalReport): string {
  return JSON.stringify(report, null, 2);
}

export function reportToMarkdown(report: EvalReport): string {
  const lines: string[] = [
    `# Eval report — ${report.dataset}`,
    '',
    `- model: \`${report.model}\` via ${report.provider}${report.judged ? ' (LLM-judged)' : ''}`,
    `- ran: ${report.startedAt} → ${report.finishedAt}`,
    `- result: **${report.passed}/${report.total}** (${(report.passRate * 100).toFixed(1)}%) — threshold ${(report.threshold * 100).toFixed(0)}% → ${report.failed ? 'FAIL' : 'PASS'}`,
    '',
    '| case | kind | status | failing checks |',
    '|---|---|---|---|',
  ];
  for (const c of report.cases) {
    const failing = c.checks.filter((k) => !k.pass).map((k) => `${k.name}: ${k.detail ?? ''}`);
    lines.push(`| ${c.id} | ${c.kind} | ${c.status} | ${failing.join('<br>') || '—'} |`);
  }
  return lines.join('\n') + '\n';
}

export function writeReport(report: EvalReport, outDir: string): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const base = join(outDir, `${report.dataset}-${stamp}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  writeFileSync(json, reportToJson(report));
  writeFileSync(md, reportToMarkdown(report));
  return { json, md };
}
