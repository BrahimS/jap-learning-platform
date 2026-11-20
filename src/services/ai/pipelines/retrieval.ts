import { readFileSync } from 'node:fs';
import type { RetrievedContext } from '../prompts/templates.js';
import type { PipelineDeps } from './context.js';
import { runEmbedding } from './capabilities.js';
import { loadCorpusJsonl } from '../corpus/jsonl.js';
import type { CorpusKind } from '../corpus/types.js';

/**
 * Retrieval interface for RAG (§8.5). Pipelines accept a Retriever and get
 * back fenced context + provenance. Issue #14/#15 provide the real corpus;
 * this file ships the provider-agnostic plumbing, an embedding-based
 * retriever over in-memory chunks, and IndexedRetriever over a prebuilt
 * corpus index file (AI_CORPUS_INDEX).
 */

export interface Retriever {
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievedContext>;
}

export const NOOP_RETRIEVER: Retriever = {
  retrieve: async () => ({ sourceIds: [], text: '' }),
};

export interface CorpusChunk {
  id: string;
  text: string;
  /** Precomputed embedding, or computed on first use via the provider. */
  embedding?: number[] | undefined;
  /** Curriculum metadata — populated when chunks come from the corpus index. */
  kind?: CorpusKind | undefined;
  /** Human-reviewed content gets a ranking boost (§8.5 priority rule). */
  reviewed?: boolean | undefined;
  jlptLevel?: string | undefined;
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

/** Score multiplier for human-reviewed chunks — verified content wins ties. */
export const REVIEWED_BOOST = 1.15;

export interface RetrieveOptions {
  topK?: number;
  kinds?: CorpusKind[];
  jlptLevel?: string;
  reviewedOnly?: boolean;
}

function filterChunks(chunks: CorpusChunk[], opts: RetrieveOptions): CorpusChunk[] {
  return chunks.filter((c) => {
    if (opts.kinds && c.kind && !opts.kinds.includes(c.kind)) return false;
    if (opts.jlptLevel && c.jlptLevel && c.jlptLevel !== opts.jlptLevel) return false;
    if (opts.reviewedOnly && c.reviewed !== true) return false;
    return true;
  });
}

function rank(
  chunks: (CorpusChunk & { embedding: number[] })[],
  qv: number[],
  topK: number,
): { c: CorpusChunk & { embedding: number[] }; score: number }[] {
  return chunks
    .map((c) => ({
      c,
      score: cosine(qv, c.embedding) * (c.reviewed ? REVIEWED_BOOST : 1),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

function toContext(
  scored: { c: CorpusChunk; score: number }[],
): RetrievedContext {
  return {
    sourceIds: scored.map((s) => s.c.id),
    text: scored
      .map((s) => `<chunk id="${s.c.id}" kind="${s.c.kind ?? 'unknown'}" reviewed="${s.c.reviewed === true}">\n${s.c.text}\n</chunk>`)
      .join('\n'),
  };
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

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext> {
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

    const eligible = filterChunks(this.chunks, opts);
    const withEmb = eligible.filter(
      (c): c is CorpusChunk & { embedding: number[] } => Array.isArray(c.embedding),
    );
    return toContext(rank(withEmb, qv, opts.topK ?? 5));
  }
}

/**
 * Retriever over a prebuilt corpus index file (issue #14). Chunks already
 * carry embeddings, so only the query is embedded per call — cheap enough
 * for the in-memory scan until a vector DB replaces it.
 *
 * Load with `IndexedRetriever.fromIndex(path, deps)` or pass chunks directly.
 */
export class IndexedRetriever implements Retriever {
  private readonly chunks: CorpusChunk[] = [];

  private constructor(
    private readonly deps: PipelineDeps,
    chunks: CorpusChunk[],
  ) {
    this.chunks.push(...chunks);
  }

  /**
   * Load a corpus/index JSONL file. Rows without embeddings are embedded
   * lazily on first retrieve — pointing at a raw corpus works, just slower.
   */
  static fromIndex(indexPath: string, deps: PipelineDeps): IndexedRetriever {
    return new IndexedRetriever(deps, loadCorpusJsonl(indexPath));
  }

  static fromChunks(
    deps: PipelineDeps,
    chunks: CorpusChunk[],
  ): IndexedRetriever {
    return new IndexedRetriever(deps, chunks);
  }

  get size(): number {
    return this.chunks.length;
  }

  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedContext> {
    if (this.chunks.length === 0) return { sourceIds: [], text: '' };

    // Embed any chunks missing vectors (raw corpus pointed at directly).
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

    const eligible = filterChunks(this.chunks, opts);
    const withEmb = eligible.filter(
      (c): c is CorpusChunk & { embedding: number[] } => Array.isArray(c.embedding),
    );
    if (withEmb.length === 0) return { sourceIds: [], text: '' };
    const [qv] = (await runEmbedding(this.deps, { texts: [query] })).data;
    if (!qv) return { sourceIds: [], text: '' };
    return toContext(rank(withEmb, qv, opts.topK ?? 5));
  }
}
