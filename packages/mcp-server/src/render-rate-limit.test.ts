import { describe, expect, it } from 'vitest';
import {
  createInMemoryRenderRateLimiter,
  maskShortCode,
} from './render-rate-limit.js';

describe('createInMemoryRenderRateLimiter', () => {
  it('allows the first `limit` hits and rejects the next', () => {
    const t = 0;
    const rl = createInMemoryRenderRateLimiter({
      windowSeconds: 60,
      limit: 3,
      now: () => t,
    });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    const fourth = rl.check('a');
    expect(fourth.allowed).toBe(false);
    if (!fourth.allowed) {
      expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
      expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60);
    }
  });

  it('opens a fresh window after the rolling period elapses', () => {
    let t = 0;
    const rl = createInMemoryRenderRateLimiter({
      windowSeconds: 60,
      limit: 2,
      now: () => t,
    });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    // Jump past the window.
    t += 60_001;
    // First hit in the new window is allowed.
    expect(rl.check('a').allowed).toBe(true);
  });

  it('rate-limits each shortCode independently', () => {
    const t = 0;
    const rl = createInMemoryRenderRateLimiter({
      windowSeconds: 60,
      limit: 2,
      now: () => t,
    });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    // Different code → fresh bucket.
    expect(rl.check('b').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(false);
  });

  it('returns retryAfterSeconds that decreases as time advances within the same window', () => {
    let t = 0;
    const rl = createInMemoryRenderRateLimiter({
      windowSeconds: 60,
      limit: 1,
      now: () => t,
    });
    rl.check('a');
    const r1 = rl.check('a');
    if (!r1.allowed) {
      const first = r1.retryAfterSeconds;
      t += 30_000;
      const r2 = rl.check('a');
      if (!r2.allowed) {
        expect(r2.retryAfterSeconds).toBeLessThan(first);
      }
    }
  });

  it('empty shortCode falls through as allowed (upstream owns validation)', () => {
    const rl = createInMemoryRenderRateLimiter();
    expect(rl.check('').allowed).toBe(true);
  });
});

describe('maskShortCode', () => {
  // Log hygiene: full shortCode is the credential. Mask aggressively.
  it('masks long codes to 3 chars + ***', () => {
    expect(maskShortCode('abcdefgh12345678')).toBe('abc***');
  });

  it('still masks short codes (degenerate input)', () => {
    expect(maskShortCode('abc')).toBe('abc***');
    expect(maskShortCode('ab')).toBe('ab***');
  });

  it('returns <empty> on empty input', () => {
    expect(maskShortCode('')).toBe('<empty>');
  });
});
