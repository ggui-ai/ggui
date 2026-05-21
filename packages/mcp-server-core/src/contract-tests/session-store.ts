/**
 * Contract test factory for {@link SessionStore} implementations.
 *
 * Normative semantics covered (see `session-store.ts` JSDoc):
 *
 *   - `create` returns a fresh session with appId + createdAt set.
 *   - `get` missing → null; hit → full session.
 *   - `list` filters on appId / userId / status.
 *   - `appendEvent` assigns monotonic gap-free `seq` starting at 1.
 *   - `appendEvent` after `session.closed` is rejected.
 *   - `observe` snapshot-then-tail: replays historical events in order,
 *     then yields new events.
 *   - `observe(fromSeq)` resumes correctly — no replay of earlier seqs.
 *   - `observe(tail: false)` terminates after historical replay.
 *   - The terminal `session.closed` event is delivered, then the
 *     iterable ends.
 *   - `delete` wakes active observers cleanly.
 *
 * Consumers pass a factory that builds a fresh store and a matching
 * clock if they want deterministic expiry-status tests. The factory
 * is called once per `it`.
 */
import { describe, expect, it } from 'vitest';
import type {
  AppendEventInput,
  SessionEvent,
  SessionStore,
} from '../session-store.js';

export interface SessionStoreContractClock {
  now(): number;
  tick(ms: number): void;
}

export interface SessionStoreContractOptions {
  /**
   * Factory that produces `(clock, store)` pairs where `store` reads
   * wall-time from `clock`. Omit if the impl can't be time-injected —
   * status=`expired` tests are then skipped, not failed.
   */
  makeWithClock?: () => Promise<{
    clock: SessionStoreContractClock;
    store: SessionStore;
  }>;
}

