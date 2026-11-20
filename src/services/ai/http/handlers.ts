import { z } from 'zod';
import { catalogItemSchema, learnerStatsSchema } from '../evaluators/schemas.js';
import { AiError, type AiCapability, type AiResult, type ExplanationLanguage } from '../types.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import type { UsageTracker } from '../usage/tracker.js';
import type { AiLogger } from '../logging/logger.js';
import {
  nextReportId,
  reportSchema,
  type FeedbackStore,
  type StoredReport,
} from '../evaluators/feedback.js';

/**
 * Server-side API endpoint handlers (§8.4). Built on Web-standard
 * Request/Response so they mount unchanged in Next.js route handlers,
 * Cloudflare Workers, Node http servers, etc:
 *
 *   // app/api/ai/tutor/route.ts
 *   export const POST = service.handlers.tutor;
 *
 * Every handler: POST-only, Zod-validated body, rate-limited, usage-tracked,
 * errors mapped to safe status codes (details logged, not leaked).
 */

const language = z.enum(['fr', 'en', 'ar']);

export const tutorBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  learnerLevel: z.string().min(1).max(40),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }))
    .max(50)
    .optional(),
  text: z.string().min(1).max(4000),
});

export const grammarBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  structure: z.string().min(1).max(200),
});

export const vocabularyBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  word: z.string().min(1).max(100),
});

export const quizBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  type: z.enum(['multiple_choice', 'sentence_completion', 'translation', 'reading_comprehension', 'jlpt_style']),
  topic: z.string().max(200).optional(),
  jlptLevel: z.enum(['N5', 'N4', 'N3', 'N2', 'N1']).optional(),
  count: z.number().int().min(1).max(20).optional(),
});

export const writingBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  sentence: z.string().min(1).max(4000),
  criteria: z.string().max(1000).optional(),
});

export const transcribeBody = z.object({
  userRef: z.string().max(128).optional(),
  audioBase64: z.string().min(1),
  mimeType: z.string().regex(/^audio\//, 'mimeType must be audio/*'),
});

export const synthesizeBody = z.object({
  userRef: z.string().max(128).optional(),
  text: z.string().min(1).max(2000),
});

export const embedBody = z.object({
  texts: z.array(z.string().min(1).max(8000)).min(1).max(64),
});

export const translateBody = z.object({
  userRef: z.string().max(128).optional(),
  text: z.string().min(1).max(4000),
  sourceLang: z.string().length(2),
  targetLang: z.string().length(2),
});

/** Learning-recommendations request (§8.2; issue #8). */
export const recommendBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  learnerLevel: z.string().min(1).max(40),
  stats: learnerStatsSchema.optional(),
  catalog: z.array(catalogItemSchema).min(1).max(500),
});

