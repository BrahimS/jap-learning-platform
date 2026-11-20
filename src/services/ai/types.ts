/** Shared types for the AI service layer. Provider- and framework-agnostic. */

export type ExplanationLanguage = 'fr' | 'en' | 'ar';

export type AiCapability =
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
  | 'recommendations';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface Provenance {
  /** Retrieved curriculum resource IDs used to ground the response (RAG). */
  sources?: string[];
  /** Whether the response is grounded in reviewed content vs. pure generation. */
  grounded: boolean;
}

export interface AiResult<T> {
  data: T;
  /** Registry model ID that produced the result. */
  model: string;
  capability: AiCapability;
  usage?: TokenUsage;
  provenance?: Provenance;
  /** Pipeline diagnostics — e.g., count of invalid items dropped pre-serve. */
  diagnostics?: Record<string, unknown>;
  latencyMs: number;
}

export type AiErrorCode =
  | 'NOT_CONFIGURED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'VALIDATION_ERROR'
  | 'UPSTREAM_4XX'
  | 'UPSTREAM_5XX'
  | 'PROVIDER_ERROR'
  | 'BAD_REQUEST';

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** HTTP status to surface to API callers, when applicable. */
  readonly status: number;
  /** Whether a retry could plausibly succeed. */
  readonly retryable: boolean;
  /** Upstream provider detail — safe to log, never contains secrets. */
  readonly detail?: string;

  constructor(
    code: AiErrorCode,
    message: string,
    opts: { status?: number; retryable?: boolean; detail?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AiError';
    this.code = code;
    this.status = opts.status ?? defaultStatus(code);
    this.retryable = opts.retryable ?? defaultRetryable(code);
    if (opts.detail !== undefined) this.detail = opts.detail;
  }
}

function defaultStatus(code: AiErrorCode): number {
  switch (code) {
    case 'NOT_CONFIGURED':
      return 503;
    case 'TIMEOUT':
      return 504;
    case 'RATE_LIMITED':
      return 429;
    case 'VALIDATION_ERROR':
    case 'BAD_REQUEST':
      return 400;
    case 'UPSTREAM_4XX':
      return 502;
    case 'UPSTREAM_5XX':
    case 'PROVIDER_ERROR':
      return 502;
  }
}

function defaultRetryable(code: AiErrorCode): boolean {
  return code === 'TIMEOUT' || code === 'UPSTREAM_5XX' || code === 'PROVIDER_ERROR';
}
