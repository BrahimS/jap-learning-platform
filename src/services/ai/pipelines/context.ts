import type { AiProvider } from '../providers/types.js';
import type { AiCapability, AiResult, ChatMessage, Provenance, TokenUsage } from '../types.js';
import { parseModelJson } from '../evaluators/schemas.js';
import { z } from 'zod';

/** Shared pipeline plumbing: chat → JSON parse → schema validate → AiResult. */

export interface PipelineDeps {
  provider: AiProvider;
  /** Resolved HF repo ID for this capability. */
  model: string;
  /** Default capability; chat pipelines override per call. */
  capability?: AiCapability;
}

export interface ChatPipelineDeps extends PipelineDeps {
  capability: AiCapability;
  /** Ask provider for JSON-mode output. Default true. */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export async function runStructuredChat<S extends z.ZodType>(
  deps: ChatPipelineDeps,
  messages: ChatMessage[],
  schema: S,
  context: string,
  provenance?: Provenance,
): Promise<AiResult<z.infer<S>>> {
  const started = Date.now();
  const result = await deps.provider.chat(deps.model, messages, {
    jsonMode: deps.jsonMode ?? true,
    // Constrained decoding where supported (Ollama format=JSON Schema) —
    // small local models otherwise invent schema keys.
    jsonSchema: z.toJSONSchema(schema),
    temperature: deps.temperature,
    maxTokens: deps.maxTokens,
  });
  const data = parseModelJson(result.content, schema, context);
  const latencyMs = Date.now() - started;
  const usage: TokenUsage | undefined = result.usage;
  return {
    data,
    model: deps.model,
    capability: deps.capability,
    latencyMs,
    ...(usage ? { usage } : {}),
    ...(provenance ? { provenance } : {}),
  };
}
