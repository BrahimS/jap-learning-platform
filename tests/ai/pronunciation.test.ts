import { describe, expect, it } from 'vitest';
import { align, normalizeForSpeech, verdictFor } from '../../src/services/ai/pipelines/alignment.js';
import { runPronunciationCheck } from '../../src/services/ai/pipelines/capabilities.js';
import type { AiProvider } from '../../src/services/ai/providers/types.js';

function providerReturning(text: string): AiProvider {
  return {
    name: 'fake-asr',
    chat: async () => ({ content: '{}' }),
    embed: async (_m, texts) => texts.map(() => [1, 0]),
    transcribe: async () => ({ text }),
    synthesize: async () => ({ audio: new Uint8Array(0), mimeType: 'audio/wav' }),
  };
}

describe('speech alignment', () => {
  it('perfect match → accuracy 1, no issues', () => {
    const r = align('こんにちは', 'こんにちは');
    expect(r.accuracy).toBe(1);
    expect(r.segments.every((s) => s.op === 'match')).toBe(true);
  });

  it('detects substitution, insertion, deletion', () => {
    const r = align('abc', 'axc'); // b→x replace... actually align gives replace or indel
    expect(r.accuracy).toBeGreaterThan(0.5);
    const ops = new Set(r.segments.map((s) => s.op));
    expect([...ops].some((o) => o !== 'match')).toBe(true);
  });

  it('normalizes punctuation and whitespace', () => {
    expect(normalizeForSpeech('こんにちは、世界。')).toBe('こんにちは世界');
    const r = align('食べる。', '食べる');
    expect(r.accuracy).toBe(1);
  });

  it('verdict thresholds', () => {
    expect(verdictFor(0.95)).toBe('good');
    expect(verdictFor(0.8)).toBe('fair');
    expect(verdictFor(0.3)).toBe('needs_work');
  });
});

describe('pronunciation check pipeline', () => {
  it('returns structured feedback for near-perfect speech', async () => {
    const res = await runPronunciationCheck(
      { provider: providerReturning('こんにちは'), model: 'asr-x' },
      { expectedText: 'こんにちは', audio: new Uint8Array(10), mimeType: 'audio/wav' },
    );
    expect(res.capability).toBe('asr');
    expect(res.data.accuracy).toBe(1);
    expect(res.data.verdict).toBe('good');
    expect(res.data.issues).toHaveLength(0);
    expect(res.data.recognized).toBe('こんにちは');
  });

  it('flags misrecognized segments', async () => {
    const res = await runPronunciationCheck(
      { provider: providerReturning('こんにちは世界'), model: 'asr-x' },
      { expectedText: 'こんにちは', audio: new Uint8Array(10), mimeType: 'audio/wav' },
    );
    expect(res.data.verdict).not.toBe('good');
    expect(res.data.issues.length).toBeGreaterThan(0);
    expect(res.data.issues[0]?.op).toBe('insert');
  });
});
