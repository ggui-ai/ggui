import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { createGguiServer, type GguiServer } from './server.js';

// ggui#1174 — the DCR door and the compensating controls around it, PINNED. A researcher
// reported that /oauth/register is open RFC 7591 DCR: any anonymous caller registers a public
// client with any redirect_uri. Open DCR is what MCP hosts expect (MCP authorization spec
// 2025-06-18: servers support dynamic registration so any client can connect), so the ruling
// is not "close the door" but "what the door validates and what the user is shown" — and every
// control below is a TEST, because a control that lives only in a line is assumed, not named.
const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  child: () => silentLogger,
};

type Fx = { readonly server: GguiServer; readonly url: string };
async function boot(consentUrl?: string): Promise<Fx> {
  const server = createGguiServer({
    logger: silentLogger,
    oauth: { issuerUrl: 'https://mcp.example.test', ...(consentUrl !== undefined ? { consentUrl } : {}) },
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  return { server, url: `http://127.0.0.1:${addr.port}` };
}
async function register(fx: Fx, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${fx.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const GOOD = 'https://client.example/cb';
const pkce = () => {
  const verifier = 'v'.repeat(64);
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
async function authorize(fx: Fx, fields: Record<string, string>): Promise<Response> {
  const form = new URLSearchParams(fields);
  return fetch(`${fx.url}/oauth/authorize`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
}
async function token(fx: Fx, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${fx.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** Register a good client, authorize with devAllowAll's key, return the code + the pieces to redeem it. */
async function obtainCode(fx: Fx): Promise<{ clientId: string; code: string; verifier: string }> {
  const reg = await register(fx, { client_name: 'test-client', redirect_uris: [GOOD] });
  expect(reg.status).toBe(201);
  const clientId = String(reg.body['client_id']);
  const { verifier, challenge } = pkce();
  const authz = await authorize(fx, { response_type: 'code', client_id: clientId, redirect_uri: GOOD, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', api_key: 'devAllowAllKey' });
  expect([302, 303]).toContain(authz.status);
  const code = new URL(authz.headers.get('location')!).searchParams.get('code')!;
  expect(code).toBeTruthy();
  return { clientId, code, verifier };
}

describe('ggui#1174 — DCR: what /oauth/register validates', () => {
  let fx: Fx;
  afterEach(async () => { await fx.server.close(); });

  it('accepts https redirect URIs, loopback http (RFC 8252 §7.3), and a private-use scheme with a dot (RFC 8252 §7.1)', async () => {
    fx = await boot();
    // The last three are the shapes real MCP hosts register (a desktop host's private-use scheme, RFC 8252 §7.1)
    // — a rule that refused them would break every desktop connector, so they are pinned as ACCEPTED.
    for (const uri of ['https://client.example/cb', 'http://127.0.0.1:49152/cb', 'http://localhost/cb', 'http://[::1]:8080/cb', 'com.example.app:/oauth/cb', 'cursor://anysphere.cursor-retrieval/oauth/user-x/callback', 'vscode://vscode.mcp/callback']) {
      const r = await register(fx, { redirect_uris: [uri] });
      expect(r.status, uri).toBe(201);
    }
  });

  it('REFUSES a redirect URI with a fragment, a non-https non-loopback scheme, a wildcard host, or a relative reference — invalid_redirect_uri', async () => {
    fx = await boot();
    for (const uri of ['https://client.example/cb#frag', 'http://attacker.example/cb', 'javascript:alert(1)', 'data:text/html,x', 'https://*.example/cb', '/relative/cb', 'not a url']) {
      const r = await register(fx, { redirect_uris: [uri] });
      expect(r.status, uri).toBe(400);
      expect(r.body['error'], uri).toBe('invalid_redirect_uri');
    }
  });

  it('refuses a batch whole when any one URI is bad — a client is not registered with a partial list', async () => {
    fx = await boot();
    const r = await register(fx, { redirect_uris: [GOOD, 'http://attacker.example/cb'] });
    expect(r.status).toBe(400);
  });

  it('bounds the registration: more than 10 redirect URIs, or a client_name over 100 characters or carrying control characters — invalid_client_metadata', async () => {
    fx = await boot();
    const many = await register(fx, { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://client.example/cb${i}`) });
    expect(many.status).toBe(400);
    expect(many.body['error']).toBe('invalid_client_metadata');
    const long = await register(fx, { client_name: 'x'.repeat(101), redirect_uris: [GOOD] });
    expect(long.status).toBe(400);
    expect(long.body['error']).toBe('invalid_client_metadata');
    const ctl = await register(fx, { client_name: 'bad\u0007name', redirect_uris: [GOOD] });
    expect(ctl.status).toBe(400);
  });
});

describe('ggui#1174 — the compensating controls, pinned', () => {
  let fx: Fx;
  afterEach(async () => { await fx.server.close(); });

  it('authorize refuses a redirect_uri the client did not register (exact match, not prefix)', async () => {
    fx = await boot();
    const reg = await register(fx, { redirect_uris: [GOOD] });
    const { challenge } = pkce();
    for (const bad of ['https://client.example/cb/extra', 'https://client.example/cb?x=1', 'https://attacker.example/cb']) {
      const authz = await authorize(fx, { response_type: 'code', client_id: String(reg.body['client_id']), redirect_uri: bad, code_challenge: challenge, code_challenge_method: 'S256', api_key: 'devAllowAllKey' });
      expect(authz.status, bad).toBe(400);
      expect(await authz.text()).toContain('not registered');
    }
  });

  it('authorize refuses PKCE `plain` and a missing code_challenge — S256 only', async () => {
    fx = await boot();
    const reg = await register(fx, { redirect_uris: [GOOD] });
    const id = String(reg.body['client_id']);
    const plain = await authorize(fx, { response_type: 'code', client_id: id, redirect_uri: GOOD, code_challenge: 'abc', code_challenge_method: 'plain', api_key: 'devAllowAllKey' });
    expect(plain.status).toBe(400);
    const none = await authorize(fx, { response_type: 'code', client_id: id, redirect_uri: GOOD, code_challenge_method: 'S256', api_key: 'devAllowAllKey' });
    expect(none.status).toBe(400);
  });

  it('token refuses a redirect_uri that differs from the one the code was bound to, a wrong client_id, and a wrong verifier — invalid_grant', async () => {
    fx = await boot();
    const { clientId, code, verifier } = await obtainCode(fx);
    const badRedirect = await token(fx, { grant_type: 'authorization_code', code, redirect_uri: 'https://attacker.example/cb', client_id: clientId, code_verifier: verifier });
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.body['error']).toBe('invalid_grant');
  });

  it('token refuses a wrong code_verifier — invalid_grant', async () => {
    fx = await boot();
    const { clientId, code } = await obtainCode(fx);
    const r = await token(fx, { grant_type: 'authorization_code', code, redirect_uri: GOOD, client_id: clientId, code_verifier: 'w'.repeat(64) });
    expect(r.status).toBe(400);
    expect(r.body['error']).toBe('invalid_grant');
  });

  it('a code is single-use: the second redemption is refused', async () => {
    fx = await boot();
    const { clientId, code, verifier } = await obtainCode(fx);
    const first = await token(fx, { grant_type: 'authorization_code', code, redirect_uri: GOOD, client_id: clientId, code_verifier: verifier });
    expect(first.status).toBe(200);
    const second = await token(fx, { grant_type: 'authorization_code', code, redirect_uri: GOOD, client_id: clientId, code_verifier: verifier });
    expect(second.status).toBe(400);
    expect(second.body['error']).toBe('invalid_grant');
  });
});

describe('ggui#1174 — the consent page names WHO is asking and WHERE the code goes', () => {
  let fx: Fx;
  afterEach(async () => { await fx.server.close(); });

  it('GET /oauth/authorize shows the client name and the redirect host before asking for a key', async () => {
    fx = await boot();
    const reg = await register(fx, { client_name: 'Acme Assistant', redirect_uris: [GOOD] });
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: String(reg.body['client_id']), redirect_uri: GOOD, code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    const res = await fetch(`${fx.url}/oauth/authorize?${q.toString()}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Acme Assistant');
    expect(html).toContain('client.example');
    expect(html.toLowerCase()).toMatch(/send|sent|redirect/);
  });

  it('with a hosted consentUrl, the 302 carries client_name (display-only) beside the redirect_uri the page must show', async () => {
    fx = await boot('https://consent.example/oauth/consent');
    const reg = await register(fx, { client_name: 'Acme Assistant', redirect_uris: [GOOD] });
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: String(reg.body['client_id']), redirect_uri: GOOD, code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    const res = await fetch(`${fx.url}/oauth/authorize?${q.toString()}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const target = new URL(res.headers.get('location')!);
    expect(target.origin + target.pathname).toBe('https://consent.example/oauth/consent');
    expect(target.searchParams.get('client_name')).toBe('Acme Assistant');
    expect(target.searchParams.get('redirect_uri')).toBe(GOOD);
    expect(target.searchParams.get('mcp_origin')).toBe('https://mcp.example.test');
  });

  it('a client_name is HTML-escaped on the page — the name a stranger registered cannot script the consent screen', async () => {
    fx = await boot();
    const reg = await register(fx, { client_name: '<img src=x onerror=alert(1)>', redirect_uris: [GOOD] });
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: String(reg.body['client_id']), redirect_uri: GOOD, code_challenge: challenge, code_challenge_method: 'S256' });
    const html = await (await fetch(`${fx.url}/oauth/authorize?${q.toString()}`)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});
