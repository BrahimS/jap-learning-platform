import type { AiCapability, TokenUsage } from '../types.js';

/**
 * AI usage & token tracking (§8.4). Pluggable sink — default keeps an
 * in-memory ring for dev/tests; production wires a persistent store
 * (issue #17 builds dashboards on top of this).
 */

export interface UsageEvent {
  at: string;
  capability: AiCapability;
  model?: string | undefined;
  /** Pseudonymous user reference — never raw PII. */
  userRef?: string | undefined;
  usage?: TokenUsage | undefined;
  latencyMs: number;
  ok: boolean;
  errorCode?: string | undefined;
}

export interface UsageSink {
  record(event: UsageEvent): void | Promise<void>;
}

export class InMemoryUsageSink implements UsageSink {
  private readonly events: UsageEvent[] = [];
  constructor(private readonly capacity = 1000) {}

  record(event: UsageEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
  }

  snapshot(): readonly UsageEvent[] {
    return this.events;
  }
}

export class UsageTracker {
  private readonly sink: UsageSink;
  constructor(sink?: UsageSink) {
    this.sink = sink ?? new InMemoryUsageSink();
  }

  record(event: Omit<UsageEvent, 'at'>): void {
    const full: UsageEvent = { ...event, at: new Date().toISOString() };
    try {
      void this.sink.record(full);
    } catch {
      /* monitoring must never break inference */
    }
  }

  get sinkRef(): UsageSink {
    return this.sink;
  }
}
