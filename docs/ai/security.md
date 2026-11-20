# AI Security, Rate Limiting & Data Protection

Issue: #6 · Spec: §8.1, §8.6, §8.7 · Epic: #1

Security review checklist for the AI layer (`src/services/ai/`). Sign-off required
before public launch of AI features. Items marked **[impl]** are enforced in code
with tests under `tests/ai/security.test.ts`.

## 1. Secrets & tokens

- [x] **[impl]** HF access token read only from `HF_TOKEN` env var, server-side.
      `loadAiConfig` never exposes it to client-reachable modules; the layer is
      only imported by server code.
- [x] **[impl]** Token never appears in responses: provider errors normalize to
      `AiError` without upstream bodies containing credentials; error responses
      return `{code, message}` only — `detail` stays server-side.
- [x] **[impl]** Logger redacts any meta key matching token/secret/key/auth/
      cookie/password patterns.
- [ ] No HF token in frontend bundles — verified by bundle/env audit at app
      build time (tracked when the app shell lands).
- [ ] Tokens rotated per environment; no shared prod/dev token.

## 2. Rate limiting & quotas

- [x] **[impl]** Sliding-window `RateLimiter` on every AI endpoint, keyed by
      `userRef` → `x-user-id` → `x-forwarded-for` → `anonymous`.
- [x] **[impl]** 429 responses include `retryAfterSeconds`.
- [ ] Per-user AI quotas persisted (daily/monthly token budgets) — needs the
      usage store from #17; in-memory limiter is per-instance only.
- [ ] Global spend ceiling alert — #17.

## 3. Input validation & prompt-injection defense

- [x] **[impl]** Every endpoint body Zod-validated; unknown fields stripped;
      body size capped (256 KB default).
- [x] **[impl]** Model output Zod-validated before reaching callers
      (`parseModelJson`) — malformed output becomes `VALIDATION_ERROR`, never
      reaches the client.
- [x] **[impl]** RAG retrieved content is fenced in `<curriculum>` tags and the
      system prompt states retrieved text is data, never instructions
      (`prompts/templates.ts` guardrails).
- [ ] Curriculum corpus content itself must be reviewed/approved before
      indexing (#14/#15) — untrusted user-generated content must never enter
      the corpus.

## 4. Data protection (conversations & learning data)

- [x] **[impl]** Usage events carry pseudonymous `userRef` only — no prompt
      content, no raw PII in telemetry.
- [x] **[impl]** Logs contain metadata (capability, model, latency, error
      code) — never prompts, completions, or audio.
- [ ] Conversation history storage: owner-scoped access only, encrypted at
      rest, retention policy defined — **requires app data layer (pending
      phases 1–7)**. Design constraint recorded: conversation payloads must
      never be logged by the AI layer (already true — layer is stateless).
- [ ] Learning-data access controls + audit trail — app layer.
- [ ] Audio uploads (ASR): retention/deletion policy, no training on user
      audio — provider terms to be confirmed per model card.

## 5. Dependency & policy enforcement

- [x] **[impl]** Test asserts `package.json` contains no proprietary AI SDKs
      (openai, @anthropic-ai, google-generativeai, etc.).
- [x] **[impl]** Test asserts every `MODEL_REGISTRY` license is in an approved
      tier (no NC/CPML/research-only) per `licensing-policy.md`.
- [ ] CI dependency audit (`npm audit` + license check) — wire when CI exists.

## 6. Failure safety

- [x] **[impl]** Model failures → typed `AiError` → safe HTTP status; upstream
      detail logged server-side only.
- [x] **[impl]** Timeouts per attempt (default 30 s), bounded retries (default
      2), no unbounded loops.
- [x] **[impl]** Monitoring sink failures swallowed — telemetry can never break
      inference.

## 7. Open items (blocked on app infrastructure)

- AuthN/AuthZ integration for `userRef` derivation (currently client-supplied —
  must be replaced by server-derived identity when auth lands).
- Persistent rate-limit/quota store (Redis/DB).
- Conversation & learning-data encryption/retention at the data layer.
- Admin access controls for usage dashboards (#17).
