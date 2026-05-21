/**
 * SqliteSessionStore tests.
 *
 * Two layers:
 *   1. The shared {@link sessionStoreContract} suite — proves the
 *      SQLite adapter honors the same append / observe / list / status
 *      semantics the in-memory reference does. Parity is the OSS
 *      credibility argument; any drift shows up as a failed contract.
 *   2. SQLite-specific behavior — persistence across instances, schema
 *      idempotence, closed-row behavior, and explicit cross-process
 *      fanout limitations documented in the module JSDoc.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sessionStoreContract } from '../contract-tests/session-store.js';
import { SqliteSessionStore } from './session-store.js';

// ── Contract suite ───────────────────────────────────────────────────

sessionStoreContract(
  'SqliteSessionStore (in-memory db)',
  () => new SqliteSessionStore({ filename: ':memory:' }),
  {
    makeWithClock: async () => {
      let now = 1_700_000_000_000;
      const clock = {
        now: () => now,
        tick: (ms: number) => {
          now += ms;
        },
      };
      return {
        clock,
        store: new SqliteSessionStore({
          filename: ':memory:',
          now: clock.now,
        }),
      };
    },
  },
);

// ── SQLite-specific behavior ─────────────────────────────────────────

describe('SqliteSessionStore — persistence', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-sqlite-session-store-'));
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('persists sessions + event history across process restarts (real file backing)', async () => {
    const path = join(tmpRoot, 'restart.sqlite');

    // Process A: write session + events, then close.
    const a = new SqliteSessionStore({ filename: path });
    const session = await a.create({ appId: 'app-a', userId: 'u1' });
    await a.appendEvent({
      sessionId: session.id,
      type: 'ui.created',
      data: { component: 'WeatherCard' },
    });
    await a.appendEvent({
      sessionId: session.id,
      type: 'ui.updated',
      data: { props: { city: 'Seoul' } },
    });
    a.close();

    // Process B (simulated): open a fresh store on the same file —
    // state must survive the close/reopen cycle.
    const b = new SqliteSessionStore({ filename: path });
    try {
      const fetched = await b.get(session.id);
      expect(fetched?.id).toBe(session.id);
      expect(fetched?.appId).toBe('app-a');
      expect(fetched?.userId).toBe('u1');
      expect(fetched?.eventSequence).toBe(2);

      // Observer replays full history (tail:false = snapshot mode).
      const replayed: { seq: number; type: string }[] = [];
      for await (const e of b.observe(session.id, { tail: false })) {
        replayed.push({ seq: e.seq, type: e.type });
      }
      expect(replayed).toEqual([
        { seq: 1, type: 'ui.created' },
        { seq: 2, type: 'ui.updated' },
      ]);
    } finally {
      b.close();
    }
  });

  it('round-trips stack entries (component variant) through SQLite without loss', async () => {
    const store = new SqliteSessionStore({ filename: ':memory:' });
    try {
      const session = await store.create({ appId: 'app-a' });
      await store.appendStackItem(session.id, {
        id: 'page-1',
        componentCode: 'export default () => null;',
        prompt: 'show weather',
        createdAt: '2026-04-19T10:00:00Z',
      });
      const fetched = await store.get(session.id);
      expect(fetched?.stack).toHaveLength(1);
      expect(fetched?.stack[0]?.id).toBe('page-1');
      expect(fetched?.currentStackIndex).toBe(0);
    } finally {
      store.close();
    }
  });

  it('upserts stack entries by id — second push with same id replaces in place', async () => {
    const store = new SqliteSessionStore({ filename: ':memory:' });
    try {
      const session = await store.create({ appId: 'app-a' });
      await store.appendStackItem(session.id, {
        id: 'page-1',
        componentCode: '',
        prompt: 'placeholder',
        createdAt: '2026-04-26T10:00:00Z',
      });
      await store.appendStackItem(session.id, {
        id: 'page-2',
        componentCode: '/* p2 */',
        createdAt: '2026-04-26T10:00:01Z',
      });
      await store.appendStackItem(session.id, {
        id: 'page-1',
        componentCode: '/* real */',
        prompt: 'placeholder',
        createdAt: '2026-04-26T10:00:02Z',
      });
      const fetched = await store.get(session.id);
      expect(fetched?.stack.map((e) => e.id)).toEqual(['page-1', 'page-2']);
      const updated = fetched?.stack[0];
      if (!updated || updated.type === 'mcpApps' || updated.type === 'system') {
        throw new Error('expected component entry');
      }
      expect(updated.componentCode).toBe('/* real */');
      expect(fetched?.currentStackIndex).toBe(0);
    } finally {
      store.close();
    }
  });

  it('round-trips stack entries (mcpApps variant) through SQLite without collapsing the discriminator', async () => {
    const store = new SqliteSessionStore({ filename: ':memory:' });
    try {
      const session = await store.create({ appId: 'app-a' });
      await store.appendStackItem(session.id, {
        id: 'mcp-1',
        type: 'mcpApps',
        source: {
          connectorId: 'stripe.com',
          toolName: 'checkout',
          resourceUri: 'ui://stripe/checkout',
        },
        createdAt: '2026-04-19T10:00:00Z',
      });
      const fetched = await store.get(session.id);
      expect(fetched?.stack).toHaveLength(1);
      const entry = fetched?.stack[0];
      expect(entry?.type).toBe('mcpApps');
      // If this ever regresses to `'component'`, the union collapsed
      // on serialize/deserialize — a real data-loss bug.
    } finally {
      store.close();
    }
  });

  it('creating two stores against the same file is schema-idempotent', async () => {
    // `CREATE TABLE IF NOT EXISTS` on both construction calls must not
    // throw, and the row written on A must be readable from B.
    const path = join(tmpRoot, 'schema-idempotent.sqlite');
    const a = new SqliteSessionStore({ filename: path });
    const s = await a.create({ appId: 'app-a' });
    a.close();

    // A fresh store reuses the existing schema without error.
    const b = new SqliteSessionStore({ filename: path });
    try {
      const fetched = await b.get(s.id);
      expect(fetched?.id).toBe(s.id);
    } finally {
      b.close();
    }
  });

  it('does NOT fan events to observers in a separate store instance (documented cross-process limitation)', async () => {
    // Same DB file, two store instances → two different waiter sets.
    // Observers on `writer` see live fanout; observers on `observer`
    // only learn about `writer`'s appends on the next historical read.
    const path = join(tmpRoot, 'cross-process-fanout.sqlite');
    // Separate idGenerators so the two stores never race on sess-N.
    // Realistic: distinct processes would pick distinct UUIDs anyway.
    const writer = new SqliteSessionStore({
      filename: path,
      idGenerator: () => 'writer-session',
    });
    const observer = new SqliteSessionStore({ filename: path });

    try {
      const s = await writer.create({ appId: 'app-a' });

      // Kick off a tailing observer on the second instance, starting
      // past the last persisted seq so historical replay doesn't race.
      const iter = observer.observe(s.id, { fromSeq: 1 })[Symbol.asyncIterator]();
      const pending = iter.next();

      // Write from the first instance. In-process fanout belongs to
      // `writer`'s waiter set, not `observer`'s — observer cannot
      // wake from this append.
      await writer.appendEvent({
        sessionId: s.id,
        type: 'ui.created',
        data: {},
      });

      // Confirm the pending observer is still parked after a short
      // grace period. If cross-process fanout ever gets added, this
      // test flips and the module JSDoc should be updated.
      const settled = await Promise.race([
        pending.then(() => 'settled' as const),
        new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(settled).toBe('pending');

      // Observer can still see the event if it starts a fresh snapshot
      // read — the event IS in the database.
      const snapshot: number[] = [];
      for await (const e of observer.observe(s.id, { tail: false })) {
        snapshot.push(e.seq);
      }
      expect(snapshot).toEqual([1]);

      // Clean up the parked observer.
      if (iter.return) await iter.return(undefined);
    } finally {
      writer.close();
      observer.close();
    }
  });

  it('close() releases the database handle when the store owns it', () => {
    const store = new SqliteSessionStore({ filename: ':memory:' });
    store.close();
    // Idempotent — calling close again must not throw.
    expect(() => store.close()).not.toThrow();
  });
});

