import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateCostUsd,
  loadPricing,
} from '../../src/services/ai/usage/pricing.js';
import { summarizeUsage, summarizeLast } from '../../src/services/ai/usage/metrics.js';
import { AlertingUsageSink, type UsageAlert } from '../../src/services/ai/usage/monitor.js';
import {
  InMemoryUsageSink,
  JsonlUsageSink,
  UsageTracker,
  type UsageEvent,
} from '../../src/services/ai/usage/tracker.js';
import { handleUsageRequest } from '../../src/services/ai/http/handlers.js';
import { createLogger } from '../../src/services/ai/logging/logger.js';

function evt(over: Partial<UsageEvent> = {}): Omit<UsageEvent, 'at'> {
  return {
    capability: 'grammar',
    model: 'Qwen/Qwen3-8B',
    latencyMs: 100,
    ok: true,
    ...over,
  };
}

describe('cost estimation', () => {
  it('prices token usage per model', () => {
    // Qwen3-8B: $0.05/M in, $0.15/M out → 1M in + 1M out = $0.20
    const cost = estimateCostUsd('Qwen/Qwen3-8B', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.2, 6);
  });

  it('returns undefined for unknown models or missing usage', () => {
    expect(estimateCostUsd('unknown/model', { promptTokens: 10 })).toBeUndefined();
    expect(estimateCostUsd('Qwen/Qwen3-8B', undefined)).toBeUndefined();
    expect(estimateCostUsd(undefined, { promptTokens: 10 })).toBeUndefined();
  });

  it('prices unit-based modalities via units param', () => {
    const cost = estimateCostUsd('openai/whisper-large-v3-turbo', undefined, {
      audioMinutes: 10,
    });
    expect(cost).toBeCloseTo(0.06, 6); // $0.006/min × 10
  });

  it('merges JSON pricing overrides', () => {
    const table = loadPricing(
      JSON.stringify({ 'Qwen/Qwen3-8B': { inputPer1MUsd: 1.0 } }),
    );
    expect(table['Qwen/Qwen3-8B']?.inputPer1MUsd).toBe(1.0);
    expect(table['Qwen/Qwen3-8B']?.outputPer1MUsd).toBe(0.15); // preserved
    expect(loadPricing('{bad json')['Qwen/Qwen3-8B']?.inputPer1MUsd).toBe(0.05);
  });
});

describe('usage metrics', () => {
  const events: UsageEvent[] = [
    { ...evt({ capability: 'grammar', latencyMs: 100, usage: { promptTokens: 100, completionTokens: 50 } }), at: '2026-01-01T00:00:01Z', costUsd: 0.001 },
    { ...evt({ capability: 'quiz', latencyMs: 300, ok: false, errorCode: 'TIMEOUT' }), at: '2026-01-01T00:00:02Z' },
    { ...evt({ capability: 'grammar', model: 'Qwen/Qwen3-32B', latencyMs: 200, userRef: 'u1' }), at: '2026-01-01T00:00:03Z' },
    { ...evt({ capability: 'asr', model: 'openai/whisper-large-v3-turbo', latencyMs: 5000 }), at: '2026-01-01T00:00:04Z' },
  ];

  it('aggregates totals, per-capability, per-model, per-user', () => {
    const s = summarizeUsage(events);
    expect(s.total.requests).toBe(4);
    expect(s.total.errors).toBe(1);
    expect(s.total.errorRate).toBeCloseTo(0.25);
    expect(s.total.latencyMs.p95).toBe(5000);
    expect(s.byCapability['grammar']?.requests).toBe(2);
    expect(s.byCapability['quiz']?.errors).toBe(1);
    expect(s.byModel['Qwen/Qwen3-8B']?.requests).toBe(2);
    expect(s.byUser['u1']?.requests).toBe(1);
    expect(s.byUser['(anonymous)']?.requests).toBe(3);
  });

  it('sums tokens and cost; counts unpriced events', () => {
    const s = summarizeUsage(events);
    expect(s.total.promptTokens).toBe(100);
    expect(s.total.completionTokens).toBe(50);
    expect(s.total.costUsd).toBeCloseTo(0.001);
    // 3 events without costUsd → unpriced (the 0.001 one is priced)
    expect(s.total.unpricedRequests).toBe(3);
  });

  it('filters by time window', () => {
    const s = summarizeUsage(events, { since: '2026-01-01T00:00:02Z' });
    expect(s.total.requests).toBe(3);
    const s2 = summarizeUsage(events, { until: '2026-01-01T00:00:02Z' });
    expect(s2.total.requests).toBe(1);
  });

  it('summarizeLast uses a rolling window', () => {
    const now = new Date().toISOString();
    const fresh: UsageEvent[] = [
      { ...evt(), at: now },
      { ...evt(), at: new Date(Date.now() - 30_000).toISOString() },
      { ...evt(), at: new Date(Date.now() - 120_000).toISOString() },
    ];
    expect(summarizeLast(fresh, 60_000).total.requests).toBe(2);
    expect(summarizeLast(fresh, 10_000).total.requests).toBe(1);
  });
});

