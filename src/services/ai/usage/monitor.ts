import type { AiLogger } from '../logging/logger.js';
import type { UsageEvent, UsageEventSource, UsageSink } from './tracker.js';
import { summarizeLast } from './metrics.js';

/**
 * Usage alerting (issue #17; §8.4 "alerting on abnormal failure rates or
 * spend"). A UsageSink decorator: every recorded event is forwarded to the
 * inner sink, then rolling-window thresholds are evaluated (throttled).
 * Alerts are deduplicated per rule with a cooldown so a sustained incident
 * logs once per cooldown window instead of per request.
 */

export interface AlertThresholds {
  /** Error rate (0-1) over the window that triggers an alert. Default 0.2. */
  errorRate?: number;
  /** Minimum requests in the window before error-rate alerts apply. Default 20. */
  minRequestsForErrorRate?: number;
  /** Estimated spend (USD) in the window that triggers an alert. Default 5. */
  spendUsd?: number;
  /** p95 latency (ms) that triggers an alert. Default 20000. */
  p95LatencyMs?: number;
  /** Rolling evaluation window. Default 5 minutes. */
  windowMs?: number;
  /** Minimum requests before latency alerts apply. Default 10. */
  minRequestsForLatency?: number;
  /** Per-rule re-alert cooldown. Default 15 minutes. */
  cooldownMs?: number;
}

export interface UsageAlert {
  rule: 'error_rate' | 'spend' | 'latency';
  message: string;
  meta: Record<string, unknown>;
  at: string;
}

interface ResolvedThresholds {
  errorRate: number;
  minRequestsForErrorRate: number;
  spendUsd: number;
  p95LatencyMs: number;
  windowMs: number;
  minRequestsForLatency: number;
  cooldownMs: number;
}

export class AlertingUsageSink implements UsageSink, UsageEventSource {
  private readonly inner: UsageSink;
  private readonly buf: UsageEvent[] = [];
  private readonly capacity: number;
  private readonly logger: AiLogger | undefined;
  private readonly onAlert: ((alert: UsageAlert) => void) | undefined;
  private readonly t: ResolvedThresholds;
  private readonly lastFired = new Map<string, number>();
  private lastEvalAt = 0;
  /** Evaluate at most this often — summarizing is O(n log n). */
  private readonly evalIntervalMs: number;

  constructor(
    inner: UsageSink,
    opts: {
      logger?: AiLogger;
      onAlert?: (alert: UsageAlert) => void;
      capacity?: number;
      /** Minimum ms between threshold evaluations (default 10s; 0 = every record). */
      evalIntervalMs?: number;
    } & AlertThresholds = {},
  ) {
    this.inner = inner;
    this.logger = opts.logger;
    this.onAlert = opts.onAlert;
    this.capacity = opts.capacity ?? 2000;
    this.evalIntervalMs = opts.evalIntervalMs ?? 10_000;
    this.t = {
      errorRate: opts.errorRate ?? 0.2,
      minRequestsForErrorRate: opts.minRequestsForErrorRate ?? 20,
      spendUsd: opts.spendUsd ?? 5,
      p95LatencyMs: opts.p95LatencyMs ?? 20_000,
      windowMs: opts.windowMs ?? 5 * 60_000,
      minRequestsForLatency: opts.minRequestsForLatency ?? 10,
      cooldownMs: opts.cooldownMs ?? 15 * 60_000,
    };
  }

  record(event: UsageEvent): void {
    void this.inner.record(event);
    this.buf.push(event);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
    const now = Date.now();
    if (now - this.lastEvalAt >= this.evalIntervalMs) {
      this.lastEvalAt = now;
      this.evaluate(now);
    }
  }

  /** Recent in-memory events (alerting window; also satisfies UsageEventSource). */
  recent(): readonly UsageEvent[] {
    return this.buf;
  }

  events(): readonly UsageEvent[] {
    return this.buf;
  }

  private evaluate(now: number): void {
    const summary = summarizeLast(this.buf, this.t.windowMs);
    const total = summary.total;
    const fire = (rule: UsageAlert['rule'], message: string, meta: Record<string, unknown>) => {
      const last = this.lastFired.get(rule) ?? 0;
      if (now - last < this.t.cooldownMs) return;
      this.lastFired.set(rule, now);
      const alert: UsageAlert = { rule, message, meta, at: new Date(now).toISOString() };
      this.logger?.warn('usage-alert', message, meta);
      try {
        this.onAlert?.(alert);
      } catch {
        /* alert delivery must never break the sink */
      }
    };

    if (total.requests >= this.t.minRequestsForErrorRate && total.errorRate >= this.t.errorRate) {
      fire(
        'error_rate',
        `AI error rate ${(total.errorRate * 100).toFixed(1)}% over ${Math.round(this.t.windowMs / 60000)}m`,
        { requests: total.requests, errorRate: total.errorRate, errors: total.errors },
      );
    }
    if (total.costUsd >= this.t.spendUsd) {
      fire(
        'spend',
        `AI spend $${total.costUsd.toFixed(4)} over ${Math.round(this.t.windowMs / 60000)}m exceeds $${this.t.spendUsd}`,
        { costUsd: total.costUsd, requests: total.requests },
      );
    }
    if (total.requests >= this.t.minRequestsForLatency && total.latencyMs.p95 >= this.t.p95LatencyMs) {
      fire('latency', `AI p95 latency ${total.latencyMs.p95}ms exceeds ${this.t.p95LatencyMs}ms`, {
        p95: total.latencyMs.p95,
        avg: total.latencyMs.avg,
        requests: total.requests,
      });
    }
  }
}
