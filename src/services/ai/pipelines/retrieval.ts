import type { RetrievedContext } from '../prompts/templates.js';
import type { PipelineDeps } from './context.js';
import { runEmbedding } from './capabilities.js';

/**
 * Retrieval interface for RAG (§8.5). Pipelines accept a Retriever and get
 * back fenced context + provenance. Issue #14/#15 provide the real corpus;
 * this file ships the provider-agnostic plumbing and an embedding-based
 * retriever that works over any in-memory chunk collection.
 */

export interface Retriever {
  retrieve(query: string): Promise<RetrievedContext>;
}

export const NOOP_RETRIEVER: Retriever = {
  retrieve: async () => ({ sourceIds: [], text: '' }),
};

export interface CorpusChunk {
  id: string;
  text: string;
  /** Precomputed embedding, or computed on first use via the provider. */
  embedding?: number[];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Embedding-based retriever over an in-memory corpus. For production scale
 * replace the scan with a vector index (pgvector, Qdrant, etc.) — the
 * Retriever interface stays the same.
 */
export class EmbeddingRetriever implements Retriever {
  private readonly chunks: CorpusChunk[] = [];

  constructor(
    private readonly deps: PipelineDeps,
    seed: CorpusChunk[] = [],
  ) {
    this.chunks.push(...seed);
  }

  addChunks(chunks: CorpusChunk[]): void {
    this.chunks.push(...chunks);
  }

  async retrieve(query: string, topK = 5): Promise<RetrievedContext> {
    if (this.chunks.length === 0) return { sourceIds: [], text: '' };

    // Embed query + any chunks missing embeddings.
    const missing = this.chunks.filter((c) => !c.embedding);
    if (missing.length > 0) {
      const vectors = (await runEmbedding(this.deps, {
        texts: missing.map((c) => c.text),
      })).data;
      missing.forEach((c, i) => {
        const v = vectors[i];
        if (v) c.embedding = v;
      });
    }
    const [qv] = (await runEmbedding(this.deps, { texts: [query] })).data;
    if (!qv) return { sourceIds: [], text: '' };

    const scored = this.chunks
      .filter((c): c is CorpusChunk & { embedding: number[] } => Array.isArray(c.embedding))
      .map((c) => ({ c, score: cosine(qv, c.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return {
      sourceIds: scored.map((s) => s.c.id),
      text: scored.map((s) => `<chunk id="${s.c.id}">\n${s.c.text}\n</chunk>`).join('\n'),
    };
  }
}
