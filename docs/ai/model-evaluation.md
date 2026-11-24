# AI Model Evaluation — Phase 8 (EPIC #1)

Issue: #2 · Spec: §8.1, §8.3, §8.7

Status: **Approved — implementation merged.** This was the §8.8 gate document; all
sub-issues shipped against these selections. License fields verified against the Hugging
Face Hub API on 2026-11-20. Quantities marked *(est.)* remain engineering estimates —
the benchmark plan in §6 is partially executed (see §7).

## 0. Self-hosted inference option (added 2026-11-24, issue #41)

`AI_PROVIDER=ollama` runs the same pipelines on local open weights — free, offline,
no HF billing. Verified on CPU-only hardware (Intel Xeon, no GPU):

- Chat: `qwen2.5:3b-instruct` (Ollama) — translate ✓, embed ✓; complex JSON schemas
  (full grammar explanations) exceed reliable 3B-class CPU output — expect validation
  failures, which the pipeline surfaces honestly as `VALIDATION_ERROR`.
- Embeddings: `qwen3-embedding:0.6b` — 1024-dim, ~2s/batch on CPU.
- ASR/TTS: not available locally — `NOT_CONFIGURED`; needs whisper.cpp / Piper sidecars
  or the HF provider.

For production quality use HF Inference Providers (needs the token's Inference
Providers permission) or a larger self-hosted model on GPU.

## 1. Selection principles

- Hugging Face Hub is the only approved registry (§8.1).
- License reviewed per model: weights, code, license file, usage restrictions.
- **Rejected on license grounds regardless of quality:** anything CC-BY-NC / NC-SA,
  CPML, or otherwise non-commercial. HF hosting ≠ open source.
- Provider independence: picks must be runnable via HF Inference Providers *or* a dedicated
  HF Inference Endpoint *or* self-hosted — never a proprietary API.

## 2. Selected models

### 2.1 Instruction-tuned LLM (tutor, grammar, vocabulary, quiz, writing, recommendations)

| Field | Value |
|---|---|
| HF repo ID | `Qwen/Qwen3-32B` (quality tier) · `Qwen/Qwen3-8B` (cost tier) |
| Architecture | Dense decoder-only transformer, hybrid thinking/non-thinking modes |
| License | **Apache-2.0** (verified via HF API) |
| Languages | 119 languages/dialects incl. Japanese, French, English, Arabic (MSA + dialects) — per Qwen3 tech report |
| Size | 32B (~65 GB bf16) / 8B (~16 GB bf16); GGUF quants available |
| Hardware | 32B: 1× A100-80G or 2× consumer GPUs quantized; 8B: single 24 GB GPU or CPU-offload *(est.)* |
| Inference latency | *(est.)* 8B: ~20–60 tok/s on A10G-class GPU; 32B: ~8–25 tok/s; thinking mode adds latency — use non-thinking for chat |
| Operating cost | HF Inference Providers (Together/Fireworks-class): ~$0.10–0.60 /M tokens depending on provider & tier *(est.)*; dedicated endpoint ~$1–3/hr GPU |
| Evaluation results | Pending benchmark (§6). Qwen3 reports SOTA open-weights results on multilingual benchmarks; Japanese + Arabic coverage confirmed in model card |

Alternates: `Qwen/Qwen3-30B-A3B-Instruct-2507` (MoE, Apache-2.0, better latency/quality ratio);
`llm-jp/llm-jp-3-7.2b-instruct` (Apache-2.0, Japanese-specialist, weaker FR/AR — candidate for
Japanese-only drills); `meta-llama/Llama-3.1-8B-Instruct` (Llama 3.1 Community License —
commercial OK but with restrictions, kept as fallback only).

### 2.2 Translation (JA ↔ FR/EN/AR explanations and back-translation checks)

| Field | Value |
|---|---|
| HF repo ID | `google/madlad400-3b-mt` (default) · `google/madlad400-10b-mt` (quality tier) |
| Architecture | Encoder-decoder Transformer (M2M-style), 400+ languages |
| License | **Apache-2.0** (verified via HF API) |
| Languages | ja, en, fr, ar all supported |
| Size | 3B (~12 GB) / 10B (~40 GB) |
| Hardware | 3B: single T4/A10G; 10B: A100-class *(est.)* |
| Inference latency | *(est.)* 3B: <1 s/sentence on A10G |
| Operating cost | Low — small model, short sequences *(est.)* cents/1k translations on serverless GPU |
| Evaluation results | Pending benchmark (§6). MADLAD-400 is Google's successor to mT5/M2M lineage; strong documented JA↔EN quality |

