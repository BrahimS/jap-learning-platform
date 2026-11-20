import type { Quiz, QuizQuestion } from '../evaluators/schemas.js';
import { JLPT_LEVELS } from '../evaluators/schemas.js';

/**
 * Quiz answer validation (§8.6; issue #11). Runs AFTER schema validation —
 * deterministic checks that every served question has a verifiable answer:
 * MC/reading answers must be one of the options, completion/translation
 * answers must be non-trivial, JLPT tags must be real curriculum levels.
 * Invalid questions are dropped before serving; if none survive, the
 * pipeline throws rather than emit unverified content.
 */

export interface RejectedQuestion {
  index: number;
  type: string;
  reason: string;
}

function hasOptions(q: QuizQuestion): q is QuizQuestion & { options: string[] } {
  return 'options' in q && Array.isArray(q.options);
}

export function validateQuestion(q: QuizQuestion, index: number): RejectedQuestion | undefined {
  const reject = (reason: string) => ({ index, type: q.type, reason });

  // JLPT level must be a real curriculum level when present (§8.6).
  if (q.jlptLevel != null && !(JLPT_LEVELS as readonly string[]).includes(q.jlptLevel)) {
    return reject(`invalid jlptLevel "${q.jlptLevel}"`);
  }

  if (hasOptions(q)) {
    if (!q.options.includes(q.answer)) {
      return reject(`answer "${q.answer}" is not among the options`);
    }
    if (new Set(q.options).size !== q.options.length) {
      return reject('duplicate options');
    }
  }

  switch (q.type) {
    case 'sentence_completion':
      if (q.answer.trim().length === 0) return reject('empty answer');
      if (q.answer.trim() === q.prompt.trim()) return reject('answer equals prompt');
      break;
    case 'translation':
      if (q.answer.trim().length === 0) return reject('empty answer');
      break;
    case 'jlpt_style':
      if (q.answer.trim().length === 0) return reject('empty answer');
      break;
    default:
      break;
  }
  return undefined;
}

export function validateQuiz(quiz: Quiz): {
  questions: QuizQuestion[];
  rejected: RejectedQuestion[];
} {
  const questions: QuizQuestion[] = [];
  const rejected: RejectedQuestion[] = [];
  quiz.questions.forEach((q, i) => {
    const bad = validateQuestion(q, i);
    if (bad) rejected.push(bad);
    else questions.push(q);
  });
  return { questions, rejected };
}
