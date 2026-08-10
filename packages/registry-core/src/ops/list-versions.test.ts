/**
 * `listArtifactVersions` op tests. Slice 7.5-follow-up L3 (2026-05-19).
 *
 * Mirrors `read.test.ts`'s shape — same in-memory storage harness, same
 * branch-by-branch coverage (200 happy path, 404 missing artifact,
 * 200-with-empty-versions for unauthed caller against private-only
 * artifact, semver DESC ordering, yanked rows surfaced).
 */
import { describe, expect, it, vi } from 'vitest';
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
};

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
  const version = overrides.version ?? '0.1.0';
  const visibility = overrides.visibility ?? 'public';
  return {
    artifactId: '@test/foo',
    version,
    // Keep the embedded manifest consistent with the row's own
    // version + visibility — the fixture previously stamped every row
    // with a `0.1.0`/`public` manifest, contradicting rows created as
    // `0.2.0` or `private`; code reading the wrong field would have
    // passed silently.
    manifest: { ...STUB_MANIFEST, version, visibility },
    kind: 'gadget',
    visibility,
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

  it('returns private rows when the caller is their publisher', async () => {
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

  it('filters private rows an authenticated stranger cannot read (no error, no leak)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.2.0', visibility: 'public' }),
    );
    await storage.claimScope({
      scope: '@test',
      ownerSubject: 'owner-9',
      claimedAt: '2026-08-01T00:00:00.000Z',
      verification: 'unverified',
    });

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage, authn: { subject: 'stranger-2' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Same degradation shape as the anonymous filter — the stranger
    // sees exactly what an anonymous caller sees.
    expect(result.body.versions.map((v) => v.version)).toEqual(['0.2.0']);
  });

  it('returns private rows when the caller owns the scope but did not publish them', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private', publishedBy: 'user-1' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.2.0', visibility: 'private', publishedBy: 'user-1' }),
    );
    await storage.claimScope({
      scope: '@test',
      ownerSubject: 'owner-9',
      claimedAt: '2026-08-01T00:00:00.000Z',
      verification: 'unverified',
    });

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage, authn: { subject: 'owner-9' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.versions.map((v) => v.version)).toEqual(['0.2.0', '0.1.0']);
  });

  it('resolves the scope owner at most ONCE across many private rows (memoized lazy lookup)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.2.0', visibility: 'private' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.3.0', visibility: 'private' }),
    );
    const getScopeOwnerSpy = vi.spyOn(storage, 'getScopeOwner');

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage, authn: { subject: 'stranger-2' } },
    );
    // All rows are private and unreadable → the not-found shape; the
    // pin here is the SINGLE owner lookup across three private rows.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(getScopeOwnerSpy).toHaveBeenCalledTimes(1);
  });

  it('anonymous callers never trigger a scope-owner lookup', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );
    const getScopeOwnerSpy = vi.spyOn(storage, 'getScopeOwner');

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    // The only version is private → anonymous gets the not-found
    // shape; the pin here is the ZERO owner lookups (anonymous denial
    // is decided before the owner arm).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(getScopeOwnerSpy).not.toHaveBeenCalled();
  });

  it('an artifact with no visible versions answers byte-identically to a true miss (no existence oracle)', async () => {
    // The metadata row exists but every version is private and the
    // caller may read none of them. A 200 `versions: []` here would
    // DIFFER from the true-miss 404 — that difference is an existence
    // oracle (probe an id, learn whether a private artifact lives
    // there). The op must answer exactly as if the artifact did not
    // exist.
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );

    const fullyInvisible = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    const trueMiss = await listArtifactVersions(
      { artifactId: '@test/absent' },
      { storage },
    );
    expect(fullyInvisible.ok).toBe(false);
    expect(trueMiss.ok).toBe(false);
    if (fullyInvisible.ok || trueMiss.ok) return;
    expect(fullyInvisible.status).toBe(404);
    expect(fullyInvisible.body.error).toBe('not_found');
    expect(fullyInvisible.body.message).toBe('no such artifact: @test/foo');
    expect(trueMiss.body.message).toBe('no such artifact: @test/absent');
  });

  it('fail-closed — a scope-owner lookup failure filters the row instead of erroring', async () => {
    // A storage fault during the ownership check must not surface as
    // a 500: only private rows trigger the lookup, so a distinctive
    // failure status would itself be an existence oracle — and an
    // open-on-error branch would serve the private row. Treat the
    // scope as unclaimed (deny) and keep listing.
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.1.0', visibility: 'private' }),
    );
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ version: '0.2.0', visibility: 'public' }),
    );
    vi.spyOn(storage, 'getScopeOwner').mockRejectedValue(
      new Error('simulated storage outage'),
    );

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage, authn: { subject: 'stranger-2' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.versions.map((v) => v.version)).toEqual(['0.2.0']);
  });

  it('never interpolates raw storage error text into the wire body', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactMetadata(makeMetadata());
    vi.spyOn(storage, 'listArtifactVersions').mockRejectedValue(
      new Error('secret-internal-arn-1234'),
    );

    const result = await listArtifactVersions(
      { artifactId: '@test/foo' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    expect(result.body.message).not.toContain('secret-internal-arn-1234');
  });
});