### 2.3 Speech recognition (Japanese ASR)

| Field | Value |
|---|---|
| HF repo ID | `openai/whisper-large-v3-turbo` (default) · `reazon-research/reazonspeech-nemo-v2` (Japanese-specialist alternate) |
| Architecture | Whisper: encoder-decoder transformer; ReazonSpeech: NVIDIA NeMo FastConformer |
| License | whisper-large-v3-turbo: **MIT** · reazonspeech-nemo-v2: **Apache-2.0** (both verified via HF API) |
| Languages | Whisper: 99 languages incl. Japanese; ReazonSpeech: Japanese only |
| Size | turbo: ~1.6 GB; reazonspeech-nemo-v2: ~1.1 GB |
| Hardware | CPU-capable for turbo with `faster-whisper` CTranslate2; GPU recommended for interactive latency |
| Inference latency | *(est.)* turbo: ~0.3–1.0× realtime on CPU, <0.2× on T4 |
| Operating cost | Very low; CPU inference viable *(est.)* |
| Evaluation results | Pending benchmark on learner speech (§6) — clean-speech WER is well documented; accented/learner Japanese is the open question |

### 2.4 Speech synthesis (Japanese TTS)

| Field | Value |
|---|---|
| HF repo ID | `Aratako/MioTTS-0.6B` (default) · `Aratako/MioTTS-1.7B` (quality tier) · `Aratako/Irodori-TTS-v4.1-Small` (alternate, MIT) |
| Architecture | LLM-based TTS over neural audio codec (MioCodec-25Hz-24kHz); Irodori: 500M Japanese TTS |
| License | MioTTS-0.6B / MioTTS-1.7B: **Apache-2.0** (Qwen3 base) · Irodori-TTS-v4.1-Small: **MIT** (all verified via HF API) |
| Languages | English + Japanese (MioTTS); Japanese (Irodori) |
| Size | 0.6B (~1.2 GB bf16, 408 MB Q4_K_M GGUF) / 1.7B (~3.5 GB) |
| Hardware | Consumer GPU or CPU via GGUF/llama.cpp-class runtime; designed for edge *(est.)* |
| Inference latency | RTF 0.055–0.065 (0.6B) / 0.10–0.11 (1.7B) measured by author on RTX 5090 — real-time factor, lower is better |
| Operating cost | Very low — sub-realtime on modest GPU; caching recommended for repeated phrases |
| Evaluation results | Author-reported RTF above; **intelligibility/prosody for learners pending our benchmark (§6)**. Caveat: very recent models (Irodori v4.1: 0 downloads/mo) — validate stability before committing |

Note: XTTS-v2 (CPML) and fish-speech/OpenAudio S1 (CC-BY-NC-SA) were **rejected — non-commercial licenses**.

### 2.5 Multilingual embeddings (semantic search / RAG)

| Field | Value |
|---|---|
| HF repo ID | `Qwen/Qwen3-Embedding-0.6B` (default) · `Qwen/Qwen3-Embedding-4B` or `BAAI/bge-m3` (quality alternates) |
| Architecture | Qwen3-Embedding: decoder LLM as embedder (last-token pooling, MRL); bge-m3: XLM-RoBERTa-style dense+sparse+multi-vector |
| License | Qwen3-Embedding: **Apache-2.0** · bge-m3 / multilingual-e5-large: **MIT** (verified via HF API) |
| Languages | 100+ incl. Japanese, French, English, Arabic |
| Size | 0.6B (~1.2 GB) / 4B (~8 GB) / bge-m3 (~2.3 GB) |
| Hardware | 0.6B: CPU viable, GPU preferred; 4B: GPU recommended *(est.)* |
| Inference latency | *(est.)* 0.6B: <50 ms/query on CPU-class hardware for short texts |
| Operating cost | Negligible at curriculum scale (thousands of chunks) |
| Evaluation results | Qwen3-Embedding tops MTEB multilingual retrieval among open models (published); pending our retrieval benchmark (§6) |

### 2.6 Pronunciation feedback (ASR + phonetic analysis)

Pipeline, not a single model:

| Component | Choice | License | Notes |
|---|---|---|---|
| Transcription | whisper-large-v3-turbo or reazonspeech-nemo-v2 (§2.3) | MIT / Apache-2.0 | Word/segment timestamps for alignment |
| G2P (text → phonemes/mora) | `pyopenjtalk` + UniDic, or `fugashi`+unidic | Permissive (BSD-style) — **verify exact terms at integration** | Japanese accent/mora handling |
| Forced alignment / scoring | Whisper timestamps vs. G2P phoneme sequence; optional Montreal Forced Aligner (MFA) Japanese model | MFA: MIT (code); acoustic models per-dictionary — **verify** | Fallback: character/mora overlap heuristics |

