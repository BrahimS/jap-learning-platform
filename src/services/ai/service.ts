import { loadAiConfig, type AiConfig } from './config.js';
import { repoIdFor, type ModelKey } from './models/registry.js';
import { HuggingFaceProvider } from './providers/huggingface.js';
import { MockProvider } from './providers/mock.js';
import type { AiProvider } from './providers/types.js';
import { RateLimiter } from './rate-limit/limiter.js';
import { UsageTracker, type UsageSink } from './usage/tracker.js';
import { createLogger, type AiLogger } from './logging/logger.js';
import { NOOP_RETRIEVER, type Retriever } from './pipelines/retrieval.js';
import {
  runEmbedding,
  runGrammarExplain,
  runQuiz,
  runSynthesis,
  runTranscription,
  runTranslation,
  runTutor,
  runVocabulary,
  runWritingCorrection,
} from './pipelines/capabilities.js';
import type { AiResult, ExplanationLanguage } from './types.js';
import {
  embedBody,
  grammarBody,
  handleAiJson,
  quizBody,
  synthesizeBody,
  transcribeBody,
  translateBody,
  tutorBody,
  vocabularyBody,
  writingBody,
  type HandlerDeps,
} from './http/handlers.js';
import type {
  GrammarExplanation,
  Quiz,
  Transcript,
  TranslationResult,
  TutorReply,
  VocabularyEntry,
  WritingCorrection,
} from './evaluators/schemas.js';
import {
  InMemoryFeedbackStore,
  JsonlFeedbackStore,
  type FeedbackStore,
} from './evaluators/feedback.js';
import { handleReportRequest, type ReportHandlerDeps } from './http/handlers.js';
import type { z } from 'zod';

/**
 * AI service facade (§8.4). One object wires config → provider → pipelines →
 * HTTP handlers. Feature code calls `service.tutor(...)` or mounts
 * `service.handlers.tutor` as a route handler. Provider is swappable via
 * deps.provider — the provider-independence requirement (§8.7).
 */

export interface AiServiceDeps {
  config?: AiConfig;
  /** Override provider (tests, self-hosted endpoints, future providers). */
  provider?: AiProvider;
  /** RAG retriever — defaults to no-op until curriculum indexing lands (#14/#15). */
  retriever?: Retriever;
  usageSink?: UsageSink;
  logger?: AiLogger;
  rateLimiter?: RateLimiter;
  /** Store for incorrect-answer reports. Default: in-memory; set AI_FEEDBACK_PATH for JSONL persistence. */
  feedbackStore?: FeedbackStore;
  /** Chat model tier: 'llmPrimary' | 'llmCostTier' | 'llmMoE' | 'llmJapaneseSpecialist'. */
  llmModel?: ModelKey;
}

export interface AiService {
  // --- pipelines (framework-agnostic) ---
  tutor(input: {
    language: ExplanationLanguage;
    learnerLevel: string;
    history?: { role: 'user' | 'assistant'; content: string }[] | undefined;
    latestUserText: string;
  }): Promise<AiResult<TutorReply>>;
  grammar(input: {
    language: ExplanationLanguage;
    structure: string;
  }): Promise<AiResult<GrammarExplanation>>;
  vocabulary(input: {
    language: ExplanationLanguage;
    word: string;
  }): Promise<AiResult<VocabularyEntry>>;
  quiz(input: {
    language: ExplanationLanguage;
    type: 'multiple_choice' | 'sentence_completion' | 'translation' | 'reading_comprehension' | 'jlpt_style';
    topic?: string | undefined;
    jlptLevel?: 'N5' | 'N4' | 'N3' | 'N2' | 'N1' | undefined;
    count?: number | undefined;
  }): Promise<AiResult<Quiz>>;
  writing(input: {
    language: ExplanationLanguage;
    sentence: string;
    criteria?: string | undefined;
  }): Promise<AiResult<WritingCorrection>>;
  translate(input: {
    text: string;
    sourceLang: string;
    targetLang: string;
    language?: ExplanationLanguage | undefined;
  }): Promise<AiResult<TranslationResult>>;
  transcribe(input: { audio: Uint8Array; mimeType: string }): Promise<AiResult<Transcript>>;
  synthesize(input: { text: string }): Promise<{
    audio: Uint8Array;
    mimeType: string;
    model: string;
    latencyMs: number;
  }>;
  embed(input: { texts: string[] }): Promise<AiResult<number[][]>>;

  /** Web-standard endpoint handlers — mount as `export const POST = service.handlers.X`. */
  handlers: {
    tutor: (req: Request) => Promise<Response>;
    grammar: (req: Request) => Promise<Response>;
    vocabulary: (req: Request) => Promise<Response>;
    quiz: (req: Request) => Promise<Response>;
    writing: (req: Request) => Promise<Response>;
    translate: (req: Request) => Promise<Response>;
    transcribe: (req: Request) => Promise<Response>;
    synthesize: (req: Request) => Promise<Response>;
    embed: (req: Request) => Promise<Response>;
    report: (req: Request) => Promise<Response>;
  };

  /** Infra accessors for monitoring/diagnostics. */
  usage: UsageTracker;
  logger: AiLogger;
  providerName: string;
  /** Active provider — exposed for eval/judge tooling; feature code should use pipelines. */
  provider: AiProvider;
  /** Incorrect-answer report store (feeds eval regression set, #16). */
  feedback: FeedbackStore;
}