describe('usage tracker', () => {
  it('enriches events with estimated costUsd', () => {
    const sink = new InMemoryUsageSink();
    const tracker = new UsageTracker(sink);
    tracker.record(
      evt({ usage: { promptTokens: 1_000_000, completionTokens: 0 } }),
    );
    const stored = sink.events()[0]!;
    expect(stored.costUsd).toBeCloseTo(0.05, 6); // Qwen3-8B input price
  });

  it('summary() reads from a queryable source', () => {
    const sink = new InMemoryUsageSink();
    const tracker = new UsageTracker(sink);
    tracker.record(evt());
    tracker.record(evt({ ok: false }));
    const s = tracker.summary();
    expect(s.total.requests).toBe(2);
    expect(s.total.errors).toBe(1);
  });

  it('JsonlUsageSink persists and reloads events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'usage-'));
    const path = join(dir, 'usage.jsonl');
    const a = new JsonlUsageSink(path);
    a.record({ ...evt(), at: new Date().toISOString() });
    const b = new JsonlUsageSink(path);
    expect(b.events()).toHaveLength(1);
    expect(b.events()[0]?.capability).toBe('grammar');
  });
});

describe('alerting sink', () => {
  it('fires error-rate alert after threshold and dedupes via cooldown', async () => {
    const inner = new InMemoryUsageSink();
    const alerts: UsageAlert[] = [];
    const sink = new AlertingUsageSink(inner, {
      minRequestsForErrorRate: 4,
      errorRate: 0.2,
      windowMs: 60_000,
      cooldownMs: 60_000,
      evalIntervalMs: 0,
      onAlert: (a) => alerts.push(a),
    });

    for (let i = 0; i < 4; i++) {
      sink.record({ ...evt({ ok: i < 3 }), at: new Date().toISOString() });
    }
    // errorRate = 3/4 = 0.75 ≥ 0.5 → one alert
    expect(alerts.filter((a) => a.rule === 'error_rate')).toHaveLength(1);
    // inner sink still got all events
    expect(inner.events()).toHaveLength(4);
  });

  it('fires spend alert on cost threshold', () => {
    const alerts: UsageAlert[] = [];
    const sink = new AlertingUsageSink(new InMemoryUsageSink(), {
      spendUsd: 0.0001,
      minRequestsForErrorRate: 999,
      minRequestsForLatency: 999,
      windowMs: 60_000,
      cooldownMs: 60_000,
      evalIntervalMs: 0,
      onAlert: (a) => alerts.push(a),
    });
    sink.record({
      ...evt({ costUsd: 0.001 }),
      at: new Date().toISOString(),
    });
    expect(alerts.some((a) => a.rule === 'spend')).toBe(true);
  });

  it('logs alerts through AiLogger without secrets', () => {
    const lines: string[] = [];
    const logger = {
      info: () => {},
      warn: (s: string, m: string, meta?: Record<string, unknown>) =>
        lines.push(JSON.stringify({ s, m, meta })),
      error: () => {},
    };
    const sink = new AlertingUsageSink(new InMemoryUsageSink(), {
      logger,
      spendUsd: 0.0001,
      minRequestsForErrorRate: 999,
      minRequestsForLatency: 999,
      windowMs: 60_000,
      cooldownMs: 60_000,
      evalIntervalMs: 0,
    });
    sink.record({ ...evt({ costUsd: 0.5 }), at: new Date().toISOString() });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).not.toMatch(/token|secret|authorization/i);
  });
});

describe('usage endpoint', () => {
  it('returns aggregated summary for GET with window', async () => {
    const sink = new InMemoryUsageSink();
    const tracker = new UsageTracker(sink);
    tracker.record(evt({ usage: { promptTokens: 10, completionTokens: 5 } }));
    const res = await handleUsageRequest(
      new Request('http://x/ai/usage?window=1h'),
      { usage: tracker },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; summary: { total: { requests: number } } };
    expect(body.ok).toBe(true);
    expect(body.summary.total.requests).toBe(1);
  });

  it('rejects bad window and non-GET methods', async () => {
    const tracker = new UsageTracker(new InMemoryUsageSink());
    const bad = await handleUsageRequest(new Request('http://x/ai/usage?window=99y'), {
      usage: tracker,
    });
    expect(bad.status).toBe(400);
    const post = await handleUsageRequest(
      new Request('http://x/ai/usage', { method: 'DELETE' }),
      { usage: tracker },
    );
    expect(post.status).toBe(405);
  });
});
