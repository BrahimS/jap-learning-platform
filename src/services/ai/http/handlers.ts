import { z } from 'zod';
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

/** "Report incorrect answer" endpoint body (§8.6). */
export const reportBody = reportSchema;

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
