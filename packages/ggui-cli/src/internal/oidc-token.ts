/**
 * OIDC token resolution chain for sigstore signing.
 *
 * Public-gadget publishing signs with sigstore's keyless flow — Fulcio
 * exchanges a short-lived OIDC identity-token for an ephemeral signing
 * cert, then Rekor anchors the resulting signature in the transparency
 * log. The CLI's job is to *get an OIDC token* from one of four sources;
 * the actual sign call lives behind `signBundleSigstore` (gadget-signing).
 *
 * Precedence (highest first):
 *
 *   1. `--identity-token <jwt>` flag (matches cosign convention).
 *   2. `GGUI_OIDC_TOKEN` env var.
 *   3. GitHub Actions ambient OIDC — when `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
 *      + `ACTIONS_ID_TOKEN_REQUEST_URL` are present, GET the token from
 *      the request URL with the request token as bearer + `audience=sigstore`.
 *   4. Interactive browser flow — only when stdout is a TTY. Prints a
 *      sigstore-issuer URL, listens on `127.0.0.1:<rand>`, waits for the
 *      OAuth redirect carrying the access_token. If we can't bind a
 *      local port we fall back to asking the user to paste the token
 *      manually.
 *
 * If none of the four work → throws with a clear error directing the
 * operator at the available knobs.
 *
 * **Tests.** The resolver is fully dependency-injectable: the env-var
 * shape, TTY-ness, and (for the GH Actions branch) the fetch function
 * are passed in. Interactive flow has a short-circuit (`interactive: false`)
 * the tests use to avoid spinning up a real OAuth listener.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface OidcResolveOptions {
  /** `--identity-token <jwt>` flag value (cosign convention). */
  readonly identityTokenFlag?: string;
  /** Environment snapshot — keeps the resolver pure for tests. */
  readonly env: NodeJS.ProcessEnv;
  /** Is stdout attached to a TTY? Gates the interactive browser flow. */
  readonly isTty: boolean;
  /**
   * Override the issuer for the interactive flow. Default:
   * `https://oauth2.sigstore.dev/auth`.
   */
  readonly issuer?: string;
  /**
   * Test seam: when `false`, skip the interactive flow entirely + throw
   * `no_token_available` instead. Production callers leave it `true`
   * (or omit it).
   */
  readonly interactive?: boolean;
  /** Test seam: inject `fetch`. Production = `globalThis.fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam: write status lines. Production = `process.stdout.write`. */
  readonly stdout?: (line: string) => void;
  /**
   * Test seam: ask the operator for a value (used by the non-TTY
   * fallback inside the interactive branch). Production = stdin prompt.
   */
  readonly prompt?: (label: string) => Promise<string>;
  /**
   * Test seam: open the issuer URL in the operator's browser. Production
   * prints the URL + relies on the user clicking it. The `open` package
   * isn't a workspace dep yet, so the default impl just prints — this
   * seam lets tests + future wiring swap it.
   */
  readonly openBrowser?: (url: string) => Promise<void>;
}

export interface OidcResolveResult {
  /** The resolved OIDC token (JWT). */
  readonly token: string;
  /** Where the token came from. */
  readonly source: 'flag' | 'env' | 'github-actions' | 'interactive';
}

/**
 * Sentinel error thrown when no OIDC source produces a usable token.
 * Carries a `code` discriminant so callers can map back into a
 * structured `PublishError`.
 */
