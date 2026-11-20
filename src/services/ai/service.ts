import { loadAiConfig, type AiConfig } from './config.js';
import { repoIdFor, type ModelKey } from './models/registry.js';
import { HuggingFaceProvider } from './providers/huggingface.js';
import { MockProvider } from './providers/mock.js';
import type { AiProvider } from './providers/types.js';
import { RateLimiter } from './rate-limit/limiter.js';
import { createLogger, type AiLogger } from './logging/logger.js';
import { NOOP_RETRIEVER, IndexedRetriever, type Retriever } from './pipelines/retrieval.js';
import {
  runAssistant,
  runEmbedding,
  runRecommendations,
  runGrammarExplain,
  runPronunciationCheck,
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
  askBody,
  embedBody,
  pronounceBody,
  recommendBody,
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
  AssistantAnswer,
  CatalogItem,
  GrammarExplanation,
  LearnerStats,
  PronunciationFeedback,
  Quiz,
  RecommendationPlan,
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
import {
  handleReportRequest,
  handleUsageRequest,
  type ReportHandlerDeps,
} from './http/handlers.js';
import {
  InMemoryUsageSink,
  JsonlUsageSink,
  UsageTracker,
  isEventSource,
  type UsageSink,
} from './usage/tracker.js';
import { AlertingUsageSink, type AlertThresholds, type UsageAlert } from './usage/monitor.js';
import { loadPricing } from './usage/pricing.js';
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
  /** RAG retriever — defaults to corpus index when AI_CORPUS_INDEX is set, else no-op. */
  retriever?: Retriever;
  usageSink?: UsageSink;
  logger?: AiLogger;
  rateLimiter?: RateLimiter;
  /** Store for incorrect-answer reports. Default: in-memory; set AI_FEEDBACK_PATH for JSONL persistence. */
  feedbackStore?: FeedbackStore;
  /**
   * Usage monitoring (issue #17). Defaults: JSONL sink when AI_USAGE_PATH is
   * set (else in-memory ring), alerting thresholds, built-in cost estimates
   * overridable via AI_PRICING_JSON. `alerts: false`-style disable: pass
   * `{ enabled: false }` is NOT supported — set extremely high thresholds or
   * provide a no-op usageSink instead.
   */
  usageAlerts?: (AlertThresholds & { onAlert?: (alert: UsageAlert) => void }) | undefined;
  /** JSON overrides for the cost table (same shape as AI_PRICING_JSON). */
  pricingOverrides?: string | undefined;
  /** Max cached TTS clips (default 200, 0 disables). */
  ttsCacheSize?: number | undefined;
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
  /** Pronunciation feedback: ASR transcript aligned against expected text. */
  pronunciationCheck(input: {
    expectedText: string;
    audio: Uint8Array;
    mimeType: string;
  }): Promise<AiResult<PronunciationFeedback>>;
  synthesize(input: { text: string }): Promise<{
    audio: Uint8Array;
    mimeType: string;
    model: string;
    latencyMs: number;
  }>;
  embed(input: { texts: string[] }): Promise<AiResult<number[][]>>;
  /** RAG-grounded Q&A — abstains when curriculum doesn't cover the question. */
  assistant(input: {
    language: ExplanationLanguage;
    question: string;
  }): Promise<AiResult<AssistantAnswer>>;
  /** Study recommendations validated against a real curriculum catalog. */
  recommendations(input: {
    language: ExplanationLanguage;
    learnerLevel: string;
    stats?: LearnerStats | undefined;
    catalog: CatalogItem[];
  }): Promise<AiResult<RecommendationPlan>>;
  /** Raw retrieval — returns fenced curriculum context + source IDs. */
  retrieve(
    query: string,
    opts?: import('./pipelines/retrieval.js').RetrieveOptions,
  ): Promise<import('./prompts/templates.js').RetrievedContext>;

  /** Web-standard endpoint handlers — mount as `export const POST = service.handlers.X`. */
  handlers: {
    tutor: (req: Request) => Promise<Response>;
    grammar: (req: Request) => Promise<Response>;
    vocabulary: (req: Request) => Promise<Response>;
    quiz: (req: Request) => Promise<Response>;
    writing: (req: Request) => Promise<Response>;
    translate: (req: Request) => Promise<Response>;
    transcribe: (req: Request) => Promise<Response>;
    /** POST — pronunciation feedback (ASR + alignment, deterministic). */
    pronounce: (req: Request) => Promise<Response>;
    synthesize: (req: Request) => Promise<Response>;
    embed: (req: Request) => Promise<Response>;
    report: (req: Request) => Promise<Response>;
    /** POST — RAG learning assistant (grounded Q&A with provenance). */
    ask: (req: Request) => Promise<Response>;
    /** POST — learning recommendations validated against the catalog. */
    recommend: (req: Request) => Promise<Response>;
    /** GET — aggregated usage/cost summary. ADMIN-ONLY: protect at the host. */
    usage: (req: Request) => Promise<Response>;
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
  const rateLimiter = deps.rateLimiter ?? new RateLimiter({ ...config.rateLimit });

  // Usage pipeline (issue #17): durable sink → alerting decorator → tracker.
  // AI_USAGE_PATH persists events as JSONL; otherwise an in-memory ring.
  const durableSink: UsageSink =
    deps.usageSink ??
    (process.env.AI_USAGE_PATH
      ? new JsonlUsageSink(process.env.AI_USAGE_PATH)
      : new InMemoryUsageSink());
  const pricing = loadPricing(deps.pricingOverrides ?? process.env.AI_PRICING_JSON);
  const alertSink = new AlertingUsageSink(durableSink, {
    logger,
    ...(deps.usageAlerts ?? {}),
  });
  const usage = new UsageTracker(alertSink, {
    pricing,
    ...(isEventSource(durableSink) ? { source: durableSink } : {}),
  });

  // Provider selection: explicit override > HF (when token present) > mock.
  // AI_PROVIDER=mock forces the mock even with a token (local dev/e2e).
  const provider: AiProvider =
    deps.provider ??
    (process.env.AI_PROVIDER === 'mock' || !config.hfToken
      ? new MockProvider()
      : new HuggingFaceProvider(config));

  // RAG retriever: explicit dep > AI_CORPUS_INDEX file > no-op. A missing or
  // malformed index degrades to no retrieval (grounded:false) — never fatal.
  let retriever: Retriever;
  if (deps.retriever) {
    retriever = deps.retriever;
  } else if (process.env.AI_CORPUS_INDEX) {
    try {
      retriever = IndexedRetriever.fromIndex(process.env.AI_CORPUS_INDEX, {
        provider,
        model: repoIdFor('embedding'),
      });
      logger.info('ai', 'corpus index loaded', { path: process.env.AI_CORPUS_INDEX });
    } catch (err) {
      logger.warn('ai', 'corpus index unavailable — retrieval disabled', {
        message: err instanceof Error ? err.message : String(err),
      });
      retriever = NOOP_RETRIEVER;
    }
  } else {
    retriever = NOOP_RETRIEVER;
  }
  const llm = { provider, model: repoIdFor(deps.llmModel ?? 'llmPrimary') };

  async function retrieveFor(query: string) {
    return retriever.retrieve(query);
  }

  const handlerDeps: HandlerDeps = { rateLimiter, usage, logger };

  // TTS audio cache (issue #13): repeated phrases (vocab, example sentences,
  // dialogue lines) are synthesized once. In-memory LRU — swap for shared
  // cache (Redis/CDN) when the app scales.
  const TTS_CACHE_MAX = deps.ttsCacheSize ?? 200;
  const ttsCache = new Map<string, { audio: Uint8Array; mimeType: string }>();

  const feedback: FeedbackStore =
    deps.feedbackStore ??
    (process.env.AI_FEEDBACK_PATH
      ? new JsonlFeedbackStore(process.env.AI_FEEDBACK_PATH)
      : new InMemoryFeedbackStore());
  const reportDeps: ReportHandlerDeps = { rateLimiter, store: feedback, logger };

  const json = <B, R extends { data: unknown }>(
    schema: z.ZodType<B>,
    capability:
      | 'tutor'
      | 'grammar'
      | 'vocabulary'
      | 'quiz'
      | 'writing'
      | 'asr'
      | 'tts'
      | 'embedding'
      | 'translation'
      | 'assistant'
      | 'recommendations',
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
    pronunciationCheck: (input) =>
      runPronunciationCheck({ ...llm, model: repoIdFor('asr') }, input),
    synthesize: async (input) => {
      const ttsModel = repoIdFor('tts');
      const key = `${ttsModel}${input.text}`;
      const hit = ttsCache.get(key);
      if (hit) {
        // Refresh LRU position.
        ttsCache.delete(key);
        ttsCache.set(key, hit);
        return { ...hit, model: ttsModel, latencyMs: 0 };
      }
      const out = await runSynthesis({ ...llm, model: ttsModel }, input);
      if (TTS_CACHE_MAX > 0) {
        if (ttsCache.size >= TTS_CACHE_MAX) {
          const oldest = ttsCache.keys().next().value;
          if (oldest !== undefined) ttsCache.delete(oldest);
        }
        ttsCache.set(key, { audio: out.audio, mimeType: out.mimeType });
      }
      return out;
    },
    embed: (input) => runEmbedding({ ...llm, model: repoIdFor('embedding') }, input),
    retrieve: (query, opts) => retriever.retrieve(query, opts),
    assistant: (input) =>
      retrieveFor(input.question).then((retrieved) =>
        runAssistant(llm, { ...input, retrieved }),
      ),
    recommendations: (input) =>
      runRecommendations(llm, {
        language: input.language,
        learnerLevel: input.learnerLevel,
        stats: input.stats ?? {},
        catalog: input.catalog,
      }),

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
      pronounce: json(pronounceBody, 'asr', 'ai:pronounce', async (b) => {
        const audio = Uint8Array.from(Buffer.from(b.audioBase64, 'base64'));
        return service.pronunciationCheck({
          expectedText: b.expectedText,
          audio,
          mimeType: b.mimeType,
        });
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
      ask: json(askBody, 'assistant', 'ai:ask', (b) =>
        service.assistant({ language: b.language, question: b.question }),
      ),
      recommend: json(recommendBody, 'recommendations', 'ai:recommend', (b) =>
        service.recommendations({
          language: b.language,
          learnerLevel: b.learnerLevel,
          ...(b.stats ? { stats: b.stats } : {}),
          catalog: b.catalog,
        }),
      ),
      report: (req: Request) => handleReportRequest(req, reportDeps),
      usage: (req: Request) => handleUsageRequest(req, { usage }),
    },

    usage,
    logger,
    feedback,
  };

  return service;
}
