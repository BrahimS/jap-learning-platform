import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { curriculumChunkSchema, type CurriculumChunk } from './types.js';

/**
 * JSONL corpus + index persistence (issue #14).
 * - Corpus file: one CurriculumChunk per line (embedding omitted).
 * - Index file: same rows with `embedding` populated by the indexer.
 * Both are validated through the Zod schema on load — malformed rows fail loudly.
 */

export function loadCorpusJsonl(path: string): CurriculumChunk[] {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'))
    .map((l, i) => {
      try {
        return curriculumChunkSchema.parse(JSON.parse(l));
      } catch (e) {
        throw new Error(`Invalid corpus chunk at ${path}:${i + 1}: ${(e as Error).message}`);
      }
    });
}

export function saveIndexJsonl(path: string, chunks: CurriculumChunk[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = chunks.map((c) => JSON.stringify(curriculumChunkSchema.parse(c)));
  writeFileSync(path, lines.join('\n') + (lines.length > 0 ? '\n' : ''));
}
