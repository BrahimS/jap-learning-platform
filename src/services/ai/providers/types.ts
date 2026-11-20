import type { ChatMessage, TokenUsage } from '../types.js';

/** Provider-agnostic inference interface. Feature code depends on this, never on HF directly. */

export interface ProviderChatOptions {
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  /** Ask the provider for JSON-mode output where supported. */
  jsonMode?: boolean | undefined;
}

export interface ProviderChatResult {
  content: string;
  usage?: TokenUsage | undefined;
}

export interface AiProvider {
  readonly name: string;
  chat(model: string, messages: ChatMessage[], opts?: ProviderChatOptions): Promise<ProviderChatResult>;
  embed(model: string, texts: string[]): Promise<number[][]>;
  /** Speech-to-text. Accepts raw audio bytes + mime type. */
  transcribe(model: string, audio: Uint8Array, mimeType: string): Promise<{ text: string }>;
  /** Text-to-speech. Returns encoded audio bytes. */
  synthesize(model: string, text: string): Promise<{ audio: Uint8Array; mimeType: string }>;
}
