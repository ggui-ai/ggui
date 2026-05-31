/**
 * SqliteBlueprintIndex tests.
 *
 * Two layers:
 *   1. Shared `runBlueprintIndexConformance` — parity with the
 *      in-memory reference. First-write-wins dedup / scope-isolation /
 *      delete drift surfaces as a failed contract.
 *   2. SQLite-specific — real-file persistence across instances,
 *      schema idempotence, first-write-wins persisting across restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runBlueprintIndexConformance } from '../contract-tests/blueprint-index.js';
import { SqliteBlueprintIndex } from './blueprint-index.js';

// ── contract suite ───────────────────────────────────────────────────

runBlueprintIndexConformance(
  'SqliteBlueprintIndex (in-memory db)',
  () => new SqliteBlueprintIndex({ filename: ':memory:' }),
);

// ── SQLite-specific behavior ─────────────────────────────────────────

describe('SqliteBlueprintIndex — persistence', () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-sqlite-blueprint-index-'));
  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('persists bindings across new index instances on the same file', async () => {
    const path = join(tmpRoot, 'restart.sqlite');

    const a = new SqliteBlueprintIndex({ filename: path });
    await a.putId('app-a', 'k1', 'uuid-1');
    await a.putId('app-a', 'k2', 'uuid-2');
    a.close();

    const b = new SqliteBlueprintIndex({ filename: path });
    try {
      await expect(b.getId('app-a', 'k1')).resolves.toBe('uuid-1');
      await expect(b.getId('app-a', 'k2')).resolves.toBe('uuid-2');
    } finally {
      b.close();
    }
  });

  it('persists deletes across instances', async () => {
    const path = join(tmpRoot, 'deletes.sqlite');
    const a = new SqliteBlueprintIndex({ filename: path });
    await a.putId('app-a', 'k1', 'uuid-1');
    await a.deleteId('app-a', 'k1');
    a.close();

    const b = new SqliteBlueprintIndex({ filename: path });
    try {
      await expect(b.getId('app-a', 'k1')).resolves.toBeNull();
    } finally {
      b.close();
    }
  });

  it('first-write-wins survives across instances (dedup is durable)', async () => {
    const path = join(tmpRoot, 'first-write-wins.sqlite');
    const a = new SqliteBlueprintIndex({ filename: path });
    await a.putId('app-a', 'k1', 'uuid-first');
    a.close();

    // A fresh process re-attempts the same (scope, exactKey) with a
    // different uuid. The ON CONFLICT DO NOTHING guard must keep the
    // first binding even though the writer is a new instance.
    const b = new SqliteBlueprintIndex({ filename: path });
    try {
      await b.putId('app-a', 'k1', 'uuid-second');
      await expect(b.getId('app-a', 'k1')).resolves.toBe('uuid-first');
    } finally {
      b.close();
    }
  });

  it('reopens an existing schema without throwing (idempotent CREATE)', async () => {
    const path = join(tmpRoot, 'schema-idempotent.sqlite');
    const a = new SqliteBlueprintIndex({ filename: path });
    await a.putId('app-a', 'k1', 'uuid-1');
    a.close();
    const b = new SqliteBlueprintIndex({ filename: path });
    try {
      await expect(b.getId('app-a', 'k1')).resolves.toBe('uuid-1');
    } finally {
      b.close();
    }
  });

  it('close() is idempotent', () => {
    const ix = new SqliteBlueprintIndex({ filename: ':memory:' });
    ix.close();
    expect(() => ix.close()).not.toThrow();
  });
});
