/**
 * Contract test for {@link RegistryStorage} — every impl runs these.
 *
 * Consumed via the package's `./testing` subpath:
 *
 * ```ts
 * import { registryStorageContract } from '@ggui-ai/registry-core/testing';
 * import { inMemoryRegistryStorage } from '@ggui-ai/registry-core';
 *
 * describe('memory impl', () => {
 *   registryStorageContract(() => inMemoryRegistryStorage());
 * });
 * ```
 *
 * The factory MUST return a fresh storage every call — the contract
 * tests rely on isolation between cases.
 */
import { describe, expect, it } from 'vitest';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import type {
  AuthorKeyRow,
  ArtifactVersionRow,
  ArtifactsMetadataRow,
  CompiledBlobRow,
} from '../types.js';
import { ARTIFACTS_METADATA_SK } from '../types.js';
import type {
  ArtifactManifest,
  BlueprintManifest,
  GadgetManifest,
} from '@ggui-ai/artifact-manifest';

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

// `overrides` is typed `Partial<GadgetManifest>` (not
// `Partial<ArtifactManifest>`) so the spread cannot widen `kind` to
// the full `'gadget' | 'blueprint'` union — the literal stays
// `'gadget'` and the object satisfies the gadget union member.
function makeStubManifest(
  overrides: Partial<GadgetManifest> = {},
): ArtifactManifest {
  return {
    kind: 'gadget',
    scope: '@test',
    name: 'foo',
    version: '0.1.0',
    description: 'a test gadget',
    visibility: 'public',
    bundle: './dist/index.js',
    exports: [
      {
        hook: 'useFoo',
        description: 'the test gadget export',
        usage: 'A test gadget for registry-core contract tests',
        example: { props: {} },
      },
    ],
    ...overrides,
  } satisfies GadgetManifest;
}

/**
 * Blueprint-kind stub manifest. Separate from {@link makeStubManifest}
 * (a gadget builder) because a blueprint and a gadget manifest are
 * disjoint union members — one carries `source`, the other `bundle` +
 * `exports`. `overrides` is `Partial<BlueprintManifest>` so the spread
 * cannot widen `kind`.
 */
function makeStubBlueprintManifest(
  overrides: Partial<BlueprintManifest> = {},
): ArtifactManifest {
  return {
    kind: 'blueprint',
    scope: '@test',
    name: 'bp',
    version: '0.1.0',
    description: 'a test blueprint',
    visibility: 'public',
    source: 'export default () => null;',
    ...overrides,
  } satisfies BlueprintManifest;
}

function makeVersion(overrides: Partial<ArtifactVersionRow> = {}): ArtifactVersionRow {
  return {
    artifactId: '@test/foo',
    version: '0.1.0',
    manifest: makeStubManifest(),
    kind: 'gadget',
    visibility: 'public',
    bundleUrl: 'https://example.invalid/bundle.js',
    bundleSri: 'sha384-AAAA',
    signatureUrl: 'https://example.invalid/bundle.js.sig',
    authorPublicKey: 'BBBB',
    publishedAt: '2026-05-17T00:00:00.000Z',
    publishedBy: 'user-1',
    ...overrides,
  };
}

function makeAuthorKey(overrides: Partial<AuthorKeyRow> = {}): AuthorKeyRow {
  return {
    subject: 'user-1',
    keyId: 'key-1',
    publicKeyBase64: 'BBBB',
    ...overrides,
  };
}

