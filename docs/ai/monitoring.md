# AI Usage Monitoring & Cost Tracking (issue #17)

Spec: §8.4 (logging/monitoring), §8.7. All metrics flow through the AI service
layer (`src/services/ai/usage/`) — feature code never tracks usage ad hoc.

## Architecture

```
handler/pipeline → UsageTracker.record(event)
                        │  enriches costUsd via pricing table
                        ▼
              AlertingUsageSink ──► durable sink (JSONL | in-memory | custom)
                        │            ▲ UsageEventSource → summary() queries
                        ▼
              threshold eval (throttled 10s, per-rule cooldown)
                        │
                        ▼
              AiLogger.warn + optional onAlert callback (webhook etc.)
```

## What is tracked

`UsageEvent`: timestamp, capability, model (registry repo ID), pseudonymous
`userRef`, token usage (prompt/completion/total), **estimated `costUsd`**,
latency, success flag, error code. No prompts, completions, tokens, or user
content are ever recorded — the logger additionally redacts
`token|secret|key|authorization|cookie|password` keys.

## Cost estimation

`usage/pricing.ts` holds a per-model price table (USD per 1M tokens; per
audio-minute for ASR; per-1K-chars for TTS). **All entries are planning
estimates** — HF Inference Providers bill through varying upstream providers,
and dedicated/self-hosted endpoints bill GPU-hours instead. Verify against
actual invoices and override via:

- env `AI_PRICING_JSON` — JSON map of `repoId → partial PriceEntry`
- `createAiService({ pricingOverrides })` / `estimateCostUsd(..., pricing)`

Events for unpriced models or missing provider usage are counted in
`unpricedRequests` — unmeasured, not zero.

## Queries

- `service.usage.summary({ since, until, maxUsers })` → `UsageSummary`
  (totals + `byCapability` / `byModel` / `byUser` with request counts, error
  rates, latency avg/p50/p95/max, tokens, cost).
- `GET` usage handler (`service.handlers.usage`, `handleUsageRequest`):
  `?window=15m|1h|24h|7d` or `?since=<ISO>`. **Admin-only — the handler does
  no auth; protect it at the host** (e.g. behind an admin session check).

## Persistence

Set `AI_USAGE_PATH=/var/log/ai-usage.jsonl` for append-only JSONL events
(`JsonlUsageSink`), readable across restarts and summable via `summary()`.
Default is an in-memory ring (1000 events) for dev/tests.

## Alerting

`AlertingUsageSink` evaluates rolling-window thresholds (defaults):

| Rule | Threshold | Min sample |
|---|---|---|
| `error_rate` | ≥ 20% errors | 20 requests / 5m |
| `spend` | ≥ $5 estimated | — |
| `latency` | p95 ≥ 20s | 10 requests / 5m |

Evaluation is throttled to once per 10s; each rule re-alerts at most every
15m (cooldown). Alerts go to `AiLogger.warn` and optionally an `onAlert`
callback for webhook/ pager integration. Tune via `createAiService({
usageAlerts: {...} })` or disable by passing a custom `usageSink`.

## Privacy

- `userRef` is pseudonymous (hashed user ID recommended at the call site).
- No message content, prompts, audio, or tokens are stored or logged.
- ASR/TTS unit costs (audio minutes, characters) are supported by
  `estimateCostUsd` but not yet populated by handlers — providers don't
  report them today; chat/embed token costs cover the dominant spend.