export class OidcResolutionError extends Error {
  readonly code:
    | 'no_token_available'
    | 'github_actions_fetch_failed'
    | 'interactive_failed';
  constructor(
    code:
      | 'no_token_available'
      | 'github_actions_fetch_failed'
      | 'interactive_failed',
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = 'OidcResolutionError';
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Default sigstore public-good issuer. Matches cosign's default. */
const DEFAULT_ISSUER = 'https://oauth2.sigstore.dev/auth';
/** Public OAuth client id for the sigstore public-good issuer. */
const SIGSTORE_OAUTH_CLIENT_ID = 'sigstore';

export async function resolveOidcToken(
  opts: OidcResolveOptions,
): Promise<OidcResolveResult> {
  // 1. --identity-token flag (highest precedence).
  if (opts.identityTokenFlag && opts.identityTokenFlag.length > 0) {
    return { token: opts.identityTokenFlag, source: 'flag' };
  }

  // 2. GGUI_OIDC_TOKEN env var.
  const envToken = opts.env['GGUI_OIDC_TOKEN'];
  if (typeof envToken === 'string' && envToken.length > 0) {
    return { token: envToken, source: 'env' };
  }

  // 3. GitHub Actions ambient OIDC.
  const ghRequestToken = opts.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  const ghRequestUrl = opts.env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  if (
    typeof ghRequestToken === 'string' &&
    ghRequestToken.length > 0 &&
    typeof ghRequestUrl === 'string' &&
    ghRequestUrl.length > 0
  ) {
    const token = await fetchGitHubActionsToken({
      requestToken: ghRequestToken,
      requestUrl: ghRequestUrl,
      fetchImpl: opts.fetch ?? globalThis.fetch.bind(globalThis),
    });
    return { token, source: 'github-actions' };
  }

  // 4. Interactive browser flow — TTY-gated.
  if (opts.isTty && opts.interactive !== false) {
    const token = await runInteractiveFlow({
      issuer: opts.issuer ?? DEFAULT_ISSUER,
      stdout: opts.stdout ?? ((s) => void process.stdout.write(s)),
      prompt: opts.prompt,
      openBrowser: opts.openBrowser,
    });
    return { token, source: 'interactive' };
  }

  throw new OidcResolutionError(
    'no_token_available',
    'no OIDC token available. Provide one of:\n' +
      '  --identity-token <jwt>\n' +
      '  GGUI_OIDC_TOKEN env var\n' +
      '  ACTIONS_ID_TOKEN_REQUEST_TOKEN + ACTIONS_ID_TOKEN_REQUEST_URL (GitHub Actions)\n' +
      '  run from a TTY for the interactive browser flow',
  );
}

// ---------------------------------------------------------------------------
// GitHub Actions ambient OIDC
//
// Standard pattern from the actions/toolkit docs:
//   GET <ACTIONS_ID_TOKEN_REQUEST_URL>&audience=sigstore
//   Authorization: bearer <ACTIONS_ID_TOKEN_REQUEST_TOKEN>
//   → { value: "<jwt>" }
// ---------------------------------------------------------------------------

async function fetchGitHubActionsToken(opts: {
  readonly requestToken: string;
  readonly requestUrl: string;
  readonly fetchImpl: typeof fetch;
}): Promise<string> {
  // Audience query parameter — sigstore's Fulcio expects `sigstore`.
  const url = appendAudience(opts.requestUrl, 'sigstore');
  let res: Response;
  try {
    res = await opts.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `bearer ${opts.requestToken}`,
        Accept: 'application/json; api-version=2.0',
      },
    });
  } catch (err) {
    throw new OidcResolutionError(
      'github_actions_fetch_failed',
      `GitHub Actions OIDC fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      // ignore
    }
    throw new OidcResolutionError(
      'github_actions_fetch_failed',
      `GitHub Actions OIDC fetch returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new OidcResolutionError(
      'github_actions_fetch_failed',
      `GitHub Actions OIDC response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { value?: unknown }).value !== 'string'
  ) {
    throw new OidcResolutionError(
      'github_actions_fetch_failed',
      'GitHub Actions OIDC response missing `value` string',
    );
  }
  const value = (parsed as { value: string }).value;
  if (value.length === 0) {
    throw new OidcResolutionError(
      'github_actions_fetch_failed',
      'GitHub Actions OIDC `value` was empty',
    );
  }
  return value;
}

/**
 * Append `audience=<aud>` to a URL, handling whether one is already
 * present. The Actions request URL ships with `?api-version=...` already.
 */
function appendAudience(url: string, audience: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}audience=${encodeURIComponent(audience)}`;
}

// ---------------------------------------------------------------------------
// Interactive browser flow — PKCE OAuth against the sigstore public-good
// issuer.
//
// Flow:
//   1. Bind a local HTTP listener on 127.0.0.1:<random>.
//   2. Build the issuer URL with redirect_uri = http://127.0.0.1:<port>/callback.
//   3. Print the URL + (try to) open the user's browser. They sign in
//      against the configured IdP (Google/Microsoft/GitHub via Dex).
//   4. The issuer redirects back to our listener with `?code=...&state=...`.
//   5. We exchange the code for an id_token via the issuer's /token endpoint.
//
// If binding the listener fails (sandboxed env, no localhost network),
// fall back to the manual-paste path: print the URL with `redirect_uri=urn:ietf:wg:oauth:2.0:oob`
// and prompt the operator to paste the token directly.
// ---------------------------------------------------------------------------

async function runInteractiveFlow(opts: {
  readonly issuer: string;
  readonly stdout: (s: string) => void;
  readonly prompt?: (label: string) => Promise<string>;
  readonly openBrowser?: (url: string) => Promise<void>;
}): Promise<string> {
  let listener: InteractiveListener | undefined;
  try {
    listener = await startCallbackListener();
  } catch {
    listener = undefined;
  }

  // PKCE pair — code_verifier kept locally, code_challenge sent to the
  // issuer. The fallback (manual-paste) doesn't need them but generating
  // them unconditionally keeps the two branches symmetrical.
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = base64UrlEncode(
    createHash('sha256').update(codeVerifier).digest(),
  );
  const state = base64UrlEncode(randomBytes(16));

  if (listener) {
    const redirectUri = `http://127.0.0.1:${listener.port}/callback`;
    const authUrl = buildAuthUrl({
      issuer: opts.issuer,
      redirectUri,
      codeChallenge,
      state,
    });
    opts.stdout(`\nOpen this URL in your browser to authenticate:\n  ${authUrl}\n\n`);
    if (opts.openBrowser) {
      try {
        await opts.openBrowser(authUrl);
      } catch {
        // ignore — printed URL is enough
      }
    }
    let callback: { code: string; state: string };
    try {
      callback = await listener.waitForCallback();
    } catch (err) {
      throw new OidcResolutionError(
        'interactive_failed',
        `interactive callback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      listener.close();
    }
    if (callback.state !== state) {
      throw new OidcResolutionError(
        'interactive_failed',
        'OAuth state mismatch — possible CSRF; aborting.',
      );
    }
    return await exchangeCodeForToken({
      issuer: opts.issuer,
      code: callback.code,
      codeVerifier,
      redirectUri,
    });
  }

  // Manual-paste fallback — couldn't bind a local port.
  const oobRedirect = 'urn:ietf:wg:oauth:2.0:oob';
  const authUrl = buildAuthUrl({
    issuer: opts.issuer,
    redirectUri: oobRedirect,
    codeChallenge,
    state,
  });
  opts.stdout(
    `\nUnable to bind a local OAuth listener.\n` +
      `Open this URL in your browser, authenticate, and paste the resulting token below:\n  ${authUrl}\n\n`,
  );
  const promptFn = opts.prompt;
  if (!promptFn) {
    throw new OidcResolutionError(
      'interactive_failed',
      'interactive fallback requires an injected prompt function (or a free localhost port)',
    );
  }
  const pasted = await promptFn('OIDC token: ');
  if (!pasted || pasted.length === 0) {
    throw new OidcResolutionError(
      'interactive_failed',
      'no token provided',
    );
  }
  return pasted.trim();
}

interface InteractiveListener {
  readonly port: number;
  waitForCallback(): Promise<{ code: string; state: string }>;
  close(): void;
}

function startCallbackListener(): Promise<InteractiveListener> {
  return new Promise((resolveStart, rejectStart) => {
    let resolveCb: ((v: { code: string; state: string }) => void) | undefined;
    let rejectCb: ((err: Error) => void) | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.statusCode = 400;
        res.end('missing url');
        return;
      }
      const u = new URL(req.url, `http://127.0.0.1`);
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const error = u.searchParams.get('error');
      if (error) {
        res.statusCode = 400;
        res.end(`error: ${error}`);
        rejectCb?.(new Error(`issuer returned error=${error}`));
        return;
      }
      if (!code || !state) {
        res.statusCode = 400;
        res.end('missing code/state');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<html><body><p>Authentication complete. You can close this tab.</p></body></html>',
      );
      resolveCb?.({ code, state });
    });
    server.once('error', (err) => rejectStart(err));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr.port !== 'number') {
        rejectStart(new Error('failed to bind callback listener'));
        return;
      }
      const port = addr.port;
      resolveStart({
        port,
        waitForCallback() {
          return new Promise((resolveInner, rejectInner) => {
            resolveCb = resolveInner;
            rejectCb = rejectInner;
          });
        },
        close() {
          server.close();
        },
      });
    });
  });
}

function buildAuthUrl(opts: {
  readonly issuer: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly state: string;
}): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SIGSTORE_OAUTH_CLIENT_ID,
    scope: 'openid email',
    redirect_uri: opts.redirectUri,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,
  });
  return `${opts.issuer}/auth?${params.toString()}`;
}

async function exchangeCodeForToken(opts: {
  readonly issuer: string;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    code_verifier: opts.codeVerifier,
    client_id: SIGSTORE_OAUTH_CLIENT_ID,
    redirect_uri: opts.redirectUri,
  });
  let res: Response;
  try {
    res = await fetch(`${opts.issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    throw new OidcResolutionError(
      'interactive_failed',
      `token exchange failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      // ignore
    }
    throw new OidcResolutionError(
      'interactive_failed',
      `token exchange HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    throw new OidcResolutionError(
      'interactive_failed',
      `token exchange response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { id_token?: unknown }).id_token !== 'string'
  ) {
    throw new OidcResolutionError(
      'interactive_failed',
      'token exchange response missing `id_token` string',
    );
  }
  return (parsed as { id_token: string }).id_token;
}

function base64UrlEncode(buf: Buffer | Uint8Array): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