export function createAiService(deps: AiServiceDeps = {}): AiService {
  const config = deps.config ?? loadAiConfig();
  const logger = deps.logger ?? createLogger('ai');
  const usage = new UsageTracker(deps.usageSink);
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ ...config.rateLimit });

  // Provider selection: explicit override > HF (when token present) > mock.
  // AI_PROVIDER=mock forces the mock even with a token (local dev/e2e).
  const provider: AiProvider =
    deps.provider ??
    (process.env.AI_PROVIDER === 'mock' || !config.hfToken
      ? new MockProvider()
      : new HuggingFaceProvider(config));

  const retriever = deps.retriever ?? NOOP_RETRIEVER;
  const llm = { provider, model: repoIdFor(deps.llmModel ?? 'llmPrimary') };

  async function retrieveFor(query: string) {
    return retriever.retrieve(query);
  }

  const handlerDeps: HandlerDeps = { rateLimiter, usage, logger };

  const feedback: FeedbackStore =
    deps.feedbackStore ??
    (process.env.AI_FEEDBACK_PATH
      ? new JsonlFeedbackStore(process.env.AI_FEEDBACK_PATH)
      : new InMemoryFeedbackStore());
  const reportDeps: ReportHandlerDeps = { rateLimiter, store: feedback, logger };

  const json = <B, R extends { data: unknown }>(
    schema: z.ZodType<B>,
    capability: 'tutor' | 'grammar' | 'vocabulary' | 'quiz' | 'writing' | 'asr' | 'tts' | 'embedding' | 'translation',
    scope: string,
    fn: (body: B) => Promise<AiResult<R['data']>>,
  ) => (req: Request) => handleAiJson(req, handlerDeps, { schema, capability, scope, fn });

  const service: AiService = {
    providerName: provider.name,
    provider,

    tutor: (input) =>
      retrieveFor(input.latestUserText).then((retrieved) =>
        runTutor(llm, { ...input, retrieved }),
      ),
    grammar: (input) =>
      retrieveFor(input.structure).then((retrieved) =>
        runGrammarExplain(llm, { ...input, retrieved }),
      ),
    vocabulary: (input) =>
      retrieveFor(input.word).then((retrieved) => runVocabulary(llm, { ...input, retrieved })),
    quiz: (input) =>
      retrieveFor(input.topic ?? input.type).then((retrieved) =>
        runQuiz(llm, { ...input, retrieved }),
      ),
    writing: (input) =>
      retrieveFor(input.sentence.slice(0, 200)).then((retrieved) =>
        runWritingCorrection(llm, { ...input, retrieved }),
      ),
    translate: (input) =>
      runTranslation(llm, { ...input, language: input.language ?? 'en' }),
    transcribe: (input) => runTranscription({ ...llm, model: repoIdFor('asr') }, input),
    synthesize: (input) => runSynthesis({ ...llm, model: repoIdFor('tts') }, input),
    embed: (input) => runEmbedding({ ...llm, model: repoIdFor('embedding') }, input),

    handlers: {
      tutor: json(tutorBody, 'tutor', 'ai:tutor', (b) =>
        service.tutor({
          language: b.language,
          learnerLevel: b.learnerLevel,
          history: b.history,
          latestUserText: b.text,
        }),
      ),
      grammar: json(grammarBody, 'grammar', 'ai:grammar', (b) =>
        service.grammar({ language: b.language, structure: b.structure }),
      ),
      vocabulary: json(vocabularyBody, 'vocabulary', 'ai:vocabulary', (b) =>
        service.vocabulary({ language: b.language, word: b.word }),
      ),
      quiz: json(quizBody, 'quiz', 'ai:quiz', (b) =>
        service.quiz({
          language: b.language,
          type: b.type,
          ...(b.topic !== undefined ? { topic: b.topic } : {}),
          ...(b.jlptLevel !== undefined ? { jlptLevel: b.jlptLevel } : {}),
          ...(b.count !== undefined ? { count: b.count } : {}),
        }),
      ),
      writing: json(writingBody, 'writing', 'ai:writing', (b) =>
        service.writing({
          language: b.language,
          sentence: b.sentence,
          ...(b.criteria !== undefined ? { criteria: b.criteria } : {}),
        }),
      ),
      translate: json(translateBody, 'translation', 'ai:translate', (b) =>
        service.translate({
          text: b.text,
          sourceLang: b.sourceLang,
          targetLang: b.targetLang,
        }),
      ),
      transcribe: json(transcribeBody, 'asr', 'ai:transcribe', async (b) => {
        const audio = Uint8Array.from(Buffer.from(b.audioBase64, 'base64'));
        return service.transcribe({ audio, mimeType: b.mimeType });
      }),
      synthesize: json(synthesizeBody, 'tts', 'ai:synthesize', async (b) => {
        const out = await service.synthesize({ text: b.text });
        // Audio is base64-encoded in JSON; a route handler can stream bytes instead.
        return {
          data: {
            audioBase64: Buffer.from(out.audio).toString('base64'),
            mimeType: out.mimeType,
          },
          model: out.model,
          capability: 'tts' as const,
          latencyMs: out.latencyMs,
        };
      }),
      embed: json(embedBody, 'embedding', 'ai:embed', (b) => service.embed({ texts: b.texts })),
      report: (req: Request) => handleReportRequest(req, reportDeps),
    },

    usage,
    logger,
    feedback,
  };

  return service;
}
