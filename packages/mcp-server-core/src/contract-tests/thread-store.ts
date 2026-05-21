/**
 * Contract test factory for {@link ThreadStore} implementations.
 *
 * Every implementation (in-memory reference, SQLite reference, SaaS
 * AppSync binding, future Postgres adapter) MUST import this factory
 * from `@ggui-ai/mcp-server-core/contract-tests` and pass it. If a
 * test here is wrong, fix it here — don't branch on implementation.
 * That invariant is what makes the store boundary load-bearing.
 *
 * What this suite locks (matches the normative-semantics block in
 * `thread-store.ts`):
 *
 *   - createThread seeds the required state + sequencing fields.
 *   - getThread returns null for the wrong owner (ownership = partition).
 *   - listThreads only surfaces the caller's threads, most-recent first.
 *   - appendMessage assigns seq monotonically + gap-free from 1.
 *   - appendMessage is idempotent on (threadId, key) — first-write-wins.
 *   - Append by a non-user author bumps unreadCount; user author does not.
 *   - mark_read zeroes unreadCount.
 *   - listMessages returns ASC by seq + respects fromSeq.
 *   - applyAction accepts exactly the 9 ThreadStateAction strings.
 *   - Idempotent no-op actions do not bump updatedAt.
 *   - State-changing actions do bump updatedAt.
 *   - restore requires pending_delete; archive/unarchive reject on pending_delete.
 *   - observeMessages replays historical + tails new appends.
 *   - observeMessages on a wrong-owner / missing thread throws not-found
 *     from the iterator's first pull.
 *   - All mutation methods reject on wrong-owner with not-found.
 */
import { describe, expect, it } from 'vitest';
import {
  InvalidThreadActionError,
  ThreadActionInvalidStateError,
  ThreadNotFoundError,
  type ThreadStore,
} from '../thread-store.js';
import type {
  AppendThreadMessageInput,
  ThreadMessage,
  ThreadStateAction,
} from '@ggui-ai/protocol';
import { THREAD_STATE_ACTIONS } from '@ggui-ai/protocol';

const OWNER_A = 'cognito_owner-a';
const OWNER_B = 'cognito_owner-b';

