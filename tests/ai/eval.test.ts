import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  evalCaseSchema,
  langScriptCheck,
  listDatasets,
  loadJsonlDataset,
  reportToMarkdown,
  runDataset,
  writeReport,
  type EvalCase,
} from '../../src/services/ai/evaluators/framework.js';
import {
  InMemoryFeedbackStore,
  JsonlFeedbackStore,
  nextReportId,
  reportSchema,
  reportToEvalCase,
} from '../../src/services/ai/evaluators/feedback.js';
import { handleReportRequest } from '../../src/services/ai/http/handlers.js';
import { RateLimiter } from '../../src/services/ai/rate-limit/limiter.js';
import { createLogger } from '../../src/services/ai/logging/logger.js';
import { mkdtemp } from 'node:fs/promises';

const CASES: EvalCase[] = [
  {
    id: 'g1',
    kind: 'grammar',
    input: { structure: '〜たことがある' },
    expect: { jlptLevel: 'N4', minExamples: 1 },
  },
  {
    id: 't1',
    kind: 'translation',
    input: { text: '私は学生です' },
    expect: { targetIncludes: 'student' },
  },
  {
    id: 'h1',
    kind: 'hallucination',
    input: { structure: '〜ざるを得ない' },
    expect: { coverageIn: ['N1'] },
  },
  {
    id: 'm1',
    kind: 'i18n',
    input: { language: 'fr' },
    expect: { lang: 'fr', manual: true },
  },
  {
    id: 'e1',
    kind: 'grammar',
    input: { structure: '〜ざるを得ない' },
    expect: { jlptLevel: 'N1' },
  },
];

const GOOD_OUTPUTS: Record<string, unknown> = {
  g1: { jlptLevel: 'N4', examples: [{ ja: '行ったことがある', en: 'I have been' }] },
  t1: { translation: 'I am a student' },
  h1: { curriculumCoverage: 'N1', explanation: 'must do' },
  m1: { explanation: 'Le verbe se conjugue ainsi' },
  e1: { jlptLevel: 'N1' },
};

describe('eval framework', () => {
  it('loads JSONL datasets and validates cases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evals-'));
    const file = join(dir, 'mini.jsonl');
    writeFileSync(
      file,
      [
        '# comment line',
        JSON.stringify(CASES[0]),
        '',
        JSON.stringify({ id: 'bad', kind: 'nope' }),
      ].join('\n'),
    );
    expect(() => loadJsonlDataset(file)).toThrow(/Invalid eval case/);
    writeFileSync(file, JSON.stringify(CASES[0]) + '\n' + JSON.stringify(CASES[1]) + '\n');
    expect(loadJsonlDataset(file)).toHaveLength(2);
    expect(listDatasets(dir)).toEqual(['mini']);
  });

  it('rejects malformed eval cases', () => {
    expect(evalCaseSchema.safeParse({ id: 'x' }).success).toBe(false);
    expect(evalCaseSchema.safeParse({ ...CASES[0], kind: 'bogus' }).success).toBe(false);
  });

  it('langScriptCheck detects explanation languages', () => {
    expect(langScriptCheck('Le chat est sur la table', 'fr')).toBe(true);
    expect(langScriptCheck('القط على الطاولة', 'ar')).toBe(true);
    expect(langScriptCheck('The cat is on the table', 'en')).toBe(true);
    expect(langScriptCheck('猫は机の上にいます', 'fr')).toBe(false);
  });

  it('runs cases and reports pass/fail/manual/error statuses', async () => {
    const report = await runDataset('mini', CASES, async (c) => {
      if (c.id === 'e1') throw new Error('upstream exploded');
      return GOOD_OUTPUTS[c.id];
    }, { threshold: 0.5, model: 'test-model' });

    // e1 executor threw → error status; m1 is manual-review; rest pass.
    expect(report.total).toBe(5);
    expect(report.cases.find((c) => c.id === 'e1')?.status).toBe('error');
    expect(report.cases.find((c) => c.id === 'm1')?.status).toBe('manual');
    expect(report.cases.filter((c) => c.status === 'pass')).toHaveLength(3);
    expect(report.passed).toBe(4); // 3 pass + 1 manual
    expect(report.passRate).toBeCloseTo(0.8);
    expect(report.failed).toBe(false);
    expect(report.judged).toBe(false);
  });

  it('marks manual-review cases and failing checks correctly', async () => {
    const report = await runDataset('mini2', [CASES[0]!], async () => ({
      jlptLevel: 'N1', // wrong level
      examples: [],
    }), { threshold: 0.9 });

    const c = report.cases[0];
    expect(c?.status).toBe('fail');
    expect(c?.checks.find((k) => k.name === 'jlptLevel')?.pass).toBe(false);
    expect(c?.checks.find((k) => k.name === 'minExamples')?.pass).toBe(false);
    expect(report.failed).toBe(true);
  });

  it('applies the optional LLM judge to i18n/translation kinds only', async () => {
    const judged = await runDataset('mini3', [CASES[1]!, CASES[0]!], async (c) => GOOD_OUTPUTS[c.id], {
      judge: async () => ({ score: 5, rationale: 'great' }),
    });
    const t1 = judged.cases.find((c) => c.id === 't1');
    const g1 = judged.cases.find((c) => c.id === 'g1');
    expect(t1?.checks.some((k) => k.name === 'llmJudge')).toBe(true);
    expect(g1?.checks.some((k) => k.name === 'llmJudge')).toBe(false);
    expect(judged.judged).toBe(true);
  });

  it('writes JSON + Markdown reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evalout-'));
    const report = {
      dataset: 'd',
      model: 'm',
      provider: 'p',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      total: 1,
      passed: 1,
      passRate: 1,
      threshold: 0.8,
      failed: false,
      judged: false,
      cases: [],
    };
    const { json, md } = writeReport(report, dir);
    expect(existsSync(json)).toBe(true);
    expect(readFileSync(md, 'utf8')).toContain('Eval report — d');
  });
});

