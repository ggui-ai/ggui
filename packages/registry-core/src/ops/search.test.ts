/**
 * `searchArtifacts` op tests.
 */
import { describe, expect, it } from 'vitest';
import { searchArtifacts } from './search.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import { ARTIFACTS_METADATA_SK, type ArtifactsMetadataRow } from '../types.js';

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
});
