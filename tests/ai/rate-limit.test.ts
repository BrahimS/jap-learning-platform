import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/services/ai/rate-limit/limiter.js';

describe('RateLimiter', () => {
  it('allows up to maxRequests then blocks', () => {
    let now = 1_000;
    const rl = new RateLimiter({ windowMs: 10_000, maxRequests: 3, now: () => now });
    expect(rl.check('u1').allowed).toBe(true);
    expect(rl.check('u1').allowed).toBe(true);
    expect(rl.check('u1').allowed).toBe(true);
    const fourth = rl.check('u1');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks keys independently', () => {
    const rl = new RateLimiter({ windowMs: 10_000, maxRequests: 1, now: () => 0 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true);
  });

  it('resets after the window', () => {
    let now = 0;
    const rl = new RateLimiter({ windowMs: 1_000, maxRequests: 1, now: () => now });
    expect(rl.check('u').allowed).toBe(true);
    expect(rl.check('u').allowed).toBe(false);
    now = 1_001;
    expect(rl.check('u').allowed).toBe(true);
  });
});
