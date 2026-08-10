/**
 * `readArtifact` op tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { readArtifact } from './read.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import { ARTIFACTS_METADATA_SK, type ArtifactVersionRow } from '../types.js';

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

function makeVersion(overrides: Partial<ArtifactVersionRow> = {}): ArtifactVersionRow {
  const version = overrides.version ?? '0.1.0';
  const visibility = overrides.visibility ?? 'public';
  return {
    artifactId: '@test/foo',
    version,
    // Keep the embedded manifest consistent with the row's own
    // version + visibility — a contradictory fixture would let code
    // that reads the wrong field pass silently.
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

describe('readArtifact', () => {
  it('returns 200 with the wire shape on hit', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion());

    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.body.manifest).toEqual(STUB_MANIFEST);
    expect(result.body.bundleUrl).toBe('http://test/bundle.js');
  });

  it('returns 404 on miss', async () => {
    const storage = inMemoryRegistryStorage();
    const result = await readArtifact(
      { artifactId: '@nope/missing', version: '0.0.0' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.status === 410) return;
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('not_found');
  });

  it('anonymous private read is byte-identical to a true not-found (no existence signal)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));

    const privateRead = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    const trueMiss = await readArtifact(
      { artifactId: '@test/foo', version: '9.9.9' },
      { storage },
    );
    expect(privateRead.ok).toBe(false);
    if (privateRead.ok || trueMiss.ok) return;
    expect(privateRead.status).toBe(404);
    if (privateRead.status !== 404 || trueMiss.status !== 404) return;
    expect(privateRead.body.error).toBe('not_found');
    // Same message SHAPE as the miss (modulo the version segment).
    expect(privateRead.body.message).toBe('package @test/foo@0.1.0 not found');
    expect(trueMiss.body.message).toBe('package @test/foo@9.9.9 not found');
  });

  it('returns 200 on private row when the caller is the publisher', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'user-1' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
  });

  it('returns 200 on private row when the caller owns the scope, consulting the scope-owner store exactly once (memoized, shared between the gate and verification surfacing)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    await storage.claimScope({
      scope: '@test',
      ownerSubject: 'owner-9',
      claimedAt: '2026-08-01T00:00:00.000Z',
      verification: 'unverified',
    });
    const getScopeOwnerSpy = vi.spyOn(storage, 'getScopeOwner');
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'owner-9' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(getScopeOwnerSpy).toHaveBeenCalledTimes(1);
  });

  it('an authenticated stranger gets the not-found shape, not a forbidden signal', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    await storage.claimScope({
      scope: '@test',
      ownerSubject: 'owner-9',
      claimedAt: '2026-08-01T00:00:00.000Z',
      verification: 'unverified',
    });
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'stranger-2' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    if (result.status !== 404) return;
    expect(result.body.error).toBe('not_found');
    expect(result.body.message).toBe('package @test/foo@0.1.0 not found');
  });

  it('a yanked private row is 404 (not 410) for an unauthorized caller', async () => {
    // The 410 body carries the manifest; leaking it to a stranger
    // would defeat the opaque posture. The private gate MUST fire
    // before the yank projection.
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    await storage.yankArtifactVersion('@test/foo', '0.1.0');
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'stranger-2' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });

  it('public reads consult the scope-owner store exactly once (memoized, for scopeVerification surfacing — supersedes the prior H2 zero-reads pin, MCP discovery §2)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion());
    const getScopeOwnerSpy = vi.spyOn(storage, 'getScopeOwner');
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'anyone' } },
    );
    expect(result.ok).toBe(true);
    expect(getScopeOwnerSpy).toHaveBeenCalledTimes(1);
  });

  it('the publisher fast path consults the scope-owner store exactly once (memoized, shared between the gate short-circuit and verification surfacing)', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    const getScopeOwnerSpy = vi.spyOn(storage, 'getScopeOwner');
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'user-1' } },
    );
    expect(result.ok).toBe(true);
    expect(getScopeOwnerSpy).toHaveBeenCalledTimes(1);
  });

  it('returns 410 on yanked row with manifest still in body', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion());
    await storage.yankArtifactVersion('@test/foo', '0.1.0');

    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(410);
    // 410 body is ReadPkgResponse not ErrorBody
    expect('manifest' in result.body).toBe(true);
  });

  it('fail-closed — a scope-owner lookup failure answers as not-found, never 500', async () => {
    // Only private rows trigger the owner lookup, so a distinctive
    // failure status (500) would itself be an existence oracle — and
    // an open-on-error branch would serve the private row. Treat the
    // scope as unclaimed (deny) and answer with the miss shape.
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    vi.spyOn(storage, 'getScopeOwner').mockRejectedValue(
      new Error('simulated storage outage'),
    );

    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage, authn: { subject: 'stranger-2' } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    if (result.status !== 404) return;
    expect(result.body).toEqual({
      error: 'not_found',
      message: 'package @test/foo@0.1.0 not found',
    });
  });

  it('never interpolates raw storage error text into the wire body', async () => {
    const storage = inMemoryRegistryStorage();
    vi.spyOn(storage, 'getArtifactVersion').mockRejectedValue(
      new Error('secret-internal-arn-1234'),
    );

    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(500);
    if (result.status !== 500) return;
    expect(result.body.message).not.toContain('secret-internal-arn-1234');
  });

  it('uses ARTIFACTS_METADATA_SK constant correctly (sanity)', () => {
    expect(ARTIFACTS_METADATA_SK).toBe('metadata#');
  });

  it('Slice 7.0 — resolves the CompiledBlob and inlines bytes when version row carries compiledDigest', async () => {
    const storage = inMemoryRegistryStorage();
    const blueprintManifest = {
      ...STUB_MANIFEST,
      kind: 'blueprint',
      source: 'export default () => null;',
    } as ArtifactManifest;
    await storage.commitVersionAndBlob(
      makeVersion({
        manifest: blueprintManifest,
        kind: 'blueprint',
        compiledDigest: 'a'.repeat(64),
      }),
      {
        compiledDigest: 'a'.repeat(64),
        compiledBytes: 'ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbDs=',
        compiledSize: 26,
        refCount: 1,
        createdAt: '2026-05-19T00:00:00.000Z',
      },
    );
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.compiledDigest).toBe('a'.repeat(64));
    expect(result.body.compiledBytes).toBe('ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbDs=');
  });

  it('Slice 7.0 — surfaces 500 when version row points at a non-existent compiled blob (regression pin)', async () => {
    const storage = inMemoryRegistryStorage();
    // Version row references a digest with no matching blob — should
    // never happen if publish succeeded; if it does, surface loudly.
    await storage.putArtifactVersionIfAbsent(
      makeVersion({ compiledDigest: 'b'.repeat(64) }),
    );
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.status === 410) return;
    expect(result.status).toBe(500);
    expect('error' in result.body && result.body.error).toBe('server_error');
  });

  it('surfaces scope verification on the read body when the scope row is verified', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion());
    await storage.claimScope({
      scope: '@test',
      ownerSubject: 'owner-1',
      claimedAt: '2026-08-01T00:00:00.000Z',
      verification: 'verified',
      verifiedDomain: 'test.example',
      verifiedAt: '2026-08-02T00:00:00.000Z',
    });
    const result = await readArtifact({ artifactId: '@test/foo', version: '0.1.0' }, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.scopeVerification).toBe('verified');
    expect(result.body.verifiedDomain).toBe('test.example');
  });

  it('surfaces unverified scope state without a domain on read', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion());
    await storage.claimScope({
      scope: '@test',
      ownerSubject: 'owner-1',
      claimedAt: '2026-08-01T00:00:00.000Z',
      verification: 'unverified',
    });
    const result = await readArtifact({ artifactId: '@test/foo', version: '0.1.0' }, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.scopeVerification).toBe('unverified');
    expect(result.body.verifiedDomain).toBeUndefined();
  });

  it('omits verification fields on read when the scope is unclaimed', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion());
    const result = await readArtifact({ artifactId: '@test/foo', version: '0.1.0' }, { storage });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.scopeVerification).toBeUndefined();
    expect(result.body.verifiedDomain).toBeUndefined();
  });
});
