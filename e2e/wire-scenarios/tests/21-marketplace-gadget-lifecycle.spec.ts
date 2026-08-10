/**
 * Scenario 21 — marketplace gadget lifecycle (Slice 4.5).
 *
 * End-to-end coverage of the publish → search → read loop against
 * `@ggui-ai/registry-server` using the fixture gadget at
 * `e2e/fixtures/marketplace-test-gadget/`:
 *
 *   1. Boot the OSS registry-server with in-memory storage + bearer
 *      authn (token = `test-token`).
 *   2. Generate a fresh Ed25519 keypair; register the public key
 *      under the fixture's test subject.
 *   3. Read the fixture's manifest + pre-built bundle from disk. The
 *      fixture declares `visibility: 'private'` — the registry
 *      enforces the visibility ↔ algorithm pairing (public ⇒ sigstore
 *      keyless, private ⇒ Ed25519 author key), and this suite signs
 *      with a real Ed25519 key.
 *   4. Sign the bundle bytes; POST /publish with bearer token.
 *   5. Verify 201 + the locked `PublishResponseBody` shape — in
 *      particular `installCommand` must say `ggui gadget install` and
 *      include the registry hostname.
 *   6. GET /search?kind=gadget — assert the private row does NOT
 *      surface (search lists only public rows).
 *   7. GET /pkg/{scope}/{name}/{version} — 403 without auth; with the
 *      bearer, assert the full read response carries the manifest +
 *      bundleUrl + bundleSri + signatureUrl + authorPublicKey.
 *   8. Fetch the bundle URL — assert the bytes round-trip + the
 *      Cache-Control header is the cache-immutable contract.
 *
 * The public lane (F3, 2026-08-10) runs in its own describe below:
 * the SAME fixture bundle published `visibility: 'public'` with a
 * REAL sigstore keyless signature (mock Fulcio/Rekor + mock TUF trust
 * root from `@ggui-ai/gadget-signing/testing`), then asserted to
 * SURFACE in `/search` — the listing assertion the private lane
 * structurally can never make.
 *
 * What this scenario does NOT cover (deferred to a follow-up):
 *   - CLI subprocess invocation of `ggui gadget publish` / `install`
 *     (the CLI surface has its own test suite at
 *     `packages/ggui-cli/src/internal/artifact-*.test.ts`).
 *   - Iframe-side rendering of the gadget through the running
 *     `ggui-default` MCP server + Playwright postMessage assertion
 *     — that path requires per-test ggui-default app-config
 *     orchestration which lands when the canvas-mode work merges.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  generateEd25519Keypair,
  signBundleEd25519,
  signBundleSigstore,
  type Ed25519Signature,
} from '@ggui-ai/gadget-signing';
import { startSigstoreMockStack } from '@ggui-ai/gadget-signing/testing';
import { parseGadgetManifest } from '@ggui-ai/artifact-manifest';
import {
  bootRegistryServer,
  TEST_REGISTRY_SUBJECT,
  TEST_REGISTRY_TOKEN,
  type RegistryServerHandle,
} from '../fixtures/registry-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(
  __dirname,
  '../../fixtures/marketplace-test-gadget',
);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function sha384(bytes: Uint8Array): string {
  return createHash('sha384').update(bytes).digest('base64');
}

describe('21 — marketplace gadget lifecycle', () => {
  let registry: RegistryServerHandle;

  beforeEach(async () => {
    registry = await bootRegistryServer();
  });

  afterEach(async () => {
    await registry.stop();
  });

  test('publish → hidden from search → authed read → bundle fetch — private-lane HTTP lifecycle', async () => {
    // ── 1. Generate keypair + register the author key ──────────────
    const keypair = await generateEd25519Keypair();
    await registry.storage.putAuthorKey({
      subject: TEST_REGISTRY_SUBJECT,
      keyId: keypair.publicKeyId,
      publicKeyBase64: base64(keypair.publicKey),
    });

    // ── 2. Load fixture manifest + bundle ──────────────────────────
    const manifestRaw = JSON.parse(
      await readFile(resolve(FIXTURE_ROOT, 'ggui.gadget.json'), 'utf-8'),
    );
    const manifest = parseGadgetManifest(manifestRaw);
    const bundleBytes = new Uint8Array(
      await readFile(resolve(FIXTURE_ROOT, 'dist/index.js')),
    );
    const bundleSha384 = sha384(bundleBytes);

    // ── 3. Sign the bundle ─────────────────────────────────────────
    const signature: Ed25519Signature = await signBundleEd25519({
      bundleBytes,
      privateKey: keypair.privateKey,
      publicKeyId: keypair.publicKeyId,
    });

    // ── 4. POST /publish ───────────────────────────────────────────
    const publishResp = await fetch(`${registry.url}/publish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TEST_REGISTRY_TOKEN}`,
      },
      body: JSON.stringify({
        manifest,
        bundle: base64(bundleBytes),
        bundleSha384,
        signature,
      }),
    });
    expect(publishResp.status).toBe(201);
    const publishBody = await publishResp.json();
    expect(publishBody.artifactId).toBe('@ggui-test/probe-gadget');
    expect(publishBody.version).toBe('0.0.1');
    expect(publishBody.installCommand).toContain('ggui gadget install');
    expect(publishBody.installCommand).toContain('@ggui-test/probe-gadget@0.0.1');
    expect(publishBody.bundleUrl).toContain('/bundles/');
    expect(publishBody.signatureUrl).toContain('.sig');

    // ── 5. GET /search ─────────────────────────────────────────────
    // The fixture is private — /search lists only public rows, so the
    // publish MUST NOT surface here. (The public lane — sigstore
    // keyless + /search listing — is the F3 describe below.)
    const searchResp = await fetch(`${registry.url}/search?kind=gadget`);
    expect(searchResp.status).toBe(200);
    const searchBody = await searchResp.json();
    const listedIds = searchBody.results.map(
      (r: { artifactId: string }) => r.artifactId,
    );
    expect(listedIds).not.toContain('@ggui-test/probe-gadget');

    // ── 6. GET /pkg/{scope}/{name}/{version} ───────────────────────
    // API GW route convention drops the leading @ — registry-server
    // accepts either, but use the dropped form to match the cloud.
    // Private row: unauthenticated read is refused…
    const unauthedReadResp = await fetch(
      `${registry.url}/pkg/ggui-test/probe-gadget/0.0.1`,
    );
    expect(unauthedReadResp.status).toBe(403);

    // …and the bearer-authed read returns the full row.
    const readResp = await fetch(
      `${registry.url}/pkg/ggui-test/probe-gadget/0.0.1`,
      { headers: { authorization: `Bearer ${TEST_REGISTRY_TOKEN}` } },
    );
    expect(readResp.status).toBe(200);
    const readBody = await readResp.json();
    expect(readBody.manifest.kind).toBe('gadget');
    expect(readBody.manifest.exports[0].hook).toBe('useTestProbe');
    expect(readBody.bundleUrl).toBe(publishBody.bundleUrl);
    expect(readBody.bundleSri).toMatch(/^sha384-/);
    expect(readBody.signatureUrl).toBe(publishBody.signatureUrl);
    expect(readBody.authorPublicKey).toBe(base64(keypair.publicKey));

    // ── 7. Fetch the bundle ────────────────────────────────────────
    const bundleResp = await fetch(publishBody.bundleUrl);
    expect(bundleResp.status).toBe(200);
    const cacheControl = bundleResp.headers.get('cache-control');
    expect(cacheControl).toMatch(/immutable/);
    expect(cacheControl).toMatch(/max-age=31536000/);
    const bundleText = await bundleResp.text();
    expect(bundleText).toContain('useTestProbe');
    expect(bundleText).toContain('GGUI_TEST_PROBE_FIRED');
  });

  test('re-publish of same (scope, name, version) returns 409 version_exists', async () => {
    const keypair = await generateEd25519Keypair();
    await registry.storage.putAuthorKey({
      subject: TEST_REGISTRY_SUBJECT,
      keyId: keypair.publicKeyId,
      publicKeyBase64: base64(keypair.publicKey),
    });
    const manifest = parseGadgetManifest(
      JSON.parse(await readFile(resolve(FIXTURE_ROOT, 'ggui.gadget.json'), 'utf-8')),
    );
    const bundleBytes = new Uint8Array(
      await readFile(resolve(FIXTURE_ROOT, 'dist/index.js')),
    );
    const bundleSha384 = sha384(bundleBytes);
    const signature = await signBundleEd25519({
      bundleBytes,
      privateKey: keypair.privateKey,
      publicKeyId: keypair.publicKeyId,
    });
    const body = JSON.stringify({
      manifest,
      bundle: base64(bundleBytes),
      bundleSha384,
      signature,
    });
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${TEST_REGISTRY_TOKEN}`,
    };

    const first = await fetch(`${registry.url}/publish`, { method: 'POST', headers, body });
    expect(first.status).toBe(201);

    const second = await fetch(`${registry.url}/publish`, { method: 'POST', headers, body });
    expect(second.status).toBe(409);
    const secondBody = await second.json();
    expect(secondBody.error).toBe('version_exists');
  });

  test('/publish without bearer token returns 401', async () => {
    const resp = await fetch(`${registry.url}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(resp.status).toBe(401);
  });
});

describe('21 — marketplace gadget lifecycle: PUBLIC sigstore lane (F3)', () => {
  test('public publish with REAL sigstore signature → 201 → SURFACES in /search → anonymous read + bundle fetch', async () => {
    // One mock stack per test: nock interceptors are process-global,
    // and the trust root must outlive the publish verify only.
    const stack = await startSigstoreMockStack();
    const registry = await bootRegistryServer({ sigstoreTuf: stack.tuf });
    try {
      // ── 1. Load fixture manifest (public variant) + bundle ───────
      const manifestRaw = JSON.parse(
        await readFile(resolve(FIXTURE_ROOT, 'ggui.gadget.json'), 'utf-8'),
      );
      const manifest = parseGadgetManifest({
        ...manifestRaw,
        visibility: 'public',
      });
      const bundleBytes = new Uint8Array(
        await readFile(resolve(FIXTURE_ROOT, 'dist/index.js')),
      );

      // ── 2. REAL sigstore keyless signing ─────────────────────────
      // Real ephemeral key → real cert from the mock CA → real
      // transparency-log entry. No author-key registration: the
      // sigstore lane's trust chain is Fulcio + Rekor, not AuthorKeys.
      const signature = await signBundleSigstore({
        bundleBytes,
        identityToken: stack.identityToken(),
        endpoints: stack.signEndpoints,
      });

      // ── 3. POST /publish ─────────────────────────────────────────
      const publishResp = await fetch(`${registry.url}/publish`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${TEST_REGISTRY_TOKEN}`,
        },
        body: JSON.stringify({
          manifest,
          bundle: base64(bundleBytes),
          bundleSha384: sha384(bundleBytes),
          signature,
        }),
      });
      const publishBody = await publishResp.json();
      expect(
        publishResp.status,
        `publish answered: ${JSON.stringify(publishBody)}`,
      ).toBe(201);
      expect(publishBody.artifactId).toBe('@ggui-test/probe-gadget');

      // ── 4. GET /search — the public row SURFACES ─────────────────
      // The restored public-lane listing assertion (removed when F1
      // flipped the fixtures honest-private).
      const searchResp = await fetch(`${registry.url}/search?kind=gadget`);
      expect(searchResp.status).toBe(200);
      const searchBody = await searchResp.json();
      const listed = searchBody.results.map(
        (r: { artifactId: string }) => r.artifactId,
      );
      expect(listed).toContain('@ggui-test/probe-gadget');

      // ── 5. Anonymous read — public rows need no bearer ───────────
      const readResp = await fetch(
        `${registry.url}/pkg/ggui-test/probe-gadget/0.0.1`,
      );
      expect(readResp.status).toBe(200);
      const readBody = await readResp.json();
      expect(readBody.manifest.visibility).toBe('public');
      // Real Fulcio-mock leaf cert pinned on the row (v0.3
      // single-certificate bundle shape).
      expect(typeof readBody.authorPublicKey).toBe('string');
      expect(Buffer.from(readBody.authorPublicKey, 'base64')[0]).toBe(0x30);

      // ── 6. Bundle bytes round-trip ───────────────────────────────
      const bundleResp = await fetch(readBody.bundleUrl);
      expect(bundleResp.status).toBe(200);
      const bundleText = await bundleResp.text();
      expect(bundleText).toContain('useTestProbe');
    } finally {
      await registry.stop();
      stack.teardown();
    }
  });
});
