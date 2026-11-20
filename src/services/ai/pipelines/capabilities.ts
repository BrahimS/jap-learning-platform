import type { AiProvider } from '../providers/types.js';
import { AiError, type AiResult, type ChatMessage, type ExplanationLanguage, type Provenance } from '../types.js';
import {
  assistantAnswerSchema,
  catalogItemSchema,
  grammarExplanationSchema,
  pronunciationFeedbackSchema,
  quizSchema,
  recommendationPlanSchema,
  transcriptSchema,
  tutorReplySchema,
  translationResultSchema,
  vocabularyEntrySchema,
  writingCorrectionSchema,
  type AssistantAnswer,
  type CatalogItem,
  type GrammarExplanation,
  type LearnerStats,
  type PronunciationFeedback,
  type Quiz,
  type RecommendationPlan,
  type Transcript,
  type TranslationResult,
  type TutorReply,
  type VocabularyEntry,
  type WritingCorrection,
} from '../evaluators/schemas.js';
import { parseModelJson } from '../evaluators/schemas.js';
import {
  assistantMessages,
  grammarExplainMessages,
  recommendationMessages,
  quizMessages,
  tutorMessages,
  vocabularyMessages,
  writingCorrectionMessages,
  type RetrievedContext,
} from '../prompts/templates.js';
import { runStructuredChat, type PipelineDeps } from './context.js';
import { validateQuiz } from './quiz-validation.js';
import { align, verdictFor } from './alignment.js';

function provOf(retrieved?: RetrievedContext): Provenance {
  return retrieved && retrieved.sourceIds.length > 0
    ? { sources: retrieved.sourceIds, grounded: true }
    : { grounded: false };
}

/**
 * Capability pipelines (§8.2). Each takes provider+model via PipelineDeps,
 * builds prompts, validates output. Feature issues (#5-#13) wire these to
 * endpoints and curriculum data.
 */

export interface TutorInput {
  language: ExplanationLanguage;
  learnerLevel: string;
  /** Prior turns (already role-tagged), excluding the newest user turn. */
  history?: ChatMessage[] | undefined;
  latestUserText: string;
  retrieved?: RetrievedContext;
}

export async function runTutor(
  deps: PipelineDeps,
  input: TutorInput,
): Promise<AiResult<TutorReply>> {
  // System prompt is independent of the user turn — take it from the template.
  const system = tutorMessages(input.language, input.learnerLevel, '', input.retrieved)[0]!;
  const messages: ChatMessage[] = [
    system,
    ...(input.history ?? []),
    { role: 'user', content: input.latestUserText },
  ];
  return runStructuredChat(
    { ...deps, capability: 'tutor' },
    messages,
    tutorReplySchema,
    'tutor',
    provOf(input.retrieved),
  );
}

export async function runGrammarExplain(
  deps: PipelineDeps,
  input: { language: ExplanationLanguage; structure: string; retrieved?: RetrievedContext | undefined },
): Promise<AiResult<GrammarExplanation>> {
  return runStructuredChat(
    { ...deps, capability: 'grammar' },
    grammarExplainMessages(input.language, input.structure, input.retrieved),
    grammarExplanationSchema,
    'grammar',
    provOf(input.retrieved),
  );
}

export async function runVocabulary(
  deps: PipelineDeps,
  input: { language: ExplanationLanguage; word: string; retrieved?: RetrievedContext | undefined },
): Promise<AiResult<VocabularyEntry>> {
  return runStructuredChat(
    { ...deps, capability: 'vocabulary' },
    vocabularyMessages(input.language, input.word, input.retrieved),
    vocabularyEntrySchema,
    'vocabulary',
    provOf(input.retrieved),
  );
}

export async function runQuiz(
  deps: PipelineDeps,
  input: {
    language: ExplanationLanguage;
    type: string;
    topic?: string | undefined;
    jlptLevel?: string | undefined;
    count?: number | undefined;
    retrieved?: RetrievedContext;
  },
): Promise<AiResult<Quiz>> {
  const result = await runStructuredChat(
    { ...deps, capability: 'quiz' },
    quizMessages(input.language, input, input.retrieved),
    quizSchema,
    'quiz',
    provOf(input.retrieved),
  );
  // §8.6: no unverified answer keys reach the learner — drop invalid
  // questions deterministically; refuse to serve an all-invalid quiz.
  const { questions, rejected } = validateQuiz(result.data);
  if (questions.length === 0) {
    throw new AiError(
      'VALIDATION_ERROR',
      'All generated quiz questions failed answer validation',
      { detail: JSON.stringify(rejected.slice(0, 5)) },
    );
  }
  return {
    ...result,
    data: { questions },
    diagnostics: { rejectedQuestions: rejected.length },
  };
}

export async function runWritingCorrection(
  deps: PipelineDeps,
  input: {
    language: ExplanationLanguage;
    sentence: string;
    criteria?: string | undefined;
    retrieved?: RetrievedContext;
  },
): Promise<AiResult<WritingCorrection>> {
  return runStructuredChat(
    { ...deps, capability: 'writing' },
    writingCorrectionMessages(input.language, input.sentence, input.criteria, input.retrieved),
    writingCorrectionSchema,
    'writing',
    provOf(input.retrieved),
  );
}

/**
 * Translation. v1 routes through the chat LLM with strict JSON output;
 * the dedicated MADLAD-400 seq2seq model (registry: `translation`) plugs in
 * here once its serving path lands — swap is config-only (§8.7).
 */
