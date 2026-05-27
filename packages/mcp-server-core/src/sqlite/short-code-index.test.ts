import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteShortCodeIndex } from './short-code-index.js';

function freshFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ggui-sqlite-shortcodes-')), 'idx.sqlite');
}

describe('SqliteShortCodeIndex', () => {
  // Mirrors the InMemoryShortCodeIndex contract suite. Persistence
  // behavior (survives close + reopen) lives in its own block below;
  // every other test uses `:memory:` for speed.

  it('lookup returns null for unknown shortCode', async () => {
    const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
    expect(await idx.lookup('nope')).toBeNull();
    idx.close();
  });

  it('put + lookup round-trip preserves the binding', async () => {
    const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
    await idx.put('abc12345', { sessionId: 's1', appId: 'a1' });
    expect(await idx.lookup('abc12345')).toEqual({
      sessionId: 's1',
      appId: 'a1',
    });
    idx.close();
  });

  it('persists stackItemId when present', async () => {
    const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
    await idx.put('abc', { sessionId: 's1', appId: 'app', stackItemId: 'stk_a' });
    expect(await idx.lookup('abc')).toEqual({
      sessionId: 's1',
      appId: 'app',
      stackItemId: 'stk_a',
    });
    idx.close();
  });

  it('omits stackItemId from the binding when absent on insert', async () => {
    // The InMemory reference omits the `stackItemId` key entirely when
    // the writer didn't pass one. Downstream consumers diff bindings
    // by key set, so the sqlite impl must honor the same shape (null
    // in storage → undefined on the way out).
    const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
    await idx.put('abc', { sessionId: 's1', appId: 'app' });
    const bound = await idx.lookup('abc');
    expect(bound).toEqual({ sessionId: 's1', appId: 'app' });
    expect(Object.prototype.hasOwnProperty.call(bound, 'stackItemId')).toBe(false);
    idx.close();
  });

  it('put is idempotent — replaces existing binding', async () => {
    const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
    await idx.put('abc', { sessionId: 's1', appId: 'a1' });
    await idx.put('abc', { sessionId: 's2', appId: 'a2' });
    expect(await idx.lookup('abc')).toEqual({ sessionId: 's2', appId: 'a2' });
    idx.close();
  });

  it('rejects empty shortCode on put', async () => {
    const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
    await expect(
      idx.put('', { sessionId: 's1', appId: 'a1' }),
    ).rejects.toThrow(/shortCode/i);
    idx.close();
  });

  describe('findBySessionId', () => {
    it('returns null for an unknown sessionId', async () => {
      const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
      expect(await idx.findBySessionId('nope')).toBeNull();
      idx.close();
    });

    it('returns null for an empty sessionId', async () => {
      const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
      expect(await idx.findBySessionId('')).toBeNull();
      idx.close();
    });

    it('returns the shortCode after a put', async () => {
      let t = 1000;
      const idx = new SqliteShortCodeIndex({
        filename: ':memory:',
        now: () => t++,
      });
      await idx.put('abc12345', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('abc12345');
      idx.close();
    });

    it('returns the latest shortCode (ORDER BY created_at DESC) for a session with multiple pushes', async () => {
      // The InMemory reference uses Map-insertion order; sqlite needs
      // an explicit `created_at` column to give the same answer
      // across restarts. Inject `now` so the ordering is deterministic
      // regardless of clock resolution.
      let t = 1000;
      const idx = new SqliteShortCodeIndex({
        filename: ':memory:',
        now: () => t++,
      });
      await idx.put('first0000', { sessionId: 's1', appId: 'app' });
      await idx.put('secnd0000', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('secnd0000');
      // Old shortCode still resolves forward (per the contract).
      expect(await idx.lookup('first0000')).toEqual({
        sessionId: 's1',
        appId: 'app',
      });
      idx.close();
    });

    it('cleans up the reverse view when a shortCode is rebound to a different session', async () => {
      // Rebind hygiene contract from the InMemory reference: if
      // shortCode "share123" was bound to s1 and then rebound to s2,
      // findBySessionId('s1') must NOT keep returning "share123" — the
      // forward row now belongs to s2. The sqlite impl gets this via
      // INSERT OR REPLACE updating the session_id column in place; the
      // `selectLatestBySession` query for s1 then matches no rows.
      let t = 1000;
      const idx = new SqliteShortCodeIndex({
        filename: ':memory:',
        now: () => t++,
      });
      await idx.put('share123', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('share123');
      await idx.put('share123', { sessionId: 's2', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBeNull();
      expect(await idx.findBySessionId('s2')).toBe('share123');
    });

    it('leaves s1 reverse entry alone when s1 also owns a different shortCode', async () => {
      // Edge case of rebind-hygiene: s1 has TWO historical shortCodes
      // (A and B), then A is rebound to s2. s1's reverse view should
      // still surface B because the LATEST surviving row for s1 is B.
      // The sqlite ORDER BY created_at DESC LIMIT 1 surfaces this
      // automatically.
      let t = 1000;
      const idx = new SqliteShortCodeIndex({
        filename: ':memory:',
        now: () => t++,
      });
      await idx.put('aaaa1111', { sessionId: 's1', appId: 'app' });
      await idx.put('bbbb2222', { sessionId: 's1', appId: 'app' });
      // s1 reverse now → 'bbbb2222' (later created_at)
      await idx.put('aaaa1111', { sessionId: 's2', appId: 'app' });
      // Rebinding 'aaaa1111' away from s1 must NOT collapse s1's
      // reverse view — 'bbbb2222' still belongs to s1.
      expect(await idx.findBySessionId('s1')).toBe('bbbb2222');
      expect(await idx.findBySessionId('s2')).toBe('aaaa1111');
    });

    it('moves to the next-latest binding when the latest is revoked', async () => {
      // ORDER BY created_at DESC LIMIT 1 means revoking the latest
      // promotes the next-latest binding automatically — the InMemory
      // reference handles this via its explicit reverse-map clear, but
      // sqlite gets it for free.
      let t = 1000;
      const idx = new SqliteShortCodeIndex({
        filename: ':memory:',
        now: () => t++,
      });
      await idx.put('first0000', { sessionId: 's1', appId: 'app' });
      await idx.put('secnd0000', { sessionId: 's1', appId: 'app' });
      expect(await idx.findBySessionId('s1')).toBe('secnd0000');
      await idx.revoke('secnd0000');
      expect(await idx.findBySessionId('s1')).toBe('first0000');
      idx.close();
    });
  });

  describe('revoke', () => {
    it('revoke makes a previously bound shortCode resolve to null', async () => {
      const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
      await idx.put('abc12345', { sessionId: 's1', appId: 'app' });
      await idx.revoke('abc12345');
      expect(await idx.lookup('abc12345')).toBeNull();
      expect(await idx.findBySessionId('s1')).toBeNull();
      idx.close();
    });

    it('revoke is idempotent — no-op on unknown shortCode', async () => {
      const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
      await expect(idx.revoke('does-not-exist')).resolves.toBeUndefined();
      await expect(idx.revoke('')).resolves.toBeUndefined();
      idx.close();
    });
  });

  describe('revokeBySessionId', () => {
    it('drops every binding for the session and returns the count', async () => {
      const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
      await idx.put('aaaa1111', { sessionId: 's1', appId: 'app' });
      await idx.put('bbbb2222', { sessionId: 's1', appId: 'app' });
      await idx.put('cccc3333', { sessionId: 's2', appId: 'app' });
      expect(await idx.revokeBySessionId('s1')).toBe(2);
      expect(await idx.lookup('aaaa1111')).toBeNull();
      expect(await idx.lookup('bbbb2222')).toBeNull();
      expect(await idx.findBySessionId('s1')).toBeNull();
      expect(await idx.lookup('cccc3333')).not.toBeNull();
      expect(await idx.findBySessionId('s2')).toBe('cccc3333');
      idx.close();
    });

    it('returns 0 on unknown sessionId, no throw', async () => {
      const idx = new SqliteShortCodeIndex({ filename: ':memory:' });
      expect(await idx.revokeBySessionId('ghost')).toBe(0);
      expect(await idx.revokeBySessionId('')).toBe(0);
      idx.close();
    });
  });

  describe('persistence across reopen', () => {
    // The point of the sqlite impl. A fresh handle opened against the
    // same file resumes the prior state — closing and reopening must
    // expose identical lookup + findBySessionId behavior.
    it('a binding survives close + reopen on a real file', async () => {
      const filename = freshFile();
      const first = new SqliteShortCodeIndex({ filename });
      await first.put('persist1', {
        sessionId: 's1',
        appId: 'app',
        stackItemId: 'stk_a',
      });
      first.close();

      const second = new SqliteShortCodeIndex({ filename });
      expect(await second.lookup('persist1')).toEqual({
        sessionId: 's1',
        appId: 'app',
        stackItemId: 'stk_a',
      });
      expect(await second.findBySessionId('s1')).toBe('persist1');
      second.close();
    });

    it('revoke also persists — second open sees the deletion', async () => {
      const filename = freshFile();
      const first = new SqliteShortCodeIndex({ filename });
      await first.put('persist2', { sessionId: 's1', appId: 'app' });
      await first.revoke('persist2');
      first.close();

      const second = new SqliteShortCodeIndex({ filename });
      expect(await second.lookup('persist2')).toBeNull();
      second.close();
    });
  });
});
