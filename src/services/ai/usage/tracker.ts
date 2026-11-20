import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AiCapability, TokenUsage } from '../types.js';
import { estimateCostUsd, type PricingTable } from './pricing.js';
import { summarizeUsage, type SummaryOptions, type UsageSummary } from './metrics.js';

/**
 * AI usage & token tracking (§8.4, issue #17). Pluggable sink — default keeps
 * an in-memory ring for dev/tests; production wires JSONL (AI_USAGE_PATH) or
 * a persistent store. Sinks that implement UsageEventSource enable summary
 * queries via UsageTracker.summary().
 */

export interface UsageEvent {
  at: string;
  capability: AiCapability;
  model?: string | undefined;
  /** Pseudonymous user reference — never raw PII. */
  userRef?: string | undefined;
  usage?: TokenUsage | undefined;
  /** Estimated USD cost, computed at record time when the model is priced. */
  costUsd?: number | undefined;
  latencyMs: number;
  ok: boolean;
  errorCode?: string | undefined;
}

export interface UsageSink {
  record(event: UsageEvent): void | Promise<void>;
}

/** Sinks that can return stored events enable UsageTracker.summary(). */
export interface UsageEventSource {
  events(): readonly UsageEvent[];
}

export function isEventSource(sink: UsageSink): sink is UsageSink & UsageEventSource {
  return typeof (sink as unknown as UsageEventSource).events === 'function';
}

export class InMemoryUsageSink implements UsageSink, UsageEventSource {
  private readonly buf: UsageEvent[] = [];
  constructor(private readonly capacity = 1000) {}

  record(event: UsageEvent): void {
    this.buf.push(event);
    if (this.buf.length > this.capacity) {
      this.buf.splice(0, this.buf.length - this.capacity);
    }
  }

  events(): readonly UsageEvent[] {
    return this.buf;
  }

  snapshot(): readonly UsageEvent[] {
    return this.buf;
  }
}

/** JSONL-backed sink — appends events, queryable by reading the file back. */
export class JsonlUsageSink implements UsageSink, UsageEventSource {
  private cache: UsageEvent[] | undefined;
  constructor(private readonly path: string) {}

  record(event: UsageEvent): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(event) + '\n');
    this.cache = undefined;
  }

  events(): readonly UsageEvent[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    this.cache = readFileSync(this.path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as UsageEvent);
    return this.cache;
  }
}

export interface UsageTrackerOptions {
  /** Pricing table for costUsd estimation (default: built-in estimates). */
  pricing?: PricingTable;
  /**
   * Queryable event source for summary() — e.g. the durable sink when `sink`
   * is an alerting/decorator wrapper. Defaults to `sink` when it is queryable.
   */
  source?: UsageEventSource;
}

export class UsageTracker {
  private readonly sink: UsageSink;
  private readonly pricing: PricingTable | undefined;
  private readonly source: UsageEventSource | undefined;

  constructor(sink?: UsageSink, opts: UsageTrackerOptions = {}) {
    this.sink = sink ?? new InMemoryUsageSink();
    this.pricing = opts.pricing;
    this.source = opts.source ?? (isEventSource(this.sink) ? this.sink : undefined);
  }

  record(event: Omit<UsageEvent, 'at' | 'costUsd'> & { costUsd?: number | undefined }): void {
    const costUsd =
      event.costUsd ??
      estimateCostUsd(event.model, event.usage, {}, this.pricing);
    const full: UsageEvent = {
      ...event,
      ...(costUsd !== undefined ? { costUsd } : {}),
      at: new Date().toISOString(),
    };
    try {
      void this.sink.record(full);
    } catch {
      /* monitoring must never break inference */
    }
  }

  /** Aggregated usage summary when a queryable source exists; else empty summary. */
  summary(opts: SummaryOptions = {}): UsageSummary {
    const events = this.source?.events() ?? [];
    return summarizeUsage(events, opts);
  }

  get sinkRef(): UsageSink {
    return this.sink;
  }
}
