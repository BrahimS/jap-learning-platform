/**
 * Eval CLI (§8.7; issue #16).
 *
 *   npm run eval                      # all datasets — needs HF_TOKEN for real results
 *   npm run eval -- --dataset grammar-accuracy
 *   npm run eval -- --judge           # add LLM-judge rubric for i18n/translation
 *   AI_PROVIDER=mock npm run eval     # smoke-test mechanics only (mock ≠ model quality)
 *
 * Without HF_TOKEN the mock provider is used: the runner, checks, and reports
 * all work, but scores are meaningless — mock output is not a model.
 *
 * Reports land in evals/results/. Exit code 1 when a dataset fails its
 * pass-rate threshold — wire into CI once it exists.
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createAiService, repoIdFor, type AiService } from '../src/services/ai/index.js';
import {
  listDatasets,
  loadJsonlDataset,
  reportToMarkdown,
  runDataset,
  writeReport,
  type EvalCase,
  type EvalExecutor,
  type EvalReport,
} from '../src/services/ai/evaluators/framework.js';
import { z } from 'zod';
import { MockProvider } from '../src/services/ai/providers/mock.js';

const DATASETS_DIR = join(import.meta.dirname, 'datasets');
const RESULTS_DIR = join(import.meta.dirname, 'results');

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', short: 'd' },
    judge: { type: 'boolean', default: false },
    threshold: { type: 'string', default: '0.8' },
    model: { type: 'string' },
  },
});

const service: AiService = createAiService();
if (service.providerName === 'mock') {
  console.warn('WARNING: mock provider active — eval scores are not meaningful. Set HF_TOKEN for real results.\n');
}
const threshold = Number.parseFloat(values.threshold ?? '0.8');

/**
 * Smoke fixtures for the mock provider: schema-valid, case-aware output so
 * `npm run eval` exercises executor → pipeline → validation → checkers →
 * report end-to-end. Scores under mock are plumbing signal only — they say
 * nothing about real model quality (see header comment).
 */
const LANG_TEXT: Record<string, { meaning: string; usage: string; gloss: string }> = {
  en: {
    meaning: 'to have done something before — life experience',
    usage: 'used when talking about things you have done',
    gloss: 'to eat — the action of eating something',
  },
  fr: {
    meaning: 'avoir déjà fait quelque chose — une expérience',
    usage: 'pour parler des choses que l’on a déjà faites',
    gloss: 'manger — le fait de manger quelque chose',
  },
  ar: {
    meaning: 'خبرة سابقة — فعل شيء من قبل',
    usage: 'يُستخدم للحديث عن أشياء فعلها المرء من قبل',
    gloss: 'يأكل — فعل تناول الطعام',
  },
  ja: {
    meaning: '以前に何かをしたことがある — 経験',
    usage: 'これまでに経験したことを話すときに使う',
    gloss: '食べる — 食事をする動作',
  },
};

function langText(lang: string | undefined) {
  return LANG_TEXT[lang ?? 'en'] ?? LANG_TEXT['en']!;
}

function mockFixtureFor(c: EvalCase): string {
  const input = c.input as {
    language?: string;
    structure?: string;
    targetLang?: string;
  };
  const expect = c.expect as {
    jlptLevel?: string | null;
    coverageIn?: string[];
    answerIncludes?: string;
    targetIncludes?: string;
  };
  const lang = langText(input.language);

  if (c.kind === 'quiz') {
    const answer =
      typeof expect.answerIncludes === 'string' ? expect.answerIncludes : 'sample answer';
    return JSON.stringify({
      questions: [
        {
          type: 'multiple_choice',
          prompt: 'Select the correct answer.',
          options: [answer, 'option B', 'option C'],
          answer,
          explanation: lang.usage,
          jlptLevel: 'N5',
        },
      ],
    });
  }

  if (c.kind === 'translation') {
    const want =
      typeof expect.targetIncludes === 'string' ? expect.targetIncludes : 'translation';
    const gloss = langText(input.targetLang).gloss;
    return JSON.stringify({ translation: `${want} — ${gloss}` });
  }

  // grammar / jlpt / hallucination / i18n all run the grammar pipeline.
  return JSON.stringify({
    structure: input.structure ?? 'mock structure',
    meaning: lang.meaning,
    usage: lang.usage,
    jlptLevel: expect.jlptLevel ?? null,
    curriculumCoverage: Array.isArray(expect.coverageIn) ? expect.coverageIn[0] : 'covered',
    examples: [
      { ja: 'これは例文です。', translation: lang.gloss },
      { ja: 'もう一つの例文です。', translation: lang.gloss },
    ],
    comparison: { with: 'a similar structure', difference: lang.usage },
    commonMistakes: ['a typical learner mistake'],
    exercises: [{ prompt: 'practice prompt', answer: 'practice answer' }],
  });
}

