/**
 * `searchArtifacts` op tests.
 */
import { describe, expect, it } from 'vitest';
import { searchArtifacts } from './search.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import {
  ARTIFACTS_METADATA_SK,
  type ArtifactScanFilter,
  type ArtifactsMetadataRow,
} from '../types.js';

function makeMetadata(overrides: Partial<ArtifactsMetadataRow> = {}): ArtifactsMetadataRow {
  return {
    artifactId: '@test/foo',
    sk: ARTIFACTS_METADATA_SK,
    kind: 'gadget',
    latestVersion: '0.1.0',
    description: 'a test gadget',
    tags: ['test'],
    visibility: 'public',
    hook: 'useFoo',
    authorName: 'Alice',
    publishedAt: '2026-05-17T00:00:00.000Z',
    publishedBy: 'user-1',
    ...overrides,
  };
}

describe('searchArtifacts', () => {
  it('returns 200 with empty results on empty store', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await searchArtifacts({}, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.results).toEqual([]);
  });

  it('lists only public rows', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/pub' }));
    await storage.putArtifactMetadata(
      makeMetadata({ artifactId: '@a/priv', visibility: 'private' }),
    );

    const result = await searchArtifacts({}, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.results.map((r) => r.artifactId)).toEqual(['@a/pub']);
  });

  it('filters by kind', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/g', kind: 'gadget' }));
    await storage.putArtifactMetadata(
      makeMetadata({ artifactId: '@a/bp', kind: 'blueprint', hook: undefined }),
    );

    const result = await searchArtifacts({ kind: 'blueprint' }, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.results.map((r) => r.artifactId)).toEqual(['@a/bp']);
  });

  it('rejects unknown kind with 400', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await searchArtifacts({ kind: 'unicorn' }, { storage });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it('rejects out-of-range limit with 400', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await searchArtifacts({ limit: '9999' }, { storage });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it('returns the lightweight summary projection', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    const result = await searchArtifacts({}, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.body.results[0];
    expect(entry).toEqual({
      artifactId: '@test/foo',
      latestVersion: '0.1.0',
      kind: 'gadget',
      description: 'a test gadget',
      tags: ['test'],
      publishedAt: '2026-05-17T00:00:00.000Z',
    });
  });

  describe('sort=recent (Slice 7.5-fu L3)', () => {
    it('orders results by publishedAt DESC', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(
        makeMetadata({ artifactId: '@a/old', publishedAt: '2026-01-01T00:00:00.000Z' }),
      );
      await storage.putArtifactMetadata(
        makeMetadata({ artifactId: '@a/new', publishedAt: '2026-05-01T00:00:00.000Z' }),
      );
      await storage.putArtifactMetadata(
        makeMetadata({ artifactId: '@a/mid', publishedAt: '2026-03-01T00:00:00.000Z' }),
      );

      const result = await searchArtifacts({ sort: 'recent' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results.map((r) => r.artifactId)).toEqual([
        '@a/new',
        '@a/mid',
        '@a/old',
      ]);
    });

    it('forwards the sort to storage as the `order` filter (ordering is the port contract)', async () => {
      const inner = inMemoryRegistryStorage();
      let seenFilter: ArtifactScanFilter | undefined;
      const storage: RegistryStorage = {
        ...inner,
        scanArtifacts: async (filter) => {
          seenFilter = filter;
          return inner.scanArtifacts(filter);
        },
      };
      const result = await searchArtifacts({ sort: 'recent' }, { storage });
      expect(result.ok).toBe(true);
      expect(seenFilter?.order).toBe('recent');

      const noSort = await searchArtifacts({}, { storage });
      expect(noSort.ok).toBe(true);
      expect(seenFilter?.order).toBeUndefined();
    });

    it('keeps recency order globally correct across cursor pages', async () => {
      const storage = inMemoryRegistryStorage();
      // Insert deliberately OUT of publish order.
      const stamps = [
        '2026-01-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
        '2026-04-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
      ];
      for (const [i, publishedAt] of stamps.entries()) {
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: `@a/p${String(i)}`, publishedAt }),
        );
      }
      const collected: string[] = [];
      let cursor: string | undefined;
      let hops = 0;
      do {
        const result = await searchArtifacts(
          { sort: 'recent', limit: 2, cursor },
          { storage },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        collected.push(...result.body.results.map((r) => r.publishedAt));
        cursor = result.body.nextCursor;
        hops++;
        if (hops > 10) throw new Error('cursor chain did not terminate');
      } while (cursor !== undefined);
      expect(collected).toEqual([...stamps].sort((a, b) => b.localeCompare(a)));
    });

    it('rejects unknown sort value with 400', async () => {
      const storage = inMemoryRegistryStorage();
      const result = await searchArtifacts({ sort: 'popular' }, { storage });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
    });

    it('no sort param → impl-defined order (no recency sort applied)', async () => {
      const storage = inMemoryRegistryStorage();
      // Insert NEWER first, then OLDER. Memory impl insertion order
      // means newer comes back first WITHOUT a sort; that's fine —
      // we just want to assert the recent sort is opt-in.
      await storage.putArtifactMetadata(
        makeMetadata({ artifactId: '@a/old', publishedAt: '2026-01-01T00:00:00.000Z' }),
      );
      await storage.putArtifactMetadata(
        makeMetadata({ artifactId: '@a/new', publishedAt: '2026-05-01T00:00:00.000Z' }),
      );

      const noSort = await searchArtifacts({}, { storage });
      expect(noSort.ok).toBe(true);
      if (!noSort.ok) return;
      // Memory map insertion order — old first.
      expect(noSort.body.results.map((r) => r.artifactId)).toEqual([
        '@a/old',
        '@a/new',
      ]);

      const recent = await searchArtifacts({ sort: 'recent' }, { storage });
      expect(recent.ok).toBe(true);
      if (!recent.ok) return;
      // Recency-sorted — new first.
      expect(recent.body.results.map((r) => r.artifactId)).toEqual([
        '@a/new',
        '@a/old',
      ]);
    });
  });

  describe('mcpTools + scope-verification surfacing (MCP discovery §2)', () => {
    it('surfaces mcpTools and mcpToolsSource from the metadata row', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(
        makeMetadata({
          artifactId: '@a/weather',
          mcpTools: [{ server: 'weather-server', tool: 'get_weather' }],
          mcpToolsSource: 'declared',
        }),
      );
      const result = await searchArtifacts({}, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results[0]?.mcpTools).toEqual([
        { server: 'weather-server', tool: 'get_weather' },
      ]);
      expect(result.body.results[0]?.mcpToolsSource).toBe('declared');
    });

    it('surfaces verified scope state with its domain', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@acme/x' }));
      await storage.claimScope({
        scope: '@acme',
        ownerSubject: 'owner-1',
        claimedAt: '2026-08-01T00:00:00.000Z',
        verification: 'verified',
        verifiedDomain: 'acme.example',
        verifiedAt: '2026-08-02T00:00:00.000Z',
      });
      const result = await searchArtifacts({}, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results[0]?.scopeVerification).toBe('verified');
      expect(result.body.results[0]?.verifiedDomain).toBe('acme.example');
    });

    it('surfaces unverified scope state without a domain', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@acme/x' }));
      await storage.claimScope({
        scope: '@acme',
        ownerSubject: 'owner-1',
        claimedAt: '2026-08-01T00:00:00.000Z',
        verification: 'unverified',
      });
      const result = await searchArtifacts({}, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results[0]?.scopeVerification).toBe('unverified');
      expect(result.body.results[0]?.verifiedDomain).toBeUndefined();
    });

    it('omits both verification fields when the scope is unclaimed', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/x' }));
      const result = await searchArtifacts({}, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results[0]?.scopeVerification).toBeUndefined();
      expect(result.body.results[0]?.verifiedDomain).toBeUndefined();
    });

    it('omits verification fields when the scope-owner read fails (still 200)', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/x' }));
      const failing: RegistryStorage = {
        ...storage,
        getScopeOwner: async () => {
          throw new Error('boom');
        },
      };
      const result = await searchArtifacts({}, { storage: failing });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results[0]?.artifactId).toBe('@a/x');
      expect(result.body.results[0]?.scopeVerification).toBeUndefined();
    });

    it('reads each unique scope once per page (batched)', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/one' }));
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/two' }));
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@b/three' }));
      const scopeReads: string[] = [];
      const counting: RegistryStorage = {
        ...storage,
        getScopeOwner: async (scope) => {
          scopeReads.push(scope);
          return storage.getScopeOwner(scope);
        },
      };
      const result = await searchArtifacts({}, { storage: counting });
      expect(result.ok).toBe(true);
      expect([...scopeReads].sort()).toEqual(['@a', '@b']);
    });
  });

  describe('tool/server search filters (MCP discovery §2)', () => {
    async function seedBoundRows(storage: RegistryStorage): Promise<void> {
      await storage.putArtifactMetadata(
        makeMetadata({
          artifactId: '@a/weather-card',
          kind: 'gadget',
          mcpTools: [{ server: 'weather-server', tool: 'get_weather' }],
          mcpToolsSource: 'declared',
        }),
      );
      await storage.putArtifactMetadata(
        makeMetadata({
          artifactId: '@b/forecast-panel',
          kind: 'blueprint',
          hook: undefined,
          mcpTools: [{ tool: 'get_weather' }, { tool: 'get_forecast' }],
          mcpToolsSource: 'derived',
        }),
      );
      await storage.putArtifactMetadata(makeMetadata({ artifactId: '@c/unbound', kind: 'gadget' }));
    }

    it('tool= matches bindings with and without a server (cross-server)', async () => {
      const storage = inMemoryRegistryStorage();
      await seedBoundRows(storage);
      const result = await searchArtifacts({ tool: 'get_weather' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results.map((r) => r.artifactId).sort()).toEqual([
        '@a/weather-card',
        '@b/forecast-panel',
      ]);
    });

    it('server= matches only entries declaring that server — bare entries never match', async () => {
      const storage = inMemoryRegistryStorage();
      await seedBoundRows(storage);
      const result = await searchArtifacts({ server: 'weather-server' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results.map((r) => r.artifactId)).toEqual(['@a/weather-card']);
    });

    it('tool+server matches only the exact pair', async () => {
      const storage = inMemoryRegistryStorage();
      await seedBoundRows(storage);
      const result = await searchArtifacts(
        { tool: 'get_forecast', server: 'weather-server' },
        { storage },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results).toEqual([]);
    });

    it('AND-composes with existing filters (tool + kind)', async () => {
      const storage = inMemoryRegistryStorage();
      await seedBoundRows(storage);
      const result = await searchArtifacts({ tool: 'get_weather', kind: 'blueprint' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results.map((r) => r.artifactId)).toEqual(['@b/forecast-panel']);
    });

    it('tool matching is case-sensitive', async () => {
      const storage = inMemoryRegistryStorage();
      await seedBoundRows(storage);
      const result = await searchArtifacts({ tool: 'Get_Weather' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results).toEqual([]);
    });

    it('private rows never surface through a tool filter', async () => {
      const storage = inMemoryRegistryStorage();
      await storage.putArtifactMetadata(
        makeMetadata({
          artifactId: '@p/secret',
          visibility: 'private',
          mcpTools: [{ tool: 'get_weather' }],
          mcpToolsSource: 'declared',
        }),
      );
      const result = await searchArtifacts({ tool: 'get_weather' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results).toEqual([]);
    });

    it('rejects a malformed tool with 400 invalid_request', async () => {
      const storage = inMemoryRegistryStorage();
      const result = await searchArtifacts({ tool: 'not a tool!' }, { storage });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
    });

    it('rejects a malformed server with 400 invalid_request', async () => {
      const storage = inMemoryRegistryStorage();
      const result = await searchArtifacts({ server: 'bad/server' }, { storage });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('invalid_request');
    });

    it('treats empty-string tool/server as absent (no filter)', async () => {
      const storage = inMemoryRegistryStorage();
      await seedBoundRows(storage);
      const result = await searchArtifacts({ tool: '', server: '' }, { storage });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.body.results).toHaveLength(3);
    });
  });
});
