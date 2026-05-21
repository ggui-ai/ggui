/**
 * Tests for the catalog-adapter port + two batteries.
 *
 * Pin shape:
 *   - Adapter interface is one batch method; in-memory + caching
 *     wrappers honor it.
 *   - In-memory adapter returns `[]` for unknown apps by default,
 *     OR a configured fallback via the with-default factory.
 *   - Caching adapter:
 *     - serves from cache within TTL,
 *     - refetches after expiry,
 *     - dedup-coalesces concurrent misses (single-flight),
 *     - per-appId invalidation forces the next fetch,
 *     - `ttlMs: 0` disables caching but keeps single-flight.
 */

import { describe, expect, it } from 'vitest';
import type { GadgetDescriptor } from '@ggui-ai/protocol';
import {
  CachingGadgetCatalog,
  type GadgetCatalogAdapter,
  InMemoryGadgetCatalog,
} from './catalog-adapter';

function makeEntry(hook: string, pkg = '@ggui-ai/gadgets'): GadgetDescriptor {
  return {
    package: pkg,
    version: '0.0.1',
    exports: [
      {
        hook,
        description: `descriptor for ${hook}`,
        usage: `use ${hook}`,
        example: { call: `${hook}()` },
      },
    ],
  };
}

/** The single hook name of a one-export test descriptor. */
function entryHook(entry: GadgetDescriptor): string | undefined {
  const exp = entry.exports[0];
  return exp !== undefined && 'hook' in exp ? exp.hook : undefined;
}

describe('InMemoryGadgetCatalog', () => {
  it('returns the registered list for a known appId', async () => {
    const cat = new InMemoryGadgetCatalog(
      new Map([['app-1', [makeEntry('useGeolocation')]]]),
    );
    const out = await cat.list('app-1');
    expect(out).toHaveLength(1);
    expect(out[0] && entryHook(out[0])).toBe('useGeolocation');
  });

  it('returns [] for an unknown appId by default', async () => {
    const cat = new InMemoryGadgetCatalog(new Map());
    expect(await cat.list('missing')).toEqual([]);
  });

  it('with-default factory falls back when appId is unknown', async () => {
    const cat = InMemoryGadgetCatalog.withDefault([
      makeEntry('useGeolocation'),
    ]);
    expect((await cat.list('missing')).map(entryHook)).toEqual([
      'useGeolocation',
    ]);
  });

  it('with-default factory prefers the per-app catalog when registered', async () => {
    const cat = InMemoryGadgetCatalog.withDefault(
      [makeEntry('useGeolocation')],
      new Map([['app-1', [makeEntry('useCamera')]]]),
    );
    expect((await cat.list('app-1')).map(entryHook)).toEqual([
      'useCamera',
    ]);
  });
});