/** Map an eval case onto the right service pipeline. */
const execute: EvalExecutor = async (c: EvalCase) => {
  const input = c.input as {
    language?: 'fr' | 'en' | 'ar';
    structure?: string;
    text?: string;
    sourceLang?: string;
    targetLang?: string;
    type?: 'multiple_choice' | 'sentence_completion' | 'translation' | 'reading_comprehension' | 'jlpt_style';
    topic?: string;
    count?: number;
    query?: string;
    topK?: number;
    kinds?: string[];
    jlptLevel?: string;
  };
  const language = input.language ?? 'en';

  // Under the mock provider, install a case-aware fixture (match '' hits any prompt).
  if (service.provider instanceof MockProvider) {
    service.provider.cannedResponses = [{ match: '', content: mockFixtureFor(c) }];
  }

  switch (c.kind) {
    case 'grammar':
    case 'jlpt':
    case 'hallucination':
    case 'i18n':
      return (await service.grammar({ language, structure: input.structure ?? '' })).data;
    case 'quiz':
      return (
        await service.quiz({
          language,
          type: input.type ?? 'multiple_choice',
          ...(input.topic ? { topic: input.topic } : {}),
          ...(input.count ? { count: input.count } : {}),
        })
      ).data;
    case 'translation':
      return (
        await service.translate({
          text: input.text ?? '',
          sourceLang: input.sourceLang ?? 'ja',
          targetLang: input.targetLang ?? 'en',
        })
      ).data;
    case 'retrieval':
      return service.retrieve(input.query ?? '', {
        ...(input.topK ? { topK: input.topK } : {}),
        ...(input.kinds
          ? { kinds: input.kinds as ('grammar' | 'vocabulary' | 'kanji' | 'jlpt' | 'explanation')[] }
          : {}),
        ...(input.jlptLevel ? { jlptLevel: input.jlptLevel } : {}),
      });
  }
};

const judgeSchema = z.object({ score: z.number().min(1).max(5), rationale: z.string() });

/** Qualitative rubric judged by the approved model stack (§8.1) — cost tier. */
async function llmJudge(c: EvalCase, output: unknown) {
  const prompt = [
    'You are a strict evaluation judge for a Japanese-learning platform.',
    `Case kind: ${c.kind}. Description: ${c.description ?? c.id}.`,
    `Expected checks: ${JSON.stringify(c.expect)}`,
    `Model output: ${JSON.stringify(output).slice(0, 4000)}`,
    'Score 1-5: 5 = fully correct, natural, level-appropriate; 1 = wrong/hallucinated.',
    'Return JSON {"score": number, "rationale": string}.',
  ].join('\n');
  const out = await service.provider.chat(
    repoIdFor('llmCostTier'),
    [
      { role: 'system', content: 'Return only JSON.' },
      { role: 'user', content: prompt },
    ],
    { jsonMode: true, maxTokens: 300 },
  );
  return judgeSchema.parse(
    JSON.parse(out.content.replace(/```json|```/g, '').trim()),
  );
}

async function main() {
  const names = values.dataset ? [values.dataset] : listDatasets(DATASETS_DIR);
  const reports: EvalReport[] = [];

  for (const name of names) {
    const cases = loadJsonlDataset(join(DATASETS_DIR, `${name}.jsonl`));
    const report = await runDataset(name, cases, execute, {
      threshold,
      model: values.model ?? 'registry-default',
      provider: service.providerName,
      ...(values.judge ? { judge: llmJudge } : {}),
    });
    reports.push(report);
    const { json, md } = writeReport(report, RESULTS_DIR);
    console.log(reportToMarkdown(report));
    console.log(`reports: ${md}\n           ${json}\n`);
  }

  const anyFailed = reports.some((r) => r.failed);
  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
