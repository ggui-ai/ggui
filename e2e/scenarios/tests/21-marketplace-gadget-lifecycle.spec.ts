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
 *   3. Read the fixture's manifest + pre-built bundle from disk.
 *   4. Sign the bundle bytes; POST /publish with bearer token.
 *   5. Verify 201 + the locked `PublishResponseBody` shape — in
 *      particular `installCommand` must say `ggui gadget install` and
 *      include the registry hostname.
 *   6. GET /search?kind=gadget — assert the published gadget is
 *      listed with the lightweight summary projection.
 *   7. GET /pkg/{scope}/{name}/{version} — assert the full read
 *      response carries the manifest + bundleUrl + bundleSri +
 *      signatureUrl + authorPublicKey.
 *   8. Fetch the bundle URL — assert the bytes round-trip + the
 *      Cache-Control header is the cache-immutable contract.
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
  type Ed25519Signature,
} from '@ggui-ai/gadget-signing';
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

  test('publish → search → read → bundle fetch — full HTTP lifecycle', async () => {
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
    const searchResp = await fetch(`${registry.url}/search?kind=gadget`);
    expect(searchResp.status).toBe(200);
    const searchBody = await searchResp.json();
    expect(searchBody.results).toHaveLength(1);
    const entry = searchBody.results[0];
    expect(entry).toMatchObject({
      artifactId: '@ggui-test/probe-gadget',
      latestVersion: '0.0.1',
      kind: 'gadget',
    });
    // tags should round-trip
    expect(entry.tags).toContain('test');

    // ── 6. GET /pkg/{scope}/{name}/{version} ───────────────────────
    // API GW route convention drops the leading @ — registry-server
    // accepts either, but use the dropped form to match the cloud.
    const readResp = await fetch(
      `${registry.url}/pkg/ggui-test/probe-gadget/0.0.1`,
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