describe('incorrect-answer feedback', () => {
  const validReport = reportSchema.parse({
    userRef: 'u1',
    capability: 'grammar',
    model: 'Qwen/Qwen3-32B',
    context: 'explained 〜たことがある',
    reportedOutput: 'wrong jlptLevel N5',
    reason: 'actual level is N4',
  });

  it('validates reports via schema', () => {
    expect(reportSchema.safeParse(validReport).success).toBe(true);
    expect(reportSchema.safeParse({ ...validReport, capability: 'bogus' }).success).toBe(false);
    expect(reportSchema.safeParse({ ...validReport, reportedOutput: '' }).success).toBe(false);
    expect(reportSchema.safeParse({ ...validReport, reason: '' }).success).toBe(false);
  });

  it('stores and lists reports in memory', () => {
    const store = new InMemoryFeedbackStore();
    const stored = { ...validReport, id: nextReportId(), at: new Date().toISOString() };
    store.add(stored);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.id).toBe(stored.id);
  });

  it('persists reports to JSONL across instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fb-'));
    const path = join(dir, 'reports.jsonl');
    const a = new JsonlFeedbackStore(path);
    const stored = { ...validReport, id: nextReportId(), at: new Date().toISOString() };
    a.add(stored);
    const b = new JsonlFeedbackStore(path);
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0]?.reason).toBe(validReport.reason);
  });

  it('converts reports into manual-review regression cases', () => {
    const stored = { ...validReport, id: 'r1', at: '2026-01-01T00:00:00Z' };
    const c = reportToEvalCase(stored);
    expect(c.kind).toBe('grammar');
    expect(c.expect.manual).toBe(true);
    expect(c.description).toContain('User-reported error');
  });

  it('report endpoint validates, rate-limits, and stores', async () => {
    const store = new InMemoryFeedbackStore();
    const deps = {
      rateLimiter: new RateLimiter({ windowMs: 60_000, maxRequests: 2 }),
      store,
      logger: createLogger('test'),
    };

    const ok = await handleReportRequest(
      new Request('http://x/report', {
        method: 'POST',
        body: JSON.stringify(validReport),
        headers: { 'content-type': 'application/json' },
      }),
      deps,
    );
    expect(ok.status).toBe(202);
    expect((await ok.json() as { id: string }).id).toMatch(/^rpt-/);
    expect(store.list()).toHaveLength(1);

    const bad = await handleReportRequest(
      new Request('http://x/report', {
        method: 'POST',
        body: JSON.stringify({ capability: 'nope' }),
      }),
      deps,
    );
    expect(bad.status).toBe(400);

    const get = await handleReportRequest(new Request('http://x/report'), deps);
    expect(get.status).toBe(405);

    // Rate limit: maxRequests=2, one used → one more allowed, third blocked.
    const r2 = await handleReportRequest(
      new Request('http://x/report', { method: 'POST', body: JSON.stringify(validReport) }),
      deps,
    );
    expect(r2.status).toBe(202);
    const r3 = await handleReportRequest(
      new Request('http://x/report', { method: 'POST', body: JSON.stringify(validReport) }),
      deps,
    );
    expect(r3.status).toBe(429);
  });
});
