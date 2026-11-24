/**
 * Public surface of the AI service layer (§8.4).
 * Import from 'src/services/ai' (or the package path once the app exists).
 */

export { createAiService, type AiService, type AiServiceDeps } from './service.js';
export { loadAiConfig, requireHfToken, type AiConfig } from './config.js';
export { MODEL_REGISTRY, getModel, repoIdFor, type ModelEntry, type ModelKey } from './models/registry.js';
export { HuggingFaceProvider } from './providers/huggingface.js';
export { MockProvider } from './providers/mock.js';
export { OllamaProvider, ollamaConfigFromEnv, type OllamaProviderConfig } from './providers/ollama.js';
export type { AiProvider, ProviderChatOptions, ProviderChatResult } from './providers/types.js';
export { RateLimiter, type RateLimitDecision } from './rate-limit/limiter.js';
export {
  UsageTracker,
  InMemoryUsageSink,
  JsonlUsageSink,
  isEventSource,
  type UsageEvent,
  type UsageEventSource,
  type UsageSink,
} from './usage/tracker.js';
export { AlertingUsageSink, type AlertThresholds, type UsageAlert } from './usage/monitor.js';
export {
  DEFAULT_PRICING,
  estimateCostUsd,
  loadPricing,
  type PriceEntry,
  type PricingTable,
} from './usage/pricing.js';
export {
  summarizeUsage,
  summarizeLast,
  type GroupStats,
  type SummaryOptions,
  type UsageSummary,
} from './usage/metrics.js';
export { createLogger, type AiLogger } from './logging/logger.js';
export {
  NOOP_RETRIEVER,
  EmbeddingRetriever,
  IndexedRetriever,
  REVIEWED_BOOST,
  type Retriever,
  type CorpusChunk,
  type RetrieveOptions,
} from './pipelines/retrieval.js';
export {
  CORPUS_KINDS,
  curriculumChunkSchema,
  type CorpusKind,
  type CurriculumChunk,
} from './corpus/types.js';
export { loadCorpusJsonl, saveIndexJsonl } from './corpus/jsonl.js';
export { buildCorpusIndex } from './corpus/indexer.js';
export { validateQuestion, validateQuiz, type RejectedQuestion } from './pipelines/quiz-validation.js';
export {
  align,
  normalizeForSpeech,
  verdictFor,
  type DiffOp,
  type DiffSegment,
} from './pipelines/alignment.js';
export {
  runAssistant,
  runPronunciationCheck,
  runRecommendations,
  runTutor,
  runGrammarExplain,
  runVocabulary,
  runQuiz,
  runWritingCorrection,
  runTranslation,
  runTranscription,
  runSynthesis,
  runEmbedding,
} from './pipelines/capabilities.js';
export {
  tutorReplySchema,
  grammarExplanationSchema,
  vocabularyEntrySchema,
  quizSchema,
  quizQuestionSchema,
  writingCorrectionSchema,
  transcriptSchema,
  translationResultSchema,
  assistantAnswerSchema,
  catalogItemSchema,
  learnerStatsSchema,
  recommendationPlanSchema,
  pronunciationFeedbackSchema,
  parseModelJson,
  JLPT_LEVELS,
} from './evaluators/schemas.js';
export {
  evalCaseSchema,
  EVAL_KINDS,
  langScriptCheck,
  listDatasets,
  loadJsonlDataset,
  reportToJson,
  reportToMarkdown,
  runDataset,
  writeReport,
} from './evaluators/framework.js';
export type {
  CaseResult,
  CheckResult,
  EvalCase,
  EvalExecutor,
  EvalKind,
  EvalReport,
  RunOptions,
} from './evaluators/framework.js';
export {
  InMemoryFeedbackStore,
  JsonlFeedbackStore,
  nextReportId,
  reportSchema,
  reportToEvalCase,
} from './evaluators/feedback.js';
export type { FeedbackStore, IncorrectAnswerReport, StoredReport } from './evaluators/feedback.js';
export { AiError } from './types.js';
export type {
  AiCapability,
  AiResult,
  AiErrorCode,
  ChatMessage,
  ExplanationLanguage,
  Provenance,
  TokenUsage,
} from './types.js';
