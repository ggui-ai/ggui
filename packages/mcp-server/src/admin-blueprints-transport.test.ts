/**
 * Admin-blueprints transport tests — exercises every externally-visible
 * code path of `POST /admin/blueprints`:
 *
 *   - happy path: builder-bearer + valid body → 200 + provider.list()
 *     surfaces the new row
 *   - idempotency: same id twice returns 200 both times, second
 *     overwrites the first
 *   - auth gates: no bearer → 401, non-builder identity → 403
 *   - body validation: missing `id` or `name` → 400
 *   - provider capability: `addManifest` absent → 501
 *   - path disable: `path: null` mounts nothing
 *   - custom path: `path: '/admin/x'` routes to the non-default URL
 *
 * Lane 3 (vitest, deterministic, no LLM, no browser). The transport
 * is thin by construction — the full `createGguiServer` integration
 * is owned by the existing boot-sites (pairing-transport.test.ts
 * proves the server-level mount + auth adapter binding pattern;
 * adding a second copy here would duplicate without adding signal).
 */
import { describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import type { AuthAdapter, AuthResult } from '@ggui-ai/mcp-server-core';
import { ManifestBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';
import {
  DEFAULT_ADMIN_BLUEPRINTS_PATH,
  mountAdminBlueprintsTransport,
  providerAcceptsManifests,
} from './admin-blueprints-transport.js';

/** Silent no-op logger — the transport emits debug/info/warn per request. */
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/** Fake AuthAdapter that resolves one bearer token to a declared identity. */
function makeAuth(tokens: Record<string, AuthResult['identity']>): AuthAdapter {
  return {
    async getIdentity(
      request: { headers: Record<string, string | undefined> },
    ): Promise<AuthResult | null> {
      const header = request.headers['authorization'];
      const h = typeof header === 'string' ? header : undefined;
      if (!h || !h.startsWith('Bearer ')) return null;
      const token = h.slice('Bearer '.length);
      const identity = tokens[token];
      if (!identity) return null;
      return { identity, source: 'dev' };
    },
  } as unknown as AuthAdapter;
}

interface BootedApp {
  url: string;
  server: HttpServer;
  provider: ManifestBlueprintProvider;
  close(): Promise<void>;
}

async function bootApp(opts: {
  auth: AuthAdapter;
  path?: string | null;
  provider?: ManifestBlueprintProvider | Record<string, unknown>;
}): Promise<BootedApp> {
  const app = express();
  app.use(express.json());
  const provider = (opts.provider ?? new ManifestBlueprintProvider()) as unknown as ManifestBlueprintProvider;
  mountAdminBlueprintsTransport(app, {
    provider: provider as ManifestBlueprintProvider,
    auth: opts.auth,
    logger: silentLogger,
    ...(opts.path !== undefined ? { path: opts.path } : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    provider: provider as ManifestBlueprintProvider,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Some responses (Express's default 404) are text/html, not JSON.
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

describe('providerAcceptsManifests', () => {
  it('returns true for ManifestBlueprintProvider', () => {
    expect(providerAcceptsManifests(new ManifestBlueprintProvider())).toBe(true);
  });

  it('returns false for a provider missing addManifest', () => {
    const stub = {
      list: async () => [],
      get: async () => null,
    };
    expect(providerAcceptsManifests(stub as never)).toBe(false);
  });
});

describe('POST /admin/blueprints — happy path', () => {
  it('builder-bearer + valid body → 200 + provider.list surfaces the new row', async () => {
    const auth = makeAuth({
      'builder-token': { kind: 'builder' },
    });
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        {
          id: 'greet-card',
          name: 'Greeting Card',
          description: 'A tiny greeting UI.',
          category: 'display',
          tags: ['hello', 'demo'],
        },
        { authorization: 'Bearer builder-token' },
      );
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ ok: true, id: 'greet-card' });

      // Provider round-trip — the new row is listable.
      const rows = await boot.provider.list({});
      expect(rows.length).toBe(1);
      expect(rows[0]?.id).toBe('greet-card');
      expect(rows[0]?.name).toBe('Greeting Card');
      expect(rows[0]?.description).toBe('A tiny greeting UI.');
      expect(rows[0]?.source).toEqual({ kind: 'user' });
      // category + tags flow through — the seed type merges both.
      expect(rows[0]?.tags).toContain('display');
      expect(rows[0]?.tags).toContain('hello');
      expect(rows[0]?.tags).toContain('demo');
    } finally {
      await boot.close();
    }
  });

  it('idempotent: same id twice returns 200 both times, second overwrites', async () => {
    const auth = makeAuth({
      'b': { kind: 'builder' },
    });
    const boot = await bootApp({ auth });
    try {
      const r1 = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'Original' },
        { authorization: 'Bearer b' },
      );
      expect(r1.status).toBe(200);

      const r2 = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'Overwritten' },
        { authorization: 'Bearer b' },
      );
      expect(r2.status).toBe(200);

      const rows = await boot.provider.list({});
      expect(rows.length).toBe(1);
      expect(rows[0]?.name).toBe('Overwritten');
    } finally {
      await boot.close();
    }
  });

  it('minimum body: `{id, name}` only → 200 + provider has the row with no optional fields', async () => {
    const auth = makeAuth({
      'b': { kind: 'builder' },
    });
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'minimal', name: 'Minimum Shape' },
        { authorization: 'Bearer b' },
      );
      expect(res.status).toBe(200);
      const rows = await boot.provider.list({});
      expect(rows[0]?.description).toBeUndefined();
      expect(rows[0]?.tags).toBeUndefined();
    } finally {
      await boot.close();
    }
  });
});

