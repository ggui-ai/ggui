/**
 * H1 prefix-split routes — OSS parity with the hosted registry's
 * public/private bundle serving.
 *
 * NEW FILE (deliberately not folded into `server.test.ts`): pins the
 * visibility-split serving contract in isolation —
 *
 *   - `/bundles/public/…`  serves anonymously with the shared-cacheable
 *     immutable header; blobs on the private prefix are invisible to it.
 *   - `/bundles/private/…` requires a bearer (401 without / with an
 *     invalid one), authorizes the caller through H2's shared
 *     `canReadPrivateArtifact` predicate (publisher OR scope owner),
 *     answers an authorization denial with the SAME opaque 404 as a
 *     miss (a distinguishable denial is an existence oracle), and
 *     serves with a non-shared-cacheable immutable header. Storage
 *     faults inside the gate answer the documented `server_error`
 *     envelope — fail-closed, no raw error text on the wire.
 *   - The pre-split route shape (`/bundles/<scope>/…`, no visibility
 *     segment) no longer exists (404).
 *
 * The suite seeds storage directly (version rows, scope-owner rows,
 * blobs) instead of running the publish ceremony — publish placement
 * is pinned in registry-core's `publish.test.ts`; this file is about
 * the transport routes. A hand-rolled multi-token `BearerAuthn` maps
 * distinct tokens onto distinct subjects so the publisher / scope-owner
 * / stranger arms are all exercisable against one server.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GadgetManifest } from '@ggui-ai/artifact-manifest';
import {
  inMemoryBundleStorage,
  inMemoryRegistryStorage,
  type ArtifactVersionRow,
  type AuthnContext,
  type RegistryStorage,
} from '@ggui-ai/registry-core';
import type { Ed25519Signature } from '@ggui-ai/gadget-signing';
import type { BearerAuthn } from './authn/bearer.js';
import { createRegistryServer, type RegistryServerHandle } from './index.js';

const PUBLISHER = 'publisher-subject';
const SCOPE_OWNER = 'scope-owner-subject';
const STRANGER = 'stranger-subject';

const TOKENS: Record<string, AuthnContext> = {
  'tok-publisher': { subject: PUBLISHER },
  'tok-owner': { subject: SCOPE_OWNER },
  'tok-stranger': { subject: STRANGER },
};

/** Multi-token bearer fake — token → subject map, null otherwise. */
function multiTokenAuthn(): BearerAuthn {
  return {
    verify(authorizationHeader) {
      if (authorizationHeader === undefined) return null;
      const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
      if (!match || !match[1]) return null;
      return TOKENS[match[1].trim()] ?? null;
    },
  };
}

function gadgetManifest(overrides: Partial<GadgetManifest>): GadgetManifest {
  return {
    kind: 'gadget',
    scope: '@split',
    name: 'probe',
    version: '1.0.0',
    description: 'H1 split probe gadget',
    visibility: 'private',
    bundle: 'src/index.ts',
    exports: [
      {
        hook: 'useProbe',
        description: 'probe hook',
        usage: 'const value = useProbe();',
        example: { props: {} },
      },
    ],
    ...overrides,
  };
}

function signatureStub(): Ed25519Signature {
  return {
    algorithm: 'ed25519',
    bundleSha384: 'AAAA',
    signature: 'BBBB',
    publicKeyId: 'kid-1',
    signedAt: '2026-08-10T00:00:00.000Z',
  };
}

interface SeededArtifact {
  readonly scope: string;
  readonly name: string;
  readonly version: string;
  readonly visibility: 'public' | 'private';
  readonly bytes: Uint8Array;
}

async function seedArtifact(
  storage: RegistryStorage,
  bundleStorage: ReturnType<typeof inMemoryBundleStorage>,
  artifact: SeededArtifact,
): Promise<void> {
  const { scope, name, version, visibility, bytes } = artifact;
  const manifest = gadgetManifest({ scope, name, version, visibility });
  const row: ArtifactVersionRow = {
    artifactId: `${scope}/${name}`,
    version,
    manifest,
    kind: 'gadget',
    visibility,
    bundleUrl: bundleStorage.bundleUrl(scope, name, version, visibility),
    bundleSri: 'sha384-stub',
    signatureUrl: bundleStorage.signatureUrl(scope, name, version, visibility),
    authorPublicKey: 'stub-key',
    publishedAt: '2026-08-10T00:00:00.000Z',
    publishedBy: PUBLISHER,
  };
  const inserted = await storage.putArtifactVersionIfAbsent(row);
  if (!inserted.ok) throw new Error(`seed collision for ${row.artifactId}@${version}`);
  await bundleStorage.putBundle(scope, name, version, visibility, bytes);
  await bundleStorage.putSignature(scope, name, version, visibility, signatureStub());
  await bundleStorage.putManifest(scope, name, version, visibility, manifest);
}

