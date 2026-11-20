import { describe, expect, it, vi } from 'vitest';
import { HuggingFaceProvider } from '../../src/services/ai/providers/huggingface.js';
import { loadAiConfig } from '../../src/services/ai/config.js';
import { AiError } from '../../src/services/ai/types.js';
import type { FetchLike } from '../../src/services/ai/providers/huggingface.js';

const config = {
  ...loadAiConfig({}),
  hfToken: 'test-token',
  requestTimeoutMs: 1000,
  maxRetries: 2,
  retryBaseDelayMs: 1,
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HuggingFaceProvider.chat', () => {
  it('sends OpenAI-compatible request and parses content+usage', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonResponse(200, {
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      }),
    );
    const p = new HuggingFaceProvider(config, { fetchImpl, sleep: async () => {} });
    const out = await p.chat('Qwen/Qwen3-8B', [{ role: 'user', content: 'hi' }], { jsonMode: true });
    expect(out.content).toBe('{"ok":true}');
    expect(out.usage?.totalTokens).toBe(12);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://router.huggingface.co/v1/chat/completions');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
    const sent = JSON.parse(String(init?.body));
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.model).toBe('Qwen/Qwen3-8B');
  });

  it('retries on 5xx then succeeds', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(503, { error: 'busy' });
      return jsonResponse(200, { choices: [{ message: { content: 'ok' } }] });
    };
    const p = new HuggingFaceProvider(config, { fetchImpl, sleep: async () => {} });
    const out = await p.chat('m', [{ role: 'user', content: 'x' }]);
    expect(out.content).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry 4xx', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return jsonResponse(400, { error: 'bad request' });
    };
    const p = new HuggingFaceProvider(config, { fetchImpl, sleep: async () => {} });
    await expect(p.chat('m', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'UPSTREAM_4XX',
      retryable: false,
    });
    expect(calls).toBe(1);
  });

  it('maps abort/timeout to TIMEOUT', async () => {
    const fetchImpl: FetchLike = async () => {
      const e = new Error('timed out');
      e.name = 'TimeoutError';
      throw e;
    };
    const p = new HuggingFaceProvider(config, { fetchImpl, sleep: async () => {} });
    await expect(p.chat('m', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('throws NOT_CONFIGURED without token', async () => {
    const noToken = loadAiConfig({});
    const p = new HuggingFaceProvider(noToken, { fetchImpl: async () => jsonResponse(200, {}) });
    await expect(p.chat('m', [{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      status: 503,
    });
  });
});

describe('HuggingFaceProvider.embed', () => {
  it('normalizes feature-extraction shapes', async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse(200, [
        [0.1, 0.2],
        [0.3, 0.4],
      ]);
    const p = new HuggingFaceProvider(config, { fetchImpl, sleep: async () => {} });
    const out = await p.embed('Qwen/Qwen3-Embedding-0.6B', ['a', 'b']);
    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
  });
});

describe('AiError', () => {
  it('carries status and retryable defaults', () => {
    expect(new AiError('RATE_LIMITED', 'x').status).toBe(429);
    expect(new AiError('UPSTREAM_5XX', 'x').retryable).toBe(true);
    expect(new AiError('VALIDATION_ERROR', 'x').status).toBe(400);
  });
});
