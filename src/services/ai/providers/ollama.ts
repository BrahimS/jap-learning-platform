import { AiError } from '../types.js';
import type { ChatMessage } from '../types.js';
import type {
  AiProvider,
  ProviderChatOptions,
  ProviderChatResult,
} from './types.js';
import type { FetchLike } from './huggingface.js';

/**
 * Self-hosted provider via Ollama (or any OpenAI-compatible local server).
 *
 * Free, offline, private — the spec's sanctioned self-host path (§8.4 keeps
 * this option for cost optimization and data control). Runs open-weight
 * models locally; on CPU-only hosts use small quantized models.
 *
 * Supported: chat + embeddings. ASR/TTS throw NOT_CONFIGURED — wire
 * whisper.cpp / Piper sidecars later if needed.
 */

export interface OllamaProviderConfig {
  /** e.g. http://localhost:11434 — also works for LM Studio (:1234/v1), llama.cpp server, etc. */
  baseUrl: string;
  /** Local model tag for chat capabilities (e.g. 'qwen3:4b'). */
  chatModel: string;
  /** Local model tag for embeddings (e.g. 'qwen3-embedding:0.6b'). */
  embedModel: string;
  requestTimeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
}

export function ollamaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OllamaProviderConfig {
  return {
    baseUrl: (env.AI_LOCAL_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, ''),
    // qwen2.5:3b-instruct verified best on CPU: non-thinking, follows JSON
    // schemas better than qwen3 smalls. Override via AI_LOCAL_CHAT_MODEL.
    chatModel: env.AI_LOCAL_CHAT_MODEL ?? 'qwen2.5:3b-instruct',
    embedModel: env.AI_LOCAL_EMBED_MODEL ?? 'qwen3-embedding:0.6b',
    // CPU inference is slow — default higher than the HF provider's 30s.
    requestTimeoutMs: Number.parseInt(env.AI_REQUEST_TIMEOUT_MS ?? '300000', 10) || 300_000,
    maxRetries: Number.parseInt(env.AI_MAX_RETRIES ?? '1', 10) || 1,
    retryBaseDelayMs: Number.parseInt(env.AI_RETRY_BASE_DELAY_MS ?? '500', 10) || 500,
  };
}

/** Map an HF registry repoId onto the right local model, or reject unsupported tasks. */
function localModelFor(repoId: string, cfg: OllamaProviderConfig): string {
  const id = repoId.toLowerCase();
  if (id.includes('embedding') || id.includes('bge')) return cfg.embedModel;
  if (id.includes('whisper') || id.includes('reazon') || id.includes('nemo')) {
    throw new AiError(
      'NOT_CONFIGURED',
      'ASR is not available on the local provider — use the HF provider or a whisper.cpp sidecar',
    );
  }
  if (id.includes('miotts') || id.includes('irodori')) {
    throw new AiError(
      'NOT_CONFIGURED',
      'TTS is not available on the local provider — use the HF provider or a Piper/Kokoro sidecar',
    );
  }
  return cfg.chatModel;
}

export class OllamaProvider implements AiProvider {
  readonly name = 'ollama';
  private readonly config: OllamaProviderConfig;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    config: OllamaProviderConfig,
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
    const local = localModelFor(model, this.config);
    // Native /api/chat: `think:false` is required — Qwen3-style reasoning
    // models otherwise burn the whole token budget on hidden reasoning.
    // Bare format:'json' is deliberately omitted (grammar constraint loops
    // small CPU models), but a full JSON Schema in `format` IS sent when the
    // pipeline supplies one — constrained decoding guarantees shape.
    const body: Record<string, unknown> = {
      model: local,
      messages,
      stream: false,
      think: false,
      ...(opts.jsonSchema ? { format: opts.jsonSchema } : {}),
      options: {
        temperature: opts.temperature ?? 0.3,
        num_predict: opts.maxTokens ?? 2048,
      },
    };

    const res = await this.request(`${this.config.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    const json = res.body as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    const content = json.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      throw new AiError('PROVIDER_ERROR', 'Empty chat completion from local provider', {
        detail: 'missing message.content',
      });
    }
    const promptTokens = json.prompt_eval_count;
    const completionTokens = json.eval_count;
    return {
      content,
      usage:
        promptTokens !== undefined || completionTokens !== undefined
          ? {
              promptTokens,
              completionTokens,
              totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
            }
          : undefined,
    };
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    const local = localModelFor(model, this.config);
    const res = await this.request(`${this.config.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: local, input: texts }),
    });
    const body = res.body as { embeddings?: number[][] };
    if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length) {
      throw new AiError('PROVIDER_ERROR', 'Unexpected embedding response shape', {
        detail: JSON.stringify(body)?.slice(0, 200),
      });
    }
    return body.embeddings;
  }

  async transcribe(_model: string, _audio: Uint8Array, _mimeType: string): Promise<{ text: string }> {
    localModelFor(_model, this.config); // throws NOT_CONFIGURED for ASR repoIds
    throw new AiError('NOT_CONFIGURED', 'transcription unavailable on local provider');
  }

  async synthesize(_model: string, _text: string): Promise<{ audio: Uint8Array; mimeType: string }> {
    localModelFor(_model, this.config); // throws NOT_CONFIGURED for TTS repoIds
    throw new AiError('NOT_CONFIGURED', 'synthesis unavailable on local provider');
  }

  private async request(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
    const doFetch = async (): Promise<{ status: number; body: unknown }> => {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...init,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (err) {
        const name = (err as { name?: string })?.name;
        if (name === 'TimeoutError' || name === 'AbortError') {
          throw new AiError('TIMEOUT', 'Local provider request timed out', { cause: err });
        }
        throw new AiError('PROVIDER_ERROR', 'Local provider request failed', { cause: err });
      }
      const text = await res.text();
      let body: unknown = text;
      try {
        body = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        /* keep raw */
      }
      if (!res.ok) {
        const detail = text.slice(0, 300);
        throw new AiError(
          res.status >= 500 ? 'UPSTREAM_5XX' : 'UPSTREAM_4XX',
          `Local provider error (${res.status})`,
          { status: res.status, retryable: res.status >= 500 || res.status === 429, detail },
        );
      }
      return { status: res.status, body };
    };

    let attempt = 0;
    for (;;) {
      try {
        return await doFetch();
      } catch (err) {
        const aiErr = err instanceof AiError ? err : new AiError('PROVIDER_ERROR', String(err));
        if (!aiErr.retryable || attempt >= this.config.maxRetries) throw aiErr;
        await this.sleep(this.config.retryBaseDelayMs * 2 ** attempt);
        attempt += 1;
      }
    }
  }
}
