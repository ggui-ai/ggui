/**
 * `publishArtifact` op tests. Covers the load-bearing flow gates:
 * manifest validation, bundle size, hash mismatch, unknown key,
 * signature verify, version_exists, success path.
 *
 * Sigstore branch (Bucket B'' B''.5) is covered via `vi.mock` against
 * `@ggui-ai/gadget-signing` — the real upstream sigstore flow needs
 * Fulcio + Rekor network access (or a `@sigstore/mock` fixture) which
 * is out of scope for the unit-test layer. The dispatch wiring itself
 * is the load-bearing thing we pin here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateEd25519Keypair,
  signBundleEd25519,
  canonicalJson,
  type Ed25519Signature,
  type SigstoreSignature,
} from '@ggui-ai/gadget-signing';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import { publishArtifact } from './publish.js';
import { inMemoryRegistryStorage } from '../impls/memory-registry-storage.js';
import { inMemoryBundleStorage } from '../impls/memory-bundle-storage.js';
import type { RegistryStorage } from '../interfaces/registry-storage.js';
import type { BundleStorage } from '../interfaces/bundle-storage.js';
import type { BlueprintProbeRunner } from './conformance.js';
import { base64Encode, sha384Base64 } from '../utils/base64.js';

// Hoisted mocks for the sigstore branch — see suite at end of file.
// `vi.hoisted` lets the mock factory close over fresh `vi.fn()` refs that
// each test re-stubs via `mockResolvedValue` without losing the
// pass-through bindings the rest of the module needs.
const sigstoreMocks = vi.hoisted(() => ({
  verifyBundleSigstore: vi.fn(),
}));

vi.mock('@ggui-ai/gadget-signing', async () => {
  const actual = await vi.importActual<typeof import('@ggui-ai/gadget-signing')>(
    '@ggui-ai/gadget-signing',
  );
  return {
    ...actual,
    verifyBundleSigstore: sigstoreMocks.verifyBundleSigstore,
  };
});

const GADGET_MANIFEST: ArtifactManifest = {
  kind: 'gadget',
  scope: '@test',
  name: 'weather',
  version: '1.0.0',
  bundle: 'src/index.ts',
  visibility: 'public',
  description: 'A test weather gadget',
  exports: [
    {
      hook: 'useWeather',
      description: 'A test weather gadget',
      usage: 'Renders a weather card for a given city',
      example: { city: 'SF' },
    },
  ],
} as ArtifactManifest;

const VALID_BUNDLE_TEXT = `
import { useState } from 'react';
import { jsx } from 'react/jsx-runtime';
export function useWeather() { return { temp: 72 }; }
`;

interface Fixture {
  storage: RegistryStorage;
  bundleStorage: BundleStorage;
  bundleBytes: Uint8Array;
  bundleB64: string;
  bundleSha384: string;
  signature: Ed25519Signature;
  keypair: Awaited<ReturnType<typeof generateEd25519Keypair>>;
  subject: string;
  publicKeyBase64: string;
}

async function makeFixture(manifest: ArtifactManifest = GADGET_MANIFEST): Promise<Fixture> {
  const keypair = await generateEd25519Keypair();
  const { publicKey, privateKey, publicKeyId } = keypair;
  const subject = 'user-1';
  const bundleBytes = new TextEncoder().encode(VALID_BUNDLE_TEXT);
  const signaturePayload =
    manifest.kind === 'gadget'
      ? bundleBytes
      : new TextEncoder().encode(canonicalJson(manifest));
  const signature = await signBundleEd25519({
    bundleBytes: signaturePayload,
    privateKey,
    publicKeyId,
  });
  const publicKeyBase64 = base64Encode(publicKey);

  const storage = inMemoryRegistryStorage();
  await storage.putAuthorKey({ subject, keyId: publicKeyId, publicKeyBase64 });

  return {
    storage,
    bundleStorage: inMemoryBundleStorage({ bundleHost: 'http://localhost:9001' }),
    bundleBytes,
    bundleB64: base64Encode(bundleBytes),
    bundleSha384: sha384Base64(bundleBytes),
    signature,
    keypair,
    subject,
    publicKeyBase64,
  };
}

describe('publishArtifact', () => {
  it('happy path — gadget publish writes rows, uploads blobs, returns 201', async () => {
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date('2026-05-17T12:00:00.000Z'),
        registryHostname: 'localhost:9001',
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(201);
    expect(result.body.artifactId).toBe('@test/weather');
    expect(result.body.version).toBe('1.0.0');
    expect(result.body.bundleUrl).toContain('@test/weather/1.0.0/bundle.js');
    expect(result.body.installCommand).toBe(
      'ggui gadget install @test/weather@1.0.0 --registry=http://localhost:9001',
    );

    const metadata = await f.storage.getArtifactMetadata('@test/weather');
    expect(metadata?.latestVersion).toBe('1.0.0');
    expect(metadata?.kind).toBe('gadget');

    const versionRow = await f.storage.getArtifactVersion('@test/weather', '1.0.0');
    expect(versionRow?.publishedBy).toBe(f.subject);
    expect(versionRow?.bundleSri).toMatch(/^sha384-/);

    const storedBundle = await f.bundleStorage.getBundle('@test', 'weather', '1.0.0');
    expect(storedBundle).toEqual(f.bundleBytes);
  });

  it('rejects with `unauthorized` when authn.subject is empty', async () => {
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: '' },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(401);
    expect(result.body.error).toBe('unauthorized');
  });

  it('rejects with `manifest_invalid` on broken manifest', async () => {
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: { ...GADGET_MANIFEST, name: 'INVALID_CAPS' },
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error).toBe('manifest_invalid');
  });

  it('rejects with `bundle_required` for gadget publish without bundle', async () => {
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error).toBe('bundle_required');
  });

  it('rejects with `bundle_hash_mismatch` when client SHA-384 disagrees', async () => {
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: f.bundleB64,
        bundleSha384: 'AAAAAAAA',
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.body.error).toBe('bundle_hash_mismatch');
  });

  it('rejects with `unknown_key` when no AuthorKeys row matches', async () => {
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: { ...f.signature, publicKeyId: 'not-registered' },
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('unknown_key');
  });

  it('rejects with `version_exists` on re-publish', async () => {
    const f = await makeFixture();
    const first = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(first.ok).toBe(true);

    const second = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: f.signature,
      },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('version_exists');
  });

  it('rejects with `conformance_failed` and hoists conformanceFailureCode to top of body', async () => {
    // Bucket B P1-G8 follow-up regression: the first failure's
    // sub-discriminator MUST surface at the wire body's TOP level so
    // callers can branch without parsing nested JSON. The full per-
    // error list stays in `detail.errors` for verbose rendering.
    const badBundleText = `
      import x from 'lodash';
      export function useWeather() { return x; }
    `;
    const badBundleBytes = new TextEncoder().encode(badBundleText);
    const { publicKey, privateKey, publicKeyId } = await generateEd25519Keypair();
    const subject = 'user-1';
    const signature = await signBundleEd25519({
      bundleBytes: badBundleBytes,
      privateKey,
      publicKeyId,
    });
    const publicKeyBase64 = base64Encode(publicKey);
    const storage = inMemoryRegistryStorage();
    await storage.putAuthorKey({ subject, keyId: publicKeyId, publicKeyBase64 });
    const bundleStorage = inMemoryBundleStorage({ bundleHost: 'http://localhost:9001' });

    const result = await publishArtifact(
      {
        manifest: GADGET_MANIFEST,
        bundle: base64Encode(badBundleBytes),
        bundleSha384: sha384Base64(badBundleBytes),
        signature,
      },
      {
        storage,
        bundleStorage,
        authn: { subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('conformance_failed');
    expect(result.body.conformanceFailureCode).toBe('disallowed_import');
    expect(result.body.detail).toBeDefined();
    const detail = result.body.detail as { errors: ReadonlyArray<{ code: string }> };
    expect(detail.errors[0]?.code).toBe('disallowed_import');
  });

  // ── B'-A11 site 1: registry-core publish op probe wiring ──────────
  //
  // The publish op accepts an optional `deps.blueprintProbe`. Three
  // observable behaviours need pinning:
  //
  //   (a) probe undefined  → probe never invoked (skipped path)
  //   (b) probe returns ok → publish proceeds normally
  //   (c) probe returns ko → 400 conformance_failed with the probe
  //                          code hoisted to top-level
  //
  // The static gates already accepted the manifest at this point (so
  // any probe-time error code surfaces from the probe runner, not the
  // static gate).

  describe('blueprint probe wiring (Bucket B\', 2026-05-18)', () => {
    const BLUEPRINT_MANIFEST: ArtifactManifest = {
      kind: 'blueprint',
      scope: '@test',
      name: 'login',
      version: '0.1.0',
      visibility: 'public',
      description: 'A test blueprint',
      source: 'export default function Login(){ return <div>Login</div>; }',
      variance: { persona: 'casual-shopper', seedPrompt: 'A simple login form' },
    } as ArtifactManifest;

    it('skips the probe when `deps.blueprintProbe` is undefined', async () => {
      // Sanity-check the skip path. If the publish op ever incorrectly
      // calls a missing probe, this assertion still holds (control case
      // for the always-throws probe test below).
      const f = await makeFixture(BLUEPRINT_MANIFEST);
      const result = await publishArtifact(
        { manifest: BLUEPRINT_MANIFEST, signature: f.signature },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
          // blueprintProbe deliberately undefined
        },
      );
      expect(result.ok).toBe(true);
    });

    it('skips the probe even when a probe is set on a non-blueprint kind', async () => {
      // Gadget manifests must never invoke the probe. Use a probe that
      // throws — if the op accidentally calls it, the test fails loud.
      const throwingProbe: BlueprintProbeRunner = {
        probe: async () => {
          throw new Error('probe should not run for gadget manifests');
        },
      };
      const f = await makeFixture();
      const result = await publishArtifact(
        {
          manifest: GADGET_MANIFEST,
          bundle: f.bundleB64,
          bundleSha384: f.bundleSha384,
          signature: f.signature,
        },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
          blueprintProbe: throwingProbe,
        },
      );
      expect(result.ok).toBe(true);
    });

    it('proceeds normally when a probe returns `ok: true`', async () => {
      let probeCallCount = 0;
      const okProbe: BlueprintProbeRunner = {
        probe: async () => {
          probeCallCount += 1;
          return { ok: true, errors: [] };
        },
      };
      const f = await makeFixture(BLUEPRINT_MANIFEST);
      const result = await publishArtifact(
        { manifest: BLUEPRINT_MANIFEST, signature: f.signature },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
          blueprintProbe: okProbe,
        },
      );
      expect(result.ok).toBe(true);
      // Pin invocation count so a future refactor that double-runs the
      // probe (e.g. via a retry loop) is caught here.
      expect(probeCallCount).toBe(1);
    });

    it('fails with 400 conformance_failed when a probe returns `ok: false`', async () => {
      const failingProbe: BlueprintProbeRunner = {
        probe: async () => ({
          ok: false,
          errors: [
            {
              code: 'blueprint_runtime_probe_failed',
              message: 'simulated probe failure for test',
            },
          ],
        }),
      };
      const f = await makeFixture(BLUEPRINT_MANIFEST);
      const result = await publishArtifact(
        { manifest: BLUEPRINT_MANIFEST, signature: f.signature },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
          blueprintProbe: failingProbe,
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('conformance_failed');
      expect(result.body.conformanceFailureCode).toBe(
        'blueprint_runtime_probe_failed',
      );
      const detail = result.body.detail as {
        errors: ReadonlyArray<{ code: string; message: string }>;
      };
      expect(detail.errors[0]?.code).toBe('blueprint_runtime_probe_failed');
      expect(detail.errors[0]?.message).toBe('simulated probe failure for test');
    });
  });

  it('blueprint publish — no bundle, signature over canonical manifest bytes', async () => {
    const blueprintManifest: ArtifactManifest = {
      kind: 'blueprint',
      scope: '@test',
      name: 'login',
      version: '0.1.0',
      visibility: 'public',
      description: 'A test blueprint',
      source: 'export default function Login(){ return <div>Login</div>; }',
      variance: { persona: 'casual-shopper', seedPrompt: 'A simple login form' },
    } as ArtifactManifest;
    const f = await makeFixture(blueprintManifest);

    const result = await publishArtifact(
      { manifest: blueprintManifest, signature: f.signature },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body.installCommand).toContain('ggui blueprint install');
    expect(result.body.bundleUrl).toBeUndefined();

    const versionRow = await f.storage.getArtifactVersion('@test/login', '0.1.0');
    // Slice 7.0 (TSX→JS compile boundary): the version row carries
    // only a content-addressed pointer; raw TSX stays on
    // manifest.source; compiled JS bytes live in the CompiledBlob row.
    expect(versionRow?.compiledDigest).toMatch(/^[a-f0-9]{64}$/);
    // Raw TSX stays on manifest.source for audit / future-recompile;
    // narrow the manifest union before reading the blueprint field.
    expect(versionRow?.manifest.kind).toBe('blueprint');
    if (versionRow?.manifest.kind === 'blueprint') {
      expect(typeof versionRow.manifest.source).toBe('string');
    }
    const blob = await f.storage.getCompiledBlob(versionRow!.compiledDigest!);
    expect(blob).not.toBeNull();
    expect(blob?.compiledSize).toBeGreaterThan(0);
    expect(blob?.refCount).toBe(1);
    // The compiled bytes are esbuild output, not TSX — but they should
    // still contain the function name we wrote (esbuild preserves
    // identifiers under `keepNames: true`).
    const compiledText = Buffer.from(blob!.compiledBytes, 'base64').toString('utf-8');
    expect(compiledText).toContain('Login');
  });

  it('Slice 7.0 — blueprint with invalid TSX source returns conformance_failed with blueprint_compile_error', async () => {
    const brokenManifest: ArtifactManifest = {
      kind: 'blueprint',
      scope: '@test',
      name: 'broken',
      version: '0.1.0',
      visibility: 'public',
      description: 'broken',
      // Syntactically invalid TSX (unterminated JSX).
      source: 'export default function B() { return <div is not valid; }',
      variance: { persona: 'casual-shopper', seedPrompt: 'b' },
    } as ArtifactManifest;
    const f = await makeFixture(brokenManifest);
    const result = await publishArtifact(
      { manifest: brokenManifest, signature: f.signature },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('conformance_failed');
    expect(result.body.conformanceFailureCode).toBe('blueprint_compile_error');

    // Critical: NO version row should have been written when the compile
    // gate fails. Confirms compile happens BEFORE the storage write.
    const row = await f.storage.getArtifactVersion('@test/broken', '0.1.0');
    expect(row).toBeNull();
  });

  it('Slice 7.0 — two-layer dedup: byte-identical compiled output increments refCount on second publish', async () => {
    const sharedSource =
      'export default function Shared(){ return <span>shared</span>; }';
    const v1Manifest: ArtifactManifest = {
      kind: 'blueprint',
      scope: '@test',
      name: 'shared',
      version: '0.1.0',
      visibility: 'public',
      description: 'shared blueprint',
      source: sharedSource,
      variance: { persona: 'casual-shopper', seedPrompt: 'shared' },
    } as ArtifactManifest;
    const v2Manifest: ArtifactManifest = { ...v1Manifest, version: '0.2.0' };

    const f = await makeFixture(v1Manifest);
    const sig2 = await signBundleEd25519({
      bundleBytes: new TextEncoder().encode(canonicalJson(v2Manifest)),
      privateKey: f.keypair.privateKey,
      publicKeyId: f.keypair.publicKeyId,
    });

    const r1 = await publishArtifact(
      { manifest: v1Manifest, signature: f.signature },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(r1.ok).toBe(true);

    const row1 = await f.storage.getArtifactVersion('@test/shared', '0.1.0');
    expect(row1?.compiledDigest).toMatch(/^[a-f0-9]{64}$/);
    const blob1 = await f.storage.getCompiledBlob(row1!.compiledDigest!);
    expect(blob1?.refCount).toBe(1);

    // Second publish — same source at a new version. Byte-identical
    // compiled output → blob-layer dedup → refCount 1 → 2. Signed with
    // the SAME author key so signature verification passes.
    const r2 = await publishArtifact(
      { manifest: v2Manifest, signature: sig2 },
      {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject: f.subject },
        clock: () => new Date(),
        registryHostname: 'localhost:9001',
      },
    );
    expect(r2.ok).toBe(true);

    const row2 = await f.storage.getArtifactVersion('@test/shared', '0.2.0');
    expect(row2?.compiledDigest).toBe(row1!.compiledDigest);
    const blob2 = await f.storage.getCompiledBlob(row1!.compiledDigest!);
    expect(blob2?.refCount).toBe(2);
  });

  // ── Bucket B'' B''.5 — sigstore branch dispatch ───────────────────
  //
  // The verify impl lives in `@ggui-ai/gadget-signing` (mocked above).
  // These tests pin the dispatch wiring at the publish-op layer:
  //   (a) valid sigstore signature → row inserted, leaf cert PEM
  //       (base64 raw bytes) pinned on `authorPublicKey`.
  //   (b) invalid sigstore signature → 400 signature_invalid with the
  //       verify reason surfaced verbatim.
  //   (c) verify-OK but bundle missing cert chain → 400
  //       signature_invalid (we can't pin signer identity).
  describe('sigstore signature branch (Bucket B\'\' B\'\'.5)', () => {
    const FULCIO_LEAF_CERT_B64 = 'MIIBSGltdWxhdGVkLWZ1bGNpby1sZWFmLWNlcnQ='; // arbitrary base64
    const SIGSTORE_BUNDLE_OBJ = {
      mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
      verificationMaterial: {
        x509CertificateChain: {
          certificates: [{ rawBytes: FULCIO_LEAF_CERT_B64 }],
        },
      },
      messageSignature: {
        messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' },
        signature: 'BBBB',
      },
    };

    async function makeSigstoreFixture(
      manifest: ArtifactManifest = GADGET_MANIFEST,
    ): Promise<{
      storage: RegistryStorage;
      bundleStorage: BundleStorage;
      bundleBytes: Uint8Array;
      bundleB64: string;
      bundleSha384: string;
      signature: SigstoreSignature;
      subject: string;
    }> {
      const subject = 'cognito-public-publisher';
      const bundleBytes = new TextEncoder().encode(VALID_BUNDLE_TEXT);
      const storage = inMemoryRegistryStorage();
      // No AuthorKeys row needed — sigstore branch doesn't consult it.
      const sha = sha384Base64(bundleBytes);
      const signature: SigstoreSignature = {
        algorithm: 'sigstore-cosign',
        bundleSha384: sha,
        bundle: JSON.stringify(SIGSTORE_BUNDLE_OBJ),
        signedAt: '2026-05-18T00:00:00.000Z',
      };
      // Touch the manifest variable so the helper accepts blueprint
      // manifests in a future expansion without re-wiring callers.
      void manifest;
      return {
        storage,
        bundleStorage: inMemoryBundleStorage({ bundleHost: 'http://localhost:9001' }),
        bundleBytes,
        bundleB64: base64Encode(bundleBytes),
        bundleSha384: sha,
        signature,
        subject,
      };
    }

    beforeEach(() => {
      sigstoreMocks.verifyBundleSigstore.mockReset();
    });

    it('valid sigstore signature → 201 + leaf-cert PEM pinned on authorPublicKey', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const f = await makeSigstoreFixture();
      const result = await publishArtifact(
        {
          manifest: GADGET_MANIFEST,
          bundle: f.bundleB64,
          bundleSha384: f.bundleSha384,
          signature: f.signature,
        },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date('2026-05-18T00:00:00.000Z'),
          registryHostname: 'localhost:9001',
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(201);
      // Sigstore verify must have been invoked once with the bundle bytes.
      expect(sigstoreMocks.verifyBundleSigstore).toHaveBeenCalledTimes(1);
      const callArg = sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0] as {
        bundleBytes: Uint8Array;
        signature: SigstoreSignature;
      };
      expect(callArg.bundleBytes).toEqual(f.bundleBytes);
      expect(callArg.signature.algorithm).toBe('sigstore-cosign');
      // Leaf cert PEM (= base64 raw bytes from the bundle) pinned on the row.
      const row = await f.storage.getArtifactVersion('@test/weather', '1.0.0');
      expect(row?.authorPublicKey).toBe(FULCIO_LEAF_CERT_B64);
    });

    it('invalid sigstore signature → 400 signature_invalid with reason surfaced', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({
        valid: false,
        reason: 'simulated upstream verify failure',
      });
      const f = await makeSigstoreFixture();
      const result = await publishArtifact(
        {
          manifest: GADGET_MANIFEST,
          bundle: f.bundleB64,
          bundleSha384: f.bundleSha384,
          signature: f.signature,
        },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('signature_invalid');
      expect(result.body.message).toContain('simulated upstream verify failure');
      // No row written on verify failure.
      const row = await f.storage.getArtifactVersion('@test/weather', '1.0.0');
      expect(row).toBe(null);
    });

    it('verify OK but bundle missing cert chain → 400 signature_invalid (cannot pin signer)', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const f = await makeSigstoreFixture();
      // Substitute a bundle JSON without verificationMaterial.
      const corruptedSignature: SigstoreSignature = {
        ...f.signature,
        bundle: JSON.stringify({
          mediaType: SIGSTORE_BUNDLE_OBJ.mediaType,
          messageSignature: SIGSTORE_BUNDLE_OBJ.messageSignature,
        }),
      };
      const result = await publishArtifact(
        {
          manifest: GADGET_MANIFEST,
          bundle: f.bundleB64,
          bundleSha384: f.bundleSha384,
          signature: corruptedSignature,
        },
        {
          storage: f.storage,
          bundleStorage: f.bundleStorage,
          authn: { subject: f.subject },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('signature_invalid');
      expect(result.body.message).toContain('verificationMaterial.x509CertificateChain');
    });
  });
});
