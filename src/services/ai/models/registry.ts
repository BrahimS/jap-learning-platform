import type { AiCapability } from '../types.js';

/**
 * Centralized model registry (§8.1, §8.4). Model IDs, licenses, and serving
 * hints live here and nowhere else. Selections per docs/ai/model-evaluation.md
 * (issue #2); license review per docs/ai/licensing-policy.md (issue #3).
 *
 * `revision` pins an immutable commit once chosen — set before production.
 */

export interface ModelEntry {
  /** Hugging Face repo ID. */
  repoId: string;
  capability: AiCapability;
  license: string;
  /** Pinned revision (commit SHA or tag). TODO before production. */
  revision?: string;
  /** 'router' = HF Inference Providers, 'api' = classic Inference API / dedicated endpoint. */
  serving: 'router' | 'api' | 'self-host';
  notes?: string;
}

export const MODEL_REGISTRY = {
  llmPrimary: {
    repoId: 'Qwen/Qwen3-32B',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'Chat/tutor/grammar/vocab/quiz/writing/recommendations. Quality tier.',
  },
  llmCostTier: {
    repoId: 'Qwen/Qwen3-8B',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'Lower-cost chat tier.',
  },
  llmMoE: {
    repoId: 'Qwen/Qwen3-30B-A3B-Instruct-2507',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'router',
    notes: 'MoE latency/quality middle ground.',
  },
  llmJapaneseSpecialist: {
    repoId: 'llm-jp/llm-jp-3-7.2b-instruct',
    capability: 'tutor',
    license: 'apache-2.0',
    serving: 'api',
    notes: 'Japanese-only drills; weaker FR/AR explanations.',
  },
  translation: {
    repoId: 'google/madlad400-3b-mt',
    capability: 'translation',
    license: 'apache-2.0',
    serving: 'api',
    notes: 'JA <-> FR/EN/AR. Quality tier: google/madlad400-10b-mt.',
  },
  asr: {
    repoId: 'openai/whisper-large-v3-turbo',
    capability: 'asr',
    license: 'mit',
    serving: 'api',
    notes: 'General ASR. Japanese specialist alt: reazon-research/reazonspeech-nemo-v2 (apache-2.0).',
  },
  tts: {
    repoId: 'Aratako/MioTTS-0.6B',
    capability: 'tts',
    license: 'apache-2.0',
    serving: 'self-host',
    notes: 'EN+JA TTS, LLM-based, RTF ~0.06. Alternates: MioTTS-1.7B, Irodori-TTS-v4.1-Small (mit).',
  },
  embedding: {
    repoId: 'Qwen/Qwen3-Embedding-0.6B',
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
