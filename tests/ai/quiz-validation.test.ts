import { describe, expect, it } from 'vitest';
import { validateQuestion, validateQuiz } from '../../src/services/ai/pipelines/quiz-validation.js';
import { runQuiz } from '../../src/services/ai/pipelines/capabilities.js';
import { AiError } from '../../src/services/ai/types.js';
import { MockProvider } from '../../src/services/ai/providers/mock.js';
import type { QuizQuestion } from '../../src/services/ai/evaluators/schemas.js';

const mc: QuizQuestion = {
  type: 'multiple_choice',
  prompt: 'りんご = ?',
  options: ['apple', 'banana'],
  answer: 'apple',
  explanation: 'fruit',
  jlptLevel: 'N5',
};

describe('quiz answer validation', () => {
  it('accepts a valid MC question', () => {
    expect(validateQuestion(mc, 0)).toBeUndefined();
  });

  it('rejects MC answer not among options', () => {
    const bad = { ...mc, answer: 'cherry' };
    expect(validateQuestion(bad, 0)?.reason).toContain('not among the options');
  });

  it('rejects duplicate options', () => {
    const bad = { ...mc, options: ['apple', 'apple'] };
    expect(validateQuestion(bad, 0)?.reason).toContain('duplicate');
  });

  it('rejects invalid JLPT level', () => {
    const bad = { ...mc, jlptLevel: 'N9' as never };
    expect(validateQuestion(bad, 0)?.reason).toContain('jlptLevel');
  });

  it('rejects empty completion answer', () => {
    const q: QuizQuestion = {
      type: 'sentence_completion',
      prompt: '私は ___ です。',
      answer: '   ',
      explanation: 'x',
      jlptLevel: null,
    };
    expect(validateQuestion(q, 0)?.reason).toContain('empty');
  });

  it('rejects answer equal to prompt', () => {
    const q: QuizQuestion = {
      type: 'sentence_completion',
      prompt: 'same',
      answer: 'same',
      explanation: 'x',
      jlptLevel: null,
    };
    expect(validateQuestion(q, 0)?.reason).toContain('equals prompt');
  });

  it('validateQuiz separates kept and rejected', () => {
    const quiz = {
      questions: [
        mc,
        { ...mc, answer: 'not-an-option' },
        {
          type: 'translation' as const,
          prompt: 'translate',
          direction: 'ja_to_native' as const,
          answer: 'hello',
          explanation: 'x',
          jlptLevel: 'N5' as const,
        },
      ],
    };
    const { questions, rejected } = validateQuiz(quiz);
    expect(questions).toHaveLength(2);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.index).toBe(1);
  });
});

describe('runQuiz integration', () => {
  function mockReturning(content: string) {
    const m = new MockProvider();
    m.cannedResponses = [{ match: 'Generate the quiz', content }];
    return { provider: m, model: 'test-llm' };
  }

  it('drops invalid questions and reports diagnostics', async () => {
    const quiz = {
      questions: [
        mc,
        { ...mc, answer: 'not-an-option', prompt: 'bad one' },
      ],
    };
    const res = await runQuiz(mockReturning(JSON.stringify(quiz)), {
      language: 'en',
      type: 'multiple_choice',
    });
    expect(res.data.questions).toHaveLength(1);
    expect(res.diagnostics?.rejectedQuestions).toBe(1);
  });

  it('throws VALIDATION_ERROR when every question is invalid', async () => {
    const quiz = { questions: [{ ...mc, answer: 'nope' }] };
    await expect(
      runQuiz(mockReturning(JSON.stringify(quiz)), { language: 'en', type: 'multiple_choice' }),
    ).rejects.toBeInstanceOf(AiError);
  });
});
