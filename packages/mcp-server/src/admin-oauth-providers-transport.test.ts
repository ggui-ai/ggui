/**
 * Admin OAuth providers transport tests — Slice C agent C
 * (`docs/plans/2026-05-01-end-user-auth-slices.md`).
 *
 * Uses an in-memory `MemoryStore` that implements `OAuthProvidersStore`
 * directly, so the route tests don't touch the filesystem.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import type { AuthAdapter, AuthResult } from '@ggui-ai/mcp-server-core';
import { InMemoryAuditSink } from '@ggui-ai/mcp-server-core/in-memory';
import {
  DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH,
  mountAdminOAuthProvidersTransport,
} from './admin-oauth-providers-transport.js';
import type { OAuthProviderConfigRecord } from './oauth-login-types.js';
import type {
  OAuthProvidersStore,
  PutInput,
} from './oauth-providers-store.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

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

interface MemoryStoreCalls {
  list: number;
  get: Array<string>;
  put: Array<PutInput>;
  setEnabled: Array<{ providerId: string; enabled: boolean }>;
  remove: Array<string>;
}

class MemoryStore implements OAuthProvidersStore {
  private rows: OAuthProviderConfigRecord[] = [];
  private envOverrides: Set<string> = new Set();
  public calls: MemoryStoreCalls = {
    list: 0,
    get: [],
    put: [],
    setEnabled: [],
    remove: [],
  };

  setEnvOverride(providerId: string, clientId: string, clientSecret: string): void {
    this.envOverrides.add(providerId);
    const idx = this.rows.findIndex((r) => r.providerId === providerId);
    const next: OAuthProviderConfigRecord = {
      providerId,
      clientId,
      clientSecret,
      source: 'env',
      enabled: true,
    };
    if (idx >= 0) this.rows[idx] = next;
    else this.rows.push(next);
  }

  seed(record: OAuthProviderConfigRecord): void {
    const idx = this.rows.findIndex((r) => r.providerId === record.providerId);
    if (idx >= 0) this.rows[idx] = record;
    else this.rows.push(record);
  }

  async list(): Promise<ReadonlyArray<OAuthProviderConfigRecord>> {
    this.calls.list += 1;
    return [...this.rows].sort((a, b) =>
      a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
    );
  }
  async get(providerId: string): Promise<OAuthProviderConfigRecord | null> {
    this.calls.get.push(providerId);
    const found = this.rows.find((r) => r.providerId === providerId && r.enabled);
    return found ?? null;
  }
  async put(input: PutInput): Promise<OAuthProviderConfigRecord> {
    this.calls.put.push(input);
    if (this.envOverrides.has(input.providerId)) {
      throw new Error(
        `oauth_provider_env_overridden: ${input.providerId} has env credentials; remove env vars to edit.`,
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(input.providerId)) {
      throw new Error(`oauth_provider_invalid_id: '${input.providerId}'`);
    }
    const enabled = input.enabled ?? true;
    const next: OAuthProviderConfigRecord = {
      providerId: input.providerId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      source: 'file',
      enabled,
    };
    const idx = this.rows.findIndex((r) => r.providerId === input.providerId);
    if (idx >= 0) this.rows[idx] = next;
    else this.rows.push(next);
    return next;
  }
  async setEnabled(providerId: string, enabled: boolean): Promise<void> {
    this.calls.setEnabled.push({ providerId, enabled });
    if (this.envOverrides.has(providerId)) {
      throw new Error(
        `oauth_provider_env_overridden: ${providerId} has env credentials; remove env vars to edit.`,
      );
    }
    const idx = this.rows.findIndex((r) => r.providerId === providerId);
    if (idx < 0) {
      throw new Error(`oauth_provider_not_found: ${providerId}`);
    }
    const existing = this.rows[idx];
    if (!existing) throw new Error(`oauth_provider_not_found: ${providerId}`);
    this.rows[idx] = { ...existing, enabled };
  }
  async remove(providerId: string): Promise<void> {
    this.calls.remove.push(providerId);
    if (this.envOverrides.has(providerId)) return;
    const idx = this.rows.findIndex((r) => r.providerId === providerId);
    if (idx < 0) return;
    this.rows.splice(idx, 1);
  }
}

interface BootedApp {
  url: string;
  server: HttpServer;
  store: MemoryStore;
  auditSink: InMemoryAuditSink;
  close(): Promise<void>;
}

const booted: BootedApp[] = [];

afterEach(async () => {
  for (const b of booted) await b.close();
  booted.length = 0;
});

async function bootApp(opts: {
  auth: AuthAdapter;
  store?: MemoryStore;
  withAudit?: boolean;
}): Promise<BootedApp> {
  const app = express();
  app.use(express.json());
  const store = opts.store ?? new MemoryStore();
  const auditSink = new InMemoryAuditSink();
  mountAdminOAuthProvidersTransport(app, {
    store,
    auth: opts.auth,
    logger: silentLogger,
    ...(opts.withAudit ? { auditSink } : {}),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen returned non-info');
  const handle: BootedApp = {
    url: `http://127.0.0.1:${addr.port}`,
    server,
    store,
    auditSink,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  booted.push(handle);
  return handle;
}

async function jsonRequest(
  url: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
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

describe('GET /ggui/admin/oauth-providers', () => {
  it('without auth returns 401 unauthenticated', async () => {
    const auth = makeAuth({});
    const boot = await bootApp({ auth });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}`,
      'GET',
    );
    expect(res.status).toBe(401);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe(
      'unauthenticated',
    );
  });

  it('with non-builder identity returns 403 forbidden', async () => {
    const auth = makeAuth({
      'user-token': { kind: 'user', userId: 'u1', roles: [] },
    });
    const boot = await bootApp({ auth });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}`,
      'GET',
      undefined,
      { authorization: 'Bearer user-token' },
    );
    expect(res.status).toBe(403);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe(
      'forbidden',
    );
  });

  it('builder gets list with redacted clientSecret', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const store = new MemoryStore();
    store.seed({
      providerId: 'google',
      clientId: 'g-id',
      clientSecret: 'super-secret-do-not-leak',
      source: 'file',
      enabled: true,
    });
    const boot = await bootApp({ auth, store });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}`,
      'GET',
      undefined,
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      providers: Array<{
        providerId: string;
        clientId: string;
        clientSecret: string;
        source: string;
        enabled: boolean;
      }>;
    };
    expect(body.providers.length).toBe(1);
    expect(body.providers[0]?.clientId).toBe('g-id');
    expect(body.providers[0]?.clientSecret).toBe('<redacted>');
    expect(body.providers[0]?.source).toBe('file');
    // Raw response text MUST NOT contain the actual secret anywhere.
    expect(JSON.stringify(body)).not.toContain('super-secret-do-not-leak');
  });
});

describe('PUT /ggui/admin/oauth-providers/:providerId', () => {
  it('happy path: 200 with redacted record + store.put called', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google`,
      'PUT',
      { clientId: 'g-id', clientSecret: 'g-secret' },
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(200);
    const body = res.json as {
      providerId: string;
      clientId: string;
      clientSecret: string;
      source: string;
      enabled: boolean;
    };
    expect(body.providerId).toBe('google');
    expect(body.clientId).toBe('g-id');
    expect(body.clientSecret).toBe('<redacted>');
    expect(body.source).toBe('file');
    expect(body.enabled).toBe(true);
    expect(boot.store.calls.put.length).toBe(1);
    expect(boot.store.calls.put[0]?.providerId).toBe('google');
    expect(boot.store.calls.put[0]?.clientSecret).toBe('g-secret');
  });

  it('env-overridden providerId returns 409', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const store = new MemoryStore();
    store.setEnvOverride('google', 'env-id', 'env-secret');
    const boot = await bootApp({ auth, store });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google`,
      'PUT',
      { clientId: 'g-id', clientSecret: 'g-secret' },
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(409);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe(
      'env_overridden',
    );
  });

  it('missing clientId returns 400', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google`,
      'PUT',
      { clientSecret: 'only-secret' },
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(400);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe(
      'bad_request',
    );
  });

  it('invalid providerId path param returns 400', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/UPPER`,
      'PUT',
      { clientId: 'id', clientSecret: 'secret' },
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(400);
    expect((res.json as { error?: { code?: string } }).error?.code).toBe(
      'bad_request',
    );
  });

  it('emits auth.oauth-config.write audit entry on success', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth, withAudit: true });
    await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google`,
      'PUT',
      { clientId: 'id', clientSecret: 'secret' },
      { authorization: 'Bearer b' },
    );
    const entries = boot.auditSink.snapshot();
    expect(entries.length).toBe(1);
    expect(entries[0]?.action).toBe('auth.oauth-config.write');
    expect(entries[0]?.actor.kind).toBe('builder');
    expect(entries[0]?.resource?.kind).toBe('oauth-provider');
    expect(entries[0]?.resource?.id).toBe('google');
  });
});

describe('POST /ggui/admin/oauth-providers/:providerId/toggle', () => {
  it('toggles enabled to false and returns 204', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const store = new MemoryStore();
    store.seed({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
      source: 'file',
      enabled: true,
    });
    const boot = await bootApp({ auth, store });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google/toggle`,
      'POST',
      { enabled: false },
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(204);
    expect(boot.store.calls.setEnabled.length).toBe(1);
    expect(boot.store.calls.setEnabled[0]).toEqual({
      providerId: 'google',
      enabled: false,
    });
  });

  it('env-overridden toggle returns 409', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const store = new MemoryStore();
    store.setEnvOverride('google', 'env-id', 'env-secret');
    const boot = await bootApp({ auth, store });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google/toggle`,
      'POST',
      { enabled: false },
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(409);
  });
});

describe('DELETE /ggui/admin/oauth-providers/:providerId', () => {
  it('returns 204 and calls store.remove', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const store = new MemoryStore();
    store.seed({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
      source: 'file',
      enabled: true,
    });
    const boot = await bootApp({ auth, store });
    const res = await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google`,
      'DELETE',
      undefined,
      { authorization: 'Bearer b' },
    );
    expect(res.status).toBe(204);
    expect(boot.store.calls.remove.length).toBe(1);
    expect(boot.store.calls.remove[0]).toBe('google');
  });

  it('emits auth.oauth-config.delete audit entry', async () => {
    const auth = makeAuth({ b: { kind: 'builder' } });
    const boot = await bootApp({ auth, withAudit: true });
    await jsonRequest(
      `${boot.url}${DEFAULT_ADMIN_OAUTH_PROVIDERS_PATH}/google`,
      'DELETE',
      undefined,
      { authorization: 'Bearer b' },
    );
    const entries = boot.auditSink.snapshot();
    expect(entries.length).toBe(1);
    expect(entries[0]?.action).toBe('auth.oauth-config.delete');
    expect(entries[0]?.resource?.id).toBe('google');
  });
});
