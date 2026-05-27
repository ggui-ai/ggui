import { describe, expect, it } from 'vitest';
import { InMemoryShortCodeIndex } from './short-code-index.js';

describe('InMemoryShortCodeIndex', () => {
  it('lookup returns null for unknown shortCode', async () => {
    const idx = new InMemoryShortCodeIndex();
    expect(await idx.lookup('nope')).toBeNull();
  });

  it('put + lookup round-trip preserves the binding', async () => {
    const idx = new InMemoryShortCodeIndex();
    await idx.put('abc12345', { sessionId: 's1', appId: 'a1' });
    const bound = await idx.lookup('abc12345');
    expect(bound).toEqual({ sessionId: 's1', appId: 'a1' });
  });

  it('put is idempotent — replaces existing binding', async () => {
    const idx = new InMemoryShortCodeIndex();
    await idx.put('abc', { sessionId: 's1', appId: 'a1' });
    await idx.put('abc', { sessionId: 's2', appId: 'a2' });
    expect(await idx.lookup('abc')).toEqual({
      sessionId: 's2',
      appId: 'a2',
    });
  });

  it('lookup returns a defensive copy', async () => {
    const idx = new InMemoryShortCodeIndex();
    await idx.put('abc', { sessionId: 's1', appId: 'a1' });
    const first = await idx.lookup('abc');
    expect(first).not.toBeNull();
    (first as { sessionId: string }).sessionId = 'mutated';
    const second = await idx.lookup('abc');
    expect(second?.sessionId).toBe('s1');
  });

  it('rejects empty shortCode on put', async () => {
    const idx = new InMemoryShortCodeIndex();
    await expect(
      idx.put('', { sessionId: 's1', appId: 'a1' }),
    ).rejects.toThrow(/shortCode/i);
  });

  it('tracks per-key entries via size', async () => {
    const idx = new InMemoryShortCodeIndex();
    expect(idx.size).toBe(0);
    await idx.put('a', { sessionId: 's1', appId: 'app' });
    await idx.put('b', { sessionId: 's2', appId: 'app' });
    expect(idx.size).toBe(2);
    // Same-key put does not grow.
    await idx.put('a', { sessionId: 's3', appId: 'app' });
    expect(idx.size).toBe(2);
  });

  describe('findBySessionId', () => {
    // Reverse-lookup seam added for the console /sessions page —
    // operator-facing list rows need to resolve "what's the current
    // shortCode for this session?" without iterating the whole index.
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
      await idx.put('abc12345', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('abc12345');
    });

    it('returns the latest shortCode when a session gets rebound under a new one', async () => {
      // Agents can push multiple blueprints on the same session; each
      // push mints a new shortCode. The reverse side is last-writer-
      // wins (the sessions page shows ONE current shortCode per row),
      // while the forward side keeps old shortCodes valid.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('first0000', { sessionId: 's1', appId: 'app' });
      await idx.put('secnd0000', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('secnd0000');
      // Old shortCode still resolves forward — operators who typed
      // the first one before the rebind still land correctly.
      expect(await idx.lookup('first0000')).toEqual({
        sessionId: 's1',
        appId: 'app',
      });
    });

    it('cleans up a stale reverse entry when a shortCode is rebound to a different session', async () => {
      // Rebind hygiene: if shortCode "x" was bound to s1 and then
      // rebound to s2, findBySessionId('s1') must not keep returning
      // "x" — its only binding on the forward side now points at s2,
      // so the reverse entry for s1 is orphaned and must go.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('share123', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('share123');
      await idx.put('share123', { sessionId: 's2', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBeNull();
      expect(await idx.findBySessionId('s2')).toBe('share123');
    });

    it('leaves s1 reverse entry alone when s1 also owns a different shortCode', async () => {
      // Edge case of rebind-hygiene: if s1 has TWO historical
      // shortCodes (A and B) and A gets rebound to s2, s1's reverse
      // entry already points at B (the later push), so it must stay
      // intact.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', { sessionId: 's1', appId: 'app' });
      await idx.put('bbbb2222', { sessionId: 's1', appId: 'app' });
      // s1 reverse now → 'bbbb2222'
      await idx.put('aaaa1111', { sessionId: 's2', appId: 'app' });
      // Rebinding 'aaaa1111' away from s1 MUST NOT wipe s1's
      // reverse entry — it doesn't point at 'aaaa1111' anymore.
      expect(await idx.findBySessionId('s1')).toBe('bbbb2222');
      expect(await idx.findBySessionId('s2')).toBe('aaaa1111');
    });
  });

  describe('revoke', () => {
    // Capability-URL hardening: revocation kills outstanding /r/<code>
    // URLs when the originating session pops/closes.
    it('revoke makes a previously bound shortCode resolve to null', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('abc12345', { sessionId: 's1', appId: 'app' });
      await idx.revoke('abc12345');
      expect(await idx.lookup('abc12345')).toBeNull();
      expect(await idx.findBySessionId('s1')).toBeNull();
    });

    it('revoke is idempotent — no-op on unknown shortCode', async () => {
      const idx = new InMemoryShortCodeIndex();
      await expect(idx.revoke('does-not-exist')).resolves.toBeUndefined();
      await expect(idx.revoke('')).resolves.toBeUndefined();
    });

    it('revoke leaves the reverse entry alone if it has since been rebound', async () => {
      // Defense-in-depth: we revoke ONE code, not the session. If the
      // session got another shortCode in the meantime, that one stays
      // valid both forward and reverse.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('first000', { sessionId: 's1', appId: 'app' });
      await idx.put('second00', { sessionId: 's1', appId: 'app' });
      // Reverse now → 'second00'
      await idx.revoke('first000');
      expect(await idx.lookup('first000')).toBeNull();
      expect(await idx.lookup('second00')).not.toBeNull();
      expect(await idx.findBySessionId('s1')).toBe('second00');
    });
  });

  describe('revokeBySessionId', () => {
    // Used by ggui_close — every /r/<code> URL bound to a closed
    // session stops resolving the moment the session is marked done.
    it('drops every binding for the session and returns the count', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', { sessionId: 's1', appId: 'app' });
      await idx.put('bbbb2222', { sessionId: 's1', appId: 'app' });
      await idx.put('cccc3333', { sessionId: 's2', appId: 'app' });
      expect(await idx.revokeBySessionId('s1')).toBe(2);
      expect(await idx.lookup('aaaa1111')).toBeNull();
      expect(await idx.lookup('bbbb2222')).toBeNull();
      expect(await idx.findBySessionId('s1')).toBeNull();
      // Different session untouched.
      expect(await idx.lookup('cccc3333')).not.toBeNull();
      expect(await idx.findBySessionId('s2')).toBe('cccc3333');
    });

    it('returns 0 on unknown sessionId, no throw', async () => {
      const idx = new InMemoryShortCodeIndex();
      expect(await idx.revokeBySessionId('ghost')).toBe(0);
      expect(await idx.revokeBySessionId('')).toBe(0);
    });
  });

  describe('revokeByStackItemId', () => {
    // Used by per-render close paths — the URL pointing at the closed
    // render stops resolving, but OTHER renders sharing the same host
    // conversation keep their URLs valid.
    it('drops only the binding(s) tied to the stackItemId', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', {
        sessionId: 's1',
        appId: 'app',
        stackItemId: 'stk_a',
      });
      await idx.put('bbbb2222', {
        sessionId: 's1',
        appId: 'app',
        stackItemId: 'stk_b',
      });
      expect(await idx.revokeByStackItemId('stk_a')).toBe(1);
      expect(await idx.lookup('aaaa1111')).toBeNull();
      // The OTHER render's URL stays valid — the host conversation
      // is still alive.
      expect(await idx.lookup('bbbb2222')).not.toBeNull();
      // Reverse pointer falls back to the surviving code if it had
      // been pointing at the revoked one; the test above ordered the
      // puts so the reverse points at 'bbbb2222' already.
      expect(await idx.findBySessionId('s1')).toBe('bbbb2222');
    });

    it('returns 0 on unknown stackItemId or empty input', async () => {
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', {
        sessionId: 's1',
        appId: 'app',
        stackItemId: 'stk_a',
      });
      expect(await idx.revokeByStackItemId('stk_ghost')).toBe(0);
      expect(await idx.revokeByStackItemId('')).toBe(0);
      // Original still resolves.
      expect(await idx.lookup('aaaa1111')).not.toBeNull();
    });

    it('clears the reverse pointer when the revoked code WAS the latest', async () => {
      // If 'aaaa1111' was the latest binding for s1 (so reverse →
      // 'aaaa1111') and we revoke it by stackItem, the reverse must
      // not keep returning the dead code.
      const idx = new InMemoryShortCodeIndex();
      await idx.put('aaaa1111', {
        sessionId: 's1',
        appId: 'app',
        stackItemId: 'stk_a',
      });
      expect(await idx.findBySessionId('s1')).toBe('aaaa1111');
      expect(await idx.revokeByStackItemId('stk_a')).toBe(1);
      expect(await idx.findBySessionId('s1')).toBeNull();
    });
  });
});