describe('CachingGadgetCatalog', () => {
  function makeCountingInner(
    out: readonly GadgetDescriptor[] = [makeEntry('useGeolocation')],
  ): { adapter: GadgetCatalogAdapter; calls: { count: number } } {
    const calls = { count: 0 };
    const adapter: GadgetCatalogAdapter = {
      async list() {
        calls.count += 1;
        return out;
      },
    };
    return { adapter, calls };
  }

  it('serves the cached result within TTL', async () => {
    let now = 1_000;
    const { adapter, calls } = makeCountingInner();
    const cat = new CachingGadgetCatalog(adapter, {
      ttlMs: 100,
      now: () => now,
    });

    await cat.list('app-1');
    await cat.list('app-1');
    now += 50;
    await cat.list('app-1');

    expect(calls.count).toBe(1);
  });

  it('refetches after TTL elapses', async () => {
    let now = 1_000;
    const { adapter, calls } = makeCountingInner();
    const cat = new CachingGadgetCatalog(adapter, {
      ttlMs: 100,
      now: () => now,
    });

    await cat.list('app-1');
    now += 200;
    await cat.list('app-1');

    expect(calls.count).toBe(2);
  });

  it('coalesces concurrent misses (single-flight)', async () => {
    let resolve!: (entries: readonly GadgetDescriptor[]) => void;
    const blocking = new Promise<readonly GadgetDescriptor[]>((r) => {
      resolve = r;
    });
    let calls = 0;
    const adapter: GadgetCatalogAdapter = {
      async list() {
        calls += 1;
        return blocking;
      },
    };
    const cat = new CachingGadgetCatalog(adapter);
    const p1 = cat.list('app-1');
    const p2 = cat.list('app-1');
    const p3 = cat.list('app-1');
    resolve([makeEntry('useGeolocation')]);
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('per-appId invalidate forces the next fetch', async () => {
    const { adapter, calls } = makeCountingInner();
    const cat = new CachingGadgetCatalog(adapter, { ttlMs: 60_000 });
    await cat.list('app-1');
    await cat.list('app-1');
    cat.invalidate('app-1');
    await cat.list('app-1');
    expect(calls.count).toBe(2);
  });

  it('invalidate() with no arg clears every cached entry', async () => {
    const { adapter, calls } = makeCountingInner();
    const cat = new CachingGadgetCatalog(adapter, { ttlMs: 60_000 });
    await cat.list('app-1');
    await cat.list('app-2');
    cat.invalidate();
    await cat.list('app-1');
    await cat.list('app-2');
    expect(calls.count).toBe(4);
  });

  it('ttlMs: 0 disables caching but keeps single-flight dedup', async () => {
    let resolve!: (entries: readonly GadgetDescriptor[]) => void;
    const blocking = new Promise<readonly GadgetDescriptor[]>((r) => {
      resolve = r;
    });
    let calls = 0;
    const adapter: GadgetCatalogAdapter = {
      async list() {
        calls += 1;
        return blocking;
      },
    };
    const cat = new CachingGadgetCatalog(adapter, { ttlMs: 0 });

    // Concurrent: dedup to one inner fetch.
    const p1 = cat.list('app-1');
    const p2 = cat.list('app-1');
    resolve([makeEntry('useGeolocation')]);
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);

    // Sequential: the next call refetches (no cache).
    await cat.list('app-1');
    expect(calls).toBe(2);
  });

  it('propagates errors from the inner adapter (no silent empty list)', async () => {
    const adapter: GadgetCatalogAdapter = {
      async list() {
        throw new Error('catalog backend down');
      },
    };
    const cat = new CachingGadgetCatalog(adapter);
    await expect(cat.list('app-1')).rejects.toThrow('catalog backend down');
  });

  it('does not poison the cache on error — next call re-attempts', async () => {
    let attempt = 0;
    const adapter: GadgetCatalogAdapter = {
      async list() {
        attempt += 1;
        if (attempt === 1) throw new Error('transient');
        return [makeEntry('useGeolocation')];
      },
    };
    const cat = new CachingGadgetCatalog(adapter);
    await expect(cat.list('app-1')).rejects.toThrow('transient');
    const out = await cat.list('app-1');
    expect(out).toHaveLength(1);
    expect(attempt).toBe(2);
  });

  it('separate appIds keep separate cache entries', async () => {
    const now = 1_000;
    let calls = 0;
    const adapter: GadgetCatalogAdapter = {
      async list(appId: string) {
        calls += 1;
        return [makeEntry(`useHook${appId}`)];
      },
    };
    const cat = new CachingGadgetCatalog(adapter, {
      ttlMs: 60_000,
      now: () => now,
    });
    const a1 = await cat.list('app-1');
    const a2 = await cat.list('app-2');
    expect(a1[0] && entryHook(a1[0])).toBe('useHookapp-1');
    expect(a2[0] && entryHook(a2[0])).toBe('useHookapp-2');
    expect(calls).toBe(2);

    // Cache hit for both.
    await cat.list('app-1');
    await cat.list('app-2');
    expect(calls).toBe(2);

    // Invalidate only app-1; app-2 stays cached.
    cat.invalidate('app-1');
    await cat.list('app-1');
    await cat.list('app-2');
    expect(calls).toBe(3);
  });
});
