/**
 * Character-level alignment for pronunciation feedback (issue #12).
 * Levenshtein DP with backtrace → match/replace/insert/delete ops that a UI
 * can render as "expected X, heard Y" highlighting. Language-agnostic —
 * works on Japanese kana/kanji and romanized text alike.
 */

export type DiffOp = 'match' | 'replace' | 'insert' | 'delete';

export interface DiffSegment {
  op: DiffOp;
  expected?: string | undefined;
  recognized?: string | undefined;
}

const MAX_CELLS = 4_000_000; // guard against pathological inputs

/** Normalize for comparison: strip whitespace + Japanese/ASCII punctuation. */
export function normalizeForSpeech(s: string): string {
  return s.replace(/[\s、。，．！？!?,.・「」『』()（）\-—–~〜]/g, '');
}

/**
 * Align expected → recognized. Returns merged diff segments plus the
 * normalized strings actually compared and a 0–1 accuracy score.
 */
export function align(expected: string, recognized: string): {
  expectedNorm: string;
  recognizedNorm: string;
  segments: DiffSegment[];
  /** 1 - editDistance / max(len) — 1.0 = perfect. */
  accuracy: number;
} {
  const a = [...normalizeForSpeech(expected)];
  const b = [...normalizeForSpeech(recognized)];
  const n = a.length;
  const m = b.length;

  if (n * m > MAX_CELLS) {
    // Too large for full DP — fall back to length-ratio accuracy, no diff.
    const denom = Math.max(n, m, 1);
    return {
      expectedNorm: a.join(''),
      recognizedNorm: b.join(''),
      segments: [],
      accuracy: Math.max(0, 1 - Math.abs(n - m) / denom),
    };
  }

  // dp[i][j] = edit distance between a[:i] and b[:j]
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) dp[i]![0] = i;
  for (let j = 0; j <= m; j++) dp[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1, // delete from expected
        dp[i]![j - 1]! + 1, // insert (extra recognized)
        dp[i - 1]![j - 1]! + cost, // match/replace
      );
    }
  }

  // Backtrace → ops (reversed at the end). Order prefers match, then
  // replace (only when chars differ), then insert, then delete.
  const rev: DiffSegment[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && dp[i]![j] === dp[i - 1]![j - 1]) {
      rev.push({ op: 'match', expected: a[i - 1], recognized: b[j - 1] });
      i--;
      j--;
    } else if (
      i > 0 &&
      j > 0 &&
      a[i - 1] !== b[j - 1] &&
      dp[i]![j] === dp[i - 1]![j - 1]! + 1
    ) {
      rev.push({ op: 'replace', expected: a[i - 1], recognized: b[j - 1] });
      i--;
      j--;
    } else if (j > 0 && dp[i]![j] === dp[i]![j - 1]! + 1) {
      rev.push({ op: 'insert', recognized: b[j - 1] });
      j--;
    } else {
      rev.push({ op: 'delete', expected: a[i - 1] });
      i--;
    }
  }
  rev.reverse();

  // Merge consecutive same-op chars into readable segments.
  const segments: DiffSegment[] = [];
  for (const seg of rev) {
    const last = segments[segments.length - 1];
    if (last && last.op === seg.op) {
      if (seg.expected) last.expected = (last.expected ?? '') + seg.expected;
      if (seg.recognized) last.recognized = (last.recognized ?? '') + seg.recognized;
    } else {
      segments.push({ ...seg });
    }
  }

  const denom = Math.max(n, m, 1);
  return {
    expectedNorm: a.join(''),
    recognizedNorm: b.join(''),
    segments,
    accuracy: Math.max(0, 1 - dp[n]![m]! / denom),
  };
}

export function verdictFor(accuracy: number): 'good' | 'fair' | 'needs_work' {
  if (accuracy >= 0.9) return 'good';
  if (accuracy >= 0.7) return 'fair';
  return 'needs_work';
}
