# jap-learning-platform

AI-assisted Japanese learning platform (JLPT-focused). French-first UI with English and Arabic support.

Phase 8 — Open-Source AI Integration is implemented as a provider-independent service layer under `src/services/ai/` (EPIC #1). All AI runs on Hugging Face-hosted open-weight models — no proprietary AI APIs.

## Quickstart

```bash
npm install
npm run dev        # http://127.0.0.1:8787 — mock provider, no token needed
```

Open http://127.0.0.1:8787 in a browser for the built-in UI (tutor, grammar, quiz, TTS, RAG assistant…).

Set `HF_TOKEN` (server-side only) to use real Hugging Face inference. Without it the service falls back to a deterministic mock provider.

### Free local inference (self-host)

`AI_PROVIDER=ollama` runs open models locally via [Ollama](https://ollama.com) — free, offline, private (the spec's self-host path). Verified setup:

```bash
# install: download ollama-darwin.tgz from ollama.com/download (universal binary)
ollama serve &
ollama pull qwen2.5:3b-instruct   # chat — best JSON compliance on CPU
ollama pull qwen3-embedding:0.6b  # embeddings (1024-dim, fast)
```

`.env.local` (gitignored) already wires this: `AI_PROVIDER=ollama`, `AI_LOCAL_CHAT_MODEL`, `AI_LOCAL_EMBED_MODEL`, optional `AI_LOCAL_BASE_URL`. ASR/TTS throw `NOT_CONFIGURED` on the local provider — use the HF provider for those.

**Hardware note:** verified on a 2013 Intel Xeon (CPU-only, ~6–15 tok/s). Small models handle simple capabilities (translate, embed, tutor) but struggle with the largest JSON schemas (full grammar explanations) — use `qwen3:8b`+ or HF Inference Providers for production quality.

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
