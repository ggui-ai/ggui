/**
 * GitHub OAuth login provider — `OAuthLoginProvider` impl for
 * `github.com` + `api.github.com`. Numeric `id` stringified for
 * `providerSubject`; falls back to `/user/emails` if `/user` returns
 * a null email and `user:email` is in scope.
 */
import type {
  AuthorizeUrlInput,
  ExchangeCodeInput,
  OAuthExchangeResult,
  OAuthLoginProvider,
} from '../oauth-login-types.js';

const DEFAULT_SCOPES: ReadonlyArray<string> = ['read:user', 'user:email'];
const AUTHORIZE_ENDPOINT = 'https://github.com/login/oauth/authorize';
const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const USER_ENDPOINT = 'https://api.github.com/user';
const USER_EMAILS_ENDPOINT = 'https://api.github.com/user/emails';
const USER_AGENT = 'ggui-oss-server';

export interface GithubLoginProviderOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Override scope list. Default: ['read:user', 'user:email']. */
  readonly scopes?: ReadonlyArray<string>;
  /** Test seam: override fetch (default: globalThis.fetch). Mock in tests. */
  readonly fetch?: typeof fetch;
}

interface GithubTokenResponse {
  readonly access_token?: string;
}

interface GithubUserResponse {
  readonly id: number;
  readonly login: string;
  readonly name?: string | null;
  readonly email?: string | null;
}

interface GithubEmailEntry {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

export function githubLoginProvider(
  opts: GithubLoginProviderOptions,
): OAuthLoginProvider {
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  return {
    providerId: 'github',
    displayName: 'GitHub',

    authorizeUrl(input: AuthorizeUrlInput): string {
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: opts.clientId,
        redirect_uri: input.redirectUri,
        scope: scopes.join(' '),
        state: input.state,
        code_challenge: input.codeChallenge,
        code_challenge_method: 'S256',
      });
      return `${AUTHORIZE_ENDPOINT}?${params.toString()}`;
    },

    async exchangeCode(input: ExchangeCodeInput): Promise<OAuthExchangeResult> {
      const tokenBody = new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      });
      const tokenRes = await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: tokenBody.toString(),
      });
      if (!tokenRes.ok) {
        const text = await tokenRes.text();
        throw new Error(
          `github_token_exchange_failed: ${tokenRes.status} ${text.slice(0, 200)}`,
        );
      }
      const tokenJson = (await tokenRes.json()) as GithubTokenResponse;
      const accessToken = tokenJson.access_token;
      if (!accessToken) {
        throw new Error('github_token_exchange_missing_access_token');
      }

      const userRes = await fetchImpl(USER_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': USER_AGENT,
        },
      });
      if (!userRes.ok) {
        const text = await userRes.text();
        throw new Error(
          `github_user_fetch_failed: ${userRes.status} ${text.slice(0, 200)}`,
        );
      }
      const user = (await userRes.json()) as GithubUserResponse;

      let email = user.email ?? undefined;
      if (!email && scopes.includes('user:email')) {
        email = await fetchPrimaryVerifiedEmail(fetchImpl, accessToken);
      }

      return {
        providerSubject: String(user.id),
        email,
        displayName: user.name ?? user.login,
      };
    },
  };
}

async function fetchPrimaryVerifiedEmail(
  fetchImpl: typeof fetch,
  accessToken: string,
): Promise<string | undefined> {
  const res = await fetchImpl(USER_EMAILS_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `github_user_emails_fetch_failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const entries = (await res.json()) as ReadonlyArray<GithubEmailEntry>;
  const primary = entries.find((e) => e.primary && e.verified);
  return primary?.email;
}
