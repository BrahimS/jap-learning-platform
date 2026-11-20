import type { ChatMessage } from '../types.js';
import type {
  AiProvider,
  ProviderChatOptions,
  ProviderChatResult,
} from './types.js';

/**
 * Deterministic in-process provider for tests and local dev when no HF token
 * is configured. Produces schema-shaped JSON so pipelines can be exercised
 * end-to-end without network access. Never used in production paths unless
 * explicitly selected.
 */
export class MockProvider implements AiProvider {
  readonly name = 'mock';
  /** Optional canned overrides keyed by a substring match on the last user message. */
  cannedResponses: { match: string; content: string }[] = [];

  async chat(
    _model: string,
    messages: ChatMessage[],
    _opts?: ProviderChatOptions,
  ): Promise<ProviderChatResult> {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const canned = this.cannedResponses.find((c) => last.includes(c.match));
    const content = canned?.content ?? defaultJsonFor(last);
    return {
      content,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
  }

  async embed(model: string, texts: string[]): Promise<number[][]> {
    // Deterministic pseudo-embedding: hash each text into a fixed-size vector.
    return texts.map((t) => {
      const v = new Array<number>(8).fill(0);
      for (let i = 0; i < t.length; i++) {
        v[(t.charCodeAt(i) + i) % v.length]! += 1 / (i + 1);
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }

  async transcribe(_model: string, audio: Uint8Array): Promise<{ text: string }> {
    return { text: `[mock transcript ${audio.byteLength}B]` };
  }

  async synthesize(_model: string, text: string) {
    // Tiny valid WAV header + silence — enough for pipeline tests.
    const header = new Uint8Array(44);
    const view = new DataView(header.buffer);
    const write = (s: string, off: number) => {
      for (let i = 0; i < s.length; i++) header[off + i] = s.charCodeAt(i);
    };
    write('RIFF', 0); view.setUint32(4, 36 + 800, true); write('WAVE', 8);
    write('fmt ', 12); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, 8000, true);
    view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    write('data', 36); view.setUint32(40, 800, true);
    const audio = new Uint8Array(header.length + 800);
    audio.set(header);
    return { audio, mimeType: 'audio/wav' };
  }
}

function defaultJsonFor(prompt: string): string {
  // The system prompt instructs JSON output; echo a minimal valid object that
  // most schemas can partially satisfy — tests override via cannedResponses.
  return JSON.stringify({
    reply: `[mock] Received: ${prompt.slice(0, 80)}`,
    note: 'mock-provider',
  });
}
