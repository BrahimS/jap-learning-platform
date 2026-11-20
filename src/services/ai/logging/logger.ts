/**
 * Structured JSON logger for the AI layer (§8.4 logging/monitoring).
 * Logs metadata only — never tokens, prompts, or user content.
 */

export interface AiLogger {
  info(scope: string, msg: string, meta?: Record<string, unknown>): void;
  warn(scope: string, msg: string, meta?: Record<string, unknown>): void;
  error(scope: string, msg: string, meta?: Record<string, unknown>): void;
}

const REDACT_KEYS = /token|secret|key|authorization|cookie|password/i;
const MAX_STRING = 200;

function sanitize(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (REDACT_KEYS.test(k)) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string' && v.length > MAX_STRING) {
      out[k] = `${v.slice(0, MAX_STRING)}…`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: 'info' | 'warn' | 'error', scope: string, msg: string, meta?: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, ...sanitize(meta) });
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(line);
}

export function createLogger(scope = 'ai'): AiLogger {
  return {
    info: (s, m, meta) => emit('info', `${scope}:${s}`, m, meta),
    warn: (s, m, meta) => emit('warn', `${scope}:${s}`, m, meta),
    error: (s, m, meta) => emit('error', `${scope}:${s}`, m, meta),
  };
}
