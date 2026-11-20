# RAG: Corpus, Indexing & Retrieval (issues #14, #15)

Spec: §8.5 (retrieval-augmented generation), §8.3 (embeddings).

## Corpus model

`src/services/ai/corpus/types.ts` — `CurriculumChunk` (JSONL, Zod-validated):

| field | meaning |
|---|---|
| `id` | stable resource ID — cited as provenance in AI responses |
| `kind` | `grammar` \| `vocabulary` \| `kanji` \| `jlpt` \| `explanation` |
| `text` | searchable content (lesson text, examples, definitions) |
| `reviewed` | **true = human-verified educational content; false = AI draft** |
| `jlptLevel` | optional N5–N1 tag |
| `lang`, `meta`, `embedding` | optional metadata / indexer output |

Rules (§8.5/§8.6):
- Only corpus content may ground answers — the model abstains
  (`curriculumCoverage: not_covered`) rather than inventing rules.
- `reviewed: true` chunks get a ranking boost (`REVIEWED_BOOST = 1.15`) so
  verified content wins near-ties; only reviewed chunks may carry
  authoritative JLPT levels.
- Retrieved text is fenced in `<curriculum>` tags and declared non-authoritative
  in every system prompt (`prompts/templates.ts` guardrails).

## Indexing

```
npm run index:corpus -- --corpus <chunks.jsonl> --out <index.jsonl>
```

`scripts/build-corpus-index.ts` embeds every chunk via the configured
embedding model (`Qwen/Qwen3-Embedding-0.6B` default, registry key
`embedding`) and writes the index file. Batches of 32. `HF_TOKEN` required for
real vectors; `AI_PROVIDER=mock` produces pseudo-vectors for plumbing tests
only — never ship a mock-built index.

Seed example: `evals/corpus/seed.jsonl` (11 hand-reviewed JLPT N5–N1 entries
covering grammar/vocab/kanji/JLPT/explanations — replace with the real
curriculum export when phases 1–7 land).

## Serving retrieval

Set `AI_CORPUS_INDEX=/path/to/index.jsonl` — `createAiService` loads it into
an `IndexedRetriever` (missing/malformed index → warn + no-op retriever,
never fatal). Every pipeline (`tutor`, `grammar`, `vocabulary`, `quiz`,
`writing`) calls `retriever.retrieve()` and attaches
`provenance.sources` = retrieved chunk IDs; `grounded: true` when sources
exist.

`IndexedRetriever` only embeds the *query* per call (chunks are pre-embedded);
raw corpus files also work — unembedded chunks embed lazily on first call.
Filters: `retrieve(query, { topK, kinds, jlptLevel, reviewedOnly })`.

At scale replace the in-memory scan with pgvector/Qdrant behind the same
`Retriever` interface — feature code is unaffected (§8.7).

## Retrieval evaluation

`evals/datasets/retrieval.jsonl` + `npm run eval` — cross-lingual queries
(EN/FR/AR → Japanese content) checked by `anySourceIn`. Requires
`AI_CORPUS_INDEX` pointing at a real-embedding index; mock embeddings make
scores meaningless (documented in the runner).

## Current status

- ✅ Corpus schema, JSONL IO, index builder, IndexedRetriever, service wiring,
  retrieval eval kind + dataset, seed corpus.
- ⏳ Real-curriculum corpus (needs phases 1–7 data), real-embedding quality
  benchmark (needs HF_TOKEN), vector-DB backend at scale.
