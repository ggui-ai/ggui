import { describe, expect, it } from 'vitest';
import { createRenderSigner } from './render-signing.js';

describe('createRenderSigner', () => {
  it('round-trips a freshly-signed shortCode', () => {
    const s = createRenderSigner({ secret: 'a'.repeat(64) });
    const { sig, exp } = s.sign('code-1');
    expect(
      s.verify({ shortCode: 'code-1', sig, exp: String(exp) }).ok,
    ).toBe(true);
  });

  it('rejects a tampered shortCode (same sig, different code)', () => {
    const s = createRenderSigner({ secret: 'b'.repeat(64) });
    const { sig, exp } = s.sign('code-1');
    const result = s.verify({
      shortCode: 'code-2',
      sig,
      exp: String(exp),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects a tampered exp (same sig, different ts)', () => {
    const s = createRenderSigner({ secret: 'c'.repeat(64) });
    const { sig, exp } = s.sign('code-1');
    const result = s.verify({
      shortCode: 'code-1',
      sig,
      exp: String(exp + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects an expired URL', () => {
    // Inject a clock + force expiry in the past.
    let now = 1_700_000_000_000;
    const s = createRenderSigner({
      secret: 'd'.repeat(64),
      ttlSeconds: 60,
      now: () => now,
    });
    const { sig, exp } = s.sign('code-1');
    expect(
      s.verify({ shortCode: 'code-1', sig, exp: String(exp) }).ok,
    ).toBe(true);
    // Jump past expiry.
    now += 120_000;
    const result = s.verify({
      shortCode: 'code-1',
      sig,
      exp: String(exp),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('expired');
  });

  it('returns malformed on missing sig or exp', () => {
    const s = createRenderSigner({ secret: 'e'.repeat(64) });
    expect(
      s.verify({ shortCode: 'x', sig: undefined, exp: '1700000000' }).ok,
    ).toBe(false);
    expect(
      s.verify({ shortCode: 'x', sig: 'aabb', exp: undefined }).ok,
    ).toBe(false);
    expect(
      s.verify({ shortCode: 'x', sig: 'aabb', exp: 'not-a-number' }).ok,
    ).toBe(false);
  });

  it('rejects a sig signed with a different secret (nuclear-rotate semantics)', () => {
    const s1 = createRenderSigner({ secret: 'f'.repeat(64) });
    const s2 = createRenderSigner({ secret: 'g'.repeat(64) });
    const { sig, exp } = s1.sign('code-x');
    // After secret rotation, EVERY outstanding URL fails — that's the
    // operational property C.2 wants. Operator restart with a new
    // explicit secret = global revoke.
    const result = s2.verify({
      shortCode: 'code-x',
      sig,
      exp: String(exp),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('rejects sig with mismatched length without timing leak', () => {
    const s = createRenderSigner({ secret: 'h'.repeat(64) });
    const { exp } = s.sign('code-1');
    const result = s.verify({
      shortCode: 'code-1',
      sig: 'short',
      exp: String(exp),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_signature');
  });

  it('auto-generates a fresh secret per signer when none is supplied', () => {
    // Property: two signers built without explicit secrets produce
    // sigs that don't validate against each other (different secrets).
    const s1 = createRenderSigner();
    const s2 = createRenderSigner();
    const { sig, exp } = s1.sign('code-1');
    const result = s2.verify({
      shortCode: 'code-1',
      sig,
      exp: String(exp),
    });
    expect(result.ok).toBe(false);
  });

  it('honors a per-call TTL override', () => {
    const now = 1_700_000_000_000;
    const s = createRenderSigner({
      secret: 'i'.repeat(64),
      ttlSeconds: 60,
      now: () => now,
    });
    const { exp } = s.sign('code-1', 3600);
    // exp should reflect the override (3600s), not the default (60s).
    const expectedExp = Math.floor(now / 1000) + 3600;
    expect(exp).toBe(expectedExp);
  });

  it('toQuerySuffix produces a clean `sig=...&exp=...` string', () => {
    const s = createRenderSigner({ secret: 'j'.repeat(64) });
    const suffix = s.toQuerySuffix({ sig: 'abc', exp: 42 });
    expect(suffix).toBe('sig=abc&exp=42');
  });
});
