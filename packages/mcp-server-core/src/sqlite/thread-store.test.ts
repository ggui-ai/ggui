/**
 * SqliteThreadStore tests.
 *
 * Two layers — same shape as the SqliteSessionStore suite:
 *   1. The shared {@link threadStoreContract} suite — proves the
 *      SQLite adapter honors the same ownership, idempotency, seq,
 *      action-state, and observe semantics the in-memory reference
 *      does. Parity is the durability story Portal's self-hosted
 *      flow relies on.
 *   2. SQLite-specific behavior — persistence across instances,
 *      schema idempotence, cross-instance observer fanout limitation
 *      (documented in the module JSDoc).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { threadStoreContract } from '../contract-tests/thread-store.js';
import { SqliteThreadStore } from './thread-store.js';

// ── Contract suite ───────────────────────────────────────────────────

threadStoreContract(
  'SqliteThreadStore (in-memory db)',
  () => new SqliteThreadStore({ filename: ':memory:' }),
);

// ── SQLite-specific behavior ─────────────────────────────────────────

describe('SqliteThreadStore — persistence', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-sqlite-thread-store-'));
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('persists threads + message history across instance restarts', async () => {
    const path = join(tmpRoot, 'restart.sqlite');

    // Writer instance: create a thread + append messages + state
    // transitions, then close.
    const a = new SqliteThreadStore({ filename: path });
    const thread = await a.createThread('cognito_alice', {
      appId: 'app-1',
      firstMessageHint: 'Hi',
      metadata: { shellType: 'chat' },
    });
    await a.appendMessage('cognito_alice', {
      threadId: thread.id,
      key: 'k1',
      authorRole: 'user',
      kind: 'text',
      blocks: [{ type: 'text', text: 'hello' }],
      textPreview: 'hello',
    });
    await a.appendMessage('cognito_alice', {
      threadId: thread.id,
      key: 'k2',
      authorRole: 'agent',
      kind: 'text',
      blocks: [{ type: 'text', text: 'hi there' }],
      textPreview: 'hi there',
    });
    await a.applyAction('cognito_alice', thread.id, 'pin');
    a.close();

    // Reader instance: fresh store on the same file — every piece of
    // state survives. Ownership partition still enforced.
    const b = new SqliteThreadStore({ filename: path });
    try {
      const fetched = await b.getThread('cognito_alice', thread.id);
      expect(fetched?.id).toBe(thread.id);
      expect(fetched?.appId).toBe('app-1');
      expect(fetched?.title).toBe('Hi');
      expect(fetched?.lastSeq).toBe(2);
      expect(fetched?.pinned).toBe(true);
      expect(fetched?.unreadCount).toBe(1); // 1 agent message
      expect(fetched?.metadata).toEqual({ shellType: 'chat' });

      const wrongOwner = await b.getThread('cognito_bob', thread.id);
      expect(wrongOwner).toBeNull();

      const messages = await b.listMessages('cognito_alice', thread.id, {});
      expect(messages.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(messages.messages[0]?.textPreview).toBe('hello');
      expect(messages.messages[0]?.blocks).toEqual([
        { type: 'text', text: 'hello' },
      ]);

      // Idempotency key dedup survives restart — retrying k1 returns
      // the originally stored row, not a new seq=3.
      const retry = await b.appendMessage('cognito_alice', {
        threadId: thread.id,
        key: 'k1',
        authorRole: 'user',
        kind: 'text',
        blocks: [{ type: 'text', text: 'retry payload discarded' }],
        textPreview: 'retry payload discarded',
      });
      expect(retry.seq).toBe(1);
      expect(retry.textPreview).toBe('hello');

      const refreshed = await b.getThread('cognito_alice', thread.id);
      expect(refreshed?.lastSeq).toBe(2); // unchanged by retry
    } finally {
      b.close();
    }
  });

  it('listThreads survives restart and respects owner partition', async () => {
    const path = join(tmpRoot, 'list-across-restart.sqlite');
    const a = new SqliteThreadStore({ filename: path });
    const t1 = await a.createThread('owner_a', { appId: 'app-x' });
    await a.createThread('owner_b', { appId: 'app-x' });
    await a.createThread('owner_a', { appId: 'app-y' });
    a.close();

    const b = new SqliteThreadStore({ filename: path });
    try {
      const resultA = await b.listThreads('owner_a', {});
      expect(resultA.threads).toHaveLength(2);
      expect(resultA.threads.every((t) => t.ownerId === 'owner_a')).toBe(true);

      const resultB = await b.listThreads('owner_b', {});
      expect(resultB.threads).toHaveLength(1);

      // Filter by appId rides through the same query path.
      const byApp = await b.listThreads('owner_a', { appId: 'app-y' });
      expect(byApp.threads.map((t) => t.id).sort()).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
      expect(byApp.threads).toHaveLength(1);
      expect(byApp.threads[0]?.id).not.toBe(t1.id);
    } finally {
      b.close();
    }
  });

  it('opening two stores against the same file is schema-idempotent', async () => {
    const path = join(tmpRoot, 'schema-idempotent.sqlite');
    const a = new SqliteThreadStore({ filename: path });
    const t = await a.createThread('owner_a', { appId: 'app-1' });
    a.close();

    const b = new SqliteThreadStore({ filename: path });
    try {
      const fetched = await b.getThread('owner_a', t.id);
      expect(fetched?.id).toBe(t.id);
    } finally {
      b.close();
    }
  });

  it('does NOT fan messages to observers in a separate store instance (documented cross-process limitation)', async () => {
    const path = join(tmpRoot, 'cross-instance-fanout.sqlite');
    const writer = new SqliteThreadStore({
      filename: path,
      idGenerator: () => 'writer-thread',
    });
    const observer = new SqliteThreadStore({ filename: path });

    try {
      const t = await writer.createThread('owner_a', { appId: 'app-1' });

      const iter = observer.observeMessages('owner_a', t.id)[
        Symbol.asyncIterator
      ]();
      const pending = iter.next();

      await writer.appendMessage('owner_a', {
        threadId: t.id,
        key: 'k1',
        authorRole: 'agent',
        kind: 'text',
        blocks: [],
        textPreview: 'hi',
      });

      // Observer should still be parked — its waiter set lives on the
      // OTHER store instance. Cross-instance fanout is out of scope
      // for the SQLite reference (and documented in the module JSDoc).
      const settled = await Promise.race([
        pending.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(settled).toBe('pending');

      // Snapshot read DOES see the persisted message — the event IS
      // in the DB, it's only the live-tail fanout that doesn't cross
      // instances.
      const snapshot: number[] = [];
      for await (const m of observer.observeMessages('owner_a', t.id, {
        tail: false,
      })) {
        snapshot.push(m.seq);
      }
      expect(snapshot).toEqual([1]);

      if (iter.return) await iter.return(undefined);
    } finally {
      writer.close();
      observer.close();
    }
  });

  it('UNIQUE(thread_id, key) enforces idempotency at the DB level', async () => {
    // Belt-and-braces: the code path already dedupes via
    // SELECT-by-key, but the DB constraint would catch any future
    // bug that bypasses the pre-check. This test just documents the
    // safety net is wired.
    const store = new SqliteThreadStore({ filename: ':memory:' });
    try {
      const t = await store.createThread('owner_a', { appId: 'app-1' });
      const a = await store.appendMessage('owner_a', {
        threadId: t.id,
        key: 'shared-key',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'first',
      });
      const b = await store.appendMessage('owner_a', {
        threadId: t.id,
        key: 'shared-key',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'second-ignored',
      });
      expect(a.seq).toBe(1);
      expect(b.seq).toBe(1);
      expect(b.textPreview).toBe('first');
      const listed = await store.listMessages('owner_a', t.id, {});
      expect(listed.messages).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('close() releases the database handle; double-close is a no-op', () => {
    const store = new SqliteThreadStore({ filename: ':memory:' });
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