export async function runTranslation(
  deps: PipelineDeps,
  input: { text: string; sourceLang: string; targetLang: string; language: ExplanationLanguage },
): Promise<AiResult<TranslationResult>> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `You are a precise translator. Translate the user's text from ${input.sourceLang} to ` +
        `${input.targetLang}. Preserve Japanese text exactly — never translate or alter Japanese ` +
        `sentences unless the target language is Japanese. Respond with JSON: ` +
        `{"translation": string, "backTranslation"?: string, "notes"?: string}.`,
    },
    { role: 'user', content: input.text },
  ];
  return runStructuredChat(
    { ...deps, capability: 'translation' },
    messages,
    translationResultSchema,
    'translation',
  );
}

/**
 * RAG learning assistant (§8.5; issue #15). Answers are grounded in retrieved
 * curriculum chunks; the model must declare coverage honestly and abstain
 * rather than invent content. Provenance carries the source chunk IDs.
 */
export async function runAssistant(
  deps: PipelineDeps,
  input: { language: ExplanationLanguage; question: string; retrieved?: RetrievedContext | undefined },
): Promise<AiResult<AssistantAnswer>> {
  return runStructuredChat(
    { ...deps, capability: 'assistant' },
    assistantMessages(input.language, input.question, input.retrieved),
    assistantAnswerSchema,
    'assistant',
    provOf(input.retrieved),
  );
}

/**
 * Learning recommendations (§8.2; issue #8). The model proposes a plan from
 * the learner profile + curriculum catalog; afterwards every recommendation
 * itemId is checked against the catalog and invented IDs are dropped —
 * recommendations can never reference content that doesn't exist.
 */
export async function runRecommendations(
  deps: PipelineDeps,
  input: {
    language: ExplanationLanguage;
    learnerLevel: string;
    stats: LearnerStats;
    catalog: CatalogItem[];
    retrieved?: RetrievedContext | undefined;
  },
): Promise<AiResult<RecommendationPlan>> {
  const catalog = input.catalog.map((c) => catalogItemSchema.parse(c));
  const catalogText = catalog
    .map((c) => `- id=${c.id} kind=${c.kind} level=${c.jlptLevel ?? 'any'}: ${c.title}${c.summary ? ` — ${c.summary}` : ''}`)
    .join('\n');
  const statsJson = JSON.stringify(input.stats);
  const result = await runStructuredChat(
    { ...deps, capability: 'recommendations' },
    recommendationMessages(input.language, input.learnerLevel, statsJson, catalogText),
    recommendationPlanSchema,
    'recommendations',
  );

  // Deterministic catalog validation — drop any recommendation whose itemId
  // is not a real catalog entry, and dedupe by itemId keeping highest priority.
  const validIds = new Set(catalog.map((c) => c.id));
  const priorityRank = { high: 0, medium: 1, low: 2 } as const;
  const seen = new Set<string>();
  const kept = result.data.recommendations
    .filter((r) => validIds.has(r.itemId))
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority])
    .filter((r) => (seen.has(r.itemId) ? false : (seen.add(r.itemId), true)));

  return { ...result, data: { ...result.data, recommendations: kept } };
}

export async function runTranscription(
  deps: PipelineDeps,
  input: { audio: Uint8Array; mimeType: string },
): Promise<AiResult<Transcript>> {
  const started = Date.now();
  const { text } = await deps.provider.transcribe(deps.model, input.audio, input.mimeType);
  const data = parseModelJson(JSON.stringify({ text }), transcriptSchema, 'transcript');
  return {
    data,
    model: deps.model,
    capability: 'asr',
    latencyMs: Date.now() - started,
  };
}

export async function runSynthesis(
  deps: PipelineDeps,
  input: { text: string },
): Promise<{ audio: Uint8Array; mimeType: string; model: string; latencyMs: number }> {
  const started = Date.now();
  const out = await deps.provider.synthesize(deps.model, input.text);
  return { ...out, model: deps.model, latencyMs: Date.now() - started };
}

/**
 * Pronunciation check (issue #12): transcribe learner audio with the ASR
 * model, align against the expected Japanese text, and return structured
 * feedback (accuracy + diff issues). Deterministic — no LLM involved.
 */
export async function runPronunciationCheck(
  deps: PipelineDeps,
  input: { expectedText: string; audio: Uint8Array; mimeType: string },
): Promise<AiResult<PronunciationFeedback>> {
  const started = Date.now();
  const { text } = await deps.provider.transcribe(deps.model, input.audio, input.mimeType);
  const { segments, accuracy } = align(input.expectedText, text);
  const issues = segments
    .filter((s) => s.op !== 'match')
    .map((s) => ({
      op: s.op as 'replace' | 'insert' | 'delete',
      ...(s.expected !== undefined ? { expected: s.expected } : {}),
      ...(s.recognized !== undefined ? { recognized: s.recognized } : {}),
    }));
  return {
    data: pronunciationFeedbackSchema.parse({
      expected: input.expectedText,
      recognized: text,
      accuracy,
      verdict: verdictFor(accuracy),
      issues,
    }),
    model: deps.model,
    capability: 'asr',
    latencyMs: Date.now() - started,
  };
}

export async function runEmbedding(
  deps: PipelineDeps,
  input: { texts: string[] },
): Promise<AiResult<number[][]>> {
  const started = Date.now();
  const vectors = await deps.provider.embed(deps.model, input.texts);
  return {
    data: vectors,
    model: deps.model,
    capability: 'embedding',
    latencyMs: Date.now() - started,
  };
}
