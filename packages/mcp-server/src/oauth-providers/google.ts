/**
 * Google OAuth login provider — `OAuthLoginProvider` impl for
 * `accounts.google.com` + `oauth2.googleapis.com`. Subject from the
 * `id_token` JWT payload (TLS-trusted, signature validation skipped
 * per Google's docs since the token came over TLS direct from the
 * token endpoint).
 */
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  OAuthExchangeResult,
  OAuthLoginProvider,
} from '../oauth-login-types.js';

const DEFAULT_SCOPES: ReadonlyArray<string> = ['openid', 'email', 'profile'];
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleLoginProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Override scope list. Default: ['openid', 'email', 'profile']. */
  readonly scopes?: ReadonlyArray<string>;
  /** Test seam: override fetch (default: globalThis.fetch). Mock in tests. */
  readonly fetch?: typeof fetch;
}

interface GoogleTokenResponse {
  readonly id_token: string;
  readonly access_token: string;
}

interface GoogleIdTokenPayload {
  readonly sub: string;
  readonly email?: string;
  readonly name?: string;
}

export function googleLoginProvider(
  opts: GoogleLoginProviderOptions,
): OAuthLoginProvider {
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  return {
    providerId: 'google',
    displayName: 'Google',

    authorizeUrl(input: AuthorizeUrlInput): string {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId,
        redirect_uri: input.redirectUri,
        scope: scopes.join(' '),
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
        access_type: 'online',
        prompt: 'consent',
      });
      return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
    },

    async exchangeCode(input: ExchangeCodeInput): Promise<OAuthExchangeResult> {
      const body = new URLSearchParams({
        code: input.code,
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.codeVerifier,
      });
      const res = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `google_token_exchange_failed: ${res.status} ${text.slice(0, 200)}`,
        );
      }
      const tokens = (await res.json()) as GoogleTokenResponse;
      const payload = decodeIdTokenPayload(tokens.id_token);
      return {
        providerSubject: payload.sub,
        email: payload.email,
        displayName: payload.name,
      };
    },
  };
}

function decodeIdTokenPayload(idToken: string): GoogleIdTokenPayload {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('google_id_token_malformed');
  }
  const json = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  return JSON.parse(json) as GoogleIdTokenPayload;
}
