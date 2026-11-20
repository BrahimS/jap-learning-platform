import type { TokenUsage } from '../types.js';

/**
 * Cost estimation for usage monitoring (issue #17; §8.3 operating costs).
 *
 * IMPORTANT: Hugging Face Inference Providers price varies by the upstream
 * provider serving the model, and dedicated/self-hosted endpoints bill by
 * GPU-hour instead. The table below contains *planning estimates* — verify
 * against actual provider invoices and override via AI_PRICING_JSON or the
 * `pricing` dep on createAiService. Every entry is flagged `estimated`.
 */

export interface PriceEntry {
  /** USD per 1M prompt tokens (chat/embedding input). */
  inputPer1MUsd?: number;
  /** USD per 1M completion tokens (chat output). */
  outputPer1MUsd?: number;
  /** USD per audio minute (ASR). */
  perAudioMinuteUsd?: number;
  /** USD per 1K characters synthesized (TTS). */
  per1kCharsUsd?: number;
  estimated: true;
  note?: string;
}

/** Keyed by HF repo ID (MODEL_REGISTRY.repoId). */
export const DEFAULT_PRICING: Record<string, PriceEntry> = {
  'Qwen/Qwen3-32B': {
    inputPer1MUsd: 0.2,
    outputPer1MUsd: 0.6,
    estimated: true,
    note: 'Router third-party providers; verify per-provider pricing.',
  },
  'Qwen/Qwen3-8B': {
    inputPer1MUsd: 0.05,
    outputPer1MUsd: 0.15,
    estimated: true,
  },
  'Qwen/Qwen3-30B-A3B-Instruct-2507': {
    inputPer1MUsd: 0.1,
    outputPer1MUsd: 0.3,
    estimated: true,
  },
  'llm-jp/llm-jp-3-7.2b-instruct': {
    inputPer1MUsd: 0.05,
    outputPer1MUsd: 0.15,
    estimated: true,
  },
  'google/madlad400-3b-mt': {
    inputPer1MUsd: 0.05,
    outputPer1MUsd: 0.05,
    estimated: true,
    note: 'Seq2seq; output tokens ≈ translated tokens.',
  },
  'google/madlad400-10b-mt': {
    inputPer1MUsd: 0.1,
    outputPer1MUsd: 0.1,
    estimated: true,
  },
  'openai/whisper-large-v3-turbo': {
    perAudioMinuteUsd: 0.006,
    estimated: true,
    note: 'Estimate per audio minute; HF bills compute-time.',
  },
  'reazon-research/reazonspeech-nemo-v2': {
    perAudioMinuteUsd: 0.004,
    estimated: true,
  },
  'Aratako/MioTTS-0.6B': {
    per1kCharsUsd: 0.01,
    estimated: true,
    note: 'Self-host preferred (RTF ~0.06 on consumer GPU); hosted price varies.',
  },
  'Aratako/MioTTS-1.7B': {
    per1kCharsUsd: 0.02,
    estimated: true,
  },
  'Aratako/Irodori-TTS-v4.1-Small': {
    per1kCharsUsd: 0.015,
    estimated: true,
  },
  'Qwen/Qwen3-Embedding-0.6B': {
    inputPer1MUsd: 0.01,
    estimated: true,
  },
  'Qwen/Qwen3-Embedding-4B': {
    inputPer1MUsd: 0.02,
    estimated: true,
  },
  'BAAI/bge-m3': {
    inputPer1MUsd: 0.01,
    estimated: true,
  },
};

export type PricingTable = Record<string, PriceEntry>;

/** Merge overrides (AI_PRICING_JSON or deps) onto defaults. */
export function loadPricing(overridesJson?: string): PricingTable {
  const table: PricingTable = { ...DEFAULT_PRICING };
  if (!overridesJson) return table;
  try {
    const parsed = JSON.parse(overridesJson) as Record<string, Partial<PriceEntry>>;
    for (const [repoId, entry] of Object.entries(parsed)) {
      table[repoId] = { ...(table[repoId] ?? {}), ...entry, estimated: true };
    }
  } catch {
    /* malformed override — keep defaults; never break the service */
  }
  return table;
}

/**
 * Estimate USD cost for one usage event.
 * Token-priced models use prompt/completion token counts; unit-priced
 * modalities (ASR minutes, TTS chars) are supplied via `units`.
 * Returns undefined when the model is unknown or no usage was reported —
 * cost is then simply unmeasured, not zero.
 */
export function estimateCostUsd(
  model: string | undefined,
  usage: TokenUsage | undefined,
  units: { audioMinutes?: number; chars?: number } = {},
  pricing: PricingTable = DEFAULT_PRICING,
): number | undefined {
  if (!model) return undefined;
  const price = pricing[model];
  if (!price) return undefined;

  let cost = 0;
  let measured = false;

  if (price.inputPer1MUsd !== undefined && usage?.promptTokens !== undefined) {
    cost += (usage.promptTokens / 1_000_000) * price.inputPer1MUsd;
    measured = true;
  }
  if (price.outputPer1MUsd !== undefined && usage?.completionTokens !== undefined) {
    cost += (usage.completionTokens / 1_000_000) * price.outputPer1MUsd;
    measured = true;
  }
  if (price.perAudioMinuteUsd !== undefined && units.audioMinutes !== undefined) {
    cost += units.audioMinutes * price.perAudioMinuteUsd;
    measured = true;
  }
  if (price.per1kCharsUsd !== undefined && units.chars !== undefined) {
    cost += (units.chars / 1000) * price.per1kCharsUsd;
    measured = true;
  }

  return measured ? cost : undefined;
}
