/**
 * Scenario 22 — marketplace blueprint lifecycle (Slice 4.5).
 *
 * Blueprint-lane mirror of scenario 21. Blueprints don't carry a
 * compiled bundle — TSX source rides inline on the manifest. The
 * publisher signs canonical-JSON manifest bytes (not bundle bytes),
 * which the registry re-canonicalizes + verifies.
 *
 *   1. Boot registry-server.
 *   2. Generate keypair, register author key under test subject.
 *   3. Read the fixture blueprint manifest from
 *      `e2e/fixtures/marketplace-test-blueprint/`.
 *   4. Sign `canonicalJson(manifest)` with the private key.
 *   5. POST /publish with bearer token — assert 201 +
 *      `installCommand` says `ggui blueprint install`.
 *   6. GET /search?kind=blueprint — confirm the entry surfaces.
 *   7. GET /pkg/.../{version} — assert the read response's
 *      `manifest.source` carries the inline TSX and there is NO `bundleUrl`.
 *
 * What this scenario does NOT cover (deferred):
 *   - CLI subprocess (`ggui blueprint publish`, `install`).
 *   - `.ggui/installed-blueprints/` materialization (CLI-side).
 *   - Playwright iframe rendering of the blueprint TSX +
 *     `data-testid="blueprint-probe"` assertion — requires per-test
 *     ggui-default app-config orchestration.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateEd25519Keypair, signBundleEd25519, canonicalJson } from '@ggui-ai/gadget-signing';
import { parseBlueprintManifest } from '@ggui-ai/artifact-manifest';
import {
  bootRegistryServer,
  TEST_REGISTRY_SUBJECT,
  TEST_REGISTRY_TOKEN,
  type RegistryServerHandle,
} from '../fixtures/registry-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = resolve(
  __dirname,
  '../../fixtures/marketplace-test-blueprint',
);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

describe('22 — marketplace blueprint lifecycle', () => {
  let registry: RegistryServerHandle;

  beforeEach(async () => {
    registry = await bootRegistryServer();
  });

  afterEach(async () => {
    await registry.stop();
  });

  test('publish → search → read — full HTTP lifecycle (no bundle)', async () => {
    // ── 1. Generate keypair + register the author key ──────────────
    const keypair = await generateEd25519Keypair();
    await registry.storage.putAuthorKey({
      subject: TEST_REGISTRY_SUBJECT,
      keyId: keypair.publicKeyId,
      publicKeyBase64: base64(keypair.publicKey),
    });

    // ── 2. Load fixture manifest ───────────────────────────────────
    const manifestRaw = JSON.parse(
      await readFile(resolve(FIXTURE_ROOT, 'ggui.blueprint.json'), 'utf-8'),
    );
    const manifest = parseBlueprintManifest(manifestRaw);

    // ── 3. Sign canonical-JSON manifest bytes ──────────────────────
    const manifestBytes = new TextEncoder().encode(canonicalJson(manifest));
    const signature = await signBundleEd25519({
      bundleBytes: manifestBytes,
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
      body: JSON.stringify({ manifest, signature }),
    });
    expect(publishResp.status).toBe(201);
    const publishBody = await publishResp.json();
    expect(publishBody.artifactId).toBe('@ggui-test/probe-blueprint');
    expect(publishBody.version).toBe('0.0.1');
    expect(publishBody.installCommand).toContain('ggui blueprint install');
    // Blueprints carry no bundle — bundle/signature URLs are absent.
    expect(publishBody.bundleUrl).toBeUndefined();
    expect(publishBody.signatureUrl).toBeUndefined();
    expect(publishBody.manifestUrl).toContain('/manifest.json');

    // ── 5. GET /search?kind=blueprint ──────────────────────────────
    const searchResp = await fetch(`${registry.url}/search?kind=blueprint`);
    expect(searchResp.status).toBe(200);
    const searchBody = await searchResp.json();
    const entry = searchBody.results.find(
      (r: { artifactId: string }) => r.artifactId === '@ggui-test/probe-blueprint',
    );
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('blueprint');

    // ── 6. GET /pkg/{scope}/{name}/{version} ───────────────────────
    const readResp = await fetch(
      `${registry.url}/pkg/ggui-test/probe-blueprint/0.0.1`,
    );
    expect(readResp.status).toBe(200);
    const readBody = await readResp.json();
    expect(readBody.manifest.kind).toBe('blueprint');
    expect(readBody.manifest.source).toContain('blueprint-probe');
    expect(readBody.bundleUrl).toBeUndefined();
    expect(readBody.signatureUrl).toBeUndefined();
    expect(readBody.authorPublicKey).toBe(base64(keypair.publicKey));
  });

  test('search filters honor kind — blueprint search hides gadget rows', async () => {
    // Seed a gadget metadata row directly so the kind filter has
    // something to discriminate against.
    await registry.storage.putArtifactMetadata({
      artifactId: '@ggui-test/some-gadget',
      sk: 'metadata#',
      kind: 'gadget',
      latestVersion: '0.0.1',
      visibility: 'public',
      publishedAt: '2026-05-17T00:00:00.000Z',
      publishedBy: TEST_REGISTRY_SUBJECT,
    });
    await registry.storage.putArtifactMetadata({
      artifactId: '@ggui-test/some-blueprint',
      sk: 'metadata#',
      kind: 'blueprint',
      latestVersion: '0.0.1',
      visibility: 'public',
      publishedAt: '2026-05-17T00:00:00.000Z',
      publishedBy: TEST_REGISTRY_SUBJECT,
    });

    const resp = await fetch(`${registry.url}/search?kind=blueprint`);
    const body = await resp.json();
    const ids: string[] = body.results.map((r: { artifactId: string }) => r.artifactId);
    expect(ids).toContain('@ggui-test/some-blueprint');
    expect(ids).not.toContain('@ggui-test/some-gadget');
  });
});