describe('POST /admin/blueprints — auth gates', () => {
  it('no Authorization header → 401 unauthenticated', async () => {
    const auth = makeAuth({});
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'y' },
      );
      expect(res.status).toBe(401);
      expect(
        (res.json as { error?: { code?: string } }).error?.code,
      ).toBe('unauthenticated');
    } finally {
      await boot.close();
    }
  });

  it('non-builder identity (user bearer) → 403 forbidden', async () => {
    const auth = makeAuth({
      'user-token': { kind: 'user', userId: 'u1', roles: [] },
    });
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'y' },
        { authorization: 'Bearer user-token' },
      );
      expect(res.status).toBe(403);
      expect(
        (res.json as { error?: { code?: string } }).error?.code,
      ).toBe('forbidden');
    } finally {
      await boot.close();
    }
  });
});

describe('POST /admin/blueprints — body validation', () => {
  it('missing id → 400 bad_request', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { name: 'no id here' },
        { authorization: 'Bearer b' },
      );
      expect(res.status).toBe(400);
      expect(
        (res.json as { error?: { code?: string } }).error?.code,
      ).toBe('bad_request');
    } finally {
      await boot.close();
    }
  });

  it('missing name → 400 bad_request', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'no-name' },
        { authorization: 'Bearer b' },
      );
      expect(res.status).toBe(400);
    } finally {
      await boot.close();
    }
  });

  it('empty object → 400 bad_request', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        {},
        { authorization: 'Bearer b' },
      );
      expect(res.status).toBe(400);
    } finally {
      await boot.close();
    }
  });
});

describe('POST /admin/blueprints — provider capability', () => {
  it('provider without addManifest → 501 not_supported', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    // Stub provider: has list/get but no addManifest (mirrors a
    // hypothetical DynamoBlueprintProvider backed by an external
    // catalog — read-only from this server's perspective).
    const stubProvider = {
      list: async () => [],
      get: async () => null,
    };
    const boot = await bootApp({ auth, provider: stubProvider });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'y' },
        { authorization: 'Bearer b' },
      );
      expect(res.status).toBe(501);
      expect(
        (res.json as { error?: { code?: string } }).error?.code,
      ).toBe('not_supported');
    } finally {
      await boot.close();
    }
  });
});

describe('POST /admin/blueprints — path config', () => {
  it('`path: null` does NOT mount the route — 404 on the default path', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth, path: null });
    try {
      const res = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'y' },
        { authorization: 'Bearer b' },
      );
      expect(res.status).toBe(404);
    } finally {
      await boot.close();
    }
  });

  it('custom path routes correctly, default path returns 404', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth, path: '/admin/custom-blueprints' });
    try {
      // Default path 404s.
      const notFound = await postJson(
        `${boot.url}${DEFAULT_ADMIN_BLUEPRINTS_PATH}`,
        { id: 'x', name: 'y' },
        { authorization: 'Bearer b' },
      );
      expect(notFound.status).toBe(404);
      // Custom path 200s.
      const ok = await postJson(
        `${boot.url}/admin/custom-blueprints`,
        { id: 'x', name: 'y' },
        { authorization: 'Bearer b' },
      );
      expect(ok.status).toBe(200);
    } finally {
      await boot.close();
    }
  });
});
