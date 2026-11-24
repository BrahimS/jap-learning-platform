import { describe, expect, it } from 'vitest';
import {
  OllamaProvider,
  ollamaConfigFromEnv,
  type OllamaProviderConfig,
} from '../../src/services/ai/providers/ollama.js';
import { AiError } from '../../src/services/ai/types.js';
import { createAiService } from '../../src/services/ai/service.js';
import type { AiConfig } from '../../src/services/ai/config.js';

const cfg: OllamaProviderConfig = {
  baseUrl: 'http://localhost:11434',
  chatModel: 'qwen3:1.7b',
  embedModel: 'qwen3-embedding:0.6b',
  requestTimeoutMs: 1000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OllamaProvider', () => {
  it('chat resolves chat repoIds to the local chat model via /api/chat', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const p = new OllamaProvider(cfg, {
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          message: { content: '{"ok":true}' },
          prompt_eval_count: 3,
          eval_count: 4,
        });
      },
    });
    const res = await p.chat('Qwen/Qwen3-32B', [{ role: 'user', content: 'hi' }], {
      jsonMode: true,
    });
    expect(res.content).toBe('{"ok":true}');
    expect(res.usage?.totalTokens).toBe(7);
    expect(calls[0]!.url).toBe('http://localhost:11434/api/chat');
    expect(calls[0]!.body.model).toBe('qwen3:1.7b');
    expect(calls[0]!.body.think).toBe(false);
    // format:'json' intentionally omitted — loops small CPU models.
    expect(calls[0]!.body.format).toBeUndefined();
    expect((calls[0]!.body.options as Record<string, unknown>).num_predict).toBe(2048);
  });

  it('embed resolves embedding repoIds and returns vectors', async () => {
    const p = new OllamaProvider(cfg, {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(String(url)).toBe('http://localhost:11434/api/embed');
        expect(body.model).toBe('qwen3-embedding:0.6b');
        expect(body.input).toEqual(['a', 'b']);
        return jsonResponse({ embeddings: [[0.1, 0.2], [0.3, 0.4]] });
      },
    });
    const vecs = await p.embed('Qwen/Qwen3-Embedding-0.6B', ['a', 'b']);
    expect(vecs).toEqual([[0.1, 0.2], [0.3, 0.4]]);
  });

  it('rejects ASR and TTS repoIds with NOT_CONFIGURED', async () => {
    const p = new OllamaProvider(cfg, { fetchImpl: async () => jsonResponse({}) });
    await expect(
      p.transcribe('openai/whisper-large-v3-turbo', new Uint8Array([1]), 'audio/wav'),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await expect(p.synthesize('Aratako/MioTTS-0.6B', 'hi')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });

  it('maps 5xx to retryable UPSTREAM_5XX and honors maxRetries', async () => {
    let calls = 0;
    const p = new OllamaProvider({ ...cfg, maxRetries: 1 }, {
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ error: 'boom' }, 500);
      },
      sleep: async () => {},
    });
    await expect(p.chat('x', [{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(AiError);
    expect(calls).toBe(2);
  });

  it('maps fetch timeout to TIMEOUT', async () => {
    const p = new OllamaProvider(cfg, {
      fetchImpl: async () => {
        const e = new Error('timed out');
        e.name = 'TimeoutError';
        throw e;
      },
    });
    await expect(p.chat('x', [{ role: 'user', content: 'hi' }])).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });
});

describe('ollamaConfigFromEnv', () => {
  it('applies defaults and overrides', () => {
    expect(ollamaConfigFromEnv({}).baseUrl).toBe('http://localhost:11434');
    const c = ollamaConfigFromEnv({
      AI_LOCAL_BASE_URL: 'http://localhost:1234/v1/',
      AI_LOCAL_CHAT_MODEL: 'qwen3:4b',
    });
    expect(c.baseUrl).toBe('http://localhost:1234/v1');
    expect(c.chatModel).toBe('qwen3:4b');
  });
});

describe('AI_PROVIDER=ollama selection', () => {
  const base: AiConfig = {
    hfToken: 'hf_fake',
    hfRouterBaseUrl: 'https://router.huggingface.co',
    hfApiBaseUrl: 'https://router.huggingface.co/hf-inference',
    requestTimeoutMs: 1000,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    rateLimit: { windowMs: 60_000, maxRequests: 100 },
  };

  it('selects OllamaProvider even when HF_TOKEN is set', () => {
    const prev = process.env.AI_PROVIDER;
    process.env.AI_PROVIDER = 'ollama';
    try {
      const svc = createAiService({ config: base });
      expect(svc.providerName).toBe('ollama');
    } finally {
      if (prev === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = prev;
    }
  });
});
