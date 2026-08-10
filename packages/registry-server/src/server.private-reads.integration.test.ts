/**
 * Parity suite — private-read ownership through the OSS server's
 * HTTP surface. The hosted deployment's read handlers pin the same
 * rule at their transport; this file proves the OSS hono transport
 * projects it identically:
 *
 *   - a private version is readable by its publisher or the owner of
 *     its scope, and by NOBODY else;
 *   - an unauthorized read (anonymous or authenticated stranger)
 *     answers byte-identically to a true not-found — the wire never
 *     confirms a private artifact exists;
 *   - list-versions FILTERS unreadable private rows rather than
 *     erroring, and an artifact with NO visible versions answers
 *     byte-identically to a true miss (a 200 `versions: []` would
 *     differ from the miss shape — an existence oracle).
 *
 * Kept separate from `server.integration.test.ts` (route-by-route
 * integration): this file is the ownership-rule contract, exercised
 * via `createRegistryApp` + `app.request()` — the hono layer is the
 * transport under test; the node-server binding adds nothing
 * auth-relevant. The shared `testing/server-harness.ts` boots ONE
 * node server with ONE bearer subject; this suite needs three
 * verified identities over one storage, so it builds three hono apps
 * directly instead.
 *
 * Three verified identities are modeled as three app instances over
 * ONE shared storage, each with its own bearer token → subject (the
 * OSS bearer adapter is one-token-one-subject by design; a
 * multi-subject deployment is multiple tokens).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  inMemoryBundleStorage,
  inMemoryRegistryStorage,
  type ArtifactVersionRow,
  type RegistryStorage,
  ARTIFACTS_METADATA_SK,
} from '@ggui-ai/registry-core';
import type { ArtifactManifest } from '@ggui-ai/artifact-manifest';
import { createBearerAuthn } from './authn/bearer.js';
import { createRegistryApp } from './server.js';

const PUBLISHER = { token: 'token-publisher', subject: 'publisher-1' } as const;
const SCOPE_OWNER = { token: 'token-owner', subject: 'owner-9' } as const;
const STRANGER = { token: 'token-stranger', subject: 'stranger-2' } as const;

const STUB_MANIFEST: ArtifactManifest = {
  kind: 'gadget',
  scope: '@acme',
  name: 'widget',
  version: '1.0.0',
  bundle: 'src/index.ts',
  visibility: 'private',
  description: 'a',
  exports: [{ hook: 'useWidget', description: 'a', usage: 'b', example: {} }],
};

function makeVersion(
  overrides: Partial<ArtifactVersionRow> = {},
): ArtifactVersionRow {
  const version = overrides.version ?? '1.0.0';
  const visibility = overrides.visibility ?? 'private';
  return {
    artifactId: '@acme/widget',
    version,
    // Embedded manifest tracks the row's version + visibility so the
    // fixture never contradicts itself.
    manifest: { ...STUB_MANIFEST, version, visibility },
    kind: 'gadget',
    visibility,
    publishedAt: '2026-08-01T00:00:00.000Z',
    publishedBy: PUBLISHER.subject,
    ...overrides,
  };
}

interface Harness {
  readonly storage: RegistryStorage;
  /** One app per identity — same storage, different verified subject. */
  readonly apps: {
    readonly publisher: Hono;
    readonly scopeOwner: Hono;
    readonly stranger: Hono;
  };
}

function bootHarness(): Harness {
  const storage = inMemoryRegistryStorage();
  const bundleStorage = inMemoryBundleStorage();
  const appFor = (identity: { token: string; subject: string }): Hono =>
    createRegistryApp({
      storage,
      bundleStorage,
      authn: createBearerAuthn(identity),
      registryHostname: 'registry.test.invalid',
    });
  return {
    storage,
    apps: {
      publisher: appFor(PUBLISHER),
      scopeOwner: appFor(SCOPE_OWNER),
      stranger: appFor(STRANGER),
    },
  };
}

function authed(token: string): RequestInit {
  return { headers: { authorization: `Bearer ${token}` } };
}

async function seedPrivateArtifact(storage: RegistryStorage): Promise<void> {
  await storage.putArtifactMetadata({
    artifactId: '@acme/widget',
    sk: ARTIFACTS_METADATA_SK,
    kind: 'gadget',
    latestVersion: '1.0.0',
    visibility: 'private',
    publishedAt: '2026-08-01T00:00:00.000Z',
    publishedBy: PUBLISHER.subject,
  });
  await storage.putArtifactVersionIfAbsent(makeVersion());
  await storage.claimScope({
    scope: '@acme',
    ownerSubject: SCOPE_OWNER.subject,
    claimedAt: '2026-08-01T00:00:00.000Z',
    verification: 'unverified',
  });
}

