import { describe, expect, it } from 'vitest';
import { createAiService } from '../../src/services/ai/service.js';
import { MockProvider } from '../../src/services/ai/providers/mock.js';
import { RateLimiter } from '../../src/services/ai/rate-limit/limiter.js';
import { InMemoryUsageSink } from '../../src/services/ai/usage/tracker.js';
import type { AiConfig } from '../../src/services/ai/config.js';

const config: AiConfig = {
  hfToken: undefined,
  hfRouterBaseUrl: 'https://router.huggingface.co',
  hfApiBaseUrl: 'https://api-inference.huggingface.co',
  requestTimeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  rateLimit: { windowMs: 60_000, maxRequests: 100 },
};

function mockWithCanned() {
  const mock = new MockProvider();
  mock.cannedResponses = [
    {
      match: 'GENERATE_TUTOR',
      content: JSON.stringify({
        replyJa: 'こんにちは！',
        explanation: 'Hello! — greeting in Japanese.',
        corrections: [],
        nextStep: 'Ask about weather',
      }),
    },
    {
      match: 'Explain the grammar structure',
      content: JSON.stringify({
        structure: '〜たことがある',
        meaning: 'have done before',
        usage: 'experience',
        jlptLevel: 'N4',
        examples: [{ ja: '日本に行ったことがある。', translation: 'I have been to Japan.' }],
        commonMistakes: ['using it for single past events'],
      }),
    },
    {
      match: 'Generate the quiz',
      content: JSON.stringify({
        questions: [
          {
            type: 'multiple_choice',
            prompt: 'りんご = ?',
            options: ['apple', 'banana', 'grape', 'orange'],
            answer: 'apple',
            explanation: 'fruit',
            jlptLevel: 'N5',
          },
        ],
      }),
    },
    {
      match: 'Explain the word',
      content: JSON.stringify({
        word: '食べる',
        reading: 'たべる',
        meaning: 'to eat',
        examples: [{ ja: 'ご飯を食べる。', translation: 'Eat a meal.' }],
        jlptLevel: 'N5',
      }),
    },
    {
      match: 'Correct this Japanese sentence',
      content: JSON.stringify({
        original: '私は学生です。',
        corrections: [],
        improved: '私は学生です。',
      }),
    },
    {
      match: 'assistant probe question',
      content: JSON.stringify({
        answer: '〜たことがある expresses experience (have done before).',
        curriculumCoverage: 'covered',
        followUp: 'Try 〜経験がある next.',
      }),
    },
    {
      match: 'TRANSLATE_ME',
      content: JSON.stringify({ translation: 'Hello', backTranslation: 'こんにちは' }),
    },
  ];
  return mock;
}