function makeCompiledBlob(overrides: Partial<CompiledBlobRow> = {}): CompiledBlobRow {
  return {
    compiledDigest:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    compiledBytes: 'ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbA==',
    compiledSize: 24,
    refCount: 1,
    createdAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

export function registryStorageContract(makeStorage: () => RegistryStorage): void {
  describe('RegistryStorage contract', () => {
    describe('plugin metadata', () => {
      it('returns null for missing artifactId', async () => {
        const storage = makeStorage();
        expect(await storage.getArtifactMetadata('@nope/missing')).toBe(null);
      });

      it('round-trips a metadata row', async () => {
        const storage = makeStorage();
        const row = makeMetadata();
        await storage.putArtifactMetadata(row);
        const fetched = await storage.getArtifactMetadata(row.artifactId);
        expect(fetched).toEqual(row);
      });

      it('overwrites on second put (latest-version semantics)', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(makeMetadata({ latestVersion: '0.1.0' }));
        await storage.putArtifactMetadata(makeMetadata({ latestVersion: '0.2.0' }));
        const fetched = await storage.getArtifactMetadata('@test/foo');
        expect(fetched?.latestVersion).toBe('0.2.0');
      });
    });

    describe('scanArtifacts', () => {
      it('returns empty page on empty store', async () => {
        const storage = makeStorage();
        const page = await storage.scanArtifacts({});
        expect(page.rows).toEqual([]);
        expect(page.nextCursor).toBeUndefined();
      });

      it('returns all public rows when no filter', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/1' }));
        await storage.putArtifactMetadata(makeMetadata({ artifactId: '@b/2' }));
        const page = await storage.scanArtifacts({});
        const ids = page.rows.map((r) => r.artifactId).sort();
        expect(ids).toEqual(['@a/1', '@b/2']);
      });

      it('filters by kind', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(makeMetadata({ artifactId: '@a/g', kind: 'gadget' }));
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@b/bp', kind: 'blueprint', hook: undefined }),
        );
        const page = await storage.scanArtifacts({ kind: 'blueprint' });
        expect(page.rows.map((r) => r.artifactId)).toEqual(['@b/bp']);
      });

      it('filters by tag', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@a/x', tags: ['map', 'leaflet'] }),
        );
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@b/y', tags: ['form'] }),
        );
        const page = await storage.scanArtifacts({ tag: 'map' });
        expect(page.rows.map((r) => r.artifactId)).toEqual(['@a/x']);
      });

      it('filters by q (substring of name / description / tags)', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(
          makeMetadata({
            artifactId: '@a/leaflet',
            description: 'Map widget',
            tags: ['geo'],
          }),
        );
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@b/form', description: 'Submission form' }),
        );
        const byName = await storage.scanArtifacts({ q: 'leaf' });
        expect(byName.rows.map((r) => r.artifactId)).toEqual(['@a/leaflet']);
        const byDesc = await storage.scanArtifacts({ q: 'widget' });
        expect(byDesc.rows.map((r) => r.artifactId)).toEqual(['@a/leaflet']);
        const byTag = await storage.scanArtifacts({ q: 'geo' });
        expect(byTag.rows.map((r) => r.artifactId)).toEqual(['@a/leaflet']);
      });
    });

    describe('plugin versions', () => {
      it('returns null for missing version', async () => {
        const storage = makeStorage();
        expect(await storage.getArtifactVersion('@nope/x', '0.0.0')).toBe(null);
      });

      it('round-trips a version row', async () => {
        const storage = makeStorage();
        const row = makeVersion();
        const result = await storage.putArtifactVersionIfAbsent(row);
        expect(result).toEqual({ ok: true });
        const fetched = await storage.getArtifactVersion(row.artifactId, row.version);
        expect(fetched).toEqual(row);
      });

      it('rejects on (artifactId, version) collision', async () => {
        const storage = makeStorage();
        await storage.putArtifactVersionIfAbsent(makeVersion());
        const second = await storage.putArtifactVersionIfAbsent(makeVersion());
        expect(second).toEqual({ ok: false, reason: 'version_exists' });
      });

      it('allows the same artifactId at different versions', async () => {
        const storage = makeStorage();
        const r1 = await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.0' }));
        const r2 = await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.2.0' }));
        expect(r1).toEqual({ ok: true });
        expect(r2).toEqual({ ok: true });
      });

      it('yanks a version (sets yanked: true)', async () => {
        const storage = makeStorage();
        await storage.putArtifactVersionIfAbsent(makeVersion());
        await storage.yankArtifactVersion('@test/foo', '0.1.0');
        const fetched = await storage.getArtifactVersion('@test/foo', '0.1.0');
        expect(fetched?.yanked).toBe(true);
      });
    });

    describe('listArtifactVersions', () => {
      it('returns empty array on miss', async () => {
        const storage = makeStorage();
        expect(await storage.listArtifactVersions('@nope/missing')).toEqual([]);
      });

      it('returns every version for a single artifactId', async () => {
        const storage = makeStorage();
        await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.0' }));
        await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.2.0' }));
        await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.5' }));
        const rows = await storage.listArtifactVersions('@test/foo');
        expect(rows.map((r) => r.version).sort()).toEqual(['0.1.0', '0.1.5', '0.2.0']);
      });

      it('scopes to the requested artifactId (does NOT leak siblings)', async () => {
        const storage = makeStorage();
        await storage.putArtifactVersionIfAbsent(
          makeVersion({ artifactId: '@test/foo', version: '0.1.0' }),
        );
        await storage.putArtifactVersionIfAbsent(
          makeVersion({ artifactId: '@test/bar', version: '0.1.0' }),
        );
        const fooRows = await storage.listArtifactVersions('@test/foo');
        expect(fooRows.map((r) => r.artifactId)).toEqual(['@test/foo']);
        const barRows = await storage.listArtifactVersions('@test/bar');
        expect(barRows.map((r) => r.artifactId)).toEqual(['@test/bar']);
      });

      it('surfaces yanked: true on yanked rows', async () => {
        const storage = makeStorage();
        await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.1.0' }));
        await storage.putArtifactVersionIfAbsent(makeVersion({ version: '0.2.0' }));
        await storage.yankArtifactVersion('@test/foo', '0.1.0');
        const rows = await storage.listArtifactVersions('@test/foo');
        const sorted = [...rows].sort((a, b) => a.version.localeCompare(b.version));
        expect(sorted.map((r) => ({ v: r.version, y: r.yanked === true }))).toEqual([
          { v: '0.1.0', y: true },
          { v: '0.2.0', y: false },
        ]);
      });
    });

    describe('compiled blobs', () => {
      it('returns null on miss', async () => {
        const storage = makeStorage();
        expect(await storage.getCompiledBlob('deadbeef')).toBe(null);
      });
    });

    describe('commitVersionAndBlob (atomic two-row write)', () => {
      // New-blob path: both rows INSERT under one transaction.
      it('new-blob path — persists both rows, refCount=1, returns mode=new-blob', async () => {
        const storage = makeStorage();
        const versionRow = makeVersion({
          artifactId: '@test/bp',
          version: '0.1.0',
          kind: 'blueprint',
          manifest: makeStubBlueprintManifest({ name: 'bp', source: 'export default () => null;' }),
          compiledDigest: 'a'.repeat(64),
          bundleUrl: undefined,
          bundleSri: undefined,
          signatureUrl: undefined,
        });
        const blobRow = makeCompiledBlob({
          compiledDigest: 'a'.repeat(64),
          refCount: 1,
        });
        const result = await storage.commitVersionAndBlob(versionRow, blobRow);
        expect(result).toEqual({ ok: true, mode: 'new-blob' });
        const fetchedVersion = await storage.getArtifactVersion('@test/bp', '0.1.0');
        expect(fetchedVersion?.compiledDigest).toBe('a'.repeat(64));
        const fetchedBlob = await storage.getCompiledBlob('a'.repeat(64));
        expect(fetchedBlob?.refCount).toBe(1);
        // Full-row faithfulness — every field round-trips through the
        // new-blob path (compiledBytes, compiledSize, createdAt).
        expect(fetchedBlob).toEqual(blobRow);
      });

      // Dedup path: version INSERT + refCount bump on the existing blob.
      it('dedup path — version row inserted, refCount bumped, returns mode=dedup', async () => {
        const storage = makeStorage();
        // Pre-seed the state after a single normal publish — version row
        // + blob row (refCount=1) committed atomically.
        const sharedDigest = 'b'.repeat(64);
        const seedBlob = makeCompiledBlob({ compiledDigest: sharedDigest, refCount: 1 });
        const firstVersion = makeVersion({
          artifactId: '@test/bp1',
          version: '0.1.0',
          kind: 'blueprint',
          manifest: makeStubBlueprintManifest({ name: 'bp1', source: 'export default () => null;' }),
          compiledDigest: sharedDigest,
          bundleUrl: undefined,
          bundleSri: undefined,
          signatureUrl: undefined,
        });
        await storage.commitVersionAndBlob(firstVersion, seedBlob);

        // Now a SECOND publish with a new (artifactId, version) but the
        // same compiled output → dedup path.
        const secondVersion = makeVersion({
          artifactId: '@test/bp2',
          version: '0.1.0',
          kind: 'blueprint',
          manifest: makeStubBlueprintManifest({ name: 'bp2', source: 'export default () => null;' }),
          compiledDigest: sharedDigest,
          bundleUrl: undefined,
          bundleSri: undefined,
          signatureUrl: undefined,
        });
        const newBlob = makeCompiledBlob({ compiledDigest: sharedDigest, refCount: 1 });
        const result = await storage.commitVersionAndBlob(secondVersion, newBlob);
        expect(result).toEqual({ ok: true, mode: 'dedup' });
        const fetchedSecond = await storage.getArtifactVersion('@test/bp2', '0.1.0');
        expect(fetchedSecond?.compiledDigest).toBe(sharedDigest);
        const fetchedBlob = await storage.getCompiledBlob(sharedDigest);
        // 1 (from seed) + 1 (from commitVersionAndBlob dedup) = 2.
        expect(fetchedBlob?.refCount).toBe(2);
      });

      // Version-exists failure: NEITHER row mutates (atomicity proof).
      it('version_exists — neither row mutates when (artifactId, version) collides', async () => {
        const storage = makeStorage();
        // Pre-publish the version row + matching blob row.
        const existingDigest = 'c'.repeat(64);
        const existingVersion = makeVersion({
          artifactId: '@test/bp',
          version: '0.1.0',
          kind: 'blueprint',
          manifest: makeStubBlueprintManifest({ name: 'bp', source: 'export default () => null;' }),
          compiledDigest: existingDigest,
          bundleUrl: undefined,
          bundleSri: undefined,
          signatureUrl: undefined,
        });
        const existingBlob = makeCompiledBlob({ compiledDigest: existingDigest, refCount: 1 });
        await storage.commitVersionAndBlob(existingVersion, existingBlob);

        // Now try to commit a DIFFERENT blob under the same
        // (artifactId, version). Should refuse + leave both stores
        // untouched.
        const conflictingDigest = 'd'.repeat(64);
        const conflictingVersion = makeVersion({
          artifactId: '@test/bp',
          version: '0.1.0',
          kind: 'blueprint',
          manifest: makeStubBlueprintManifest({ name: 'bp', source: 'export default () => 1;' }),
          compiledDigest: conflictingDigest,
          bundleUrl: undefined,
          bundleSri: undefined,
          signatureUrl: undefined,
        });
        const conflictingBlob = makeCompiledBlob({
          compiledDigest: conflictingDigest,
          refCount: 1,
        });
        const result = await storage.commitVersionAndBlob(
          conflictingVersion,
          conflictingBlob,
        );
        expect(result).toEqual({ ok: false, reason: 'version_exists' });

        // Confirm: the existing version row is untouched (still points
        // at the original digest).
        const fetched = await storage.getArtifactVersion('@test/bp', '0.1.0');
        expect(fetched?.compiledDigest).toBe(existingDigest);
        // Confirm: the conflicting blob was NOT inserted.
        const conflictingBlobFetched = await storage.getCompiledBlob(conflictingDigest);
        expect(conflictingBlobFetched).toBeNull();
        // Confirm: the existing blob's refCount was NOT bumped.
        const existingBlobFetched = await storage.getCompiledBlob(existingDigest);
        expect(existingBlobFetched?.refCount).toBe(1);
      });
    });

    describe('author keys', () => {
      it('returns null on miss', async () => {
        const storage = makeStorage();
        expect(await storage.getAuthorKey('nobody', 'nope')).toBe(null);
      });

      it('round-trips an author key', async () => {
        const storage = makeStorage();
        const row = makeAuthorKey();
        await storage.putAuthorKey(row);
        expect(await storage.getAuthorKey(row.subject, row.keyId)).toEqual(row);
      });

      it('lists author keys scoped by subject', async () => {
        const storage = makeStorage();
        await storage.putAuthorKey(makeAuthorKey({ subject: 'alice', keyId: 'k1' }));
        await storage.putAuthorKey(makeAuthorKey({ subject: 'alice', keyId: 'k2' }));
        await storage.putAuthorKey(makeAuthorKey({ subject: 'bob', keyId: 'k1' }));
        const aliceKeys = await storage.listAuthorKeys('alice');
        expect(aliceKeys.map((k) => k.keyId).sort()).toEqual(['k1', 'k2']);
      });
    });
  });
}
