# AI Technology & Licensing Policy

Issue: #3 · Spec: §8.1, §8.7 · Epic: #1 (EPIC 18 — Open-Source AI Integration)

This policy is mandatory for all AI functionality in this platform. It exists to keep the
product legally clean, commercially viable, provider-independent, and auditable.

## 1. Approved model registry

- **Hugging Face Hub is the only approved model registry.** No models from other hubs,
  paper-only releases, or anonymous mirrors.
- Every model must be recorded in the centralized model registry
  (`src/services/ai/models/` once the integration layer lands — see issue #4) with:
  repo ID, revision/commit hash pinned, license, intended capability, and approval reference.
- Model identifiers and configuration live in **one place**. Feature code never hardcodes
  a model ID or provider endpoint.

## 2. License review checklist (per model, before integration)

A model is approved only after reviewing **all** of the following. HF hosting a model does
**not** make it open source.

- [ ] **Weights license** — read the license named in the model card (`license:` tag AND the
      LICENSE file / card text; they can differ).
- [ ] **Code license** — inference code, tokenizer, and preprocessing dependencies.
- [ ] **Usage restrictions** — acceptable-use policies, field-of-use limits, redistribution
      terms, attribution requirements.
- [ ] **Commercial suitability** — explicit permission for commercial use, or a license whose
      terms permit it (Apache-2.0, MIT, BSD, Llama Community License, Gemma Terms of Use with
      their conditions noted).
- [ ] **Derivative/share-alike clauses** — note SA obligations (e.g. CC-BY-SA) even if
      commercial use is allowed; prefer unencumbered licenses.
- [ ] **Dataset provenance** — for fine-tuned models, check training-data licenses too.

### License tiers

| Tier | Examples | Rule |
|---|---|---|
| Preferred | Apache-2.0, MIT, BSD | Use freely; record license in registry |
| Conditional | Llama Community, Gemma ToU, Falcon LLM | Allowed; document restrictions (naming, MAU thresholds, use policy) in registry |
| Rejected | CC-BY-NC*, CPML, proprietary API weights, "research only" | Never integrate |

*Any "NC" (non-commercial) clause is an automatic rejection for this commercial product.

## 3. Prohibited technologies

- **Never** integrate proprietary commercial AI APIs: OpenAI, Anthropic, Gemini, or any
  equivalent hosted service.
- **Never** add SDKs/packages whose primary purpose is calling such APIs.
- No "temporary" exceptions — if a capability lacks an approved open model, the capability
  ships disabled or waits for an approved model.

## 4. Architecture rules

- **Provider-independent**: the AI service layer (`src/services/ai/`) abstracts providers.
  Feature code calls pipelines, not HF APIs directly. Swapping a model or provider is a
  config/registry change, not a feature rewrite (§8.7).
- **Server-side only**: HF access tokens, provider keys, and all inference calls live on
  the server. Tokens must never appear in frontend bundles, client env vars, logs, or commits.
- **Serving options** (any may be used, all are HF-hosted artifacts):
  - HF Inference Providers (serverless router) — default for supported models.
  - HF Inference Endpoints (dedicated deployment) — for latency-sensitive or unsupported tasks.
  - Self-hosted open weights — kept as a first-class option for cost optimization and data
    control (§8.4). Self-hosting does not change license obligations.
- **Self-hosted ≠ license-free**: running weights yourself does not remove license duties
  (attribution, use restrictions, share-alike).

## 5. Change management

- Adding or replacing a model = update registry entry + re-run license checklist + re-run
  the evaluation harness (#16) on affected capabilities.
- License or terms-of-service changes upstream must be monitored; a license change to a
  rejected tier triggers removal or replacement.
- This policy and the registry are reviewed at each epic/phase boundary.

## 6. Enforcement

- PR checklist item for any change touching `src/services/ai/` or adding AI dependencies:
  *"License reviewed per docs/ai/licensing-policy.md; model registered."*
- Dependency audits flag AI SDKs that phone home to proprietary APIs.
- The evaluation framework (#16) tags every model response with the registry ID used, so
  outputs are traceable to a license-approved model.

## 7. Relationship to other documents

- `docs/ai/model-evaluation.md` (#2) — per-model findings feeding this policy.
- Issue #14/#15 security & RAG issues implement the token-handling and data-protection
  rules referenced above.
