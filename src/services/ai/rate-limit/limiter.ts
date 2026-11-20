/**
 * In-memory sliding-window rate limiter (§8.4, §8.6/issue #6 hooks).
 * Per-key limits; swap the store for Redis/etc. when scaling horizontally.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxRequests: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface Bucket {
  resetAt: number;
  count: number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.maxRequests = opts.maxRequests;
    this.now = opts.now ?? Date.now;
  }

  check(key: string): RateLimitDecision {
    const now = this.now();
    this.evict(now);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { resetAt: now + this.windowMs, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.maxRequests;
    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private evict(now: number): void {
    // Bound memory: drop expired buckets. Runs at most once per window.
    if (this.buckets.size < 10_000) return;
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }
}
