import type { UsageEvent } from './tracker.js';

/**
 * Usage aggregation for monitoring dashboards/queries (issue #17).
 * Pure functions over UsageEvent[] — the store stays pluggable.
 */

export interface GroupStats {
  requests: number;
  ok: number;
  errors: number;
  /** errors / requests; 0 when no requests. */
  errorRate: number;
  latencyMs: { avg: number; p50: number; p95: number; max: number };
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum of measured costs (USD). */
  costUsd: number;
  /** Events with no cost data (unknown model or missing usage). */
  unpricedRequests: number;
}

export interface UsageSummary {
  since?: string;
  until?: string;
  total: GroupStats;
  byCapability: Record<string, GroupStats>;
  byModel: Record<string, GroupStats>;
  /** Top users by request count — userRef is pseudonymous by contract. */
  byUser: Record<string, GroupStats>;
  generatedAt: string;
}

interface Acc {
  stats: GroupStats;
  lats: number[];
}

function newAcc(): Acc {
  return {
    lats: [],
    stats: {
      requests: 0,
      ok: 0,
      errors: 0,
      errorRate: 0,
      latencyMs: { avg: 0, p50: 0, p95: 0, max: 0 },
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      unpricedRequests: 0,
    },
  };
}

function add(acc: Acc, e: UsageEvent): void {
  const s = acc.stats;
  s.requests += 1;
  if (e.ok) s.ok += 1;
  else s.errors += 1;
  acc.lats.push(e.latencyMs);
  s.latencyMs.max = Math.max(s.latencyMs.max, e.latencyMs);
  s.promptTokens += e.usage?.promptTokens ?? 0;
  s.completionTokens += e.usage?.completionTokens ?? 0;
  s.totalTokens += e.usage?.totalTokens ?? 0;
  if (e.costUsd !== undefined) s.costUsd += e.costUsd;
  else s.unpricedRequests += 1;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

function finalize(acc: Acc): GroupStats {
  const s = acc.stats;
  const lats = [...acc.lats].sort((a, b) => a - b);
  const sum = lats.reduce((a, b) => a + b, 0);
  return {
    requests: s.requests,
    ok: s.ok,
    errors: s.errors,
    errorRate: s.requests === 0 ? 0 : s.errors / s.requests,
    latencyMs: {
      avg: lats.length === 0 ? 0 : Math.round(sum / lats.length),
      p50: Math.round(percentile(lats, 50)),
      p95: Math.round(percentile(lats, 95)),
      max: s.latencyMs.max,
    },
    promptTokens: s.promptTokens,
    completionTokens: s.completionTokens,
    totalTokens: s.totalTokens,
    costUsd: Math.round(s.costUsd * 1_000_000) / 1_000_000,
    unpricedRequests: s.unpricedRequests,
  };
}

export interface SummaryOptions {
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (exclusive). */
  until?: string;
  /** Max entries in byUser (default 25); the tail folds into '(other)'. */
  maxUsers?: number;
}

function toRecord(map: Map<string, Acc>): Record<string, GroupStats> {
  const rec: Record<string, GroupStats> = {};
  const entries = [...map.entries()].sort(
    (a, b) => b[1].stats.requests - a[1].stats.requests,
  );
  for (const [k, v] of entries) rec[k] = finalize(v);
  return rec;
}

export function summarizeUsage(
  events: readonly UsageEvent[],
  opts: SummaryOptions = {},
): UsageSummary {
  const sinceMs = opts.since ? Date.parse(opts.since) : undefined;
  const untilMs = opts.until ? Date.parse(opts.until) : undefined;
  const filtered = events.filter((e) => {
    const t = Date.parse(e.at);
    if (sinceMs !== undefined && Number.isFinite(sinceMs) && t < sinceMs) return false;
    if (untilMs !== undefined && Number.isFinite(untilMs) && t >= untilMs) return false;
    return true;
  });

  const total = newAcc();
  const byCapability = new Map<string, Acc>();
  const byModel = new Map<string, Acc>();
  const byUser = new Map<string, Acc>();

  for (const e of filtered) {
    add(total, e);
    for (const [map, key] of [
      [byCapability, e.capability],
      [byModel, e.model ?? '(unknown)'],
      [byUser, e.userRef ?? '(anonymous)'],
    ] as const) {
      let acc = map.get(key);
      if (!acc) {
        acc = newAcc();
        map.set(key, acc);
      }
      add(acc, e);
    }
  }

  // Fold byUser tail into '(other)' so request/token/cost totals stay
  // reconcilable (latency percentiles for the bucket are approximate).
  const maxUsers = opts.maxUsers ?? 25;
  const userEntries = [...byUser.entries()].sort(
    (a, b) => b[1].stats.requests - a[1].stats.requests,
  );
  const byUserOut: Record<string, GroupStats> = {};
  for (const [k, acc] of userEntries.slice(0, maxUsers)) {
    byUserOut[k] = finalize(acc);
  }
  if (userEntries.length > maxUsers) {
    const other = newAcc();
    for (const [, acc] of userEntries.slice(maxUsers)) {
      const s = acc.stats;
      other.stats.requests += s.requests;
      other.stats.ok += s.ok;
      other.stats.errors += s.errors;
      other.stats.latencyMs.max = Math.max(other.stats.latencyMs.max, s.latencyMs.max);
      other.stats.promptTokens += s.promptTokens;
      other.stats.completionTokens += s.completionTokens;
      other.stats.totalTokens += s.totalTokens;
      other.stats.costUsd += s.costUsd;
      other.stats.unpricedRequests += s.unpricedRequests;
    }
    byUserOut['(other)'] = finalize(other);
  }

  return {
    ...(opts.since ? { since: opts.since } : {}),
    ...(opts.until ? { until: opts.until } : {}),
    total: finalize(total),
    byCapability: toRecord(byCapability),
    byModel: toRecord(byModel),
    byUser: byUserOut,
    generatedAt: new Date().toISOString(),
  };
}

/** Convenience: rolling window ending now. */
export function summarizeLast(
  events: readonly UsageEvent[],
  windowMs: number,
): UsageSummary {
  return summarizeUsage(events, { since: new Date(Date.now() - windowMs).toISOString() });
}
