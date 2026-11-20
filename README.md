# jap-learning-platform

AI-assisted Japanese learning platform (JLPT-focused). French-first UI with English and Arabic support.

Phase 8 — Open-Source AI Integration is implemented as a provider-independent service layer under `src/services/ai/` (EPIC #1). All AI runs on Hugging Face-hosted open-weight models — no proprietary AI APIs.

## Quickstart

```bash
npm install
npm run dev        # http://127.0.0.1:8787 — mock provider, no token needed
```

Set `HF_TOKEN` (server-side only) to use real Hugging Face inference. Without it the service falls back to a deterministic mock provider.

## Endpoints

All POST unless noted. Bodies are Zod-validated; errors are safe/public.

| Route | Capability |
|---|---|
| `/ai/tutor` `/ai/grammar` `/ai/vocabulary` `/ai/quiz` `/ai/writing` | LLM pipelines |
| `/ai/translate` `/ai/ask` `/ai/recommend` | Translation, RAG assistant, study plan |
| `/ai/transcribe` `/ai/synthesize` | ASR + pronunciation, TTS |
| `/ai/embed` | Multilingual embeddings |
| `/ai/report` | Report incorrect AI answers |
| `/ai/usage` (GET) | Usage/cost summary |

## Scripts

- `npm run dev` / `npm start` — dev server (no auth/TLS; not for production)
- `npm test` — Vitest suite
- `npm run typecheck` — strict `tsc --noEmit`
- `npm run eval` — run eval datasets (needs `HF_TOKEN` for real models)
- `npm run index:corpus` — build the curriculum embedding index (`AI_CORPUS_INDEX`)

## Docs

- `docs/ai/model-evaluation.md` — model selection, licenses, benchmarks
- `docs/ai/licensing-policy.md` — license review rules
- `docs/ai/security.md` — tokens, rate limits, prompt-injection boundaries
- `docs/ai/rag.md` — corpus format and retrieval
- `docs/ai/monitoring.md` — usage tracking, cost, alerts
