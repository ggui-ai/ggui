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
  ScopeOwnerRow,
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

function makeScopeOwner(overrides: Partial<ScopeOwnerRow> = {}): ScopeOwnerRow {
  return {
    scope: '@test',
    ownerSubject: 'user-1',
    claimedAt: '2026-08-10T00:00:00.000Z',
    verification: 'unverified',
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

      it('order: recent returns rows newest-first by publishedAt', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@a/old', publishedAt: '2026-01-01T00:00:00.000Z' }),
        );
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@a/new', publishedAt: '2026-05-01T00:00:00.000Z' }),
        );
        await storage.putArtifactMetadata(
          makeMetadata({ artifactId: '@a/mid', publishedAt: '2026-03-01T00:00:00.000Z' }),
        );
        const page = await storage.scanArtifacts({ order: 'recent' });
        expect(page.rows.map((r) => r.artifactId)).toEqual([
          '@a/new',
          '@a/mid',
          '@a/old',
        ]);
      });

      it('order: recent stays globally correct across the cursor chain', async () => {
        const storage = makeStorage();
        // Insert deliberately OUT of publish order so insertion order
        // cannot masquerade as recency order.
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
        // Walk the FULL cursor chain with a page size smaller than the
        // row count — the concatenation must be one globally-descending
        // sequence (per-page recency is exactly the defect this
        // obligation exists to rule out).
        const collected: string[] = [];
        let cursor: string | undefined;
        let hops = 0;
        do {
          const page = await storage.scanArtifacts({
            order: 'recent',
            limit: 2,
            cursor,
          });
          collected.push(...page.rows.map((r) => r.publishedAt));
          cursor = page.nextCursor;
          hops++;
          if (hops > 10) throw new Error('cursor chain did not terminate');
        } while (cursor !== undefined);
        expect(collected).toHaveLength(stamps.length);
        expect(collected).toEqual(
          [...stamps].sort((a, b) => b.localeCompare(a)),
        );
      });

      it('order: recent composes with filter dimensions', async () => {
        const storage = makeStorage();
        await storage.putArtifactMetadata(
          makeMetadata({
            artifactId: '@a/old-gadget',
            kind: 'gadget',
            publishedAt: '2026-01-01T00:00:00.000Z',
          }),
        );
        await storage.putArtifactMetadata(
          makeMetadata({
            artifactId: '@a/bp',
            kind: 'blueprint',
            hook: undefined,
            publishedAt: '2026-04-01T00:00:00.000Z',
          }),
        );
        await storage.putArtifactMetadata(
          makeMetadata({
            artifactId: '@a/new-gadget',
            kind: 'gadget',
            publishedAt: '2026-03-01T00:00:00.000Z',
          }),
        );
        const page = await storage.scanArtifacts({
          order: 'recent',
          kind: 'gadget',
        });
        expect(page.rows.map((r) => r.artifactId)).toEqual([
          '@a/new-gadget',
          '@a/old-gadget',
        ]);
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

    describe('scope owners', () => {
      it('returns null for an unclaimed scope', async () => {
        const storage = makeStorage();
        expect(await storage.getScopeOwner('@nobody-claimed-this')).toBe(null);
      });

      it('claims an unclaimed scope and round-trips the full row', async () => {
        const storage = makeStorage();
        const row = makeScopeOwner();
        const result = await storage.claimScope(row);
        expect(result).toEqual({ ok: true });
        expect(await storage.getScopeOwner(row.scope)).toEqual(row);
      });

      it('rejects a second claim on an already-claimed scope (first row untouched)', async () => {
        const storage = makeStorage();
        const first = makeScopeOwner({ ownerSubject: 'user-1' });
        await storage.claimScope(first);
        const second = await storage.claimScope(
          makeScopeOwner({ ownerSubject: 'user-2', claimedAt: '2026-08-11T00:00:00.000Z' }),
        );
        expect(second).toEqual({ conflict: true });
        // First-writer-wins: the persisted row is the FIRST claimant's.
        expect(await storage.getScopeOwner('@test')).toEqual(first);
      });

      it('a simulated race between two claims yields exactly one winner', async () => {
        // Both claims run concurrently against the same fresh storage.
        // The atomicity obligation (conditional create — DDB
        // `attribute_not_exists(scope)`, filesystem O_EXCL, memory
        // check-and-set without an interleaving await) means EXACTLY
        // one may win; the loser MUST see `{ conflict: true }` and the
        // persisted row MUST be the winner's.
        const storage = makeStorage();
        const claimA = makeScopeOwner({ ownerSubject: 'racer-a' });
        const claimB = makeScopeOwner({ ownerSubject: 'racer-b' });
        const [a, b] = await Promise.all([
          storage.claimScope(claimA),
          storage.claimScope(claimB),
        ]);
        const results = [
          { claim: claimA, result: a },
          { claim: claimB, result: b },
        ];
        const winners = results.filter((r) => 'ok' in r.result);
        const losers = results.filter((r) => 'conflict' in r.result);
        expect(winners).toHaveLength(1);
        expect(losers).toHaveLength(1);
        expect(await storage.getScopeOwner('@test')).toEqual(winners[0]!.claim);
      });

      it('claims are scoped — sibling scopes claim independently', async () => {
        const storage = makeStorage();
        const a = await storage.claimScope(makeScopeOwner({ scope: '@alpha' }));
        const b = await storage.claimScope(
          makeScopeOwner({ scope: '@beta', ownerSubject: 'user-2' }),
        );
        expect(a).toEqual({ ok: true });
        expect(b).toEqual({ ok: true });
        expect((await storage.getScopeOwner('@alpha'))?.ownerSubject).toBe('user-1');
        expect((await storage.getScopeOwner('@beta'))?.ownerSubject).toBe('user-2');
      });

      it('updateScopeOwner rewrites the full row when the expectation matches the stored snapshot', async () => {
        const storage = makeStorage();
        await storage.claimScope(makeScopeOwner());
        const verified: ScopeOwnerRow = {
          ...makeScopeOwner(),
          verification: 'verified',
          verifiedDomain: 'test.example',
          verifiedAt: '2026-08-12T00:00:00.000Z',
        };
        const result = await storage.updateScopeOwner(verified, {
          ownerSubject: 'user-1',
          verification: 'unverified',
        });
        expect(result).toEqual({ ok: true });
        expect(await storage.getScopeOwner('@test')).toEqual(verified);
      });

      it('updateScopeOwner seeds a row when the caller expects absence (operator seed path)', async () => {
        const storage = makeStorage();
        const seeded = makeScopeOwner({ scope: '@seeded', ownerSubject: 'operator-chosen' });
        const result = await storage.updateScopeOwner(seeded, { absent: true });
        expect(result).toEqual({ ok: true });
        expect(await storage.getScopeOwner('@seeded')).toEqual(seeded);
        // A first-publish claim against the seeded scope now conflicts.
        expect(
          await storage.claimScope(makeScopeOwner({ scope: '@seeded', ownerSubject: 'squatter' })),
        ).toEqual({ conflict: true });
      });

      it('updateScopeOwner refuses a stale snapshot — RMW race loses, row untouched', async () => {
        const storage = makeStorage();
        const current = makeScopeOwner({ ownerSubject: 'current-owner' });
        await storage.claimScope(current);
        // Operator read an OLD snapshot (different owner) — e.g. a
        // concurrent transfer landed between their read and this write.
        const result = await storage.updateScopeOwner(
          makeScopeOwner({ ownerSubject: 'operator-target' }),
          { ownerSubject: 'stale-previous-owner', verification: 'unverified' },
        );
        expect(result).toEqual({ conflict: true });
        expect(await storage.getScopeOwner('@test')).toEqual(current);
      });

      it('updateScopeOwner refuses a verification-stale snapshot', async () => {
        const storage = makeStorage();
        await storage.claimScope(makeScopeOwner());
        // Verification flipped concurrently — the (owner, verification)
        // pair is the snapshot identity, so a matching owner alone is
        // not enough.
        const result = await storage.updateScopeOwner(
          makeScopeOwner({ ownerSubject: 'new-owner' }),
          { ownerSubject: 'user-1', verification: 'verified' },
        );
        expect(result).toEqual({ conflict: true });
        expect(await storage.getScopeOwner('@test')).toEqual(makeScopeOwner());
      });

      it('updateScopeOwner expect-absent refuses when a claim landed first', async () => {
        const storage = makeStorage();
        const claimed = makeScopeOwner({ ownerSubject: 'racing-claimant' });
        await storage.claimScope(claimed);
        const result = await storage.updateScopeOwner(
          makeScopeOwner({ ownerSubject: 'operator-target' }),
          { absent: true },
        );
        expect(result).toEqual({ conflict: true });
        expect(await storage.getScopeOwner('@test')).toEqual(claimed);
      });

      it('updateScopeOwner expect-match refuses when the row is missing', async () => {
        const storage = makeStorage();
        const result = await storage.updateScopeOwner(makeScopeOwner(), {
          ownerSubject: 'user-1',
          verification: 'unverified',
        });
        expect(result).toEqual({ conflict: true });
        expect(await storage.getScopeOwner('@test')).toBeNull();
      });

      it('getScopeOwner observes a completed claim immediately (conflict re-read obligation)', async () => {
        // The publish gate's claim-conflict path re-reads to learn the
        // winner. A read that can miss a completed claim would turn the
        // losing racer's publish into a spurious storage-inconsistency
        // failure — reads MUST be read-your-writes strong here.
        const storage = makeStorage();
        await storage.claimScope(makeScopeOwner({ ownerSubject: 'winner' }));
        expect((await storage.getScopeOwner('@test'))?.ownerSubject).toBe('winner');
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
