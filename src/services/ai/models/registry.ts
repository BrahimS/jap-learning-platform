import type { AiCapability } from '../types.js';

/**
 * Centralized model registry (§8.1, §8.4). Model IDs, licenses, and serving
 * hints live here and nowhere else. Selections per docs/ai/model-evaluation.md
 * (issue #2); license review per docs/ai/licensing-policy.md (issue #3).
 *
 * `revision` pins the immutable commit evaluated for each model. Serverless
 * providers (router/hf-inference) do not accept a revision parameter, so the
 * pin takes effect when self-hosting or deploying dedicated endpoints.
 */

export interface ModelEntry {
  /** Hugging Face repo ID. */
  repoId: string;
  capability: AiCapability;
  license: string;
  /** Pinned revision (commit SHA). Used for self-host/dedicated endpoints; serverless providers serve their own snapshot. */
  revision?: string;
  /** 'router' = HF Inference Providers, 'api' = classic Inference API / dedicated endpoint. */
  serving: 'router' | 'api' | 'self-host';
  notes?: string;
}

export const MODEL_REGISTRY = {
  llmPrimary: {
    repoId: 'Qwen/Qwen3-32B',
    revision: '9216db5781bf21249d130ec9da846c4624c16137',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'Chat/tutor/grammar/vocab/quiz/writing/recommendations. Quality tier.',
  },
  llmCostTier: {
    repoId: 'Qwen/Qwen3-8B',
    revision: 'b968826d9c46dd6066d109eabc6255188de91218',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'Lower-cost chat tier.',
  },
  llmMoE: {
    repoId: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
    revision: '0d7cf23991f47feeb3a57ecb4c9cee8ea4a17bfe',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'MoE latency/quality middle ground.',
  },
  llmJapaneseSpecialist: {
    repoId: 'llm-jp/llm-jp-3-7.2b-instruct',
    revision: '687b7a4313b5d9ac1548e1a1d6f3bc699e4acbcb',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'api',
    notes: 'Japanese-only drills; weaker FR/AR explanations.',
  },
  translation: {
    repoId: 'google/madlad400-3b-mt',
    revision: 'fa184c675da0b5c9e1c8694fccd4e12e2d422094',
    capability: 'translation',
    license: 'apache-2.0',
    serving: 'api',
    notes: 'JA <-> FR/EN/AR. Quality tier: google/madlad400-10b-mt.',
  },
  asr: {
    repoId: 'openai/whisper-large-v3-turbo',
    revision: '41f01f3fe87f28c78e2fbf8b568835947dd65ed9',
    capability: 'asr',
    license: 'mit',
    serving: 'api',
    notes: 'General ASR. Japanese specialist alt: reazon-research/reazonspeech-nemo-v2 (apache-2.0).',
  },
  tts: {
    repoId: 'Aratako/MioTTS-0.6B',
    revision: '901ee12c50efd68ea3db6a6780cd29da197cd0da',
    capability: 'tts',
    license: 'apache-2.0',
    serving: 'self-host',
    notes: 'EN+JA TTS, LLM-based, RTF ~0.06. Alternates: MioTTS-1.7B, Irodori-TTS-v4.1-Small (mit).',
  },
  embedding: {
    repoId: 'Qwen/Qwen3-Embedding-0.6B',
    revision: '97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3',
    capability: 'embedding',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'Alternates: Qwen3-Embedding-4B, BAAI/bge-m3 (mit).',
  },
} as const satisfies Record<string, ModelEntry>;

export type ModelKey = keyof typeof MODEL_REGISTRY;

export function getModel(key: ModelKey): ModelEntry {
  return MODEL_REGISTRY[key];
}

export function repoIdFor(key: ModelKey): string {
  return MODEL_REGISTRY[key].repoId;
}
