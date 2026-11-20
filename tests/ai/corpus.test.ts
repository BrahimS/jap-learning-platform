import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IndexedRetriever,
  EmbeddingRetriever,
  REVIEWED_BOOST,
  type CorpusChunk,
} from '../../src/services/ai/pipelines/retrieval.js';
import { loadCorpusJsonl, saveIndexJsonl } from '../../src/services/ai/corpus/jsonl.js';
import { buildCorpusIndex } from '../../src/services/ai/corpus/indexer.js';
import { curriculumChunkSchema, type CurriculumChunk } from '../../src/services/ai/corpus/types.js';
import { MockProvider } from '../../src/services/ai/providers/mock.js';
import type { AiProvider } from '../../src/services/ai/providers/types.js';

/** Deterministic "semantic" embedder for tests: maps keywords to axes. */
function fakeEmbed(text: string): number[] {
  const t = text.toLowerCase();
  return [
    /eat|食|taberu/.test(t) ? 1 : 0,
    /go|行|iku/.test(t) ? 1 : 0,
    /interesting|面白/.test(t) ? 1 : 0,
    /experience|ことがある/.test(t) ? 1 : 0,
    /obligation|ざるを得ない|no choice/.test(t) ? 1 : 0,
    /honorific|humble|敬/.test(t) ? 1 : 0,
    /maybe|perhaps|もしか/.test(t) ? 1 : 0,
    /jlpt|n5/.test(t) ? 1 : 0,
    0.01, // small bias so vectors aren't zero
  ];
}

const fakeProvider: AiProvider = {
  name: 'fake-embed',
  chat: async () => ({ content: '{}' }),
  embed: async (_m, texts) => texts.map(fakeEmbed),
  transcribe: async () => ({ text: '' }),
  synthesize: async () => ({ audio: new Uint8Array(0), mimeType: 'audio/wav' }),
};

const deps = { provider: fakeProvider, model: 'fake-embed-model' };

const CHUNKS: CurriculumChunk[] = [
  { id: 'v-eat', text: '食べる taberu — verb to eat', kind: 'vocabulary', reviewed: true, embedding: fakeEmbed('eat food taberu') },
  { id: 'v-go', text: '行く iku — verb to go', kind: 'vocabulary', reviewed: true, embedding: fakeEmbed('go iku') },
  { id: 'g-exp', text: '〜たことがある — have done before, experience', kind: 'grammar', reviewed: true, embedding: fakeEmbed('experience have done before') },
  { id: 'g-oblig', text: '〜ざるを得ない — have no choice but to', kind: 'grammar', reviewed: false, embedding: fakeEmbed('obligation no choice') },
  { id: 'x-hon', text: '尊敬語 sonkeigo honorific vs 謙譲語 kenjougo humble', kind: 'explanation', reviewed: true, embedding: fakeEmbed('honorific humble') },
];

describe('corpus jsonl', () => {
  it('round-trips validated chunks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    const path = join(dir, 'c.jsonl');
    const rows: CurriculumChunk[] = [
      { id: 'a', kind: 'grammar', text: 'test', reviewed: true, jlptLevel: 'N4' },
      { id: 'b', kind: 'vocabulary', text: 'word', reviewed: false },
    ];
    saveIndexJsonl(path, rows);
    const loaded = loadCorpusJsonl(path);
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.jlptLevel).toBe('N4');
    expect(loaded[1]?.reviewed).toBe(false);
  });

  it('rejects malformed chunks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'));
    const path = join(dir, 'bad.jsonl');
    writeFileSync(path, JSON.stringify({ id: 'x', kind: 'grammar', text: 't', reviewed: 'yes' }) + '\n');
    expect(() => loadCorpusJsonl(path)).toThrow(/Invalid corpus chunk/);
  });

  it('schema requires id/kind/text/reviewed', () => {
    expect(curriculumChunkSchema.safeParse({ id: 'a', kind: 'grammar', text: 't' }).success).toBe(false);
    expect(curriculumChunkSchema.safeParse({ id: 'a', kind: 'bogus', text: 't', reviewed: true }).success).toBe(false);
  });
});

describe('indexer', () => {
  it('embeds all chunks in batches', async () => {
    const chunks = [
      { id: 'a', kind: 'grammar' as const, text: 'one', reviewed: true },
      { id: 'b', kind: 'vocabulary' as const, text: 'two', reviewed: false },
    ];
    const indexed = await buildCorpusIndex(deps, chunks);
    expect(indexed).toHaveLength(2);
    expect(indexed[0]?.embedding).toHaveLength(9);
    expect(indexed[1]?.embedding).toHaveLength(9);
  });
});

describe('IndexedRetriever', () => {
  it('returns relevant chunks for a query', async () => {
    const r = IndexedRetriever.fromChunks(deps, CHUNKS);
    const ctx = await r.retrieve('how do I say have done something before');
    expect(ctx.sourceIds).toContain('g-exp');
    expect(ctx.text).toContain('chunk id="g-exp"');
    expect(ctx.text).toContain('reviewed="true"');
  });

  it('supports kind and jlptLevel filters', async () => {
    const r = IndexedRetriever.fromChunks(deps, CHUNKS);
    const vocabOnly = await r.retrieve('eat go interesting', { kinds: ['vocabulary'] });
    expect(vocabOnly.sourceIds.every((id) => id.startsWith('v-'))).toBe(true);
  });

  it('loads from an index JSONL file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'idx-'));
    const path = join(dir, 'index.jsonl');
    const withEmb = CHUNKS.map((c) => ({ ...c, embedding: c.embedding! }));
    saveIndexJsonl(path, withEmb);
    const r = IndexedRetriever.fromIndex(path, deps);
    expect(r.size).toBe(CHUNKS.length);
    const ctx = await r.retrieve('honorific humble speech');
    expect(ctx.sourceIds[0]).toBe('x-hon');
  });

  it('reviewed boost can outrank an unreviewed near-tie', async () => {
    // Same vector → cosine 1.0; reviewed gets REVIEWED_BOOST.
    const same = fakeEmbed('obligation no choice');
    const r = IndexedRetriever.fromChunks(deps, [
      { id: 'unreviewed', text: 'x', kind: 'grammar', reviewed: false, embedding: same },
      { id: 'reviewed', text: 'x', kind: 'grammar', reviewed: true, embedding: same },
    ]);
    const ctx = await r.retrieve('obligation no choice', { topK: 2 });
    expect(ctx.sourceIds[0]).toBe('reviewed');
    expect(REVIEWED_BOOST).toBeGreaterThan(1);
  });

  it('EmbeddingRetriever still works over in-memory chunks', async () => {
    const r = new EmbeddingRetriever(deps, [
      { id: 'a', text: 'eat food', embedding: fakeEmbed('eat') },
      { id: 'b', text: 'go travel', embedding: fakeEmbed('go') },
    ]);
    const ctx = await r.retrieve('something to eat');
    expect(ctx.sourceIds[0]).toBe('a');
  });
});
