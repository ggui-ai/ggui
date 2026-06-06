/**
 * Contract test factory for {@link GguiSessionStore} implementations.
 *
 * Normative semantics covered (see `render-store.ts` JSDoc):
 *
 *   - `create` returns a fresh render with appId + createdAt set.
 *   - `get` missing → null; hit → full render.
 *   - `list` filters on appId / userId / status.
 *   - `appendEvent` assigns monotonic gap-free `seq` starting at 1.
 *   - `observe` snapshot-then-tail: replays historical events in order,
 *     then yields new events.
 *   - `observe(fromSeq)` resumes correctly — no replay of earlier seqs.
 *   - `observe(tail: false)` terminates after historical replay.
 *   - `delete` wakes active observers cleanly.
 *
 * Consumers pass a factory that builds a fresh store and a matching
 * clock if they want deterministic expiry-status tests. The factory
 * is called once per `it`.
 */
import { describe, expect, it } from 'vitest';
import type {
  AppendEventInput,
  GguiSessionEvent,
  GguiSessionStore,
} from '../ggui-session-store.js';

export interface GguiSessionStoreContractClock {
  now(): number;
  tick(ms: number): void;
}

export interface GguiSessionStoreContractOptions {
  /**
   * Factory that produces `(clock, store)` pairs where `store` reads
   * wall-time from `clock`. Omit if the impl can't be time-injected —
   * status=`expired` tests are then skipped, not failed.
   */
  makeWithClock?: () => Promise<{
    clock: GguiSessionStoreContractClock;
    store: GguiSessionStore;
  }>;
}

export function renderStoreContract(
  label: string,
  makeStore: () => Promise<GguiSessionStore> | GguiSessionStore,
  opts: GguiSessionStoreContractOptions = {},
): void {
  describe(`GguiSessionStore contract — ${label}`, () => {
    it('create returns a render with appId + timestamps populated', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a', userId: 'u1' });
      expect(r.appId).toBe('app-a');
      expect(r.userId).toBe('u1');
      expect(r.id).toBeTruthy();
      expect(typeof r.createdAt).toBe('number');
      expect(typeof r.lastActivityAt).toBe('number');
      expect(typeof r.expiresAt).toBe('number');
      expect(r.eventSequence).toBe(0);
    });

    it('get on a missing id returns null; hit returns full render', async () => {
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

    it('appendEvent assigns monotonic gap-free seq starting at 1', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a' });
      const a = await store.appendEvent({
        sessionId: r.id,
        type: 'ui.created',
        data: { a: 1 },
      });
      const b = await store.appendEvent({
        sessionId: r.id,
        type: 'ui.updated',
        data: { a: 2 },
      });
      const c = await store.appendEvent({
        sessionId: r.id,
        type: 'tool.called',
        data: {},
      });
      expect([a, b, c]).toEqual([1, 2, 3]);
      const fetched = await store.get(r.id);
      expect(fetched?.eventSequence).toBe(3);
    });

    it('appendEvent on a missing render rejects', async () => {
      const store = await makeStore();
      await expect(
        store.appendEvent({ sessionId: 'nope', type: 'ui.created', data: {} }),
      ).rejects.toThrow();
    });

    it('observe replays historical events in order (snapshot mode)', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a' });
      await appendMany(store, r.id, [
        { type: 'ui.created', data: { n: 1 } },
        { type: 'ui.updated', data: { n: 2 } },
        { type: 'ui.updated', data: { n: 3 } },
      ]);
      const collected = await collect(store.observe(r.id, { tail: false }));
      expect(collected.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(collected.map((e) => e.type)).toEqual([
        'ui.created',
        'ui.updated',
        'ui.updated',
      ]);
    });

    it('observe with fromSeq skips earlier events', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a' });
      await appendMany(store, r.id, [
        { type: 'ui.created', data: {} },
        { type: 'ui.updated', data: {} },
        { type: 'tool.called', data: {} },
      ]);
      const collected = await collect(
        store.observe(r.id, { tail: false, fromSeq: 2 }),
      );
      expect(collected.map((e) => e.seq)).toEqual([2, 3]);
    });

    it('observe tail yields new events after historical replay', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a' });
      await store.appendEvent({
        sessionId: r.id,
        type: 'ui.created',
        data: {},
      });

      const collected: GguiSessionEvent[] = [];
      const iter = store.observe(r.id)[Symbol.asyncIterator]();
      // First next resolves synchronously from backlog.
      const first = await iter.next();
      if (!first.done) collected.push(first.value);

      // Second next awaits — append while it's pending.
      const pending = iter.next();
      await store.appendEvent({
        sessionId: r.id,
        type: 'ui.updated',
        data: { fresh: true },
      });
      const second = await pending;
      if (!second.done) collected.push(second.value);

      // Dispose the iterator explicitly — there is no terminal event,
      // so the consumer is responsible for ending the loop (the render
      // would otherwise tail until TTL expiry / explicit `delete`).
      if (iter.return) await iter.return(undefined);

      expect(collected.map((e) => e.seq)).toEqual([1, 2]);
      expect(collected[1]?.type).toBe('ui.updated');
    });

    it('observe terminates cleanly when the render is deleted mid-stream', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a' });
      const iter = store.observe(r.id)[Symbol.asyncIterator]();
      const pending = iter.next();
      await store.delete(r.id);
      const result = await pending;
      expect(result.done).toBe(true);
    });

    it('observe return() disposes the iterator cleanly', async () => {
      const store = await makeStore();
      const r = await store.create({ appId: 'app-a' });
      const iter = store.observe(r.id)[Symbol.asyncIterator]();
      if (iter.return) {
        const ret = await iter.return(undefined);
        expect(ret.done).toBe(true);
      }
    });

    if (opts.makeWithClock) {
      const makeWithClock = opts.makeWithClock;

      it('list status=expired picks up renders past their expiresAt', async () => {
        const { clock, store } = await makeWithClock();
        const a = await store.create({ appId: 'app-a' });
        // Force the render to expire by writing expiresAt < now.
        await store.update(a.id, { expiresAt: clock.now() - 1 });
        const expired = await store.list({ appId: 'app-a', status: 'expired' });
        expect(expired.map((s) => s.id)).toEqual([a.id]);
      });
    }
  });
}

async function appendMany(
  store: GguiSessionStore,
  sessionId: string,
  events: Array<Omit<AppendEventInput, 'sessionId'>>,
): Promise<void> {
  for (const e of events) {
    await store.appendEvent({ ...e, sessionId });
  }
}

async function collect(
  iterable: AsyncIterable<GguiSessionEvent>,
): Promise<GguiSessionEvent[]> {
  const out: GguiSessionEvent[] = [];
  for await (const e of iterable) out.push(e);
  return out;
}
