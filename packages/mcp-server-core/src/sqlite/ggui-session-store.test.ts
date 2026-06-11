/**
 * SqliteGguiSessionStore tests.
 *
 * Two layers — same shape as the SqliteThreadStore suite:
 *   1. The shared `../contract-tests` batteries —
 *      {@link gguiSessionStoreContract} (normative semantics: round
 *      trips, monotonic gap-free seq, observe snapshot-then-tail,
 *      expiry status via injected clock) and
 *      {@link runGguiSessionStoreConformance} (bug classes:
 *      endUserIdentity round-trip parity, status precedence, commit
 *      upsert-in-place). Parity with the in-memory reference is the
 *      durability story `ggui serve --db` relies on.
 *   2. SQLite-specific behavior — persistence across instance
 *      restarts, which the in-process batteries can't observe.
 *
 * Contract runs use `:memory:` databases (fresh per `makeStore` call);
 * the conformance battery exercises the real temp-file path + teardown
 * because file-backed mode is the production configuration.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gguiSessionStoreContract } from '../contract-tests/ggui-session-store.js';
import { runGguiSessionStoreConformance } from '../contract-tests/ggui-session-store.conformance.js';
import { SqliteGguiSessionStore } from './ggui-session-store.js';

// ── Shared contract suite ────────────────────────────────────────────

const openStores: SqliteGguiSessionStore[] = [];
afterAll(() => {
  for (const store of openStores.splice(0)) store.close();
});

function makeMemoryStore(
  opts: { now?: () => number } = {},
): SqliteGguiSessionStore {
  const store = new SqliteGguiSessionStore({ filename: ':memory:', ...opts });
  openStores.push(store);
  return store;
}

gguiSessionStoreContract(
  'SqliteGguiSessionStore (in-memory db)',
  () => makeMemoryStore(),
  {
    makeWithClock: async () => {
      let now = 1_700_000_000_000;
      const clock = {
        now: () => now,
        tick: (ms: number) => {
          now += ms;
        },
      };
      return { clock, store: makeMemoryStore({ now: clock.now }) };
    },
  },
);

// ── Bug-class conformance battery (temp-file db) ─────────────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-sqlite-session-store-'));
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

let dbCounter = 0;

runGguiSessionStoreConformance('SqliteGguiSessionStore (temp file)', {
  create: async () =>
    new SqliteGguiSessionStore({
      filename: join(tmpRoot, `conformance-${++dbCounter}.sqlite`),
    }),
  cleanup: (store) => {
    if (store instanceof SqliteGguiSessionStore) store.close();
  },
});

// ── SQLite-specific behavior ─────────────────────────────────────────

describe('SqliteGguiSessionStore — persistence', () => {
  it('persists renders + event history across instance restarts', async () => {
    const path = join(tmpRoot, 'restart.sqlite');

    // Writer instance: create a render, append events, then close.
    const writer = new SqliteGguiSessionStore({ filename: path });
    await writer.create({
      id: 'render-1',
      appId: 'app-1',
      userId: 'u-1',
      endUserIdentity: {
        userId: 'u-1',
        provider: 'custom',
        authenticatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await writer.appendEvent({
      sessionId: 'render-1',
      type: 'ui.created',
      data: { n: 1 },
    });
    await writer.appendEvent({
      sessionId: 'render-1',
      type: 'ui.updated',
      data: { n: 2 },
    });
    writer.close();

    // Reader instance over the same file: full state survives.
    const reader = new SqliteGguiSessionStore({ filename: path });
    try {
      const got = await reader.get('render-1');
      expect(got?.appId).toBe('app-1');
      expect(got?.userId).toBe('u-1');
      expect(got?.endUserIdentity?.userId).toBe('u-1');
      expect(got?.eventSequence).toBe(2);

      const events: number[] = [];
      for await (const e of reader.observe('render-1', { tail: false })) {
        events.push(e.seq);
      }
      expect(events).toEqual([1, 2]);
    } finally {
      reader.close();
    }
  });
});
