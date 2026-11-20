import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AiCapability } from '../types.js';
import type { EvalCase, EvalKind } from './framework.js';

/**
 * User "report incorrect answer" flow (§8.6; issue #16).
 * Reports are validated, stored (JSONL), and convertible into regression
 * eval cases so a fixed bug stays fixed.
 */

export const reportSchema = z.object({
  userRef: z.string().max(128).optional(),
  capability: z.enum([
    'tutor',
    'grammar',
    'vocabulary',
    'quiz',
    'writing',
    'asr',
    'tts',
    'embedding',
    'translation',
    'assistant',
  ]),
  /** Model registry ID that produced the flagged output. */
  model: z.string().max(200).optional(),
  /** What the learner was doing / the input that produced it. */
  context: z.string().max(2000).optional(),
  /** The incorrect AI output (or a description of the error). */
  reportedOutput: z.string().min(1).max(8000),
  reason: z.string().min(1).max(1000),
});
export type IncorrectAnswerReport = z.infer<typeof reportSchema>;

export interface StoredReport extends IncorrectAnswerReport {
  id: string;
  at: string;
}

export interface FeedbackStore {
  add(report: StoredReport): void | Promise<void>;
  list(): StoredReport[];
}

export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly items: StoredReport[] = [];
  add(r: StoredReport): void {
    this.items.push(r);
  }
  list(): StoredReport[] {
    return [...this.items];
  }
}

/** JSONL-backed store — appends to a file, readable across restarts. */
export class JsonlFeedbackStore implements FeedbackStore {
  private cache: StoredReport[] | undefined;
  constructor(private readonly path: string) {}

  add(report: StoredReport): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(report) + '\n');
    this.cache = undefined;
  }

  list(): StoredReport[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    this.cache = readFileSync(this.path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as StoredReport);
    return this.cache;
  }
}

const CAPABILITY_TO_KIND: Record<AiCapability, EvalKind> = {
  tutor: 'i18n',
  grammar: 'grammar',
  vocabulary: 'grammar',
  quiz: 'quiz',
  writing: 'grammar',
  asr: 'i18n',
  tts: 'i18n',
  embedding: 'i18n',
  translation: 'translation',
  assistant: 'i18n',
};

let counter = 0;
export function nextReportId(): string {
  counter += 1;
  return `rpt-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/** Convert a user report into a manual-review regression eval case. */
export function reportToEvalCase(report: StoredReport): EvalCase {
  return {
    id: `regression-${report.id}`,
    kind: CAPABILITY_TO_KIND[report.capability as AiCapability] ?? 'i18n',
    description: `User-reported error (${report.capability}): ${report.reason}`,
    input: {
      context: report.context,
      reportedOutput: report.reportedOutput,
      reason: report.reason,
    },
    expect: { manual: true },
  };
}