`facebook/mms-1b-all` (CC-BY-NC) was evaluated for phoneme recognition and **rejected — non-commercial**.
This is the least mature category; a spike task is required before committing (§6).

## 3. Rejected candidates (license)

| Model | License | Reason rejected |
|---|---|---|
| `facebook/nllb-200-*` | CC-BY-NC-4.0 | Non-commercial |
| `Unbabel/TowerInstruct-7B-v0.2` | CC-BY-NC-4.0 | Non-commercial |
| `jinaai/jina-embeddings-v3` | CC-BY-NC-4.0 | Non-commercial (despite strong multilingual scores) |
| `coqui/XTTS-v2` | CPML (custom, non-commercial) | Non-commercial |
| `fishaudio/fish-speech-1.5`, `OpenAudio/S1*` | CC-BY-NC-SA-4.0 | Non-commercial + share-alike |
| `facebook/mms-1b-all` | CC-BY-NC-4.0 | Non-commercial |

## 4. Infrastructure fit (§8.4)

- **HF Inference Providers** (serverless router): expected to cover LLM (Qwen3), embeddings
  (Qwen3-Embedding/bge-m3), translation (MADLAD), ASR (whisper). Provider availability per model
  to be confirmed at integration time — the registry must not hardcode a provider.
- **HF Inference Endpoints / self-host**: required for TTS (MioTTS/Irodori are too new for
  provider catalogs) and possibly ReazonSpeech. This is also the self-hosting path §8.4 requires
  keeping open.
- All inference server-side only; HF token in env, never in client bundles.

## 5. Decision summary

| Capability | Primary | Alternate | License |
|---|---|---|---|
| Tutor/grammar/vocab/quiz/writing/recs LLM | Qwen3-32B | Qwen3-8B (cost), Qwen3-30B-A3B (latency), llm-jp-3 (JA-only) | Apache-2.0 |
| Translation | madlad400-3b-mt | madlad400-10b-mt | Apache-2.0 |
| ASR | whisper-large-v3-turbo | reazonspeech-nemo-v2 | MIT / Apache-2.0 |
| TTS | MioTTS-0.6B | MioTTS-1.7B, Irodori-TTS-v4.1-Small | Apache-2.0 / MIT |
| Embeddings | Qwen3-Embedding-0.6B | Qwen3-Embedding-4B, bge-m3 | Apache-2.0 / MIT |
| Pronunciation | §2.6 pipeline | — | mixed, verify at integration |

## 6. Benchmark plan (before sign-off)

1. Japanese generation quality: 50-prompt eval set (grammar explanations, corrections,
   tutoring dialogue) scored for accuracy/naturalness — human + LLM-judge with rubric.
2. FR/EN/AR explanation quality: same prompts, translated explanations rated by
   native-quality rubric; AR is the highest-risk language — weighted accordingly.
3. ASR: WER on ~1h of learner Japanese speech (read + spontaneous), accented speakers.
4. TTS: MOS-style intelligibility check on 100 curriculum sentences; measure RTF on target
   hardware (not just RTX 5090).
5. Embeddings: retrieval recall@5 on ~200 learner queries against curriculum corpus.
6. Pronunciation: spike — validate G2P+alignment pipeline on minimal pairs (e.g., し/つ,
   long vowels) before committing architecture.
7. Cost/latency: measure p50/p95 on chosen serving path; record in this doc.

Results will be appended here and to `docs/ai/` before the gate is considered passed.

## 7. First real results (2026-11-24, local self-host)

Provider: Ollama on CPU-only Intel Xeon (no GPU) — `qwen2.5:3b-instruct` chat,
`qwen3-embedding:0.6b` embeddings. Dataset: `translation` (9 cases).

- Result: **5/9 (55.6%)** — below the 80% gate, as expected for a 3B CPU model vs the
  Qwen3-32B target. Failures are honest quality signal: Arabic renderings differed
  lexically, one "student" case missed, one JSON-parse error.
- Latency: ~8s/translation, ~2s embedding batch — usable for dev, not production.
- Conclusion: self-host path works mechanically end-to-end; production quality still
  requires HF Inference Providers or GPU self-hosting per §6 benchmarks.