describe('private-read ownership over the OSS HTTP surface', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = bootHarness();
    await seedPrivateArtifact(harness.storage);
  });

  describe('GET /pkg/:scope/:name/:version', () => {
    it('200 for the publisher', async () => {
      const res = await harness.apps.publisher.request(
        '/pkg/@acme/widget/1.0.0',
        authed(PUBLISHER.token),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { publishedBy: string };
      expect(body.publishedBy).toBe(PUBLISHER.subject);
    });

    it('200 for the scope owner who did not publish the row', async () => {
      const res = await harness.apps.scopeOwner.request(
        '/pkg/@acme/widget/1.0.0',
        authed(SCOPE_OWNER.token),
      );
      expect(res.status).toBe(200);
    });

    it('anonymous caller gets a response byte-identical to a true miss', async () => {
      const privateRead = await harness.apps.publisher.request(
        '/pkg/@acme/widget/1.0.0',
      );
      const trueMiss = await harness.apps.publisher.request(
        '/pkg/@acme/widget/9.9.9',
      );
      expect(privateRead.status).toBe(404);
      expect(trueMiss.status).toBe(404);
      const privateBody = (await privateRead.json()) as {
        error: string;
        message: string;
      };
      const missBody = (await trueMiss.json()) as {
        error: string;
        message: string;
      };
      expect(privateBody.error).toBe('not_found');
      // Identical shape modulo the version segment the caller typed.
      expect(privateBody.message).toBe('package @acme/widget@1.0.0 not found');
      expect(missBody.message).toBe('package @acme/widget@9.9.9 not found');
    });

    it('an authenticated stranger gets the same not-found shape (no forbidden signal)', async () => {
      const res = await harness.apps.stranger.request(
        '/pkg/@acme/widget/1.0.0',
        authed(STRANGER.token),
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; message: string };
      expect(body).toEqual({
        error: 'not_found',
        message: 'package @acme/widget@1.0.0 not found',
      });
    });
  });

  describe('GET /pkg/:scope/:name (list versions)', () => {
    beforeEach(async () => {
      await harness.storage.putArtifactVersionIfAbsent(
        makeVersion({ version: '1.1.0', visibility: 'public' }),
      );
    });

    it('publisher sees private and public rows', async () => {
      const res = await harness.apps.publisher.request(
        '/pkg/@acme/widget',
        authed(PUBLISHER.token),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { versions: { version: string }[] };
      expect(body.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    });

    it('scope owner sees private and public rows', async () => {
      const res = await harness.apps.scopeOwner.request(
        '/pkg/@acme/widget',
        authed(SCOPE_OWNER.token),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { versions: { version: string }[] };
      expect(body.versions.map((v) => v.version)).toEqual(['1.1.0', '1.0.0']);
    });

    it('authenticated stranger degrades to the public subset — same as anonymous', async () => {
      const strangerRes = await harness.apps.stranger.request(
        '/pkg/@acme/widget',
        authed(STRANGER.token),
      );
      const anonymousRes = await harness.apps.stranger.request('/pkg/@acme/widget');
      expect(strangerRes.status).toBe(200);
      const strangerBody = (await strangerRes.json()) as {
        versions: { version: string }[];
      };
      const anonymousBody = (await anonymousRes.json()) as {
        versions: { version: string }[];
      };
      expect(strangerBody.versions.map((v) => v.version)).toEqual(['1.1.0']);
      expect(strangerBody).toEqual(anonymousBody);
    });

    it('fully-private artifact answers a stranger byte-identically to a true miss (no existence oracle)', async () => {
      // Fresh harness without the public 1.1.0 row: every version is
      // private and unreadable. A 200 `versions: []` here would differ
      // from the true-miss 404 — that difference is an existence
      // oracle, so the list route must answer exactly as if the
      // artifact did not exist.
      const isolated = bootHarness();
      await seedPrivateArtifact(isolated.storage);
      const fullyInvisible = await isolated.apps.stranger.request(
        '/pkg/@acme/widget',
        authed(STRANGER.token),
      );
      const trueMiss = await isolated.apps.stranger.request(
        '/pkg/@acme/absent',
        authed(STRANGER.token),
      );
      expect(fullyInvisible.status).toBe(404);
      expect(trueMiss.status).toBe(404);
      const invisibleBody = (await fullyInvisible.json()) as {
        error: string;
        message: string;
      };
      const missBody = (await trueMiss.json()) as {
        error: string;
        message: string;
      };
      expect(invisibleBody.error).toBe('not_found');
      // Identical shape modulo the artifact id the caller typed.
      expect(invisibleBody.message).toBe('no such artifact: @acme/widget');
      expect(missBody.message).toBe('no such artifact: @acme/absent');
    });
  });
});
