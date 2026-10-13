/**
 * ggui#1865 — a store that cannot record an authorize fails the authorize
 * CLOSED. The client stamp (`lastAuthorizeAt` / `lastResource`) is written
 * before any code is minted; if the store throws, no code is stored and the
 * user gets an error page, never a code that works now and whose client lapses
 * later. And a store that throws anywhere else on the OAuth routes yields a
 * defined error response, not a request left hanging.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createGguiServer, type GguiServer } from './server.js';
import { InMemoryOAuthStorage, type AuthCodeRecord, type ClientRecord, type OAuthStorage } from './oauth.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, child: () => silentLogger };

/** The reference store, with switches that make one operation throw, and a record of the codes it stored. */
class SwitchableStorage implements OAuthStorage {
  readonly inner = new InMemoryOAuthStorage();
  readonly storedCodes: AuthCodeRecord[] = [];
  putClientFails = false;
  getClientFails = false;
  async putAuthCode(record: AuthCodeRecord): Promise<void> {
    this.storedCodes.push(record);
    return this.inner.putAuthCode(record);
  }
  consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    return this.inner.consumeAuthCode(code);
  }
  async putClient(record: ClientRecord): Promise<void> {
    if (this.putClientFails) throw new Error('store unavailable');
    return this.inner.putClient(record);
  }
  async getClient(clientId: string): Promise<ClientRecord | null> {
    if (this.getClientFails) throw new Error('store unavailable');
    return this.inner.getClient(clientId);
  }
  listClients(): Promise<readonly ClientRecord[]> {
    return this.inner.listClients();
  }
  deleteClient(clientId: string): Promise<void> {
    return this.inner.deleteClient(clientId);
  }
}

const GOOD = 'https://client.example/cb';
const challenge = createHash('sha256').update('v'.repeat(64)).digest('base64url');

let server: GguiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(storage: OAuthStorage): Promise<string> {
  server = createGguiServer({ logger: silentLogger, oauth: { issuerUrl: 'https://mcp.example.test', storage } });
  const http = await server.listen(0, '127.0.0.1');
  const addr = http.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return `http://127.0.0.1:${addr.port}`;
}

async function registerClient(url: string): Promise<string> {
  const res = await fetch(`${url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [GOOD] }) });
  expect(res.status).toBe(201);
  return String(((await res.json()) as Record<string, unknown>)['client_id']);
}

function authorize(url: string, clientId: string): Promise<Response> {
  const form = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: GOOD, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', api_key: 'devAllowAllKey', resource: 'https://mcp.example.test/mcp' });
  return fetch(`${url}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
}

describe('authorize records the client before it mints a code (ggui#1865)', () => {
  it('a store that cannot record the authorize: error page, no code stored, no redirect', async () => {
    const storage = new SwitchableStorage();
    const url = await boot(storage);
    const clientId = await registerClient(url);
    storage.putClientFails = true;
    const res = await authorize(url, clientId);
    expect(res.status).toBe(503);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('could not be recorded');
    expect(storage.storedCodes).toEqual([]);
  });

  it('a store that records it: the client carries the stamp, and a code is issued', async () => {
    const storage = new SwitchableStorage();
    const url = await boot(storage);
    const clientId = await registerClient(url);
    const before = Date.now();
    const res = await authorize(url, clientId);
    expect([302, 303]).toContain(res.status);
    expect(new URL(res.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    const client = await storage.inner.getClient(clientId);
    expect(client?.lastAuthorizeAt).toBeGreaterThanOrEqual(before);
    expect(client?.lastResource).toBe('https://mcp.example.test/mcp');
    expect(storage.storedCodes).toHaveLength(1);
  });
});

describe('a store that throws on the OAuth routes yields a defined error, not a hung request and not the error itself (ggui#1865)', () => {
  it('authorize (its validating read): 500 with the generic page; the store\'s message never reaches the browser', async () => {
    const storage = new SwitchableStorage();
    const url = await boot(storage);
    const clientId = await registerClient(url);
    storage.getClientFails = true;
    const res = await fetch(`${url}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: GOOD, code_challenge: challenge, code_challenge_method: 'S256' })}`, { signal: AbortSignal.timeout(5_000), redirect: 'manual' });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('Something went wrong on the server');
    expect(body).not.toContain('store unavailable');
  });

  it('register: 500 with server_error JSON, and no error text', async () => {
    const storage = new SwitchableStorage();
    const url = await boot(storage);
    storage.putClientFails = true;
    const res = await fetch(`${url}/oauth/register`, { signal: AbortSignal.timeout(5_000), method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [GOOD] }) });
    expect(res.status).toBe(500);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['error']).toBe('server_error');
    expect(JSON.stringify(body)).not.toContain('store unavailable');
  });
});
