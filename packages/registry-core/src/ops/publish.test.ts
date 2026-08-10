/**
 * `publishArtifact` op tests. Covers the load-bearing flow gates:
 * manifest validation, bundle size, hash mismatch, unknown key,
 * signature verify, version_exists, success path.
 *
 * Sigstore branch: `verifyBundleSigstore` is mocked HERE (via
 * `vi.mock` against `@ggui-ai/gadget-signing`) for cheap gate-order +
 * error-path + option-threading coverage only. The REAL cryptographic
 * publish path — genuine sigstore-signed bundle through the full op,
 * verified against mock Fulcio/Rekor/TUF infrastructure — lives in
 * `publish.sigstore.integration.test.ts` (F3), which this file's
 * mocked dispatch pins must never substitute for.
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
import { publishArtifact, type PublishArtifactDeps } from './publish.js';
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

// Default fixture pairs `visibility: 'private'` with the Ed25519
// signatures `makeFixture` produces — the server enforces the pairing
// (public ⇒ sigstore-cosign, private ⇒ ed25519), see the F1 suite.
const GADGET_MANIFEST: ArtifactManifest = {
  kind: 'gadget',
  scope: '@test',
  name: 'weather',
  version: '1.0.0',
  bundle: 'src/index.ts',
  visibility: 'private',
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

/** Public variant for the sigstore-signed suites. */
const PUBLIC_GADGET_MANIFEST: ArtifactManifest = {
  ...GADGET_MANIFEST,
  visibility: 'public',
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

  it('rejects a manifest whose descriptor projection is invalid (non-URL connect entry) — publish never freezes an uninstallable artifact', async () => {
    // The manifest schema accepts any non-empty string in `connect[]`,
    // but the installed catalog row requires full URLs. A published
    // version is immutable, so a manifest that projects to an invalid
    // row would be PERMANENTLY uninstallable — reject it at publish.
    const f = await makeFixture();
    const result = await publishArtifact(
      {
        manifest: { ...GADGET_MANIFEST, connect: ['not a url'] },
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
    expect(result.body.error).toBe('manifest_invalid');
    expect(result.body.message).toContain('connect');
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
      visibility: 'private',
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
      visibility: 'private',
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
      visibility: 'private',
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
      visibility: 'private',
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

  // ── F1 — visibility ↔ algorithm pairing gate ──────────────────────
  //
  // The algorithm bifurcation is a trust-model contract: `public`
  // artifacts sign via sigstore keyless so every public publish lands
  // in a public transparency log; `private` artifacts sign with a
  // registered Ed25519 author key. The CLI pairs them client-side,
  // but a hand-rolled request can lie — the SERVER must enforce the
  // pairing or a public+Ed25519 publish becomes publicly listable
  // with no transparency-log entry. The gate is a cheap field
  // comparison and MUST fire before any signature verification work.
  describe('visibility ↔ algorithm pairing (F1)', () => {
    beforeEach(() => {
      sigstoreMocks.verifyBundleSigstore.mockReset();
    });

    it('rejects `visibility: public` + Ed25519 signature with 400 visibility_algorithm_mismatch', async () => {
      const publicManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        visibility: 'public',
      } as ArtifactManifest;
      const f = await makeFixture(publicManifest);
      const result = await publishArtifact(
        {
          manifest: publicManifest,
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
      expect(result.body.error).toBe('visibility_algorithm_mismatch');
      expect(result.body.message).toContain('sigstore');
      expect(result.body.message).toContain('transparency log');
      // No version row must be written for a rejected publish.
      const row = await f.storage.getArtifactVersion('@test/weather', '1.0.0');
      expect(row).toBeNull();
    });

    it('rejects `visibility: private` + sigstore signature with 400 visibility_algorithm_mismatch — before verification runs', async () => {
      const privateManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        visibility: 'private',
      } as ArtifactManifest;
      const bundleBytes = new TextEncoder().encode(VALID_BUNDLE_TEXT);
      const sha = sha384Base64(bundleBytes);
      const sigstoreSignature: SigstoreSignature = {
        algorithm: 'sigstore-cosign',
        bundleSha384: sha,
        bundle: JSON.stringify({
          mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
          verificationMaterial: {
            x509CertificateChain: {
              certificates: [{ rawBytes: 'AAAA' }],
            },
          },
          messageSignature: {
            messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' },
            signature: 'BBBB',
          },
        }),
        signedAt: '2026-08-09T00:00:00.000Z',
      };
      const result = await publishArtifact(
        {
          manifest: privateManifest,
          bundle: base64Encode(bundleBytes),
          bundleSha384: sha,
          signature: sigstoreSignature,
        },
        {
          storage: inMemoryRegistryStorage(),
          bundleStorage: inMemoryBundleStorage({ bundleHost: 'http://localhost:9001' }),
          authn: { subject: 'user-1' },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('visibility_algorithm_mismatch');
      expect(result.body.message).toContain('Ed25519');
      // Placement: the pairing gate is a cheap field comparison and
      // fires BEFORE the cryptographic verify dispatch.
      expect(sigstoreMocks.verifyBundleSigstore).not.toHaveBeenCalled();
    });

    it('accepts the private + Ed25519 pairing (201)', async () => {
      const privateManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        visibility: 'private',
      } as ArtifactManifest;
      const f = await makeFixture(privateManifest);
      const result = await publishArtifact(
        {
          manifest: privateManifest,
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
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(201);
    });

    it('accepts the public + sigstore pairing (201)', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const publicManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        visibility: 'public',
      } as ArtifactManifest;
      const bundleBytes = new TextEncoder().encode(VALID_BUNDLE_TEXT);
      const sha = sha384Base64(bundleBytes);
      const sigstoreSignature: SigstoreSignature = {
        algorithm: 'sigstore-cosign',
        bundleSha384: sha,
        bundle: JSON.stringify({
          mediaType: 'application/vnd.dev.sigstore.bundle+json;version=0.3',
          verificationMaterial: {
            x509CertificateChain: {
              certificates: [{ rawBytes: 'AAAA' }],
            },
          },
          messageSignature: {
            messageDigest: { algorithm: 'SHA2_256', digest: 'AAAA' },
            signature: 'BBBB',
          },
        }),
        signedAt: '2026-08-09T00:00:00.000Z',
      };
      const result = await publishArtifact(
        {
          manifest: publicManifest,
          bundle: base64Encode(bundleBytes),
          bundleSha384: sha,
          signature: sigstoreSignature,
        },
        {
          storage: inMemoryRegistryStorage(),
          bundleStorage: inMemoryBundleStorage({ bundleHost: 'http://localhost:9001' }),
          authn: { subject: 'user-1' },
          clock: () => new Date(),
          registryHostname: 'localhost:9001',
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(201);
    });
  });

  // ── F0 — scope ownership at publish ───────────────────────────────
  //
  // Gate 2c: reserved-scope denylist, then owner check, then
  // first-publish claim. Cheap-first order pin: the gate runs after the
  // F1 pairing (2b) and BEFORE any bundle decode — an other-caller
  // publish must answer `scope_forbidden` even when its bundle is
  // garbage.
  describe('scope ownership at publish (F0)', () => {
    function deps(f: Fixture, subject: string, overrides: Partial<PublishArtifactDeps> = {}): PublishArtifactDeps {
      return {
        storage: f.storage,
        bundleStorage: f.bundleStorage,
        authn: { subject },
        clock: () => new Date('2026-08-10T12:00:00.000Z'),
        registryHostname: 'localhost:9001',
        ...overrides,
      };
    }

    function input(f: Fixture, manifest: ArtifactManifest = GADGET_MANIFEST) {
      return {
        manifest,
        bundle: f.bundleB64,
        bundleSha384: f.bundleSha384,
        signature: f.signature,
      };
    }

    it('first publish into an unclaimed scope claims it — row asserted', async () => {
      const f = await makeFixture();
      const result = await publishArtifact(input(f), deps(f, f.subject));
      expect(result.ok).toBe(true);
      const owner = await f.storage.getScopeOwner('@test');
      expect(owner).toEqual({
        scope: '@test',
        ownerSubject: f.subject,
        claimedAt: '2026-08-10T12:00:00.000Z',
        verification: 'unverified',
      });
    });

    it('same-caller republish into the claimed scope succeeds', async () => {
      const f = await makeFixture();
      const first = await publishArtifact(input(f), deps(f, f.subject));
      expect(first.ok).toBe(true);
      const secondManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        version: '1.0.1',
      } as ArtifactManifest;
      const second = await publishArtifact(input(f, secondManifest), deps(f, f.subject));
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.status).toBe(201);
    });

    it('other-caller publish into a claimed scope → 403 scope_forbidden, before any bundle work', async () => {
      const f = await makeFixture();
      const first = await publishArtifact(input(f), deps(f, f.subject));
      expect(first.ok).toBe(true);
      // The squatter's bundle is INVALID base64 — if the scope gate ran
      // after bundle decode (step 3) this would answer
      // `manifest_invalid: bundle field is not valid base64` instead.
      const result = await publishArtifact(
        {
          manifest: { ...GADGET_MANIFEST, version: '2.0.0' },
          bundle: '!!!not-base64!!!',
          bundleSha384: f.bundleSha384,
          signature: f.signature,
        },
        deps(f, 'user-2'),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('scope_forbidden');
      // Remedy message stays registry-neutral (OSS purity).
      expect(result.body.message).toContain('scope');
      expect(result.body.message).not.toMatch(/ggui\.ai|guuey|cloud/i);
      // Ownership unchanged.
      expect((await f.storage.getScopeOwner('@test'))?.ownerSubject).toBe(f.subject);
    });

    it('reserved scope → 403 scope_forbidden and NO claim row', async () => {
      const reservedManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        scope: '@anthropic',
      } as ArtifactManifest;
      const f = await makeFixture();
      const result = await publishArtifact(
        input(f, reservedManifest),
        deps(f, f.subject),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('scope_forbidden');
      expect(await f.storage.getScopeOwner('@anthropic')).toBeNull();
    });

    it('operator-seeded owner publishes into a RESERVED scope (reserved blocks claims, not owned publishes)', async () => {
      const reservedManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        scope: '@anthropic',
      } as ArtifactManifest;
      const f = await makeFixture(reservedManifest);
      // Ops seeded the ownership row for the reserved scope (the
      // `ggui_ops_scope_transfer` path) — the seeded owner publishes
      // like any other owner.
      const seeded = await f.storage.updateScopeOwner(
        {
          scope: '@anthropic',
          ownerSubject: f.subject,
          claimedAt: '2026-08-09T00:00:00.000Z',
          verification: 'unverified',
        },
        { absent: true },
      );
      expect(seeded).toEqual({ ok: true });
      const result = await publishArtifact(
        input(f, reservedManifest),
        deps(f, f.subject),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(201);
    });

    it('non-owner publish into a SEEDED reserved scope → 403 scope_forbidden (owner rule, not reserved rule)', async () => {
      const reservedManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        scope: '@anthropic',
      } as ArtifactManifest;
      const f = await makeFixture(reservedManifest);
      await f.storage.updateScopeOwner(
        {
          scope: '@anthropic',
          ownerSubject: 'first-party-subject',
          claimedAt: '2026-08-09T00:00:00.000Z',
          verification: 'verified',
          verifiedDomain: 'anthropic.com',
          verifiedAt: '2026-08-09T00:00:00.000Z',
        },
        { absent: true },
      );
      const result = await publishArtifact(
        input(f, reservedManifest),
        deps(f, f.subject),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('scope_forbidden');
      expect(result.body.message).toContain('owned by another publisher');
    });

    it('reservedScopes option REPLACES the built-in list', async () => {
      const f = await makeFixture();
      // '@test' becomes reserved under the custom list…
      const forbidden = await publishArtifact(
        input(f),
        deps(f, f.subject, { reservedScopes: ['@test'] }),
      );
      expect(forbidden.ok).toBe(false);
      if (forbidden.ok) return;
      expect(forbidden.body.error).toBe('scope_forbidden');

      // …and a built-in reserved scope becomes claimable when the
      // custom list omits it (replacement, not extension).
      const anthropicManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        scope: '@anthropic',
      } as ArtifactManifest;
      const f2 = await makeFixture();
      const allowed = await publishArtifact(
        input(f2, anthropicManifest),
        deps(f2, f2.subject, { reservedScopes: ['@only-this-one'] }),
      );
      expect(allowed.ok).toBe(true);
    });

    it('lost claim race, winner is another subject → 403 scope_forbidden (re-read path)', async () => {
      const f = await makeFixture();
      const winnerRow = {
        scope: '@test',
        ownerSubject: 'racer-winner',
        claimedAt: '2026-08-10T11:59:59.000Z',
        verification: 'unverified' as const,
      };
      let reads = 0;
      const racingStorage: RegistryStorage = {
        ...f.storage,
        // First read (rule 2): unclaimed. The claim then loses the
        // race; the re-read sees the winner's row.
        async getScopeOwner(scope) {
          reads += 1;
          if (reads === 1) return null;
          return scope === '@test' ? winnerRow : null;
        },
        async claimScope() {
          return { conflict: true };
        },
      };
      const result = await publishArtifact(
        input(f),
        deps(f, f.subject, { storage: racingStorage }),
      );
      expect(reads).toBe(2);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.status).toBe(403);
      expect(result.body.error).toBe('scope_forbidden');
    });

    it('lost claim race, winner is the SAME subject → publish proceeds (re-read path)', async () => {
      const f = await makeFixture();
      let reads = 0;
      const racingStorage: RegistryStorage = {
        ...f.storage,
        async getScopeOwner(scope) {
          reads += 1;
          if (reads === 1) return null;
          return scope === '@test'
            ? {
                scope: '@test',
                ownerSubject: f.subject,
                claimedAt: '2026-08-10T11:59:59.000Z',
                verification: 'unverified' as const,
              }
            : null;
        },
        async claimScope() {
          return { conflict: true };
        },
      };
      const result = await publishArtifact(
        input(f),
        deps(f, f.subject, { storage: racingStorage }),
      );
      expect(reads).toBe(2);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(201);
    });

    it('claim is durable when a downstream gate fails (documented judgment call)', async () => {
      const f = await makeFixture();
      const result = await publishArtifact(
        {
          manifest: GADGET_MANIFEST,
          bundle: f.bundleB64,
          // Wrong digest — fails step 4, AFTER the 2c claim.
          bundleSha384: sha384Base64(new TextEncoder().encode('other-bytes')),
          signature: f.signature,
        },
        deps(f, f.subject),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.body.error).toBe('bundle_hash_mismatch');
      // The failed publish still claimed the scope for its caller —
      // re-usable by the same caller, reclaimable via ops like any
      // unverified scope.
      expect((await f.storage.getScopeOwner('@test'))?.ownerSubject).toBe(f.subject);
    });

    it('F1 pairing still fires first — public+Ed25519 into a FOREIGN claimed scope answers visibility_algorithm_mismatch', async () => {
      const f = await makeFixture();
      const first = await publishArtifact(input(f), deps(f, f.subject));
      expect(first.ok).toBe(true);
      const publicManifest: ArtifactManifest = {
        ...GADGET_MANIFEST,
        version: '3.0.0',
        visibility: 'public',
      } as ArtifactManifest;
      const result = await publishArtifact(
        input(f, publicManifest),
        deps(f, 'user-2'),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.body.error).toBe('visibility_algorithm_mismatch');
    });
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
      manifest: ArtifactManifest = PUBLIC_GADGET_MANIFEST,
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
          manifest: PUBLIC_GADGET_MANIFEST,
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
          manifest: PUBLIC_GADGET_MANIFEST,
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
          manifest: PUBLIC_GADGET_MANIFEST,
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
      // The diagnostic names BOTH wire shapes the extractor accepts —
      // v0.3 single-leaf (preferred) and the v0.1/v0.2 chain (legacy).
      expect(result.body.message).toContain('verificationMaterial.certificate.rawBytes');
      expect(result.body.message).toContain(
        'verificationMaterial.x509CertificateChain.certificates[0].rawBytes',
      );
    });

    it('threads deps.sigstoreTuf into the verifyBundleSigstore call (F2)', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const f = await makeSigstoreFixture();
      const result = await publishArtifact(
        {
          manifest: PUBLIC_GADGET_MANIFEST,
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
          sigstoreTuf: { tufCachePath: '/tmp/sigstore-js', tufForceCache: true },
        },
      );
      expect(result.ok).toBe(true);
      expect(sigstoreMocks.verifyBundleSigstore).toHaveBeenCalledTimes(1);
      expect(sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0]).toMatchObject({
        tufCachePath: '/tmp/sigstore-js',
        tufForceCache: true,
      });
    });

    it('omits TUF options from the verify call when deps.sigstoreTuf is unset', async () => {
      sigstoreMocks.verifyBundleSigstore.mockResolvedValue({ valid: true });
      const f = await makeSigstoreFixture();
      await publishArtifact(
        {
          manifest: PUBLIC_GADGET_MANIFEST,
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
      expect(sigstoreMocks.verifyBundleSigstore).toHaveBeenCalledTimes(1);
      expect(sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0]).not.toHaveProperty(
        'tufCachePath',
      );
      expect(sigstoreMocks.verifyBundleSigstore.mock.calls[0]?.[0]).not.toHaveProperty(
        'tufForceCache',
      );
    });
  });
});
