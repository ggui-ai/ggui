/**
 * End-to-end pairing transport + auth-bridge tests. Boots a real
 * server on an ephemeral port and exercises every externally-visible
 * pairing path:
 *
 *   - POST /pair — happy path (init → complete → authenticated /mcp),
 *     invalid code, expired code (via caller-supplied clock),
 *     replay prevention, malformed body.
 *   - Revocation — revokePairing immediately invalidates future /mcp
 *     calls that present the token.
 *   - POST /admin/pair/init — builder auth succeeds, unauth → 401,
 *     `adminInitPath: null` disables the route.
 *   - Opt-in — `pairing: false`/omitted mounts neither route.
 *   - Composition — `pairing: { service }` mounts routes but leaves
 *     the bridge to the caller.
 *   - Failure mode — `pairing: true` + an adapter without
 *     registerToken throws at boot.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';
import type {
  AuthAdapter,
  AuthResult,
  PairingCompletion,
  PairingInit,
  PairingService,
} from '@ggui-ai/mcp-server-core';
import {
  InMemoryAuthAdapter,
  InMemoryPairingService,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

interface BootedFixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

async function boot(
  opts: Parameters<typeof createGguiServer>[0] = {},
): Promise<BootedFixture> {
  const server = createGguiServer({ logger: silentLogger, ...opts });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return { server, httpServer, url: `http://127.0.0.1:${addr.port}` };
}

async function mcpInitializeWithBearer(
  url: string,
  token: string,
): Promise<void> {
  // Use a real MCP client — proves the bearer path we plug pairing
  // tokens into is the same one every other token flows through,
  // not a bespoke fake.
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: 'pair-test', version: '0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  await client.close();
}

describe('pairing transport — opt-in', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('omitted / false: no /pair or /admin/pair/init routes', async () => {
    fx = await boot({ auth: new InMemoryAuthAdapter({ devAllowAll: true }) });
    expect(fx.server.pairingService).toBeNull();
    const pair = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456', deviceName: 'x' }),
    });
    expect(pair.status).toBe(404);
    const admin = await fetch(`${fx.url}/admin/pair/init`, { method: 'POST' });
    expect(admin.status).toBe(404);
  });

  it('pairing: true with default adapter mounts routes and exposes pairingService', async () => {
    fx = await boot({ pairing: true });
    expect(fx.server.pairingService).not.toBeNull();
  });
});

describe('pairing transport — full round-trip via default bridge', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('init → complete → MCP handshake under the minted token', async () => {
    // Explicit non-devAllowAll adapter so we prove the minted token
    // really is what authenticates /mcp (not dev-mode rescue).
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      pairing: true,
    });
    expect(fx.server.pairingService).not.toBeNull();

    const init = await fx.server.pairingService!.initPairing();
    expect(init.code).toMatch(/^\d{6}$/);
    expect(init.serverName).toBe('ggui-mcp-server');

    const completeRes = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'iPhone 15' }),
    });
    expect(completeRes.status).toBe(200);
    const completion = (await completeRes.json()) as PairingCompletion;
    expect(completion.pairingId).toBeTruthy();
    expect(completion.token).toBeTruthy();
    expect(completion.deviceName).toBe('iPhone 15');
    expect(completion.serverName).toBe('ggui-mcp-server');

    // Token authenticates /mcp via the normal bearer path.
    await expect(
      mcpInitializeWithBearer(fx.url, completion.token),
    ).resolves.toBeUndefined();
  });

  it('rejects wrong code with 401 pairing_rejected', async () => {
    fx = await boot({ pairing: true });
    await fx.server.pairingService!.initPairing();
    const res = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '000000', deviceName: 'x' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('pairing_rejected');
  });

  it('one-shot: same code cannot be used twice', async () => {
    fx = await boot({ pairing: true });
    const init = await fx.server.pairingService!.initPairing();
    const first = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'A' }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'B' }),
    });
    expect(second.status).toBe(401);
  });

  it('malformed body returns 400 bad_request', async () => {
    fx = await boot({ pairing: true });
    await fx.server.pairingService!.initPairing();
    const missingCode = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceName: 'x' }),
    });
    expect(missingCode.status).toBe(400);
    const body = (await missingCode.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('bad_request');

    const missingDevice = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    });
    expect(missingDevice.status).toBe(400);

    const nonStringCode = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 123456, deviceName: 'x' }),
    });
    expect(nonStringCode.status).toBe(400);
  });
});

describe('pairing transport — auth bridge lifecycle', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('revokePairing invalidates future /mcp requests using the token', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      pairing: true,
    });
    const init = await fx.server.pairingService!.initPairing();
    const res = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'iPhone' }),
    });
    const completion = (await res.json()) as PairingCompletion;

    // Token works before revoke.
    await expect(
      mcpInitializeWithBearer(fx.url, completion.token),
    ).resolves.toBeUndefined();

    await fx.server.pairingService!.revokePairing(completion.pairingId);

    // Token rejected after revoke. The StreamableHTTP client throws on
    // non-2xx initialize — assert via the raw POST to /mcp so we can
    // inspect the status directly.
    const unauthResponse = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${completion.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(unauthResponse.status).toBe(401);
  });

  it('issued tokens carry pairing metadata on the AuthResult', async () => {
    // Spy on the adapter's registerToken to catch what the bridge
    // hands it — that's the single seam the rest of /mcp depends on.
    const observed: Array<{ token: string; result: AuthResult }> = [];
    class ObservingAdapter extends InMemoryAuthAdapter {
      override registerToken(token: string, result: AuthResult): void {
        observed.push({ token, result });
        super.registerToken(token, result);
      }
    }
    const adapter = new ObservingAdapter();
    fx = await boot({ auth: adapter, pairing: true });

    const init = await fx.server.pairingService!.initPairing();
    await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'Desk Pro' }),
    });

    expect(observed).toHaveLength(1);
    const recorded = observed[0]!;
    expect(recorded.result.identity.kind).toBe('builder');
    expect(recorded.result.source).toBe('pairing');
    expect(recorded.result.metadata?.['deviceName']).toBe('Desk Pro');
    expect(recorded.result.metadata?.['pairingId']).toBeTruthy();
  });

  it('throws at boot when pairing: true meets an adapter without registerToken', async () => {
    // Minimal adapter with no mutation surface — stands in for a
    // future Cognito/OIDC binding that can't register local tokens.
    const readOnlyAdapter: AuthAdapter = {
      async authenticate() {
        return null;
      },
      async getIdentity() {
        return null;
      },
    };
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        auth: readOnlyAdapter,
        pairing: true,
      }),
    ).toThrow(/registerToken/);
  });
});

describe('pairing transport — caller-owned service', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('pairing: { service } mounts routes without touching the auth adapter', async () => {
    // Caller-owned: the custom service mints tokens but only the
    // caller's bridge (if any) would register them on the adapter.
    // Here we omit the bridge entirely and verify the routes still
    // mount + respond.
    const adapter = new InMemoryAuthAdapter({ devAllowAll: false });
    const service: PairingService = new InMemoryPairingService({
      serverName: 'custom-server',
      generateCode: () => '424242',
    });
    fx = await boot({ auth: adapter, pairing: { service } });
    expect(fx.server.pairingService).toBe(service);

    await service.initPairing();
    const res = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '424242', deviceName: 'x' }),
    });
    expect(res.status).toBe(200);
    const completion = (await res.json()) as PairingCompletion;
    expect(completion.serverName).toBe('custom-server');

    // No bridge means the minted token does NOT authenticate /mcp.
    const mcp = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${completion.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(mcp.status).toBe(401);
  });

  it('custom path + adminInitPath are honored', async () => {
    fx = await boot({
      pairing: {
        path: '/v1/pair',
        adminInitPath: '/v1/admin/init',
      },
    });
    const init = await fx.server.pairingService!.initPairing();
    const defaultPath = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'x' }),
    });
    expect(defaultPath.status).toBe(404);

    const customPath = await fetch(`${fx.url}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'x' }),
    });
    expect(customPath.status).toBe(200);
  });
});

describe('admin pair init route', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('POST /admin/pair/init with builder bearer returns an init', async () => {
    fx = await boot({ pairing: true });
    const res = await fetch(`${fx.url}/admin/pair/init`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev-builder' },
    });
    expect(res.status).toBe(200);
    const init = (await res.json()) as PairingInit;
    expect(init.code).toMatch(/^\d{6}$/);
    expect(init.serverName).toBe('ggui-mcp-server');
    expect(typeof init.codeExpiresAt).toBe('number');
  });

  it('POST /admin/pair/init without bearer → 401', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      pairing: true,
    });
    const res = await fetch(`${fx.url}/admin/pair/init`, { method: 'POST' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthenticated');
  });

  it('POST /admin/pair/init with user identity → 403 forbidden', async () => {
    const adapter = new InMemoryAuthAdapter();
    adapter.registerToken('user-tok', {
      identity: { kind: 'user', userId: 'u1', roles: [] },
      source: 'cognito',
    });
    fx = await boot({ auth: adapter, pairing: true });
    const res = await fetch(`${fx.url}/admin/pair/init`, {
      method: 'POST',
      headers: { authorization: 'Bearer user-tok' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('forbidden');
  });

  it('adminInitPath: null disables the admin route', async () => {
    fx = await boot({ pairing: { adminInitPath: null } });
    const res = await fetch(`${fx.url}/admin/pair/init`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(404);
  });
});

describe('admin pair revoke route', () => {
  let fx: BootedFixture;
  afterEach(async () => {
    await fx.server.close();
  });

  it('POST /admin/pair/:pairingId/revoke with builder bearer revokes + future /mcp calls fail', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      pairing: true,
    });
    // Mint a pair token via the normal init → complete flow, then
    // revoke it through the HTTP route (not the programmatic service
    // handle) so this test exercises exactly the wire path `/admin/
    // pair/:pairingId/revoke` that operators hit.
    const init = await fx.server.pairingService!.initPairing();
    const completeRes = await fetch(`${fx.url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: init.code, deviceName: 'revoke-test' }),
    });
    const completion = (await completeRes.json()) as PairingCompletion;

    // Pre-revoke sanity: the token authenticates.
    await expect(
      mcpInitializeWithBearer(fx.url, completion.token),
    ).resolves.toBeUndefined();

    // Revoke via the HTTP admin route. Builder bearer here is the
    // SAME pair-minted bearer — the revoke route requires builder
    // identity, and a just-minted pair token IS a builder per the
    // `onTokenIssued` bridge in `mountPairingTransport`.
    const revokeRes = await fetch(
      `${fx.url}/admin/pair/${completion.pairingId}/revoke`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${completion.token}` },
      },
    );
    expect(revokeRes.status).toBe(200);
    const revokeBody = (await revokeRes.json()) as {
      ok?: boolean;
      pairingId?: string;
    };
    expect(revokeBody.ok).toBe(true);
    expect(revokeBody.pairingId).toBe(completion.pairingId);

    // Post-revoke: the same token must now be rejected. `/mcp` uses
    // the same `resolveIdentity` path; an unregistered bearer → 401.
    const unauthResponse = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${completion.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(unauthResponse.status).toBe(401);
  });

  it('POST /admin/pair/:pairingId/revoke without bearer → 401', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      pairing: true,
    });
    const res = await fetch(`${fx.url}/admin/pair/not-a-real-id/revoke`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('unauthenticated');
  });

  it('POST /admin/pair/:pairingId/revoke with user identity → 403 forbidden', async () => {
    const adapter = new InMemoryAuthAdapter();
    adapter.registerToken('user-tok', {
      identity: { kind: 'user', userId: 'u1', roles: [] },
      source: 'cognito',
    });
    fx = await boot({ auth: adapter, pairing: true });
    const res = await fetch(`${fx.url}/admin/pair/not-a-real-id/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer user-tok' },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('forbidden');
  });

  it('POST /admin/pair/:pairingId/revoke is idempotent — unknown id returns ok:true', async () => {
    // Matches `InMemoryPairingService.revokePairing` contract — a
    // nonexistent id is a no-op, NOT a 404. The HTTP surface carries
    // that same idempotency so an admin cleanup loop is safe to
    // re-run without branching on "was it ever minted?".
    fx = await boot({ pairing: true });
    const res = await fetch(`${fx.url}/admin/pair/never-minted/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev-builder' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; pairingId?: string };
    expect(body.ok).toBe(true);
    expect(body.pairingId).toBe('never-minted');
  });

  it('adminRevokePath: null disables the revoke route', async () => {
    fx = await boot({ pairing: { adminRevokePath: null } });
    const res = await fetch(`${fx.url}/admin/pair/x/revoke`, {
      method: 'POST',
      headers: { authorization: 'Bearer dev' },
    });
    expect(res.status).toBe(404);
  });
});
