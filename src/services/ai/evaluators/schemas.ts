import { z } from 'zod';
import { AiError } from '../types.js';

/**
 * Zod response schemas (§8.4). Every model output is validated against these
 * before it reaches a feature. Strict shapes keep the provider-independent
 * contract honest — a model change that alters output shape fails loudly here.
 */

const jaText = z.string().min(1);
const translation = z.object({
  fr: z.string().optional(),
  en: z.string().optional(),
  ar: z.string().optional(),
  text: z.string().optional(),
});

export const JLPT_LEVELS = ['N5', 'N4', 'N3', 'N2', 'N1'] as const;
export const jlptLevel = z.enum(JLPT_LEVELS).nullable().optional();

export const tutorReplySchema = z.object({
  /** Japanese reply at the learner's level. */
  replyJa: jaText,
  /** Explanation in the user's selected language. */
  explanation: z.string(),
  /** Grammar/vocabulary corrections, if any. */
  corrections: z
    .array(
      z.object({
        original: z.string(),
        corrected: z.string(),
        explanation: z.string(),
      }),
    )
    .optional(),
  /** Contextual next-step recommendation. */
  nextStep: z.string().optional(),
});
export type TutorReply = z.infer<typeof tutorReplySchema>;

export const grammarExampleSchema = z.object({
  ja: jaText,
  reading: z.string().optional(),
  translation: z.string(),
});

/** Whether the topic is covered by reviewed curriculum content (§8.5/§8.6). */
export const curriculumCoverage = z
  .enum(['covered', 'partial', 'not_covered'])
  .optional();

export const grammarExplanationSchema = z.object({
  structure: z.string(),
  meaning: z.string(),
  usage: z.string(),
  jlptLevel: jlptLevel,
  curriculumCoverage,
  examples: z.array(grammarExampleSchema).min(1),
  /** Side-by-side comparison with a similar structure. */
  comparison: z
    .object({
      with: z.string(),
      difference: z.string(),
    })
    .optional(),
  commonMistakes: z.array(z.string()).optional(),
  exercises: z
    .array(
      z.object({
        prompt: z.string(),
        answer: z.string(),
        explanation: z.string().optional(),
      }),
    )
    .optional(),
});
export type GrammarExplanation = z.infer<typeof grammarExplanationSchema>;

export const vocabularyEntrySchema = z.object({
  word: jaText,
  reading: z.string(),
  meaning: z.string(),
  examples: z.array(
    z.object({ ja: jaText, translation: z.string() }),
  ).min(1),
  usage: z.string().optional(),
  synonyms: z.array(z.string()).optional(),
  antonyms: z.array(z.string()).optional(),
  jlptLevel: jlptLevel,
  curriculumCoverage,
});
export type VocabularyEntry = z.infer<typeof vocabularyEntrySchema>;

export const quizQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('multiple_choice'),
    prompt: z.string(),
    options: z.array(z.string()).min(2),
    answer: z.string(),
    explanation: z.string(),
    jlptLevel: jlptLevel,
  }),
  z.object({
    type: z.literal('sentence_completion'),
    prompt: z.string(),
    answer: z.string(),
    explanation: z.string(),
    jlptLevel: jlptLevel,
  }),
  z.object({
    type: z.literal('translation'),
    prompt: z.string(),
    direction: z.enum(['ja_to_native', 'native_to_ja']),
    answer: z.string(),
    explanation: z.string(),
    jlptLevel: jlptLevel,
  }),
  z.object({
    type: z.literal('reading_comprehension'),
    passage: z.string(),
    prompt: z.string(),
    options: z.array(z.string()).min(2),
    answer: z.string(),
    explanation: z.string(),
    jlptLevel: jlptLevel,
  }),
  z.object({
    type: z.literal('jlpt_style'),
    prompt: z.string(),
    options: z.array(z.string()).min(2).optional(),
    answer: z.string(),
    explanation: z.string(),
    jlptLevel: z.enum(JLPT_LEVELS),
  }),
]);
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

export const quizSchema = z.object({
  questions: z.array(quizQuestionSchema).min(1),
});
export type Quiz = z.infer<typeof quizSchema>;

export const writingCorrectionSchema = z.object({
  original: z.string(),
  corrections: z.array(
    z.object({
      /** Offending span or description of the error location. */
      issue: z.string(),
      category: z.enum(['grammar', 'particles', 'conjugation', 'word_choice', 'style', 'other']),
      explanation: z.string(),
      suggestion: z.string(),
    }),
  ),
  improved: z.string(),
  score: z.number().min(0).max(100).optional(),
});
export type WritingCorrection = z.infer<typeof writingCorrectionSchema>;

export const transcriptSchema = z.object({
  text: z.string(),
  language: z.string().optional(),
});
export type Transcript = z.infer<typeof transcriptSchema>;

export const translationResultSchema = z.object({
  translation: z.string().min(1),
  /** Back-translation for verification, when the model provides it. */
  backTranslation: z.string().optional(),
  notes: z.string().optional(),
});
export type TranslationResult = z.infer<typeof translationResultSchema>;

/** RAG learning assistant answer (§8.5; issue #15). */
export const assistantAnswerSchema = z.object({
  /** Answer in the user's explanation language; Japanese examples inline. */
  answer: z.string().min(1),
  /** Whether retrieved curriculum content covers the question — required here. */
  curriculumCoverage: z.enum(['covered', 'partial', 'not_covered']),
  /** Optional follow-up suggestion tied to curriculum. */
  followUp: z.string().optional(),
});
export type AssistantAnswer = z.infer<typeof assistantAnswerSchema>;

/**
 * Parse a model's text output as JSON and validate against a schema.
 * Strips markdown code fences, throws VALIDATION_ERROR on failure.
 */
export function parseModelJson<S extends z.ZodType>(
  raw: string,
  schema: S,
  context: string,
): z.infer<S> {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (cause) {
    throw new AiError('VALIDATION_ERROR', `Model output is not valid JSON (${context})`, {
      cause,
      detail: cleaned.slice(0, 300),
    });
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AiError('VALIDATION_ERROR', `Model output failed schema validation (${context})`, {
      detail: result.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  return result.data;
}
