import type { PipelineDeps } from '../pipelines/context.js';
import { runEmbedding } from '../pipelines/capabilities.js';
import type { CurriculumChunk } from './types.js';

/**
 * Corpus indexer (issue #14). Embeds every chunk's text with the configured
 * embedding model and returns chunks with `embedding` populated — persist
 * with saveIndexJsonl(). Batches to stay under provider payload limits.
 */

const BATCH_SIZE = 32;

export async function buildCorpusIndex(
  deps: PipelineDeps,
  chunks: CurriculumChunk[],
): Promise<CurriculumChunk[]> {
  const out: CurriculumChunk[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = (
      await runEmbedding(deps, { texts: batch.map((c) => c.text) })
    ).data;
    batch.forEach((c, j) => {
      const v = vectors[j];
      out.push(v ? { ...c, embedding: v } : c);
    });
  }
  return out;
}
