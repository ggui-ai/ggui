/**
 * `listArtifactVersions` op tests. Slice 7.5-follow-up L3 (2026-05-19).
 *
 * Mirrors `read.test.ts`'s shape — same in-memory storage harness, same
 * branch-by-branch coverage (200 happy path, 404 missing artifact,
 * 200-with-empty-versions for unauthed caller against private-only
 * artifact, semver DESC ordering, yanked rows surfaced).
 */
import { describe, expect, it } from 'vitest';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import { listArtifactVersions } from './list-versions.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import {
  ARTIFACTS_METADATA_SK,
  type ArtifactVersionRow,
  type ArtifactsMetadataRow,
} from '../types.js';

const STUB_MANIFEST: ArtifactManifest = {
  kind: 'gadget',
  scope: '@test',
  name: 'foo',
  version: '0.1.0',
  bundle: 'src/index.ts',
  visibility: 'public',
  description: 'a',
  exports: [{ hook: 'useFoo', description: 'a', usage: 'b', example: {} }],
} as ArtifactManifest;

function makeMetadata(
  overrides: Partial<ArtifactsMetadataRow> = {},
): ArtifactsMetadataRow {
  return {
    artifactId: '@test/foo',
    sk: ARTIFACTS_METADATA_SK,
    kind: 'gadget',
    latestVersion: '0.2.0',
    description: 'a',
    visibility: 'public',
    publishedAt: '2026-05-17T00:00:00.000Z',
    publishedBy: 'user-1',
    ...overrides,
  };
}

function makeVersion(
  overrides: Partial<ArtifactVersionRow> = {},
): ArtifactVersionRow {
  return {
    artifactId: '@test/foo',
    version: '0.1.0',
    manifest: STUB_MANIFEST,
    kind: 'gadget',
    visibility: 'public',
    bundleUrl: 'http://test/bundle.js',
    bundleSri: 'sha384-X',
    signatureUrl: 'http://test/bundle.js.sig',
    publishedAt: '2026-05-17T00:00:00.000Z',
    publishedBy: 'user-1',
    ...overrides,
  };
}

describe('listArtifactVersions', () => {
  it('returns 400 on empty artifactId', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await listArtifactVersions({ artifactId: '' }, { storage });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid_request');
  });

  it('returns 404 when artifact metadata is absent', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await listArtifactVersions(
      { artifactId: '@nope/missing' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('not_found');
  });

  it('returns 200 with semver-DESC ordering on hit', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.0' }));
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.2.0' }));
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.5' }));

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body.artifactId).toBe('@test/foo');
    expect(result.body.versions.map((v) => v.version)).toEqual([
      '0.2.0',
      '0.1.5',
      '0.1.0',
    ]);
  });

  it('orders semver correctly including pre-release', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '1.0.0-alpha' }));
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '1.0.0' }));
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.9.0' }));
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '2.0.0-rc.1' }));

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2.0.0-rc.1 > 1.0.0 > 1.0.0-alpha > 0.9.0 (pre-release < release at same core).
    expect(result.body.versions.map((v) => v.version)).toEqual([
      '2.0.0-rc.1',
      '1.0.0',
      '1.0.0-alpha',
      '0.9.0',
    ]);
  });

  it('surfaces yanked: true on yanked rows (does NOT filter)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.0' }));
    await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.2.0' }));
    await storage.yankArtifactVersion('@test/foo', '0.1.0');

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.versions).toEqual([
      {
        version: '0.2.0',
        publishedAt: '2026-05-17T00:00:00.000Z',
        yanked: false,
        kind: 'gadget',
        visibility: 'public',
      },
      {
        version: '0.1.0',
        publishedAt: '2026-05-17T00:00:00.000Z',
        yanked: true,
        kind: 'gadget',
        visibility: 'public',
      },
    ]);
  });

  it('filters private rows for unauthenticated callers', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.2.0', visibility: 'public' }),
    );

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the public row.
    expect(result.body.versions.map((v) => v.version)).toEqual(['0.2.0']);
  });

  it('returns private rows for authenticated callers', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.2.0', visibility: 'public' }),
    );

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage, authn: { subject: 'user-1' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.versions.map((v) => v.version)).toEqual(['0.2.0', '0.1.0']);
  });

  it('returns empty versions when all rows are private and caller is unauthed (does NOT 404)', async () => {
    // The metadata row exists (public artifacts can be created via
    // partial-publish flows or org migration), but every version is
    // private. We MUST NOT 404 here — that would leak the existence
    // of a private artifact. 200 with `versions: []` is the
    // information-hiding choice (cf. GitHub private-repo 404).
    //
    // The metadata row in this scenario is itself public (defensive
    // — we never gate on metadata.visibility, see op-level comment).
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.versions).toEqual([]);
  });
});
