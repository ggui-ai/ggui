/**
 * Tier 2 OAuth flow: prove the simulator drives an OSS server through
 * the full RFC discovery + DCR + PKCE + code-grant chain that real
 * MCP-Apps hosts run when they hit a 401.
 *
 * What this asserts:
 *   1. RFC 9728 protected-resource doc → carries an `authorization_servers`
 *      pointer the host can chain to RFC 8414 metadata.
 *   2. RFC 8414 AS metadata → all 4 endpoints (authorize / token /
 *      register) + S256 PKCE support.
 *   3. RFC 7591 DCR → server issues `client_id` + echoes redirect_uris.
 *   4. PKCE happy path → access_token comes back equal to the paste-key
 *      (devAllowAll path).
 *   5. RFC 8707 §2.2 → matching `resource` on /authorize + /token
 *      succeeds; mismatched resource on /token rejects with
 *      `invalid_target` (the canonical error code).
 *
 * If any of these break, real claude.ai can't connect. The earlier
 * `server.test.ts:436` battery already covers the server side; this
 * suite covers the simulator's accuracy in driving it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  OAuthFlowSimulator,
  bootOssServer,
  generatePkcePair,
  type OssFixture,
} from '../src/index.js';

describe('host-simulator: OAuth flow', () => {
  let fixture: OssFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
  });

  it('generates a valid PKCE pair', () => {
    const pkce = generatePkcePair();
    // base64url charset, 43-char canonical length for 32-byte input.
    expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(pkce.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.codeChallengeMethod).toBe('S256');
    // Each call returns a fresh pair.
    const second = generatePkcePair();
    expect(second.codeVerifier).not.toBe(pkce.codeVerifier);
  });

  it('discovers the RFC 9728 protected-resource doc', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    const pr = await flow.discoverProtectedResource();
    expect(pr.resource).toMatch(/\/mcp$/);
    expect(pr.authorization_servers).toHaveLength(1);
    expect(pr.authorization_servers[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('discovers the RFC 8414 authorization-server metadata', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    const meta = await flow.discoverAuthorizationServer();
    expect(meta.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(meta.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(meta.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(meta.code_challenge_methods_supported).toContain('S256');
    expect(meta.grant_types_supported).toContain('authorization_code');
    expect(meta.response_types_supported).toContain('code');
    expect(meta.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('runs the full happy-path flow → access_token returned', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    const result = await flow.runFullFlow({
      apiKey: 'devAllowAllKey',
      state: 'opaque-test-state',
    });
    // OSS devAllowAll passes through the apiKey as the access_token.
    expect(result.accessToken).toBe('devAllowAllKey');
    expect(result.clientId).toMatch(/^mcp_client_/);
    expect(result.state).toBe('opaque-test-state');
    expect(result.pkce.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });

  it('DCR registers a client and echoes redirect_uris + client_name', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    const dcr = await flow.register({
      clientName: 'simulator-test-client',
      redirectUris: ['https://client.example/cb'],
    });
    expect(dcr.client_id).toMatch(/^mcp_client_/);
    expect(dcr.redirect_uris).toEqual(['https://client.example/cb']);
    expect(dcr.client_name).toBe('simulator-test-client');
    expect(dcr.token_endpoint_auth_method).toBe('none');
  });

  it('RFC 8707: matching resource on /authorize + /token succeeds', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    // The PR doc tells us what the canonical resource URI is.
    const pr = await flow.discoverProtectedResource();
    const result = await flow.runFullFlow({
      apiKey: 'devAllowAllKey',
      resource: pr.resource,
    });
    expect(result.accessToken).toBe('devAllowAllKey');
  });

  it('RFC 8707: mismatched resource on /token rejects with invalid_target', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    const pr = await flow.discoverProtectedResource();

    // Manually run the steps so we can vary the /token resource
    // independent of the /authorize one.
    const dcr = await flow.register({
      redirectUris: ['https://client.example/cb'],
    });
    const pkce = generatePkcePair();
    const authz = await flow.submitAuthorize({
      clientId: dcr.client_id,
      redirectUri: 'https://client.example/cb',
      codeVerifier: pkce.codeVerifier,
      codeChallenge: pkce.codeChallenge,
      resource: pr.resource,
      apiKey: 'devAllowAllKey',
    });
    expect('code' in authz, 'authorize must succeed').toBe(true);
    const code = (authz as { code: string }).code;

    // Drift the /token resource — server MUST reject with
    // invalid_target per RFC 8707 §2.
    await expect(
      flow.exchangeToken({
        code,
        codeVerifier: pkce.codeVerifier,
        clientId: dcr.client_id,
        redirectUri: 'https://client.example/cb',
        resource: 'https://wrong.example/mcp',
      }),
    ).rejects.toThrow(/invalid_target/);
  });

  it('PKCE mismatch on /token rejects with invalid_grant', async () => {
    fixture = await bootOssServer({ oauth: {} });
    const flow = new OAuthFlowSimulator({ url: fixture.url });
    const dcr = await flow.register({
      redirectUris: ['https://client.example/cb'],
    });
    const pkce = generatePkcePair();
    const authz = await flow.submitAuthorize({
      clientId: dcr.client_id,
      redirectUri: 'https://client.example/cb',
      codeVerifier: pkce.codeVerifier,
      codeChallenge: pkce.codeChallenge,
      apiKey: 'devAllowAllKey',
    });
    expect('code' in authz).toBe(true);
    const code = (authz as { code: string }).code;

    // Send a different verifier — server hashes + compares, mismatch → 400.
    const otherVerifier = generatePkcePair().codeVerifier;
    await expect(
      flow.exchangeToken({
        code,
        codeVerifier: otherVerifier,
        clientId: dcr.client_id,
        redirectUri: 'https://client.example/cb',
      }),
    ).rejects.toThrow(/invalid_grant|PKCE/i);
  });
});
