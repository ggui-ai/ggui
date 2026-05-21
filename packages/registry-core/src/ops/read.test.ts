/**
 * `readArtifact` op tests.
 */
import { describe, expect, it } from 'vitest';
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
} as ArtifactManifest;

function makeVersion(overrides: Partial<ArtifactVersionRow> = {}): ArtifactVersionRow {
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

  it('returns 403 on private row without authn', async () => {
    const storage = inMemoryRegistryStorage();
    await storage.putArtifactVersionIfAbsent(makeVersion({ visibility: 'private' }));
    const result = await readArtifact(
      { artifactId: '@test/foo', version: '0.1.0' },
      { storage },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it('returns 200 on private row with authn', async () => {
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
});