/** Pronunciation check: expected text + learner audio (issue #12). */
export const pronounceBody = z.object({
  userRef: z.string().max(128).optional(),
  expectedText: z.string().min(1).max(1000),
  audioBase64: z.string().min(1),
  mimeType: z.string().regex(/^audio\//, 'mimeType must be audio/*'),
});

/** RAG learning assistant question (§8.5). */
export const askBody = z.object({
  userRef: z.string().max(128).optional(),
  language,
  question: z.string().min(1).max(4000),
});

/** "Report incorrect answer" endpoint body (§8.6). */
export const reportBody = reportSchema;

/** Window shorthands for the usage endpoint. */
const WINDOW_MS: Record<string, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export interface HandlerDeps {
  rateLimiter: RateLimiter;
  usage: UsageTracker;
  logger: AiLogger;
  /** Max request body size guard. */
  maxBodyBytes?: number;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function errorResponse(err: unknown, logger: AiLogger, scope: string): Response {
  if (err instanceof AiError) {
    logger.warn(scope, 'ai request failed', { code: err.code, status: err.status });
    return jsonResponse(err.status, { ok: false, error: { code: err.code, message: err.message } });
  }
  logger.error(scope, 'unexpected ai failure', {
    message: err instanceof Error ? err.message : String(err),
  });
  return jsonResponse(500, { ok: false, error: { code: 'INTERNAL', message: 'Internal error' } });
}

/**
 * Wrap a capability call: rate limit → run → usage record → JSON response.
 * `fn` receives the validated body and must return an AiResult (or audio).
 */
export async function handleAiJson<B, R extends { data: unknown }>(
  req: Request,
  deps: HandlerDeps,
  opts: {
    schema: z.ZodType<B>;
    capability: AiCapability;
    scope: string;
    fn: (body: B) => Promise<AiResult<R['data']>>;
  },
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
  }
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > (deps.maxBodyBytes ?? 256 * 1024)) {
      return jsonResponse(413, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body too large' } });
    }
    raw = JSON.parse(text);
  } catch {
    return jsonResponse(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } });
  }

  const parsed = opts.schema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(400, {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid request',
        issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  }
  const body = parsed.data as B & { userRef?: string };

  const limitKey =
    body.userRef ??
    req.headers.get('x-user-id') ??
    req.headers.get('x-forwarded-for') ??
    'anonymous';
  const decision = deps.rateLimiter.check(`${opts.capability}:${limitKey}`);
  if (!decision.allowed) {
    return jsonResponse(429, {
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  const started = Date.now();
  try {
    const result = await opts.fn(body);
    deps.usage.record({
      capability: opts.capability,
      model: result.model,
      userRef: body.userRef,
      usage: result.usage,
      latencyMs: result.latencyMs,
      ok: true,
    });
    deps.logger.info(opts.scope, 'ai request ok', {
      capability: opts.capability,
      model: result.model,
      latencyMs: result.latencyMs,
    });
    return jsonResponse(200, { ok: true, result: result.data, meta: metaOf(result) });
  } catch (err) {
    deps.usage.record({
      capability: opts.capability,
      userRef: body.userRef,
      latencyMs: Date.now() - started,
      ok: false,
      errorCode: err instanceof AiError ? err.code : 'INTERNAL',
    });
    return errorResponse(err, deps.logger, opts.scope);
  }
}

function metaOf(result: AiResult<unknown>) {
  return {
    model: result.model,
    capability: result.capability,
    latencyMs: result.latencyMs,
    usage: result.usage,
    provenance: result.provenance,
    diagnostics: result.diagnostics,
  };
}

export interface ReportHandlerDeps {
  rateLimiter: RateLimiter;
  store: FeedbackStore;
  logger: AiLogger;
  maxBodyBytes?: number;
}

/**
 * POST handler for incorrect-answer reports. Not model inference — no usage
 * tokens consumed — but still rate-limited and validated.
 */
export async function handleReportRequest(
  req: Request,
  deps: ReportHandlerDeps,
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: { code: 'METHOD', message: 'POST only' } });
  }
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > (deps.maxBodyBytes ?? 64 * 1024)) {
      return jsonResponse(413, { ok: false, error: { code: 'BAD_REQUEST', message: 'Body too large' } });
    }
    raw = JSON.parse(text);
  } catch {
    return jsonResponse(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } });
  }

  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonResponse(400, {
      ok: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid report',
        issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  }
  const report = parsed.data;

  const limitKey = report.userRef ?? req.headers.get('x-user-id') ?? 'anonymous';
  const decision = deps.rateLimiter.check(`report:${limitKey}`);
  if (!decision.allowed) {
    return jsonResponse(429, {
      ok: false,
      error: { code: 'RATE_LIMITED', message: 'Too many reports' },
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  const stored: StoredReport = {
    ...report,
    id: nextReportId(),
    at: new Date().toISOString(),
  };
  await deps.store.add(stored);
  deps.logger.info('report', 'incorrect-answer report stored', {
    capability: report.capability,
    reportId: stored.id,
  });
  return jsonResponse(202, { ok: true, id: stored.id });
}

/**
 * GET /ai/usage — aggregated usage/cost summary (issue #17).
 * ADMIN-ONLY: mount behind authentication in the host app; the handler itself
 * performs no auth. Query params: `?window=15m|1h|24h|7d` or `?since=<ISO>`.
 */
export async function handleUsageRequest(
  req: Request,
  deps: { usage: UsageTracker },
): Promise<Response> {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse(405, { ok: false, error: { code: 'METHOD', message: 'GET only' } });
  }
  const url = new URL(req.url);
  const windowParam = url.searchParams.get('window') ?? '';
  const sinceParam = url.searchParams.get('since') ?? undefined;
  const windowMs = WINDOW_MS[windowParam];
  const since =
    sinceParam ??
    (windowMs !== undefined ? new Date(Date.now() - windowMs).toISOString() : undefined);
  if (sinceParam !== undefined && Number.isNaN(Date.parse(sinceParam))) {
    return jsonResponse(400, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid since parameter (expected ISO timestamp)' },
    });
  }
  if (windowParam !== '' && windowMs === undefined) {
    return jsonResponse(400, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'Invalid window (expected 15m|1h|24h|7d)' },
    });
  }
  const summary = deps.usage.summary({ ...(since !== undefined ? { since } : {}) });
  return jsonResponse(200, { ok: true, summary });
}
