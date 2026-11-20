/**
 * Public surface of the AI service layer (§8.4).
 * Import from 'src/services/ai' (or the package path once the app exists).
 */

export { createAiService, type AiService, type AiServiceDeps } from './service.js';
export { loadAiConfig, requireHfToken, type AiConfig } from './config.js';
export { MODEL_REGISTRY, getModel, repoIdFor, type ModelEntry, type ModelKey } from './models/registry.js';
export { HuggingFaceProvider } from './providers/huggingface.js';
export { MockProvider } from './providers/mock.js';
export type { AiProvider, ProviderChatOptions, ProviderChatResult } from './providers/types.js';
export { RateLimiter, type RateLimitDecision } from './rate-limit/limiter.js';
export { UsageTracker, InMemoryUsageSink, type UsageEvent, type UsageSink } from './usage/tracker.js';
export { createLogger, type AiLogger } from './logging/logger.js';
export { NOOP_RETRIEVER, EmbeddingRetriever, type Retriever, type CorpusChunk } from './pipelines/retrieval.js';
export {
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