export function threadStoreContract(
  label: string,
  makeStore: () => Promise<ThreadStore> | ThreadStore,
): void {
  describe(`ThreadStore contract — ${label}`, () => {
    it('createThread seeds required state + sequencing fields', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, {
        appId: 'app-1',
        firstMessageHint: 'hello world',
        metadata: { shellType: 'chat' },
      });
      expect(t.appId).toBe('app-1');
      expect(t.ownerId).toBe(OWNER_A);
      expect(t.lastSeq).toBe(0);
      expect(t.unreadCount).toBe(0);
      expect(t.pinned).toBe(false);
      expect(t.muted).toBe(false);
      expect(t.status).toBe('active');
      expect(t.title).toBe('hello world');
      expect(t.metadata).toEqual({ shellType: 'chat' });
      expect(typeof t.createdAt).toBe('string');
      expect(typeof t.updatedAt).toBe('string');
      expect(t.lastMessageAt).toBeUndefined();
    });

    it('createThread without firstMessageHint leaves title undefined', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      expect(t.title).toBeUndefined();
    });

    it('getThread partitions by ownerId (wrong owner → null)', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await expect(store.getThread(OWNER_A, t.id)).resolves.not.toBeNull();
      await expect(store.getThread(OWNER_B, t.id)).resolves.toBeNull();
      await expect(store.getThread(OWNER_A, 'missing')).resolves.toBeNull();
    });

    it('listThreads only returns the caller owner threads', async () => {
      const store = await makeStore();
      const a1 = await store.createThread(OWNER_A, { appId: 'app-x' });
      const a2 = await store.createThread(OWNER_A, { appId: 'app-y' });
      await store.createThread(OWNER_B, { appId: 'app-x' });
      const res = await store.listThreads(OWNER_A, {});
      const ids = res.threads.map((t) => t.id).sort();
      expect(ids).toEqual([a1.id, a2.id].sort());
    });

    it('listThreads filters by appId and status', async () => {
      const store = await makeStore();
      const t1 = await store.createThread(OWNER_A, { appId: 'app-x' });
      const t2 = await store.createThread(OWNER_A, { appId: 'app-y' });
      await store.applyAction(OWNER_A, t2.id, 'archive');

      const byApp = await store.listThreads(OWNER_A, { appId: 'app-x' });
      expect(byApp.threads.map((t) => t.id)).toEqual([t1.id]);

      const archived = await store.listThreads(OWNER_A, {
        status: 'archived',
      });
      expect(archived.threads.map((t) => t.id)).toEqual([t2.id]);

      const active = await store.listThreads(OWNER_A, { status: 'active' });
      expect(active.threads.map((t) => t.id)).toEqual([t1.id]);
    });

    it('listThreads orders most-recently-active first', async () => {
      const store = await makeStore();
      const older = await store.createThread(OWNER_A, { appId: 'app-x' });
      const newer = await store.createThread(OWNER_A, { appId: 'app-x' });
      // Append to `older` to bump its lastMessageAt past `newer`'s
      // createdAt. (Real-world flow: an old thread receives a new
      // message and jumps to the top of the list.)
      await sleep(5);
      await appendBasic(store, OWNER_A, older.id, 'k1', 'user');
      const res = await store.listThreads(OWNER_A, {});
      expect(res.threads.map((t) => t.id)).toEqual([older.id, newer.id]);
    });

    it('listThreads honors limit + cursor round-trip', async () => {
      const store = await makeStore();
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const t = await store.createThread(OWNER_A, { appId: 'app-x' });
        ids.push(t.id);
        // Give the clock a chance to advance so ordering is stable.
        await sleep(2);
      }
      const page1 = await store.listThreads(OWNER_A, { limit: 2 });
      expect(page1.threads).toHaveLength(2);
      expect(page1.nextCursor).toBeTruthy();
      const page2 = await store.listThreads(OWNER_A, {
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.threads).toHaveLength(2);
      const page3 = await store.listThreads(OWNER_A, {
        limit: 2,
        cursor: page2.nextCursor,
      });
      expect(page3.threads).toHaveLength(1);
      expect(page3.nextCursor).toBeUndefined();

      const seen = new Set<string>();
      for (const p of [page1, page2, page3]) {
        for (const t of p.threads) seen.add(t.id);
      }
      expect(seen.size).toBe(5);
    });

    it('appendMessage assigns seq monotonically + gap-free from 1', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      const m1 = await appendBasic(store, OWNER_A, t.id, 'k1', 'user');
      const m2 = await appendBasic(store, OWNER_A, t.id, 'k2', 'agent');
      const m3 = await appendBasic(store, OWNER_A, t.id, 'k3', 'system');
      expect([m1.seq, m2.seq, m3.seq]).toEqual([1, 2, 3]);
      const fetched = await store.getThread(OWNER_A, t.id);
      expect(fetched?.lastSeq).toBe(3);
      expect(typeof fetched?.lastMessageAt).toBe('string');
    });

    it('appendMessage dedupes on (threadId, key) — first-write-wins', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      const first = await store.appendMessage(OWNER_A, {
        threadId: t.id,
        key: 'kx',
        authorRole: 'user',
        kind: 'text',
        blocks: [{ type: 'text', text: 'hello' }],
        textPreview: 'hello',
      });
      const retry = await store.appendMessage(OWNER_A, {
        threadId: t.id,
        key: 'kx',
        authorRole: 'user',
        kind: 'text',
        // Different payload — MUST be discarded.
        blocks: [{ type: 'text', text: 'different' }],
        textPreview: 'different',
      });
      expect(retry.seq).toBe(first.seq);
      expect(retry.at).toBe(first.at);
      expect(retry.textPreview).toBe('hello');
      expect(retry.blocks).toEqual([{ type: 'text', text: 'hello' }]);
      const fetched = await store.getThread(OWNER_A, t.id);
      expect(fetched?.lastSeq).toBe(1);
    });

    it('appendMessage by non-user author bumps unreadCount; user does not', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await appendBasic(store, OWNER_A, t.id, 'k1', 'user');
      let fetched = await store.getThread(OWNER_A, t.id);
      expect(fetched?.unreadCount).toBe(0);

      await appendBasic(store, OWNER_A, t.id, 'k2', 'agent');
      await appendBasic(store, OWNER_A, t.id, 'k3', 'system');
      fetched = await store.getThread(OWNER_A, t.id);
      expect(fetched?.unreadCount).toBe(2);
    });

    it('listMessages returns ASC by seq and respects fromSeq', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      for (let i = 1; i <= 5; i++) {
        await appendBasic(store, OWNER_A, t.id, `k${i}`, 'user');
      }
      const all = await store.listMessages(OWNER_A, t.id, {});
      expect(all.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);

      const fromMiddle = await store.listMessages(OWNER_A, t.id, {
        fromSeq: 3,
      });
      expect(fromMiddle.messages.map((m) => m.seq)).toEqual([3, 4, 5]);
    });

    it('listMessages limit + cursor round-trip', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      for (let i = 1; i <= 5; i++) {
        await appendBasic(store, OWNER_A, t.id, `k${i}`, 'user');
      }
      const page1 = await store.listMessages(OWNER_A, t.id, { limit: 2 });
      expect(page1.messages.map((m) => m.seq)).toEqual([1, 2]);
      expect(page1.nextCursor).toBeTruthy();

      const page2 = await store.listMessages(OWNER_A, t.id, {
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.messages.map((m) => m.seq)).toEqual([3, 4]);

      const page3 = await store.listMessages(OWNER_A, t.id, {
        limit: 2,
        cursor: page2.nextCursor,
      });
      expect(page3.messages.map((m) => m.seq)).toEqual([5]);
      expect(page3.nextCursor).toBeUndefined();
    });

    it('applyAction accepts exactly the 9 canonical actions', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      // Cycle through each canonical action that's valid from `active`.
      // (restore is tested separately because it needs pending_delete.)
      const safeOrder: ThreadStateAction[] = [
        'pin',
        'unpin',
        'mute',
        'unmute',
        'archive',
        'unarchive',
        'mark_read',
      ];
      for (const action of safeOrder) {
        await store.applyAction(OWNER_A, t.id, action);
      }
      // Every known action is in THREAD_STATE_ACTIONS.
      expect(THREAD_STATE_ACTIONS).toHaveLength(9);
      // Unknown strings reject.
      await expect(
        store.applyAction(
          OWNER_A,
          t.id,
          'snooze' as unknown as ThreadStateAction,
        ),
      ).rejects.toBeInstanceOf(InvalidThreadActionError);
    });

    it('applyAction toggles boolean state idempotently', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      const pinned = await store.applyAction(OWNER_A, t.id, 'pin');
      expect(pinned.pinned).toBe(true);
      const pinnedAgain = await store.applyAction(OWNER_A, t.id, 'pin');
      expect(pinnedAgain.pinned).toBe(true);
      // Idempotent — no updatedAt bump on the second call.
      expect(pinnedAgain.updatedAt).toBe(pinned.updatedAt);

      const unpinned = await store.applyAction(OWNER_A, t.id, 'unpin');
      expect(unpinned.pinned).toBe(false);
      const unpinnedAgain = await store.applyAction(OWNER_A, t.id, 'unpin');
      expect(unpinnedAgain.pinned).toBe(false);
      expect(unpinnedAgain.updatedAt).toBe(unpinned.updatedAt);
    });

    it('applyAction mark_read zeroes unreadCount', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await appendBasic(store, OWNER_A, t.id, 'k1', 'agent');
      await appendBasic(store, OWNER_A, t.id, 'k2', 'agent');
      let fetched = await store.getThread(OWNER_A, t.id);
      expect(fetched?.unreadCount).toBe(2);
      const marked = await store.applyAction(OWNER_A, t.id, 'mark_read');
      expect(marked.unreadCount).toBe(0);
      fetched = await store.getThread(OWNER_A, t.id);
      expect(fetched?.unreadCount).toBe(0);
    });

    it('applyAction request_delete then restore transitions statuses', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      const deleted = await store.applyAction(
        OWNER_A,
        t.id,
        'request_delete',
      );
      expect(deleted.status).toBe('pending_delete');
      const restored = await store.applyAction(OWNER_A, t.id, 'restore');
      expect(restored.status).toBe('active');
    });

    it('applyAction restore rejects when status !== pending_delete', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await expect(
        store.applyAction(OWNER_A, t.id, 'restore'),
      ).rejects.toBeInstanceOf(ThreadActionInvalidStateError);
      await store.applyAction(OWNER_A, t.id, 'archive');
      await expect(
        store.applyAction(OWNER_A, t.id, 'restore'),
      ).rejects.toBeInstanceOf(ThreadActionInvalidStateError);
    });

    it('applyAction archive/unarchive reject on pending_delete', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await store.applyAction(OWNER_A, t.id, 'request_delete');
      await expect(
        store.applyAction(OWNER_A, t.id, 'archive'),
      ).rejects.toBeInstanceOf(ThreadActionInvalidStateError);
      await expect(
        store.applyAction(OWNER_A, t.id, 'unarchive'),
      ).rejects.toBeInstanceOf(ThreadActionInvalidStateError);
    });

    it('mutations reject for wrong owner with ThreadNotFoundError', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await expect(
        store.appendMessage(OWNER_B, {
          threadId: t.id,
          key: 'k1',
          authorRole: 'user',
          kind: 'text',
          blocks: [],
          textPreview: '',
        }),
      ).rejects.toBeInstanceOf(ThreadNotFoundError);

      await expect(
        store.listMessages(OWNER_B, t.id, {}),
      ).rejects.toBeInstanceOf(ThreadNotFoundError);

      await expect(
        store.applyAction(OWNER_B, t.id, 'pin'),
      ).rejects.toBeInstanceOf(ThreadNotFoundError);
    });

    it('observeMessages replays historical then yields new appends', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await appendBasic(store, OWNER_A, t.id, 'k1', 'user');
      await appendBasic(store, OWNER_A, t.id, 'k2', 'agent');

      const iter = store.observeMessages(OWNER_A, t.id)[
        Symbol.asyncIterator
      ]();

      const first = await iter.next();
      const second = await iter.next();
      expect(first.value?.seq).toBe(1);
      expect(second.value?.seq).toBe(2);

      const pending = iter.next();
      await appendBasic(store, OWNER_A, t.id, 'k3', 'system');
      const third = await pending;
      expect(third.value?.seq).toBe(3);

      if (iter.return) await iter.return(undefined);
    });

    it('observeMessages with fromSeq skips earlier messages', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      for (let i = 1; i <= 3; i++) {
        await appendBasic(store, OWNER_A, t.id, `k${i}`, 'user');
      }
      const collected = await collect(
        store.observeMessages(OWNER_A, t.id, {
          fromSeq: 2,
          tail: false,
        }),
      );
      expect(collected.map((m) => m.seq)).toEqual([2, 3]);
    });

    it('observeMessages with tail=false ends after historical replay', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      await appendBasic(store, OWNER_A, t.id, 'k1', 'user');
      const collected = await collect(
        store.observeMessages(OWNER_A, t.id, { tail: false }),
      );
      expect(collected.map((m) => m.seq)).toEqual([1]);
    });

    it('observeMessages throws ThreadNotFoundError on wrong owner', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      const iter = store.observeMessages(OWNER_B, t.id)[
        Symbol.asyncIterator
      ]();
      await expect(iter.next()).rejects.toBeInstanceOf(ThreadNotFoundError);
    });

    it('observeMessages throws ThreadNotFoundError on missing thread', async () => {
      const store = await makeStore();
      const iter = store.observeMessages(OWNER_A, 'missing')[
        Symbol.asyncIterator
      ]();
      await expect(iter.next()).rejects.toBeInstanceOf(ThreadNotFoundError);
    });

    it('observeMessages return() disposes the iterator cleanly', async () => {
      const store = await makeStore();
      const t = await store.createThread(OWNER_A, { appId: 'app-1' });
      const iter = store.observeMessages(OWNER_A, t.id)[
        Symbol.asyncIterator
      ]();
      if (iter.return) {
        const r = await iter.return(undefined);
        expect(r.done).toBe(true);
      }
    });
  });
}

async function appendBasic(
  store: ThreadStore,
  ownerId: string,
  threadId: string,
  key: string,
  author: 'user' | 'agent' | 'system',
): Promise<ThreadMessage> {
  const input: AppendThreadMessageInput = {
    threadId,
    key,
    authorRole: author,
    kind: 'text',
    blocks: [{ type: 'text', text: key }],
    textPreview: key,
  };
  return store.appendMessage(ownerId, input);
}

async function collect(
  iterable: AsyncIterable<ThreadMessage>,
): Promise<ThreadMessage[]> {
  const out: ThreadMessage[] = [];
  for await (const m of iterable) out.push(m);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
