/**
 * Generation cache — admin-route helper tests.
 *
 * The intent-keyed `lookupGenerationCache` + `recordGenerationCache`
 * were retired (production traffic routes through `matchBlueprint` /
 * `blueprint-registry.ts` now). What remains are the enumeration +
 * invalidation helpers backing `/ggui/console/cache`:
 *
 *   - `listGenerationCache` — operator view of in-scope entries
 *   - `invalidateGenerationCache` — single-entry delete
 *   - `clearGenerationCache` — bulk delete in scope
 *
 * Setup uses `vectorStore.putVector` directly so the tests don't
 * depend on any retired writer.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InMemoryVectorStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  clearGenerationCache,
  invalidateGenerationCache,
  listGenerationCache,
} from './generation-cache';

/**
 * Test-local deterministic key for an intent. The production
 * `blueprintKey(contract)` produces a hex hash slug; here the value
 * just has to be unique + stable per intent for the test predicate.
 */
function intentKey(intent: string): string {
  return createHash('sha256').update(intent.trim()).digest('hex').slice(0, 16);
}

/**
 * Write a blueprint-registry-shaped row directly to the vector store.
 * Mirrors what `registerBlueprint` writes (Slice 16d): the row's key is
 * `${kind}:${contractKey}` and the metadata bundle carries
 * `{intent, componentCode, contract, contractKey, kind, createdAt}`
 * plus optional `hitCount` / `lastHitAt`. The admin helpers gate on
 * this exact shape — older intent-keyed rows are silently skipped.
 */
function writeCacheRow(
  vectorStore: InMemoryVectorStore,
  scope: string,
  input: {
    readonly intent: string;
    readonly componentCode: string;
    readonly contractKey?: string;
    readonly kind?: string;
    readonly createdAt?: string;
    readonly hitCount?: number;
    readonly lastHitAt?: string;
  },
): void {
  const normalized = input.intent.trim();
  // Derive a deterministic contractKey from the intent so each test
  // entry has a stable id without a real contract.
  const contractKey = input.contractKey ?? intentKey(normalized);
  const kind = input.kind ?? 'template';
  vectorStore.putVector(scope, {
    key: `${kind}:${contractKey}`,
    vector: [0, 0, 0, 0],
    metadata: {
      intent: normalized,
      componentCode: input.componentCode,
      contract: '{}',
      contractKey,
      kind,
      createdAt: input.createdAt ?? '2026-04-21T00:00:00Z',
      ...(input.hitCount !== undefined ? { hitCount: input.hitCount } : {}),
      ...(input.lastHitAt !== undefined ? { lastHitAt: input.lastHitAt } : {}),
    },
  });
}

describe('listGenerationCache', () => {
  it('returns [] for an empty scope', async () => {
    const vectorStore = new InMemoryVectorStore();
    const entries = await listGenerationCache({ vectorStore }, 'empty');
    expect(entries).toEqual([]);
  });

  it('lists every cache-shaped entry in the scope', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'weather card',
      componentCode: 'export default () => <div>w</div>',
      createdAt: '2026-04-21T00:00:00Z',
    });
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'todo list',
      componentCode: 'export default () => <div>t</div>',
      createdAt: '2026-04-21T01:00:00Z',
    });

    const entries = await listGenerationCache({ vectorStore }, 'app-1');
    expect(entries).toHaveLength(2);
    const byIntent = new Map(entries.map((e) => [e.cachedIntent, e]));
    expect(byIntent.get('weather card')?.id).toBe(
      `template:${intentKey('weather card')}`,
    );
    expect(byIntent.get('weather card')?.cachedAt).toBe(
      '2026-04-21T00:00:00Z',
    );
    expect(byIntent.get('weather card')?.contractKey).toBe(
      intentKey('weather card'),
    );
    expect(byIntent.get('weather card')?.kind).toBe('template');
    expect(byIntent.get('todo list')?.id).toBe(
      `template:${intentKey('todo list')}`,
    );
  });

  it('surfaces hitCount / lastHitAt when present, omits them when not', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'no-bumps',
      componentCode: 'export default () => null',
    });
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'bumped',
      componentCode: 'export default () => null',
      hitCount: 3,
      lastHitAt: '2026-04-21T02:00:00Z',
    });

    const entries = await listGenerationCache({ vectorStore }, 'app-1');
    const byIntent = new Map(entries.map((e) => [e.cachedIntent, e]));
    expect(byIntent.get('no-bumps')?.hitCount).toBeUndefined();
    expect(byIntent.get('no-bumps')?.lastHitAt).toBeUndefined();
    expect(byIntent.get('bumped')?.hitCount).toBe(3);
    expect(byIntent.get('bumped')?.lastHitAt).toBe('2026-04-21T02:00:00Z');
  });

  it('skips non-cache entries (defensive — same scope may host other shapes)', async () => {
    // A hypothetical other vector family written under the same scope
    // (e.g., blueprint-registry rows). `list` must not surface it as
    // a cache entry — the console viewer would render garbage.
    const vectorStore = new InMemoryVectorStore();
    vectorStore.putVector('app-1', {
      key: 'some-other-family-entry',
      vector: [1, 0, 0, 0],
      metadata: { blueprint: 'foo', catalog: 'bar' },
    });
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'weather card',
      componentCode: 'export default () => null',
    });
    const entries = await listGenerationCache({ vectorStore }, 'app-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe(
      `template:${intentKey('weather card')}`,
    );
  });

  it('does not leak entries across scopes', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-A', {
      intent: 'A-only',
      componentCode: 'export default () => null',
    });
    writeCacheRow(vectorStore, 'app-B', {
      intent: 'B-only',
      componentCode: 'export default () => null',
    });
    const a = await listGenerationCache({ vectorStore }, 'app-A');
    const b = await listGenerationCache({ vectorStore }, 'app-B');
    expect(a).toHaveLength(1);
    expect(a[0]!.cachedIntent).toBe('A-only');
    expect(b).toHaveLength(1);
    expect(b[0]!.cachedIntent).toBe('B-only');
  });
});

