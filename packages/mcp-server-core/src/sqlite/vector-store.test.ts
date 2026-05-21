/**
 * SqliteVectorStore tests.
 *
 * Two layers:
 *   1. Shared `vectorStoreContract` — parity with the in-memory
 *      reference. Any ranking / upsert / scope-isolation drift
 *      surfaces as a failed contract.
 *   2. SQLite-specific — real-file persistence across instances,
 *      schema idempotence, metadata JSON round-trip (all four
 *      scalar types + unicode), corrupt-row recovery.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  enumerableVectorStoreContract,
  vectorStoreContract,
} from '../contract-tests/vector-store.js';
import { SqliteVectorStore } from './vector-store.js';

// ── contract suite ───────────────────────────────────────────────────

vectorStoreContract(
  'SqliteVectorStore (in-memory db)',
  () => new SqliteVectorStore({ filename: ':memory:' }),
);
enumerableVectorStoreContract(
  'SqliteVectorStore (in-memory db)',
  () => new SqliteVectorStore({ filename: ':memory:' }),
);

// ── SQLite-specific behavior ─────────────────────────────────────────

describe('SqliteVectorStore — persistence', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-sqlite-vector-store-'));
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('persists vectors + metadata across new store instances on the same file', async () => {
    const path = join(tmpRoot, 'restart.sqlite');

    // Process A — populate.
    const a = new SqliteVectorStore({ filename: path });
    await a.putVector('app-a', {
      key: 'weather-card',
      vector: [0.8, 0.6, 0, 0],
      metadata: { blueprint: 'weather', tier: 1 },
    });
    await a.putVector('app-a', {
      key: 'news-feed',
      vector: [0, 0, 1, 0],
      metadata: { blueprint: 'news', tier: 2 },
    });
    a.close();

    // Process B — re-open the same file.
    const b = new SqliteVectorStore({ filename: path });
    try {
      const results = await b.query('app-a', [1, 0, 0, 0], 10);
      // Both entries come back. Ranking is weather first (non-zero
      // projection on x axis) then news (orthogonal → score 0).
      expect(results.map((r) => r.key)).toEqual(['weather-card', 'news-feed']);
      expect(results[0]?.metadata).toEqual({ blueprint: 'weather', tier: 1 });
      expect(results[1]?.metadata).toEqual({ blueprint: 'news', tier: 2 });
    } finally {
      b.close();
    }
  });

  it('persists deletes across instances', async () => {
    const path = join(tmpRoot, 'deletes.sqlite');
    const a = new SqliteVectorStore({ filename: path });
    await a.putVector('app-a', { key: 'k1', vector: [1, 0, 0], metadata: {} });
    await a.putVector('app-a', { key: 'k2', vector: [0, 1, 0], metadata: {} });
    await a.deleteVector('app-a', 'k1');
    a.close();

    const b = new SqliteVectorStore({ filename: path });
    try {
      const results = await b.query('app-a', [1, 0, 0], 10);
      expect(results.map((r) => r.key)).toEqual(['k2']);
    } finally {
      b.close();
    }
  });

  it('reopens an existing schema without throwing (idempotent CREATE)', async () => {
    const path = join(tmpRoot, 'schema-idempotent.sqlite');
    const a = new SqliteVectorStore({ filename: path });
    await a.putVector('app-a', { key: 'k1', vector: [1, 0], metadata: {} });
    a.close();
    // Second construction must succeed + inherit the table.
    const b = new SqliteVectorStore({ filename: path });
    try {
      const results = await b.query('app-a', [1, 0], 10);
      expect(results).toHaveLength(1);
    } finally {
      b.close();
    }
  });

  it('round-trips metadata with all four scalar types + unicode', async () => {
    const store = new SqliteVectorStore({ filename: ':memory:' });
    try {
      const metadata = {
        str: 'héllo — 日本語',
        num: 3.14159,
        zero: 0,
        bool: true,
        falsy: false,
        nul: null,
      };
      await store.putVector('app-a', {
        key: 'k1',
        vector: [1, 0, 0],
        metadata,
      });
      const [hit] = await store.query('app-a', [1, 0, 0], 10);
      expect(hit?.metadata).toEqual(metadata);
    } finally {
      store.close();
    }
  });

  it('produces a human-readable row on disk (auditable via cat)', async () => {
    const path = join(tmpRoot, 'auditable.sqlite');
    const store = new SqliteVectorStore({ filename: path });
    try {
      await store.putVector('app-a', {
        key: 'weather-card',
        vector: [0.1, 0.2, 0.3],
        metadata: { blueprint: 'weather' },
      });
    } finally {
      store.close();
    }
    // Dump as a text blob — we're not running the SQLite CLI here,
    // but the JSON payloads are still byte-strings inside the file.
    const blob = readFileSync(path).toString('binary');
    expect(blob).toContain('weather-card');
    expect(blob).toContain('[0.1,0.2,0.3]');
    expect(blob).toContain('"blueprint":"weather"');
  });

  it('upsert overwrites vector + metadata atomically (no duplicate row)', async () => {
    const path = join(tmpRoot, 'upsert.sqlite');
    const store = new SqliteVectorStore({ filename: path });
    try {
      await store.putVector('app-a', {
        key: 'k1',
        vector: [1, 0, 0],
        metadata: { version: 1 },
      });
      await store.putVector('app-a', {
        key: 'k1',
        vector: [0, 1, 0],
        metadata: { version: 2 },
      });
      const results = await store.query('app-a', [0, 1, 0], 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.metadata).toEqual({ version: 2 });
    } finally {
      store.close();
    }
  });

  it('listByScope persists + roundtrips across instances on the same file', async () => {
    const path = join(tmpRoot, 'list-persistence.sqlite');
    const a = new SqliteVectorStore({ filename: path });
    try {
      await a.putVector('app-a', {
        key: 'k1',
        vector: [0.1, 0.2, 0.3],
        metadata: { tag: 'one' },
      });
      await a.putVector('app-a', {
        key: 'k2',
        vector: [0.4, 0.5, 0.6],
        metadata: { tag: 'two' },
      });
    } finally {
      a.close();
    }

    const b = new SqliteVectorStore({ filename: path });
    try {
      const entries = await b.listByScope('app-a');
      const byKey = new Map(entries.map((e) => [e.key, e]));
      expect(byKey.size).toBe(2);
      expect(byKey.get('k1')?.vector).toEqual([0.1, 0.2, 0.3]);
      expect(byKey.get('k1')?.metadata).toEqual({ tag: 'one' });
      expect(byKey.get('k2')?.vector).toEqual([0.4, 0.5, 0.6]);
      expect(byKey.get('k2')?.metadata).toEqual({ tag: 'two' });
    } finally {
      b.close();
    }
  });

  it('listByScope skips corrupt rows (parity with query)', async () => {
    // Same corruption pattern the `query` degradation test uses, proved
    // against `listByScope` to keep both read paths in lockstep.
    const path = join(tmpRoot, 'list-corrupt.sqlite');
    const store = new SqliteVectorStore({ filename: path });
    try {
      await store.putVector('app-a', { key: 'good', vector: [1, 0, 0], metadata: {} });
      await store.putVector('app-a', { key: 'bad', vector: [0, 1, 0], metadata: {} });
    } finally {
      store.close();
    }

    const tamper = new SqliteVectorStore({ filename: path });
    try {
      // @ts-expect-error — reach into a private for test-only setup
      const db = tamper.db as { prepare(sql: string): { run(...args: unknown[]): unknown } };
      db.prepare(
        `UPDATE vectors SET vector = 'not-json' WHERE scope = 'app-a' AND key = 'bad'`,
      ).run();
    } finally {
      tamper.close();
    }

    const store2 = new SqliteVectorStore({ filename: path });
    try {
      const entries = await store2.listByScope('app-a');
      expect(entries.map((e) => e.key)).toEqual(['good']);
    } finally {
      store2.close();
    }
  });

  it('query degrades gracefully on a corrupt vector row (skips instead of throwing)', async () => {
    // Manually tamper with the DB to simulate a row whose `vector`
    // JSON got corrupted outside our writer (disk corruption, manual
    // operator edit, etc.). The query must return the valid rows
    // and drop the broken one rather than crash.
    const path = join(tmpRoot, 'corrupt.sqlite');
    const store = new SqliteVectorStore({ filename: path });
    try {
      await store.putVector('app-a', { key: 'good', vector: [1, 0, 0], metadata: {} });
      await store.putVector('app-a', { key: 'bad', vector: [0, 1, 0], metadata: {} });
    } finally {
      store.close();
    }

    // Write a corrupted vector directly via a fresh better-sqlite3
    // handle. Using the public adapter to do this would be cheating.
    const tamper = new SqliteVectorStore({ filename: path });
    try {
      // @ts-expect-error — reach into a private for test-only setup
      const db = tamper.db as { prepare(sql: string): { run(...args: unknown[]): unknown } };
      db.prepare(
        `UPDATE vectors SET vector = 'not-json' WHERE scope = 'app-a' AND key = 'bad'`,
      ).run();
    } finally {
      tamper.close();
    }

    const store2 = new SqliteVectorStore({ filename: path });
    try {
      const results = await store2.query('app-a', [1, 0, 0], 10);
      expect(results.map((r) => r.key)).toEqual(['good']);
    } finally {
      store2.close();
    }
  });

  it('treats an empty-file open as a fresh empty store (reopen recovery)', async () => {
    // Not a semantic test of put/get — the schema CREATE covers it.
    // Here we verify that an existing-but-empty file doesn't crash
    // construction. Operators occasionally `: > file` to reset.
    const path = join(tmpRoot, 'empty.sqlite');
    writeFileSync(path, '');
    const store = new SqliteVectorStore({ filename: path });
    try {
      await expect(store.query('app-a', [1, 0], 10)).resolves.toEqual([]);
      await store.putVector('app-a', { key: 'k1', vector: [1, 0], metadata: {} });
      const results = await store.query('app-a', [1, 0], 10);
      expect(results).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('close() is idempotent', () => {
    const store = new SqliteVectorStore({ filename: ':memory:' });
    store.close();
    expect(() => store.close()).not.toThrow();
  });
});
