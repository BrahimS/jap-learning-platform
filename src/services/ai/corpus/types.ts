import { z } from 'zod';
import { JLPT_LEVELS } from '../evaluators/schemas.js';

/**
 * Curriculum corpus model (§8.5; issue #14).
 *
 * The corpus is the ONLY content RAG may ground answers in: grammar lessons,
 * vocabulary entries, kanji, JLPT materials, approved explanations. Every
 * chunk declares whether it is `reviewed` (human-verified educational
 * content) or AI-generated draft — reviewed content is prioritized in
 * retrieval and is the only kind allowed to set authoritative JLPT levels.
 */

export const CORPUS_KINDS = [
  'grammar',
  'vocabulary',
  'kanji',
  'jlpt',
  'explanation',
] as const;
export type CorpusKind = (typeof CORPUS_KINDS)[number];

export const curriculumChunkSchema = z.object({
  /** Stable resource ID — cited as provenance in AI responses. */
  id: z.string().min(1).max(200),
  kind: z.enum(CORPUS_KINDS),
  /** Searchable text: lesson content, example sentences, definitions. */
  text: z.string().min(1).max(8000),
  /** Human-reviewed educational content vs. AI-generated draft. */
  reviewed: z.boolean(),
  jlptLevel: z.enum(JLPT_LEVELS).optional(),
  /** BCP-47-ish language tag of the text content (mostly 'ja'). */
  lang: z.string().max(10).optional(),
  /** Optional structured payload (e.g. vocab readings, lesson metadata). */
  meta: z.record(z.string(), z.unknown()).optional(),
  /** Filled by the indexer — never authored by hand. */
  embedding: z.array(z.number()).optional(),
});
export type CurriculumChunk = z.infer<typeof curriculumChunkSchema>;
