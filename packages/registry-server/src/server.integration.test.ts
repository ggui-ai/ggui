/**
 * Integration test for the OSS registry server. Spins up a real
 * `createRegistryServer` in-process on a free port (via `port: 0`),
 * hits every route with `fetch`, and asserts the wire shapes.
 *
 * Strategy:
 *
 *   - Memory storage + memory bundles + a known test token.
 *   - One server per `describe` group so tests share boot cost; each
 *     test resets state via the `MemoryStorage` factory called fresh
 *     in `beforeAll`.
 *   - `fetch` against the bound `actualPort` — we don't go through hono
 *     directly because that'd skip the `@hono/node-server` layer.
 *
 * What's exercised:
 *
 *   - `/healthz` → { ok: true }
 *   - `/search` → empty result on fresh store
 *   - `/publish` 401 without bearer
 *   - `/publish` 201 happy path with a signed gadget
 *   - `/pkg/:scope/:name/:version` 200 after publish
 *   - `/pkg/...` 404 on miss
 *   - `/conformance/check` 200 with `ok: false` on invalid manifest
 *   - `/bundles/.../bundle.js` 200 + Cache-Control: immutable
 *   - `/bundles/.../bundle.js` 404 on miss
 *
 * The main suite's publish journeys use `visibility: 'private'` +
 * Ed25519 — the server enforces the visibility ↔ algorithm pairing
 * (public ⇒ sigstore keyless, private ⇒ Ed25519 author key). The
 * public sigstore lane runs in its own describe at the bottom (F3,
 * 2026-08-10): a REAL sigstore-signed public publish over the wire —
 * signed against in-process mock Fulcio/Rekor, verified through the
 * server's `sigstoreTuf` trust-root seam — then listed by `/search`
 * and read anonymously.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateEd25519Keypair,
  signBundleEd25519,
  signBundleSigstore,
  type Ed25519Signature,
} from '@ggui-ai/gadget-signing';
import { startSigstoreMockStack } from '@ggui-ai/gadget-signing/testing';
import {
  ARTIFACTS_METADATA_SK,
  inMemoryBundleStorage,
  inMemoryRegistryStorage,
  type AuthorKeyRow,
  type RegistryStorage,
} from '@ggui-ai/registry-core';
import type { GadgetManifest } from '@ggui-ai/artifact-manifest';
import { createBearerAuthn } from './authn/bearer.js';
import { createRegistryServer, type RegistryServerHandle } from './index.js';

const TEST_TOKEN = 'test-token-please-rotate';
const TEST_SUBJECT = 'test-publisher-1';

interface Harness {
  readonly handle: RegistryServerHandle;
  readonly storage: RegistryStorage;
  readonly baseUrl: string;
  readonly authHeader: string;
  readonly keypair: Awaited<ReturnType<typeof generateEd25519Keypair>>;
}

async function bootHarness(
  serverOptions: Pick<
    Parameters<typeof createRegistryServer>[0],
    'sigstoreTuf'
  > = {},
): Promise<Harness> {
  const storage = inMemoryRegistryStorage();
  const keypair = await generateEd25519Keypair();
  // The AuthorKeyRow's keyId MUST equal the signature's publicKeyId
  // for the publish op's lookup `getAuthorKey(subject, signature.publicKeyId)`
  // to resolve. `generateEd25519Keypair` derives a stable publicKeyId
  // from the key bytes; we use the same id everywhere.
  const authorKey: AuthorKeyRow = {
    subject: TEST_SUBJECT,
    keyId: keypair.publicKeyId,
    publicKeyBase64: Buffer.from(keypair.publicKey).toString('base64'),
  };
  await storage.putAuthorKey(authorKey);

  // Boot the server first on port 0 so we know the actualPort before
  // composing the bundle host — the memory bundle storage's URL
  // composition must match the port the bundles route serves on.
  const placeholderBundleStorage = inMemoryBundleStorage({
    bundleHost: 'http://placeholder.invalid',
  });
  const authn = createBearerAuthn({ token: TEST_TOKEN, subject: TEST_SUBJECT });

  const handle = createRegistryServer({
    storage,
    bundleStorage: placeholderBundleStorage,
    authn,
    host: '127.0.0.1',
    port: 0,
    bundleHost: 'http://placeholder.invalid',
    registryHostname: 'localhost:9001',
    ...serverOptions,
  });
  await handle.start();
  const baseUrl = `http://127.0.0.1:${handle.actualPort}`;

  return {
    handle,
    storage,
    baseUrl,
    authHeader: `Bearer ${TEST_TOKEN}`,
    keypair,
  };
}

function makeGadgetManifest(overrides: Partial<GadgetManifest> = {}): GadgetManifest {
  return {
    kind: 'gadget',
    scope: '@test',
    name: 'probe',
    version: '0.1.0',
    description: 'a test gadget',
    // Pairs with the Ed25519 signature `signedPublishBody` produces —
    // the publish op rejects public+Ed25519 (pairing gate, F1).
    visibility: 'private',
    bundle: 'src/index.ts',
    exports: [
      {
        hook: 'useProbe',
        description: 'a test gadget',
        usage: 'A probe gadget used by the registry-server integration tests',
        example: { props: {} },
      },
    ],
    ...overrides,
  };
}

const SIMPLE_BUNDLE = `export function useProbe(){return null;}\nexport default useProbe;\n`;

async function signedPublishBody(
  manifest: GadgetManifest,
  bundle: string,
  keypair: Awaited<ReturnType<typeof generateEd25519Keypair>>,
): Promise<{
  manifest: GadgetManifest;
  bundle: string;
  bundleSha384: string;
  signature: Ed25519Signature;
}> {
  const bundleBytes = new TextEncoder().encode(bundle);
  const signature = await signBundleEd25519({
    bundleBytes,
    privateKey: keypair.privateKey,
    publicKeyId: keypair.publicKeyId,
  });
  return {
    manifest,
    bundle: Buffer.from(bundleBytes).toString('base64'),
    bundleSha384: signature.bundleSha384,
    signature,
  };
}

// ──────────────────────────────────────────────────────────────────────

describe('OSS registry server', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await bootHarness();
  });

  afterAll(async () => {
    await harness.handle.stop();
  });

  // ── /healthz ──
  it('GET /healthz returns 200 + { ok: true }', async () => {
    const res = await fetch(`${harness.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  // ── /search ──
  it('GET /search returns an empty page on a fresh registry', async () => {
    const res = await fetch(`${harness.baseUrl}/search`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[] };
    expect(body.results).toEqual([]);
  });

  it('GET /search?kind=invalid returns 400', async () => {
    const res = await fetch(`${harness.baseUrl}/search?kind=nope`);
    expect(res.status).toBe(400);
  });

  // ── /publish auth ──
  it('POST /publish without bearer returns 401', async () => {
    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('POST /publish with malformed bearer returns 401', async () => {
    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('POST /publish with the wrong scheme returns 401', async () => {
    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(TEST_TOKEN).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // ── /publish happy path ──
  it('POST /publish with a valid signed gadget returns 201', async () => {
    const manifest = makeGadgetManifest();
    const body = await signedPublishBody(manifest, SIMPLE_BUNDLE, harness.keypair);

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    const respBody = (await res.json()) as {
      artifactId: string;
      version: string;
      installCommand: string;
    };
    expect(respBody.artifactId).toBe('@test/probe');
    expect(respBody.version).toBe('0.1.0');
    expect(respBody.installCommand).toContain('ggui gadget install');
    expect(respBody.installCommand).toContain('@test/probe@0.1.0');
  });

  // ── /publish pairing gate (F1) ──
  it('POST /publish with visibility public + Ed25519 returns 400 visibility_algorithm_mismatch', async () => {
    // Wire-level pin of the server-side pairing gate: public artifacts
    // MUST carry a sigstore keyless signature (public transparency
    // log); an Ed25519-signed public publish is rejected outright.
    const manifest = makeGadgetManifest({ name: 'mismatched', visibility: 'public' });
    const body = await signedPublishBody(manifest, SIMPLE_BUNDLE, harness.keypair);

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const respBody = (await res.json()) as { error: string; message: string };
    expect(respBody.error).toBe('visibility_algorithm_mismatch');
    expect(respBody.message).toContain('transparency log');
  });

  // ── /publish scope-ownership gate (F0) ──
  it('POST /publish into a scope owned by another subject returns 403 scope_forbidden', async () => {
    // Wire-level pin of the ownership gate. The single-token OSS
    // harness carries one subject, so the foreign owner is seeded
    // directly through the operator-only storage write.
    const seeded = await harness.storage.updateScopeOwner(
      {
        scope: '@squatted-elsewhere',
        ownerSubject: 'somebody-else',
        claimedAt: '2026-08-10T00:00:00.000Z',
        verification: 'unverified',
      },
      { absent: true },
    );
    expect(seeded).toEqual({ ok: true });
    const manifest = makeGadgetManifest({ scope: '@squatted-elsewhere' });
    const body = await signedPublishBody(manifest, SIMPLE_BUNDLE, harness.keypair);

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const respBody = (await res.json()) as { error: string; message: string };
    expect(respBody.error).toBe('scope_forbidden');
    expect(respBody.message).toContain('owned by another publisher');
  });

  it('POST /publish into a reserved scope returns 403 scope_forbidden', async () => {
    const manifest = makeGadgetManifest({ scope: '@anthropic' });
    const body = await signedPublishBody(manifest, SIMPLE_BUNDLE, harness.keypair);

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(403);
    const respBody = (await res.json()) as { error: string };
    expect(respBody.error).toBe('scope_forbidden');
  });

  // ── /pkg/:scope/:name/:version ──
  it('GET /pkg/:scope/:name/:version after publish returns 200 + manifest', async () => {
    // (Depends on the publish test above. The row is private, so the
    // read carries the bearer.)
    const res = await fetch(`${harness.baseUrl}/pkg/test/probe/0.1.0`, {
      headers: { authorization: harness.authHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { manifest: { kind: string; scope: string } };
    expect(body.manifest.kind).toBe('gadget');
    expect(body.manifest.scope).toBe('@test');
  });

  it('GET /pkg/:scope/:name/:version of a private row without auth returns 403', async () => {
    const res = await fetch(`${harness.baseUrl}/pkg/test/probe/0.1.0`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('forbidden');
  });

  it('GET /pkg/:scope/:name/:version with leading @ also works', async () => {
    const res = await fetch(`${harness.baseUrl}/pkg/@test/probe/0.1.0`, {
      headers: { authorization: harness.authHeader },
    });
    expect(res.status).toBe(200);
  });

  it('GET /pkg/... on miss returns 404', async () => {
    const res = await fetch(`${harness.baseUrl}/pkg/test/nope/9.9.9`);
    expect(res.status).toBe(404);
  });

  // ── /pkg/:scope/:name (Slice 7.5-fu L3 list-versions) ──
  it('GET /pkg/:scope/:name returns the version timeline (semver DESC)', async () => {
    // Publish two more versions on top of the 0.1.0 already in storage.
    for (const version of ['0.2.0', '0.1.5']) {
      const body = await signedPublishBody(
        makeGadgetManifest({ version }),
        SIMPLE_BUNDLE,
        harness.keypair,
      );
      const res = await fetch(`${harness.baseUrl}/publish`, {
        method: 'POST',
        headers: {
          authorization: harness.authHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
    }

    // Private rows only surface for authed callers.
    const res = await fetch(`${harness.baseUrl}/pkg/test/probe`, {
      headers: { authorization: harness.authHeader },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      artifactId: string;
      versions: ReadonlyArray<{ version: string; yanked: boolean; kind: string }>;
    };
    expect(body.artifactId).toBe('@test/probe');
    expect(body.versions.map((v) => v.version)).toEqual([
      '0.2.0',
      '0.1.5',
      '0.1.0',
    ]);
    for (const v of body.versions) {
      expect(v.yanked).toBe(false);
      expect(v.kind).toBe('gadget');
    }
  });

  it('GET /pkg/:scope/:name with leading @ also works', async () => {
    const res = await fetch(`${harness.baseUrl}/pkg/@test/probe`, {
      headers: { authorization: harness.authHeader },
    });
    expect(res.status).toBe(200);
  });

  it('GET /pkg/:scope/:name on missing artifact returns 404', async () => {
    const res = await fetch(`${harness.baseUrl}/pkg/test/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  // ── /search?sort=recent (Slice 7.5-fu L3) ──
  it('GET /search?sort=recent orders by publishedAt DESC', async () => {
    // `/search` exposes only `visibility: 'public'` rows, and the
    // publish journeys in this suite are private (pairing gate: a
    // public publish would need a sigstore signature — Fulcio/Rekor is
    // out of scope here). Seed two public metadata rows directly with
    // distinct publishedAt values to pin the recency ordering.
    await harness.storage.putArtifactMetadata({
      artifactId: '@test/earlier',
      sk: ARTIFACTS_METADATA_SK,
      kind: 'gadget',
      latestVersion: '0.1.0',
      description: 'an earlier-published artifact',
      visibility: 'public',
      publishedAt: '2026-05-01T00:00:00.000Z',
      publishedBy: TEST_SUBJECT,
    });
    await harness.storage.putArtifactMetadata({
      artifactId: '@test/later',
      sk: ARTIFACTS_METADATA_SK,
      kind: 'gadget',
      latestVersion: '0.1.0',
      description: 'a later-published artifact',
      visibility: 'public',
      publishedAt: '2026-05-02T00:00:00.000Z',
      publishedBy: TEST_SUBJECT,
    });

    const res = await fetch(`${harness.baseUrl}/search?sort=recent`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: ReadonlyArray<{ artifactId: string; publishedAt: string }>;
    };
    expect(body.results.length).toBeGreaterThanOrEqual(2);
    expect(body.results.map((r) => r.artifactId)).toContain('@test/later');
    // Each pair in publishedAt-DESC order.
    for (let i = 0; i < body.results.length - 1; i++) {
      const a = body.results[i]!;
      const b = body.results[i + 1]!;
      expect(a.publishedAt >= b.publishedAt).toBe(true);
    }
  });

  it('GET /search?sort=invalid returns 400', async () => {
    const res = await fetch(`${harness.baseUrl}/search?sort=popular`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  // ── /conformance/check ──
  it('POST /conformance/check returns 200 with ok: false on invalid manifest', async () => {
    const res = await fetch(`${harness.baseUrl}/conformance/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { kind: 'gadget' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; errors: unknown[] };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
  });

  // ── /bundles/... cache headers ──
  it('GET /bundles/:scope/:name/:version/bundle.js returns 200 + Cache-Control immutable', async () => {
    // The publish above wrote the bundle to memory storage.
    const res = await fetch(`${harness.baseUrl}/bundles/@test/probe/0.1.0/bundle.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const text = await res.text();
    expect(text).toContain('useProbe');
  });

  it('GET /bundles/.../bundle.js.sig returns 200 + Cache-Control immutable', async () => {
    const res = await fetch(`${harness.baseUrl}/bundles/@test/probe/0.1.0/bundle.js.sig`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const body = (await res.json()) as Ed25519Signature;
    expect(body.algorithm).toBe('ed25519');
  });

  it('GET /bundles/.../manifest.json returns 200 + Cache-Control immutable', async () => {
    const res = await fetch(`${harness.baseUrl}/bundles/@test/probe/0.1.0/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('gadget');
  });

  it('GET /bundles/.../bundle.js on miss returns 404', async () => {
    const res = await fetch(`${harness.baseUrl}/bundles/@test/nope/9.9.9/bundle.js`);
    expect(res.status).toBe(404);
  });

  // ── /publish duplicate ──
  it('POST /publish of the same (artifactId, version) returns 409', async () => {
    const manifest = makeGadgetManifest();
    const body = await signedPublishBody(manifest, SIMPLE_BUNDLE, harness.keypair);

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(409);
    const respBody = (await res.json()) as { error: string };
    expect(respBody.error).toBe('version_exists');
  });

  // ── /author-keys (Slice 6.4-follow-up) ──
  it('POST /author-keys without bearer returns 401', async () => {
    const res = await fetch(`${harness.baseUrl}/author-keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('POST /author-keys with malformed body returns 400 invalid_request', async () => {
    const res = await fetch(`${harness.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('POST /author-keys with JSON null body returns 400 (audit 2026-05-19 H2)', async () => {
    // Hono's `c.req.json()` parses "null" successfully and returns
    // `null` — the route's null-guard catches this before the next
    // line tries to read `.publicKeyBase64` off null. Regression
    // pin so a future refactor that drops the guard fails loudly.
    const res = await fetch(`${harness.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: 'null',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('POST /author-keys with valid publicKeyBase64 returns 201 then 200 idempotent', async () => {
    // Generate a FRESH keypair (don't reuse `harness.keypair` — that
    // one is pre-seeded into storage by `bootHarness`, which would
    // force the first call onto the 200-idempotent branch and leave
    // the 201 fresh-write path uncovered). Audit 2026-05-19 M5.
    const fresh = await generateEd25519Keypair();
    const publicKeyBase64 = Buffer.from(fresh.publicKey).toString('base64');

    const firstRes = await fetch(`${harness.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicKeyBase64 }),
    });
    expect(firstRes.status).toBe(201);
    const firstBody = (await firstRes.json()) as { keyId: string };
    expect(firstBody.keyId).toBe(fresh.publicKeyId);

    // Second register with the same key is unambiguously idempotent → 200.
    const secondRes = await fetch(`${harness.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicKeyBase64 }),
    });
    expect(secondRes.status).toBe(200);
  });

  it('POST /author-keys with wrong-length key bytes returns 400 invalid_request', async () => {
    const wrongLen = Buffer.alloc(16).toString('base64');
    const res = await fetch(`${harness.baseUrl}/author-keys`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicKeyBase64: wrongLen }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_request');
    expect(body.message).toMatch(/32 raw bytes/);
  });
});

// ── Public sigstore lane (F3, 2026-08-10) ────────────────────────────
//
// The wire-level coverage F1's honest-pairing flip removed comes back
// here with REAL crypto: the publish body carries a signature produced
// by the real `signBundleSigstore` against in-process mock
// Fulcio/Rekor, and the server verifies it through the REAL
// `verifyBundleSigstore` — the mock TUF trust root injected only via
// the server's `sigstoreTuf` option (the same seam a private sigstore
// deployment would use). nock intercepts the sigstore clients'
// http-agent traffic only; the suite's own undici `fetch` calls to the
// in-process server are untouched.
describe('OSS registry server — public sigstore lane (F3)', () => {
  let harness: Harness;
  let stack: Awaited<ReturnType<typeof startSigstoreMockStack>>;

  beforeAll(async () => {
    stack = await startSigstoreMockStack();
    harness = await bootHarness({ sigstoreTuf: stack.tuf });
  });

  afterAll(async () => {
    await harness.handle.stop();
    stack.teardown();
  });

  it('POST /publish (public + real sigstore) → 201; /search lists the row; anonymous read succeeds', async () => {
    const manifest = makeGadgetManifest({
      name: 'public-probe',
      visibility: 'public',
    });
    const bundleBytes = new TextEncoder().encode(SIMPLE_BUNDLE);
    const signature = await signBundleSigstore({
      bundleBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        manifest,
        bundle: Buffer.from(bundleBytes).toString('base64'),
        bundleSha384: createHash('sha384').update(bundleBytes).digest('base64'),
        signature,
      }),
    });
    const resBody = (await res.json()) as {
      artifactId?: string;
      installCommand?: string;
      error?: string;
      message?: string;
    };
    expect(res.status, `publish answered: ${JSON.stringify(resBody)}`).toBe(201);
    expect(resBody.artifactId).toBe('@test/public-probe');
    expect(resBody.installCommand).toContain('ggui gadget install');

    // The public row IS listed — the /search assertion the private
    // Ed25519 lane structurally can never make.
    const searchRes = await fetch(`${harness.baseUrl}/search?kind=gadget`);
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as {
      results: ReadonlyArray<{ artifactId: string; visibility?: string }>;
    };
    expect(searchBody.results.map((r) => r.artifactId)).toContain(
      '@test/public-probe',
    );

    // Public row → anonymous read succeeds (no bearer), and the row
    // carries the REAL leaf-cert pin the publish op extracted from
    // the v0.3 bundle.
    const readRes = await fetch(`${harness.baseUrl}/pkg/test/public-probe/0.1.0`);
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as {
      manifest: { visibility: string };
      authorPublicKey?: string;
    };
    expect(readBody.manifest.visibility).toBe('public');
    expect(typeof readBody.authorPublicKey).toBe('string');
    expect(Buffer.from(readBody.authorPublicKey!, 'base64')[0]).toBe(0x30);
  });

  it('POST /publish (public) with a REAL signature over different bytes → 400 signature_invalid', async () => {
    const manifest = makeGadgetManifest({
      name: 'public-tampered',
      visibility: 'public',
    });
    const publishedBytes = new TextEncoder().encode(SIMPLE_BUNDLE);
    const otherBytes = new TextEncoder().encode(
      'export function useProbe(){return 1;}\n',
    );
    const foreign = await signBundleSigstore({
      bundleBytes: otherBytes,
      identityToken: stack.identityToken(),
      endpoints: stack.signEndpoints,
    });
    // Correct the fast-hash claim so only the real cryptographic
    // check can reject.
    const transplanted = {
      ...foreign,
      bundleSha384: createHash('sha384').update(publishedBytes).digest('base64'),
    };

    const res = await fetch(`${harness.baseUrl}/publish`, {
      method: 'POST',
      headers: {
        authorization: harness.authHeader,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        manifest,
        bundle: Buffer.from(publishedBytes).toString('base64'),
        bundleSha384: createHash('sha384').update(publishedBytes).digest('base64'),
        signature: transplanted,
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('signature_invalid');
    expect(body.message).toMatch(/sigstore verification failed/);
  });
});

describe('createBearerAuthn', () => {
  it('rejects an empty token at construction time', () => {
    expect(() => createBearerAuthn({ token: '' })).toThrow();
  });

  it('verifies the configured token in constant time', () => {
    const authn = createBearerAuthn({ token: 'abc123', subject: 'alice' });
    expect(authn.verify('Bearer abc123')).toEqual({ subject: 'alice' });
    expect(authn.verify('Bearer abc124')).toBe(null);
    expect(authn.verify('Bearer ')).toBe(null);
    expect(authn.verify('Basic abc123')).toBe(null);
    expect(authn.verify(undefined)).toBe(null);
  });

  it('produces a stable default subject when none is configured', () => {
    const a = createBearerAuthn({ token: 'secret' });
    const b = createBearerAuthn({ token: 'secret' });
    const subjectA = a.verify('Bearer secret');
    const subjectB = b.verify('Bearer secret');
    expect(subjectA?.subject).toBe(subjectB?.subject);
    expect(subjectA?.subject.startsWith('bearer-')).toBe(true);
  });
});
