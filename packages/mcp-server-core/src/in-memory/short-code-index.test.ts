import { describe, expect, it } from 'vitest';
import { InMemoryShortCodeIndex } from './short-code-index.js';

describe('InMemoryShortCodeIndex', () => {
  it('lookup returns null for unknown shortCode', async () => {
    const idx = new InMemoryShortCodeIndex();
    expect(await idx.lookup('nope')).toBeNull();
  });

  it('put + lookup round-trip preserves the binding', async () => {
    const idx = new InMemoryShortCodeIndex();
    await idx.put('abc12345', { sessionId: 'r1', appId: 'a1' });
    const bound = await idx.lookup('abc12345');
    expect(bound).toEqual({ sessionId: 'r1', appId: 'a1' });
  });

  it('put is idempotent — replaces existing binding', async () => {
    const idx = new InMemoryShortCodeIndex();
    await idx.put('abc', { sessionId: 'r1', appId: 'a1' });
    await idx.put('abc', { sessionId: 'r2', appId: 'a2' });
    expect(await idx.lookup('abc')).toEqual({
      sessionId: 'r2',
      appId: 'a2',
    });
  });

  it('lookup returns a defensive copy', async () => {
    const idx = new InMemoryShortCodeIndex();
    await idx.put('abc', { sessionId: 'r1', appId: 'a1' });
    const first = await idx.lookup('abc');
    expect(first).not.toBeNull();
    (first as { sessionId: string }).sessionId = 'mutated';
    const second = await idx.lookup('abc');
    expect(second?.sessionId).toBe('r1');
  });

  it('rejects empty shortCode on put', async () => {
    const idx = new InMemoryShortCodeIndex();
    await expect(
      idx.put('', { sessionId: 'r1', appId: 'a1' }),
    ).rejects.toThrow(/shortCode/i);
  });

  it('tracks per-key entries via size', async () => {
    const idx = new InMemoryShortCodeIndex();
    expect(idx.size).toBe(0);
    await idx.put('a', { sessionId: 'r1', appId: 'app' });
    await idx.put('b', { sessionId: 'r2', appId: 'app' });
    expect(idx.size).toBe(2);
    // Same-key put does not grow.
    await idx.put('a', { sessionId: 'r3', appId: 'app' });
    expect(idx.size).toBe(2);
  });

  describe('findBySessionId', () => {
    // Reverse-lookup seam added for the console /renders page —
    // operator-facing list rows need to resolve "what's the current
    // shortCode for this render?" without iterating the whole index.
    it('returns null for an unknown sessionId', async () => {
      const idx = new InMemoryShortCodeIndex();
      expect(await idx.findBySessionId('nope')).toBeNull();
    });

    it('returns null for an empty sessionId', async () => {
      const idx = new InMemoryShortCodeIndex();
      expect(await idx.findBySessionId('')).toBeNull();
    });

    it('returns the shortCode after a put', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('abc12345', { sessionId: 'r1', appId: 'app' });
      expect(await idx.findBySessionId('r1')).toBe('abc12345');
    });

    it('returns the latest shortCode when a render gets rebound under a new one', async () => {
      // Agents can render multiple blueprints under the same sessionId;
      // each render mints a new shortCode. The reverse side is last-
      // writer-wins (the renders page shows ONE current shortCode per
      // row), while the forward side keeps old shortCodes valid.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('first0000', { sessionId: 'r1', appId: 'app' });
      await idx.put('secnd0000', { sessionId: 'r1', appId: 'app' });
      expect(await idx.findBySessionId('r1')).toBe('secnd0000');
      // Old shortCode still resolves forward — operators who typed
      // the first one before the rebind still land correctly.
      expect(await idx.lookup('first0000')).toEqual({
        sessionId: 'r1',
        appId: 'app',
      });
    });

    it('cleans up a stale reverse entry when a shortCode is rebound to a different render', async () => {
      // Rebind hygiene: if shortCode "x" was bound to r1 and then
      // rebound to r2, findBySessionId('r1') must not keep returning
      // "x" — its only binding on the forward side now points at r2,
      // so the reverse entry for r1 is orphaned and must go.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('share123', { sessionId: 'r1', appId: 'app' });
      expect(await idx.findBySessionId('r1')).toBe('share123');
      await idx.put('share123', { sessionId: 'r2', appId: 'app' });
      expect(await idx.findBySessionId('r1')).toBeNull();
      expect(await idx.findBySessionId('r2')).toBe('share123');
    });

    it('leaves r1 reverse entry alone when r1 also owns a different shortCode', async () => {
      // Edge case of rebind-hygiene: if r1 has TWO historical
      // shortCodes (A and B) and A gets rebound to r2, r1's reverse
      // entry already points at B (the later render), so it must stay
      // intact.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', { sessionId: 'r1', appId: 'app' });
      await idx.put('bbbb2222', { sessionId: 'r1', appId: 'app' });
      // r1 reverse now → 'bbbb2222'
      await idx.put('aaaa1111', { sessionId: 'r2', appId: 'app' });
      // Rebinding 'aaaa1111' away from r1 MUST NOT wipe r1's
      // reverse entry — it doesn't point at 'aaaa1111' anymore.
      expect(await idx.findBySessionId('r1')).toBe('bbbb2222');
      expect(await idx.findBySessionId('r2')).toBe('aaaa1111');
    });
  });

  describe('revoke', () => {
    // Capability-URL hardening: revocation kills outstanding /r/<code>
    // URLs when the originating render pops/closes.
    it('revoke makes a previously bound shortCode resolve to null', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('abc12345', { sessionId: 'r1', appId: 'app' });
      await idx.revoke('abc12345');
      expect(await idx.lookup('abc12345')).toBeNull();
      expect(await idx.findBySessionId('r1')).toBeNull();
    });

    it('revoke is idempotent — no-op on unknown shortCode', async () => {
      const idx = new InMemoryShortCodeIndex();
      await expect(idx.revoke('does-not-exist')).resolves.toBeUndefined();
      await expect(idx.revoke('')).resolves.toBeUndefined();
    });

    it('revoke leaves the reverse entry alone if it has since been rebound', async () => {
      // Defense-in-depth: we revoke ONE code, not the render. If the
      // render got another shortCode in the meantime, that one stays
      // valid both forward and reverse.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('first000', { sessionId: 'r1', appId: 'app' });
      await idx.put('second00', { sessionId: 'r1', appId: 'app' });
      // Reverse now → 'second00'
      await idx.revoke('first000');
      expect(await idx.lookup('first000')).toBeNull();
      expect(await idx.lookup('second00')).not.toBeNull();
      expect(await idx.findBySessionId('r1')).toBe('second00');
    });
  });

  describe('revokeBySessionId', () => {
    // Used when a render is forcibly torn down (e.g. operator
    // GC or quota eviction) — every /r/<code> URL bound to that
    // render stops resolving the moment the render is dropped.
    it('drops every binding for the render and returns the count', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', { sessionId: 'r1', appId: 'app' });
      await idx.put('bbbb2222', { sessionId: 'r1', appId: 'app' });
      await idx.put('cccc3333', { sessionId: 'r2', appId: 'app' });
      expect(await idx.revokeBySessionId('r1')).toBe(2);
      expect(await idx.lookup('aaaa1111')).toBeNull();
      expect(await idx.lookup('bbbb2222')).toBeNull();
      expect(await idx.findBySessionId('r1')).toBeNull();
      // Different render untouched.
      expect(await idx.lookup('cccc3333')).not.toBeNull();
      expect(await idx.findBySessionId('r2')).toBe('cccc3333');
    });

    it('returns 0 on unknown sessionId, no throw', async () => {
      const idx = new InMemoryShortCodeIndex();
      expect(await idx.revokeBySessionId('ghost')).toBe(0);
      expect(await idx.revokeBySessionId('')).toBe(0);
    });
  });
});
