/**
 * Corpus index builder (issue #14).
 *
 *   npm run index:corpus -- --corpus evals/corpus/seed.jsonl --out evals/corpus/seed.index.jsonl
 *
 * Embeds every chunk with the configured embedding model (HF_TOKEN required
 * for real vectors; AI_PROVIDER=mock produces deterministic pseudo-vectors
 * for plumbing tests only). Point the service at the output via
 * AI_CORPUS_INDEX=<path>.
 */

import { parseArgs } from 'node:util';
import { createAiService, repoIdFor } from '../src/services/ai/index.js';
import { loadCorpusJsonl, saveIndexJsonl } from '../src/services/ai/corpus/jsonl.js';
import { buildCorpusIndex } from '../src/services/ai/corpus/indexer.js';

const { values } = parseArgs({
  options: {
    corpus: { type: 'string' },
    out: { type: 'string' },
  },
});

if (!values.corpus || !values.out) {
  console.error('usage: build-corpus-index --corpus <in.jsonl> --out <index.jsonl>');
  process.exit(2);
}

const service = createAiService();
if (service.providerName === 'mock') {
  console.warn('WARNING: mock provider — embeddings are pseudo-vectors, not semantic.');
}

const chunks = loadCorpusJsonl(values.corpus);
console.log(`loaded ${chunks.length} chunks; embedding with ${repoIdFor('embedding')}…`);
const indexed = await buildCorpusIndex(
  { provider: service.provider, model: repoIdFor('embedding') },
  chunks,
);
saveIndexJsonl(values.out, indexed);
console.log(`wrote ${indexed.length} indexed chunks → ${values.out}`);