describe('H1 bundle routes — visibility prefix split', () => {
  let handle: RegistryServerHandle;
  let baseUrl: string;

  const publicBytes = new TextEncoder().encode('export function usePub() {}');
  const privateBytes = new TextEncoder().encode('export function useSecret() {}');

  beforeAll(async () => {
    const storage = inMemoryRegistryStorage();
    const bundleStorage = inMemoryBundleStorage({
      bundleHost: 'http://placeholder.invalid',
    });

    await seedArtifact(storage, bundleStorage, {
      scope: '@split',
      name: 'open-probe',
      version: '1.0.0',
      visibility: 'public',
      bytes: publicBytes,
    });
    await seedArtifact(storage, bundleStorage, {
      scope: '@split',
      name: 'secret-probe',
      version: '1.0.0',
      visibility: 'private',
      bytes: privateBytes,
    });
    // Scope owner differs from the publisher — the OR-arm of the
    // authorization rule must hold for both identities.
    await storage.claimScope({
      scope: '@split',
      ownerSubject: SCOPE_OWNER,
      claimedAt: '2026-08-10T00:00:00.000Z',
      verification: 'unverified',
    });

    handle = createRegistryServer({
      storage,
      bundleStorage,
      authn: multiTokenAuthn(),
      host: '127.0.0.1',
      port: 0,
      bundleHost: 'http://placeholder.invalid',
      registryHostname: 'localhost:9001',
    });
    await handle.start();
    baseUrl = `http://127.0.0.1:${handle.actualPort}`;
  });

  afterAll(async () => {
    await handle.stop();
  });

  // ── public prefix ────────────────────────────────────────────────────
  describe('/bundles/public/…', () => {
    it('serves a public bundle anonymously with the shared-cacheable immutable header', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/public/@split/open-probe/1.0.0/bundle.js`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(await res.text()).toBe(new TextDecoder().decode(publicBytes));
    });

    it('serves public signature + manifest anonymously', async () => {
      const sig = await fetch(
        `${baseUrl}/bundles/public/@split/open-probe/1.0.0/bundle.js.sig`,
      );
      expect(sig.status).toBe(200);
      const man = await fetch(
        `${baseUrl}/bundles/public/@split/open-probe/1.0.0/manifest.json`,
      );
      expect(man.status).toBe(200);
    });

    it('does NOT serve a private artifact through the public prefix (404, no auth bypass)', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/public/@split/secret-probe/1.0.0/bundle.js`,
      );
      expect(res.status).toBe(404);
    });

    it('404s on a miss', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/public/@split/nope/9.9.9/bundle.js`,
      );
      expect(res.status).toBe(404);
    });
  });

  // ── private prefix ───────────────────────────────────────────────────
  describe('/bundles/private/…', () => {
    const privateBundlePath = '/bundles/private/@split/secret-probe/1.0.0/bundle.js';

    it('401s without a bearer', async () => {
      const res = await fetch(`${baseUrl}${privateBundlePath}`);
      expect(res.status).toBe(401);
    });

    it('401s with an invalid bearer', async () => {
      const res = await fetch(`${baseUrl}${privateBundlePath}`, {
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(res.status).toBe(401);
    });

    it('answers an unauthorized caller with the SAME opaque 404 as a miss (no existence oracle)', async () => {
      const denied = await fetch(`${baseUrl}${privateBundlePath}`, {
        headers: { authorization: 'Bearer tok-stranger' },
      });
      expect(denied.status).toBe(404);
      const deniedBody = await denied.text();

      const miss = await fetch(
        `${baseUrl}/bundles/private/@split/nope/9.9.9/bundle.js`,
        { headers: { authorization: 'Bearer tok-stranger' } },
      );
      expect(miss.status).toBe(404);
      // Shape equality — byte-identical body, same content type.
      expect(deniedBody).toBe(await miss.text());
      expect(denied.headers.get('content-type')).toBe(
        miss.headers.get('content-type'),
      );
    });

    it('serves the bundle to the publisher with a non-shared-cacheable immutable header', async () => {
      const res = await fetch(`${baseUrl}${privateBundlePath}`, {
        headers: { authorization: 'Bearer tok-publisher' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe(
        'private, max-age=31536000, immutable',
      );
      expect(await res.text()).toBe(new TextDecoder().decode(privateBytes));
    });

    it('serves the bundle to the scope owner (who is not the publisher)', async () => {
      const res = await fetch(`${baseUrl}${privateBundlePath}`, {
        headers: { authorization: 'Bearer tok-owner' },
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(new TextDecoder().decode(privateBytes));
    });

    it('gates signature + manifest behind the same rule', async () => {
      for (const file of ['bundle.js.sig', 'manifest.json']) {
        const anon = await fetch(
          `${baseUrl}/bundles/private/@split/secret-probe/1.0.0/${file}`,
        );
        expect(anon.status, `${file} anonymous`).toBe(401);
        const stranger = await fetch(
          `${baseUrl}/bundles/private/@split/secret-probe/1.0.0/${file}`,
          { headers: { authorization: 'Bearer tok-stranger' } },
        );
        expect(stranger.status, `${file} stranger`).toBe(404);
        const owner = await fetch(
          `${baseUrl}/bundles/private/@split/secret-probe/1.0.0/${file}`,
          { headers: { authorization: 'Bearer tok-owner' } },
        );
        expect(owner.status, `${file} owner`).toBe(200);
        expect(owner.headers.get('cache-control')).toBe(
          'private, max-age=31536000, immutable',
        );
      }
    });

    it('404s an unknown triple even for an authenticated caller', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/private/@split/nope/9.9.9/bundle.js`,
        { headers: { authorization: 'Bearer tok-publisher' } },
      );
      expect(res.status).toBe(404);
    });

    it('does NOT serve a public artifact through the private prefix (404)', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/private/@split/open-probe/1.0.0/bundle.js`,
        { headers: { authorization: 'Bearer tok-publisher' } },
      );
      expect(res.status).toBe(404);
    });
  });

  // ── storage faults fail closed with the documented envelope ──────────
  describe('/bundles/private/… under storage faults', () => {
    it('answers server_error (500) with no raw error text when the version-row read faults', async () => {
      const bundleStorage = inMemoryBundleStorage({
        bundleHost: 'http://placeholder.invalid',
      });
      const faultyStorage = inMemoryRegistryStorage();
      const raw = 'SIMULATED-DDB-OUTAGE-c0ffee (connection reset by peer)';
      const throwing: RegistryStorage = {
        ...faultyStorage,
        getArtifactVersion: async () => {
          throw new Error(raw);
        },
      };
      const faulty = createRegistryServer({
        storage: throwing,
        bundleStorage,
        authn: multiTokenAuthn(),
        host: '127.0.0.1',
        port: 0,
        bundleHost: 'http://placeholder.invalid',
        registryHostname: 'localhost:9001',
      });
      await faulty.start();
      try {
        const res = await fetch(
          `http://127.0.0.1:${faulty.actualPort}/bundles/private/@split/secret-probe/1.0.0/bundle.js`,
          { headers: { authorization: 'Bearer tok-publisher' } },
        );
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string; message: string };
        expect(body.error).toBe('server_error');
        // Fail-closed AND leak-free: the raw fault text never reaches
        // the wire.
        expect(JSON.stringify(body)).not.toContain('SIMULATED-DDB-OUTAGE');
        expect(JSON.stringify(body)).not.toContain('connection reset');
      } finally {
        await faulty.stop();
      }
    });

    it('denies (opaque 404) when the scope-owner lookup faults — the resolver fails closed', async () => {
      // Publisher mismatch forces the owner arm; a faulting owner
      // lookup must DENY (resolve null via createScopeOwnerResolver),
      // not fail open or surface a private-row-only 500.
      const bundleStorage = inMemoryBundleStorage({
        bundleHost: 'http://placeholder.invalid',
      });
      const base = inMemoryRegistryStorage();
      const server = createRegistryServer({
        storage: {
          ...base,
          getScopeOwner: async () => {
            throw new Error('SIMULATED-SCOPES-OUTAGE');
          },
        },
        bundleStorage,
        authn: multiTokenAuthn(),
        host: '127.0.0.1',
        port: 0,
        bundleHost: 'http://placeholder.invalid',
        registryHostname: 'localhost:9001',
      });
      await seedArtifact(base, bundleStorage, {
        scope: '@split',
        name: 'secret-probe',
        version: '1.0.0',
        visibility: 'private',
        bytes: privateBytes,
      });
      await server.start();
      try {
        const res = await fetch(
          `http://127.0.0.1:${server.actualPort}/bundles/private/@split/secret-probe/1.0.0/bundle.js`,
          { headers: { authorization: 'Bearer tok-owner' } },
        );
        expect(res.status).toBe(404);
        expect(await res.text()).not.toContain('SIMULATED-SCOPES-OUTAGE');
      } finally {
        await server.stop();
      }
    });
  });

  // ── CORS split (review finding 5) ────────────────────────────────────
  describe('CORS posture', () => {
    it('public bundle responses keep the permissive ACAO *', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/public/@split/open-probe/1.0.0/bundle.js`,
      );
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });

    it('private bundle responses carry NO ACAO header (excluded like /publish)', async () => {
      for (const [headers, label] of [
        [{ authorization: 'Bearer tok-publisher' }, 'authorized 200'],
        [{}, 'anonymous 401'],
        [{ authorization: 'Bearer tok-stranger' }, 'denied 404'],
      ] as const) {
        const res = await fetch(
          `${baseUrl}/bundles/private/@split/secret-probe/1.0.0/bundle.js`,
          { headers },
        );
        expect(
          res.headers.get('access-control-allow-origin'),
          `${label} must not be cross-origin readable`,
        ).toBe(null);
      }
    });

    it('OPTIONS preflight on the private prefix is not granted the permissive 204', async () => {
      const res = await fetch(
        `${baseUrl}/bundles/private/@split/secret-probe/1.0.0/bundle.js`,
        { method: 'OPTIONS' },
      );
      expect(res.status).not.toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(null);
    });
  });

  // ── pre-split route shape is gone ────────────────────────────────────
  it('the unsplit route shape /bundles/<scope>/… no longer exists (404)', async () => {
    for (const path of [
      '/bundles/@split/open-probe/1.0.0/bundle.js',
      '/bundles/@split/secret-probe/1.0.0/bundle.js',
    ]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(404);
    }
  });
});
