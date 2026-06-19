import { describe, expect, it } from 'vitest';
import {
  OidcJwtAuthAdapter,
  type TrustedIssuerRow,
} from './oidc-jwt-auth-adapter.js';
import { authAdapterContract } from './contract-tests/auth-adapter.js';

const ISS = 'https://id.guuey.com';
const AUD = 'https://mcp.ggui.ai/apps/app_123';
const AUD_PATTERN = /^https:\/\/mcp\.ggui\.ai\/apps\/([A-Za-z0-9_-]+)$/;

// base64url an unsigned JWT so the adapter can read the *unverified* iss
// for verifier selection. The mock verifier ignores the signature.
function unsignedJwt(payload: object): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(payload)}.sig`;
}

function rowWithVerifier(
  verify: (t: string) => Promise<unknown>,
): TrustedIssuerRow {
  return {
    providerId: 'guuey',
    issuer: ISS,
    audiencePattern: AUD_PATTERN,
    verifier: { verify },
  };
}

describe('OidcJwtAuthAdapter', () => {
  it('verifies, namespaces the subject, stamps appId from aud, source=oidc', async () => {
    const a = new OidcJwtAuthAdapter([
      rowWithVerifier(async () => ({ iss: ISS, sub: 'g_abc', aud: AUD })),
    ]);
    const res = await a.authenticate(unsignedJwt({ iss: ISS, sub: 'g_abc', aud: AUD }));
    expect(res).not.toBeNull();
    expect(res?.identity.kind).toBe('user');
    expect(res?.source).toBe('oidc');
    if (res?.identity.kind === 'user') {
      expect(res.identity.userId).toBe('guuey:g_abc'); // composeOAuthUserId
      expect(res.identity.appId).toBe('app_123'); // extracted from aud
      expect(res.identity.roles).toEqual([]); // fixed minimal
    }
    expect(res?.metadata).toMatchObject({ iss: ISS, sub: 'g_abc' });
  });

  it('returns null when the verifier throws (bad sig/expiry collapse to null)', async () => {
    const a = new OidcJwtAuthAdapter([
      rowWithVerifier(async () => {
        throw new Error('expired');
      }),
    ]);
    expect(await a.authenticate(unsignedJwt({ iss: ISS, sub: 'x', aud: AUD }))).toBeNull();
  });

  it('returns null when iss matches no registry row', async () => {
    const a = new OidcJwtAuthAdapter([rowWithVerifier(async () => ({}))]);
    expect(
      await a.authenticate(unsignedJwt({ iss: 'https://evil.test', sub: 'x', aud: AUD })),
    ).toBeNull();
  });

  it('returns null when the verified iss != the selected row issuer (defense)', async () => {
    const a = new OidcJwtAuthAdapter([
      rowWithVerifier(async () => ({ iss: 'https://evil.test', sub: 'x', aud: AUD })),
    ]);
    expect(await a.authenticate(unsignedJwt({ iss: ISS, sub: 'x', aud: AUD }))).toBeNull();
  });

  it('returns null when aud fails the row pattern', async () => {
    const a = new OidcJwtAuthAdapter([
      rowWithVerifier(async () => ({ iss: ISS, sub: 'x', aud: 'https://evil.test/apps/app_1' })),
    ]);
    expect(
      await a.authenticate(unsignedJwt({ iss: ISS, sub: 'x', aud: 'https://evil.test/apps/app_1' })),
    ).toBeNull();
  });

  it('returns null on an unparseable token (no decodable iss)', async () => {
    const a = new OidcJwtAuthAdapter([rowWithVerifier(async () => ({}))]);
    expect(await a.authenticate('not.a.jwt')).toBeNull();
    expect(await a.authenticate('')).toBeNull();
  });

  it('getIdentity reads Bearer and delegates', async () => {
    const a = new OidcJwtAuthAdapter([
      rowWithVerifier(async () => ({ iss: ISS, sub: 'g_abc', aud: AUD })),
    ]);
    const tok = unsignedJwt({ iss: ISS, sub: 'g_abc', aud: AUD });
    const res = await a.getIdentity({ headers: { authorization: `Bearer ${tok}` } });
    expect(res?.identity.kind).toBe('user');
    expect(await a.getIdentity({ headers: { authorization: 'Basic abc' } })).toBeNull();
  });

  it('a row with jwksUrl but no injected factory/verifier → null (verifier_unavailable, fail-closed)', async () => {
    // No `buildVerifier` factory and no per-row `verifier`: getVerifier returns
    // null → the adapter rejects (verifier_unavailable). Fail-closed, never crash.
    const a = new OidcJwtAuthAdapter([
      {
        providerId: 'guuey',
        issuer: 'https://id.guuey.com',
        audiencePattern: /^https:\/\/mcp\.ggui\.ai\/apps\/([A-Za-z0-9_-]+)$/,
        jwksUrl: 'https://id.guuey.com/.well-known/jwks.json',
        alg: ['RS256'],
      },
    ]);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tok = `${b64({ alg: 'RS256' })}.${b64({ iss: 'https://id.guuey.com', sub: 'x', aud: 'https://mcp.ggui.ai/apps/a' })}.sig`;
    // No verifier can be resolved (no factory, no row.verifier) → null, no throw.
    await expect(a.authenticate(tok)).resolves.toBeNull();
  });
});

describe('OidcJwtAuthAdapter — adversarial', () => {
  const row = (verify: (t: string) => Promise<unknown>) => ({
    providerId: 'guuey',
    issuer: ISS,
    audiencePattern: AUD_PATTERN,
    verifier: { verify },
  });

  it('rejects an aud array with >1 entry (not a single resource indicator)', async () => {
    const a = new OidcJwtAuthAdapter([
      row(async () => ({ iss: ISS, sub: 'x', aud: [AUD, 'https://mcp.ggui.ai/apps/other'] })),
    ]);
    expect(await a.authenticate(unsignedJwt({ iss: ISS, sub: 'x', aud: [AUD, 'x'] }))).toBeNull();
  });

  it('rejects a token whose unverified iss is a substring/lookalike of a trusted iss', async () => {
    const a = new OidcJwtAuthAdapter([row(async () => ({ iss: ISS, sub: 'x', aud: AUD }))]);
    expect(
      await a.authenticate(
        unsignedJwt({ iss: 'https://id.guuey.com.evil.test', sub: 'x', aud: AUD }),
      ),
    ).toBeNull();
  });

  it('does not read roles/workspaceId from token claims', async () => {
    const a = new OidcJwtAuthAdapter([
      row(async () => ({ iss: ISS, sub: 'x', aud: AUD, roles: ['ops'], workspaceId: 'w' })),
    ]);
    const res = await a.authenticate(unsignedJwt({ iss: ISS, sub: 'x', aud: AUD }));
    if (res?.identity.kind === 'user') {
      expect(res.identity.roles).toEqual([]);
      expect(res.identity.workspaceId).toBeUndefined();
    }
  });
});

// Seam conformance (no seeder — OIDC can't register ad-hoc tokens).
authAdapterContract(
  'OidcJwtAuthAdapter',
  () =>
    new OidcJwtAuthAdapter([
      {
        providerId: 'guuey',
        issuer: ISS,
        audiencePattern: AUD_PATTERN,
        verifier: {
          verify: async () => {
            throw new Error('no');
          },
        },
      },
    ]),
);
