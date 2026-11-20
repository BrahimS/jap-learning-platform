import { describe, expect, it } from 'vitest';
import {
  JLPT_LEVELS,
  grammarExplanationSchema,
  parseModelJson,
  quizSchema,
  tutorReplySchema,
} from '../../src/services/ai/evaluators/schemas.js';
import { AiError } from '../../src/services/ai/types.js';

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    const out = parseModelJson('{"replyJa":"こんにちは","explanation":"hello"}', tutorReplySchema, 't');
    expect(out.replyJa).toBe('こんにちは');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"replyJa":"はい","explanation":"yes"}\n```';
    const out = parseModelJson(raw, tutorReplySchema, 't');
    expect(out.explanation).toBe('yes');
  });

  it('throws VALIDATION_ERROR on non-JSON', () => {
    expect(() => parseModelJson('not json', tutorReplySchema, 't')).toThrowError(AiError);
    try {
      parseModelJson('not json', tutorReplySchema, 't');
    } catch (e) {
      expect((e as AiError).code).toBe('VALIDATION_ERROR');
    }
  });

  it('throws VALIDATION_ERROR on schema mismatch', () => {
    try {
      parseModelJson('{"wrong":1}', tutorReplySchema, 't');
      expect.unreachable();
    } catch (e) {
      expect((e as AiError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('quizSchema', () => {
  it('accepts each question type', () => {
    const quiz = {
      questions: [
        {
          type: 'multiple_choice',
          prompt: 'りんご means?',
          options: ['apple', 'banana', 'grape', 'orange'],
          answer: 'apple',
          explanation: 'fruit',
          jlptLevel: 'N5',
        },
        {
          type: 'sentence_completion',
          prompt: '私は ___ です。',
          answer: '学生',
          explanation: 'student',
          jlptLevel: null,
        },
        {
          type: 'translation',
          prompt: 'Translate: 食べる',
          direction: 'ja_to_native',
          answer: 'to eat',
          explanation: 'verb',
          jlptLevel: 'N4',
        },
        {
          type: 'reading_comprehension',
          passage: '田中さんは毎朝コーヒーを飲みます。',
          prompt: 'What does Tanaka drink?',
          options: ['tea', 'coffee', 'juice', 'water'],
          answer: 'coffee',
          explanation: 'コーヒー = coffee',
        },
        {
          type: 'jlpt_style',
          prompt: 'Select the correct particle: 私 ___ 学生です',
          options: ['が', 'を', 'に', 'で'],
          answer: 'は',
          explanation: 'topic marker',
          jlptLevel: 'N5',
        },
      ],
    };
    expect(quizSchema.safeParse(quiz).success).toBe(true);
  });

  it('rejects invalid JLPT level', () => {
    const bad = {
      questions: [
        {
          type: 'multiple_choice',
          prompt: 'q',
          options: ['a', 'b'],
          answer: 'a',
          explanation: 'e',
          jlptLevel: 'N0',
        },
      ],
    };
    expect(quizSchema.safeParse(bad).success).toBe(false);
    expect(JLPT_LEVELS).toContain('N1');
  });

  it('rejects MCQ without enough options', () => {
    const bad = {
      questions: [
        { type: 'multiple_choice', prompt: 'q', options: ['only'], answer: 'only', explanation: 'e' },
      ],
    };
    expect(quizSchema.safeParse(bad).success).toBe(false);
  });
});

describe('grammarExplanationSchema', () => {
  it('requires at least one example', () => {
    const bad = { structure: '〜たことがある', meaning: 'm', usage: 'u', examples: [] };
    expect(grammarExplanationSchema.safeParse(bad).success).toBe(false);
  });
});