export function sessionStoreContract(
  label: string,
  makeStore: () => Promise<SessionStore> | SessionStore,
  opts: SessionStoreContractOptions = {},
): void {
  describe(`SessionStore contract — ${label}`, () => {
    it('create returns a session with appId + timestamps populated', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a', userId: 'u1' });
      expect(s.appId).toBe('app-a');
      expect(s.userId).toBe('u1');
      expect(s.id).toBeTruthy();
      expect(typeof s.createdAt).toBe('number');
      expect(typeof s.lastActivityAt).toBe('number');
      expect(typeof s.expiresAt).toBe('number');
      expect(s.stack).toEqual([]);
      expect(s.eventSequence).toBe(0);
    });

    it('get on a missing id returns null; hit returns full session', async () => {
      const store = await makeStore();
      await expect(store.get('nope')).resolves.toBeNull();
      const created = await store.create({ appId: 'app-a' });
      const fetched = await store.get(created.id);
      expect(fetched?.id).toBe(created.id);
      expect(fetched?.appId).toBe('app-a');
    });

    it('list filters on appId + userId', async () => {
      const store = await makeStore();
      await store.create({ appId: 'app-a', userId: 'u1' });
      await store.create({ appId: 'app-a', userId: 'u2' });
      await store.create({ appId: 'app-b', userId: 'u1' });
      const byApp = await store.list({ appId: 'app-a' });
      expect(byApp).toHaveLength(2);
      expect(byApp.every((s) => s.appId === 'app-a')).toBe(true);
      const byUser = await store.list({ userId: 'u1' });
      expect(byUser).toHaveLength(2);
      expect(byUser.every((s) => s.userId === 'u1')).toBe(true);
    });

    it('list status=active excludes closed sessions', async () => {
      const store = await makeStore();
      const live = await store.create({ appId: 'app-a' });
      const done = await store.create({ appId: 'app-a' });
      await store.appendEvent({
        sessionId: done.id,
        type: 'session.closed',
        data: {},
      });
      const active = await store.list({ appId: 'app-a', status: 'active' });
      const completed = await store.list({ appId: 'app-a', status: 'completed' });
      expect(active.map((s) => s.id)).toEqual([live.id]);
      expect(completed.map((s) => s.id)).toEqual([done.id]);
    });

    it('appendEvent assigns monotonic gap-free seq starting at 1', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      const a = await store.appendEvent({
        sessionId: s.id,
        type: 'ui.created',
        data: { a: 1 },
      });
      const b = await store.appendEvent({
        sessionId: s.id,
        type: 'ui.updated',
        data: { a: 2 },
      });
      const c = await store.appendEvent({
        sessionId: s.id,
        type: 'tool.called',
        data: {},
      });
      expect([a, b, c]).toEqual([1, 2, 3]);
      const fetched = await store.get(s.id);
      expect(fetched?.eventSequence).toBe(3);
    });

    it('appendEvent rejects a session that has emitted session.closed', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      await store.appendEvent({
        sessionId: s.id,
        type: 'session.closed',
        data: {},
      });
      await expect(
        store.appendEvent({ sessionId: s.id, type: 'ui.created', data: {} }),
      ).rejects.toThrow();
    });

    it('appendEvent on a missing session rejects', async () => {
      const store = await makeStore();
      await expect(
        store.appendEvent({ sessionId: 'nope', type: 'ui.created', data: {} }),
      ).rejects.toThrow();
    });

    it('observe replays historical events in order (snapshot mode)', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      await appendMany(store, s.id, [
        { type: 'ui.created', data: { n: 1 } },
        { type: 'ui.updated', data: { n: 2 } },
        { type: 'ui.updated', data: { n: 3 } },
      ]);
      const collected = await collect(store.observe(s.id, { tail: false }));
      expect(collected.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(collected.map((e) => e.type)).toEqual([
        'ui.created',
        'ui.updated',
        'ui.updated',
      ]);
    });

    it('observe with fromSeq skips earlier events', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      await appendMany(store, s.id, [
        { type: 'ui.created', data: {} },
        { type: 'ui.updated', data: {} },
        { type: 'tool.called', data: {} },
      ]);
      const collected = await collect(
        store.observe(s.id, { tail: false, fromSeq: 2 }),
      );
      expect(collected.map((e) => e.seq)).toEqual([2, 3]);
    });

    it('observe tail yields new events after historical replay', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      await store.appendEvent({
        sessionId: s.id,
        type: 'ui.created',
        data: {},
      });

      const collected: SessionEvent[] = [];
      const iter = store.observe(s.id)[Symbol.asyncIterator]();
      // First next resolves synchronously from backlog.
      const first = await iter.next();
      if (!first.done) collected.push(first.value);

      // Second next awaits — append while it's pending.
      const pending = iter.next();
      await store.appendEvent({
        sessionId: s.id,
        type: 'ui.updated',
        data: { fresh: true },
      });
      const second = await pending;
      if (!second.done) collected.push(second.value);

      // Close and expect the terminal event + iterator end.
      const thirdP = iter.next();
      await store.appendEvent({
        sessionId: s.id,
        type: 'session.closed',
        data: {},
      });
      const third = await thirdP;
      if (!third.done) collected.push(third.value);
      const fourth = await iter.next();

      expect(collected.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(collected[2]?.type).toBe('session.closed');
      expect(fourth.done).toBe(true);
    });

    it('observe terminates cleanly when the session is deleted mid-stream', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      const iter = store.observe(s.id)[Symbol.asyncIterator]();
      const pending = iter.next();
      await store.delete(s.id);
      const result = await pending;
      expect(result.done).toBe(true);
    });

    it('observe return() disposes the iterator cleanly', async () => {
      const store = await makeStore();
      const s = await store.create({ appId: 'app-a' });
      const iter = store.observe(s.id)[Symbol.asyncIterator]();
      if (iter.return) {
        const r = await iter.return(undefined);
        expect(r.done).toBe(true);
      }
    });

    if (opts.makeWithClock) {
      const makeWithClock = opts.makeWithClock;

      it('list status=expired picks up sessions past their expiresAt', async () => {
        const { clock, store } = await makeWithClock();
        const a = await store.create({ appId: 'app-a' });
        // Force the session to expire by writing expiresAt < now.
        await store.update(a.id, { expiresAt: clock.now() - 1 });
        const expired = await store.list({ appId: 'app-a', status: 'expired' });
        expect(expired.map((s) => s.id)).toEqual([a.id]);
      });
    }
  });
}

async function appendMany(
  store: SessionStore,
  sessionId: string,
  events: Array<Omit<AppendEventInput, 'sessionId'>>,
): Promise<void> {
  for (const e of events) {
    await store.appendEvent({ ...e, sessionId });
  }
}

async function collect(
  iterable: AsyncIterable<SessionEvent>,
): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}