function makeService(rateLimiter?: RateLimiter) {
  const sink = new InMemoryUsageSink();
  const svc = createAiService({
    config,
    provider: mockWithCanned(),
    usageSink: sink,
    ...(rateLimiter ? { rateLimiter } : {}),
  });
  return { svc, sink };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('AiService pipelines (mock provider)', () => {
  it('tutor returns schema-validated reply with provenance', async () => {
    const { svc } = makeService();
    const res = await svc.tutor({
      language: 'en',
      learnerLevel: 'N5',
      latestUserText: 'GENERATE_TUTOR',
    });
    expect(res.data.replyJa).toBe('こんにちは！');
    expect(res.model).toContain('Qwen');
    expect(res.provenance?.grounded).toBe(false);
    expect(res.usage?.totalTokens).toBe(30);
  });

  it('grammar returns validated explanation', async () => {
    const { svc } = makeService();
    const res = await svc.grammar({ language: 'fr', structure: '〜たことがある' });
    expect(res.data.jlptLevel).toBe('N4');
    expect(res.data.examples.length).toBeGreaterThan(0);
  });

  it('quiz returns validated questions', async () => {
    const { svc } = makeService();
    const res = await svc.quiz({ language: 'en', type: 'multiple_choice', topic: 'food' });
    expect(res.data.questions[0]?.answer).toBe('apple');
  });

  it('embed returns vectors', async () => {
    const { svc } = makeService();
    const res = await svc.embed({ texts: ['hello', 'world'] });
    expect(res.data.length).toBe(2);
    expect(res.data[0]!.length).toBe(8);
  });

  it('synthesize returns wav bytes', async () => {
    const { svc } = makeService();
    const out = await svc.synthesize({ text: 'こんにちは' });
    expect(out.mimeType).toBe('audio/wav');
    expect(out.audio.byteLength).toBeGreaterThan(44);
  });

  it('transcribe returns transcript', async () => {
    const { svc } = makeService();
    const res = await svc.transcribe({ audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' });
    expect(res.data.text).toContain('[mock transcript');
  });
});

describe('AiService HTTP handlers', () => {
  it('POST /tutor returns 200 with validated result', async () => {
    const { svc, sink } = makeService();
    const res = await svc.handlers.tutor(
      post('/tutor', {
        userRef: 'u1',
        language: 'en',
        learnerLevel: 'N5',
        text: 'GENERATE_TUTOR',
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.replyJa).toBe('こんにちは！');
    expect(body.meta.model).toContain('Qwen');
    expect(sink.snapshot().some((e) => e.ok && e.capability === 'tutor')).toBe(true);
  });

  it('rejects invalid body with 400', async () => {
    const { svc } = makeService();
    const res = await svc.handlers.tutor(post('/tutor', { language: 'en' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects non-POST with 405', async () => {
    const { svc } = makeService();
    const res = await svc.handlers.tutor(
      new Request('http://localhost/tutor', { method: 'GET' }),
    );
    expect(res.status).toBe(405);
  });

  it('enforces rate limiting', async () => {
    const rl = new RateLimiter({ windowMs: 60_000, maxRequests: 2, now: () => 0 });
    const { svc } = makeService(rl);
    const mk = () =>
      svc.handlers.embed(post('/embed', { texts: ['a'] }));
    expect((await mk()).status).toBe(200);
    expect((await mk()).status).toBe(200);
    const third = await mk();
    expect(third.status).toBe(429);
    expect((await third.json()).error.code).toBe('RATE_LIMITED');
  });

  it('synthesize handler returns base64 audio', async () => {
    const { svc } = makeService();
    const res = await svc.handlers.synthesize(post('/synthesize', { text: 'テスト' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.audioBase64.length).toBeGreaterThan(0);
    expect(body.result.mimeType).toBe('audio/wav');
  });
});

describe('RAG assistant (#15)', () => {
  it('answers with provenance from the retriever', async () => {
    const retriever = {
      retrieve: async () => ({
        sourceIds: ['gram-takoto-ga-aru'],
        text: '<chunk id="gram-takoto-ga-aru">exp</chunk>',
      }),
    };
    const svc2 = createAiService({
      config,
      provider: mockWithCanned(),
      retriever,
      usageSink: new InMemoryUsageSink(),
    });
    const res = await svc2.assistant({
      language: 'en',
      question: 'assistant probe question',
    });
    expect(res.data.curriculumCoverage).toBe('covered');
    expect(res.data.answer).toContain('experience');
    expect(res.provenance?.sources).toEqual(['gram-takoto-ga-aru']);
    expect(res.provenance?.grounded).toBe(true);
  });

  it('ask handler validates body and returns grounded answer', async () => {
    const { svc } = makeService();
    const res = await svc.handlers.ask(
      post('/ask', { language: 'fr', question: 'assistant probe question' }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.curriculumCoverage).toBe('covered');
    expect(body.meta.provenance).toBeDefined();
  });

  it('ask handler rejects invalid body', async () => {
    const { svc } = makeService();
    const res = await svc.handlers.ask(post('/ask', { language: 'en' }));
    expect(res.status).toBe(400);
  });
});
