import type { AiConfig } from '../config.js';
import { requireHfToken } from '../config.js';
import { AiError } from '../types.js';
import type { ChatMessage } from '../types.js';
import type {
  AiProvider,
  ProviderChatOptions,
  ProviderChatResult,
} from './types.js';

/**
 * Hugging Face provider (§8.4).
 * - chat:      HF Inference Providers router, OpenAI-compatible `/v1/chat/completions`
 * - embed:     hf-inference task endpoint `/models/{id}` (feature-extraction)
 * - transcribe/synthesize: hf-inference task endpoints
 * Token is sent server-side only and never logged.
 */

export interface FetchLike {
  (input: string | URL, init?: RequestInit): Promise<Response>;
}

interface HttpAttempt {
  status: number;
  body: unknown;
}

export class HuggingFaceProvider implements AiProvider {
  readonly name = 'huggingface';
  private readonly config: AiConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: AiConfig,
    deps: { fetchImpl?: FetchLike; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.config = config;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async chat(
    model: string,
    messages: ChatMessage[],
    opts: ProviderChatOptions = {},
  ): Promise<ProviderChatResult> {
    const token = requireHfToken(this.config);
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 2048,
    };
    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const res = await this.request(`${this.config.hfRouterBaseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const json = res.body as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new AiError('PROVIDER_ERROR', 'Empty chat completion from provider', {
        detail: 'missing choices[0].message.content',
      });
    }
    return {
      content,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
          }
        : undefined,
    };
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    const token = requireHfToken(this.config);
    const res = await this.request(
      `${this.config.hfApiBaseUrl}/models/${model}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ inputs: texts, options: { wait: true } }),
      },
    );
    const body = res.body;
    // feature-extraction returns number[][] for a list of inputs (or number[] for one).
    if (Array.isArray(body) && body.every((v) => Array.isArray(v))) {
      return body as number[][];
    }
    if (Array.isArray(body) && body.every((v) => typeof v === 'number')) {
      return [body as number[]];
    }
    throw new AiError('PROVIDER_ERROR', 'Unexpected embedding response shape', {
      detail: JSON.stringify(body)?.slice(0, 200),
    });
  }

  async transcribe(
    model: string,
    audio: Uint8Array,
    mimeType: string,
  ): Promise<{ text: string }> {
    const token = requireHfToken(this.config);
    const form = new FormData();
    form.append('file', new Blob([audio as BlobPart], { type: mimeType }), 'audio');
    const res = await this.request(`${this.config.hfApiBaseUrl}/models/${model}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
    });
    const body = res.body as { text?: string };
    if (typeof body.text !== 'string') {
      throw new AiError('PROVIDER_ERROR', 'Unexpected transcription response', {
        detail: JSON.stringify(body)?.slice(0, 200),
      });
    }
    return { text: body.text };
  }

  async synthesize(model: string, text: string): Promise<{ audio: Uint8Array; mimeType: string }> {
    const token = requireHfToken(this.config);
    const res = await this.rawRequest(`${this.config.hfApiBaseUrl}/models/${model}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ inputs: text }),
    });
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new AiError('PROVIDER_ERROR', 'Empty audio response from TTS provider');
    }
    return { audio: buf, mimeType: contentType };
  }

  /** JSON request with retry/timeout; returns parsed body. */
  private async request(url: string, init: RequestInit): Promise<HttpAttempt> {
    const res = await this.rawRequest(url, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body — keep raw text */
    }
    return { status: res.status, body };
  }

  private async rawRequest(url: string, init: RequestInit): Promise<Response> {
    return this.withRetry(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (err) {
        throw normalizeFetchError(err);
      }
      if (res.ok) return res;

      // Drain body for error detail (bounded).
      const text = await res.text().catch(() => '');
      throw httpError(res.status, text);
    });
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const aiErr = err instanceof AiError ? err : new AiError('PROVIDER_ERROR', String(err));
        if (!aiErr.retryable || attempt >= this.config.maxRetries) throw aiErr;
        const delay =
          this.config.retryBaseDelayMs * 2 ** attempt + Math.floor(Math.random() * 100);
        await this.sleep(delay);
        attempt += 1;
      }
    }
  }
}

function normalizeFetchError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new AiError('TIMEOUT', 'AI provider request timed out', { cause: err });
  }
  return new AiError('PROVIDER_ERROR', 'AI provider request failed', { cause: err });
}

function httpError(status: number, bodyText: string): AiError {
  const detail = bodyText.slice(0, 500);
  if (status === 429) {
    return new AiError('PROVIDER_ERROR', 'AI provider rate limited', {
      status,
      retryable: true,
      detail,
    });
  }
  if (status >= 500) {
    return new AiError('UPSTREAM_5XX', `AI provider error (${status})`, {
      status,
      retryable: true,
      detail,
    });
  }
  return new AiError('UPSTREAM_4XX', `AI provider rejected request (${status})`, {
    status,
    retryable: false,
    detail,
  });
}