describe('invalidateGenerationCache', () => {
  it('removes the entry from the scope', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'weather card',
      componentCode: 'export default () => null',
    });
    expect(await listGenerationCache({ vectorStore }, 'app-1')).toHaveLength(1);

    await invalidateGenerationCache(
      { vectorStore },
      'app-1',
      `template:${intentKey('weather card')}`,
    );

    expect(await listGenerationCache({ vectorStore }, 'app-1')).toHaveLength(0);
  });

  it('is idempotent — deleting a non-existent id is a no-op', async () => {
    const vectorStore = new InMemoryVectorStore();
    await expect(
      invalidateGenerationCache({ vectorStore }, 'app-1', 'never-stored'),
    ).resolves.toBeUndefined();
  });

  it('does not affect entries in sibling scopes', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-A', {
      intent: 'shared',
      componentCode: 'export default () => null',
    });
    writeCacheRow(vectorStore, 'app-B', {
      intent: 'shared',
      componentCode: 'export default () => null',
    });
    await invalidateGenerationCache(
      { vectorStore },
      'app-A',
      `template:${intentKey('shared')}`,
    );
    expect(await listGenerationCache({ vectorStore }, 'app-A')).toHaveLength(0);
    expect(await listGenerationCache({ vectorStore }, 'app-B')).toHaveLength(1);
  });
});

describe('clearGenerationCache', () => {
  it('returns deletedCount=0 on an empty scope', async () => {
    const vectorStore = new InMemoryVectorStore();
    const result = await clearGenerationCache({ vectorStore }, 'empty');
    expect(result).toEqual({ deletedCount: 0 });
  });

  it('deletes every cache entry in the scope and returns the count', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'one',
      componentCode: 'export default () => null',
    });
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'two',
      componentCode: 'export default () => null',
    });
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'three',
      componentCode: 'export default () => null',
    });

    const result = await clearGenerationCache({ vectorStore }, 'app-1');
    expect(result).toEqual({ deletedCount: 3 });
    expect(await listGenerationCache({ vectorStore }, 'app-1')).toEqual([]);
  });

  it('leaves non-cache entries in the scope untouched', async () => {
    const vectorStore = new InMemoryVectorStore();
    vectorStore.putVector('app-1', {
      key: 'foreign-family',
      vector: [1, 0, 0, 0],
      metadata: { catalog: 'something-else' },
    });
    writeCacheRow(vectorStore, 'app-1', {
      intent: 'weather card',
      componentCode: 'export default () => null',
    });

    const result = await clearGenerationCache({ vectorStore }, 'app-1');
    expect(result).toEqual({ deletedCount: 1 });

    // The foreign-family entry survives.
    const raw = await vectorStore.query('app-1', [1, 0, 0, 0], 10);
    expect(raw.map((r) => r.key)).toContain('foreign-family');
  });

  it('does not sweep sibling scopes', async () => {
    const vectorStore = new InMemoryVectorStore();
    writeCacheRow(vectorStore, 'app-A', {
      intent: 'a',
      componentCode: 'export default () => null',
    });
    writeCacheRow(vectorStore, 'app-B', {
      intent: 'b',
      componentCode: 'export default () => null',
    });
    const result = await clearGenerationCache({ vectorStore }, 'app-A');
    expect(result).toEqual({ deletedCount: 1 });
    expect(await listGenerationCache({ vectorStore }, 'app-B')).toHaveLength(1);
  });
});
