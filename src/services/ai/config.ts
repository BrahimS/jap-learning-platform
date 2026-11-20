import { AiError } from './types.js';

/**
 * Central AI configuration. Server-side only — never import this module from
 * client code. Tokens come from env vars and are never logged or returned.
 */

export interface AiConfig {
  /** Hugging Face access token. Required for authenticated inference. */
  hfToken: string | undefined;
  /** HF Inference Providers router base (OpenAI-compatible). */
  hfRouterBaseUrl: string;
  /** HF task-endpoint base (feature-extraction, ASR, TTS). Provider appends `/models/{id}`. */
  hfApiBaseUrl: string;
  /** Per-attempt request timeout. */
  requestTimeoutMs: number;
  /** Retries after the initial attempt. */
  maxRetries: number;
  /** Base delay for exponential backoff (ms). */
  retryBaseDelayMs: number;
  /** Global rate limit applied to AI endpoints. */
  rateLimit: { windowMs: number; maxRequests: number };
}

export interface AiConfigEnv {
  HF_TOKEN?: string;
  HF_ROUTER_BASE_URL?: string;
  HF_API_BASE_URL?: string;
  AI_REQUEST_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  AI_RETRY_BASE_DELAY_MS?: string;
  AI_RATE_LIMIT_WINDOW_MS?: string;
  AI_RATE_LIMIT_MAX?: string;
}

const DEFAULTS = {
  hfRouterBaseUrl: 'https://router.huggingface.co',
  // Legacy api-inference.huggingface.co was retired Nov 2025; task endpoints
  // now live under the hf-inference provider on the router.
  hfApiBaseUrl: 'https://router.huggingface.co/hf-inference',
  requestTimeoutMs: 30_000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 30,
} as const;

function int(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadAiConfig(env: AiConfigEnv = process.env as AiConfigEnv): AiConfig {
  return {
    hfToken: env.HF_TOKEN,
    hfRouterBaseUrl: env.HF_ROUTER_BASE_URL ?? DEFAULTS.hfRouterBaseUrl,
    hfApiBaseUrl: env.HF_API_BASE_URL ?? DEFAULTS.hfApiBaseUrl,
    requestTimeoutMs: int(env.AI_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    maxRetries: int(env.AI_MAX_RETRIES, DEFAULTS.maxRetries),
    retryBaseDelayMs: int(env.AI_RETRY_BASE_DELAY_MS, DEFAULTS.retryBaseDelayMs),
    rateLimit: {
      windowMs: int(env.AI_RATE_LIMIT_WINDOW_MS, DEFAULTS.rateLimitWindowMs),
      maxRequests: int(env.AI_RATE_LIMIT_MAX, DEFAULTS.rateLimitMax),
    },
  };
}

/** Throws NOT_CONFIGURED when the token required for server-side inference is absent. */
export function requireHfToken(config: AiConfig): string {
  if (!config.hfToken) {
    throw new AiError(
      'NOT_CONFIGURED',
      'Hugging Face token is not configured (HF_TOKEN). AI features are unavailable.',
    );
  }
  return config.hfToken;
}
