/**
 * Auth adapter contract + two built-in adapters: signed-token guest
 * identification (the default — works across browser + RN + CLI
 * without cookie-jar friction) + static bearer-token user
 * authentication.
 *
 * Two hooks on the contract:
 *
 *   - `authenticate(req)` — resolves a {@link Principal} from a
 *     request. Called once per endpoint hit. Return `null` to gate
 *     the request behind 401.
 *
 *   - `mount(router)` — adapters self-describe what `/auth/*`
 *     endpoints they need (e.g. `POST /auth/guest` for the guest-
 *     token mint). The library wires the adapter-returned sub-router
 *     under `/auth` — the `/auth/*` namespace is RESERVED for
 *     adapters, no library route lives there.
 *
 * One optional override:
 *
 *   - `authorizeChat(principal, chatRow)` — chat ownership check,
 *     defaults to `chatRow.ownerId === principalId(principal)`.
 *     Override for team chats, shared org access, admin override.
 *
 * Forward-looking shape: every richer flow (OAuth Authorization Code
 * + PKCE, JWT with JWKS rotation, platform-signed headers) is a new
 * adapter that satisfies the same contract — no handler rewrite
 * needed. Tracked in #289.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';

/**
 * Identified entity making a request.
 *
 *   - Guest principals are NOT authenticated — anyone who steals the
 *     signed token can present the id. The signature only guarantees
 *     the id was issued by THIS deployment (well, by a holder of the
 *     signing secret).
 *
 *   - User principals come from a real authentication path (bearer
 *     token here; future adapters cover OAuth / JWT / platform
 *     trust).
 *
 * Use {@link principalId} when you need the unique string handle
 * without discriminating on `kind`.
 */
export type Principal =
  | {
      readonly kind: 'guest';
      readonly guestId: string;
      /** ms epoch when the token was minted. */
      readonly issuedAt: number;
      /** ms epoch when the token expires. */
      readonly expiresAt: number;
    }
  | {
      readonly kind: 'user';
      readonly userId: string;
      readonly claims?: Record<string, unknown>;
    };

/**
 * Outcome of {@link AuthAdapter.authenticate}.
 *
 *   - `null` — adapter rejected the request. Library responds 401.
 *   - `{principal, responseHeaders?}` — caller is identified.
 *     `responseHeaders` are merged onto every response from this
 *     request (the bearer-token model rarely needs this, but it
 *     keeps a clean extension surface for cookie / session adapters
 *     that might land later).
 */
export type AuthResult = {
  readonly principal: Principal;
  readonly responseHeaders?: HeadersInit;
} | null;

/**
 * Minimal chat-row shape the chat-ownership check operates on. The
 * library treats `ownerId` as the unique handle a {@link Principal}
 * presents — `guestId` for guests, `userId` for users.
 */
export interface ChatRow {
  readonly chatId: string;
  readonly ownerId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Auth-adapter contract. One required method + two optional hooks.
 */
export interface AuthAdapter {
  /**
   * Resolve the requesting principal. Throws are surfaced as 500;
   * returning `null` is the documented "reject" path that produces
   * 401.
   */
  authenticate(req: Request): Promise<AuthResult>;
  /**
   * Optional chat-ownership check. Defaults to
   * `chatRow.ownerId === principalId(principal)`. Override for team
   * chats, shared organization access, admin override, etc.
   */
  authorizeChat?(
    principal: Principal,
    chatRow: ChatRow,
  ): Promise<boolean> | boolean;
  /**
   * Optional: mount the adapter's `/auth/*` endpoints on a
   * sub-router scoped to that prefix. Called once at server
   * construction. The library mounts the resulting router at
   * `/auth`, so an adapter writes `router.post('/guest', ...)` and
   * the live route is `POST /auth/guest`.
   *
   * The `/auth/*` namespace is RESERVED for adapters — the library
   * never registers a route there itself.
   */
  mount?(router: Hono): void;
}

/** Stable string handle for a principal. */
export function principalId(p: Principal): string {
  return p.kind === 'guest' ? p.guestId : p.userId;
}

/**
 * Default chat-ownership check used by the library when an adapter
 * doesn't supply its own. Strict `ownerId === principal handle`
 * match — no sharing, no admin override.
 */
export function defaultAuthorizeChat(
  principal: Principal,
  chatRow: ChatRow,
): boolean {
  return chatRow.ownerId === principalId(principal);
}

// ─── createGuestTokenAuth ────────────────────────────────────────────────────

const BASE62 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62FromBytes(bytes: Buffer, len: number): string {
  let n = 0n;
  for (let i = 0; i < bytes.length; i++) {
    n = (n << 8n) | BigInt(bytes[i] as number);
  }
  let out = '';
  for (let i = 0; i < len; i++) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out;
}

/**
 * Mint a fresh `guest_<22-char base62>` id from 16 random bytes —
 * 132 bits of entropy, URL-safe alphabet, no padding.
 */
export function mintGuestId(): string {
  return `guest_${base62FromBytes(randomBytes(16), 22)}`;
}

export interface GuestTokenAuthOptions {
  /**
   * HMAC signing secret for the token. When omitted, the library
   * mints one at boot via `crypto.randomBytes(32)` and logs a single
   * warning suggesting the operator set `GUEST_TOKEN_SECRET` for
   * stability across restarts.
   *
   * Stability matters: a fresh secret each boot invalidates every
   * outstanding guest token → every returning visitor looks new.
   */
  readonly signingSecret?: string;
  /** Default 30 days. */
  readonly tokenLifetimeSeconds?: number;
  /** Override warning emitter for tests / quieter deployments. */
  readonly logSecretWarning?: (line: string) => void;
}

/**
 * Default-when-omitted auth adapter. Token-based instead of
 * cookie-based to keep the same auth path working across browser +
 * React Native + CLI (RN's cookie-jar plumbing is friction we don't
 * want in the default).
 *
 * Wire shape:
 *
 *   - Client `POST /auth/guest` → server mints
 *     `{guestId, guestToken, expiresAt}`.
 *   - Client stores `guestToken` in localStorage / AsyncStorage.
 *   - Client sends `Authorization: Bearer <guestToken>` on every
 *     subsequent request.
 *   - Server verifies signature + expiry, returns Principal.
 *   - Expired / tampered token → 401; client posts /auth/guest
 *     again, retries.
 *
 * Token = base64url JSON `{guestId, issuedAt, expiresAt}` with a
 * hex HMAC-SHA256 signature appended. Stateless; no per-token
 * server-side storage.
 */
export function createGuestTokenAuth(
  opts: GuestTokenAuthOptions = {},
): AuthAdapter {
  const tokenLifetimeSeconds =
    opts.tokenLifetimeSeconds ?? 60 * 60 * 24 * 30;
  let secret = opts.signingSecret;
  if (secret === undefined) {
    secret = randomBytes(32).toString('hex');
    const warn =
      opts.logSecretWarning ??
      ((line: string): void => {
        // eslint-disable-next-line no-console
        console.warn(line);
      });
    warn(
      '[agent-server] createGuestTokenAuth: no signingSecret provided — generated an ephemeral one. Guest tokens will not survive a restart. Set GUEST_TOKEN_SECRET (or pass signingSecret) for stability.',
    );
  }
  const signingSecret = secret;

  function mintToken(): {
    readonly guestId: string;
    readonly guestToken: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
  } {
    const guestId = mintGuestId();
    const issuedAt = Date.now();
    const expiresAt = issuedAt + tokenLifetimeSeconds * 1000;
    const guestToken = encodeGuestToken(
      { guestId, issuedAt, expiresAt },
      signingSecret,
    );
    return { guestId, guestToken, issuedAt, expiresAt };
  }

  return {
    async authenticate(req) {
      const principal = parseGuestBearer(req, signingSecret);
      if (!principal) return null;
      return { principal };
    },
    mount(router) {
      // POST /auth/guest — mint a fresh guest token. Idempotent
      // from the server's POV (no per-token storage); each call
      // returns a new identity.
      router.post('/guest', (c) => {
        const minted = mintToken();
        return c.json(
          {
            guestId: minted.guestId,
            guestToken: minted.guestToken,
            expiresAt: minted.expiresAt,
          },
          200,
          { 'Cache-Control': 'no-store' },
        );
      });

      // GET /auth/me — surfaces the current bearer's principal.
      // 401 when no valid bearer rides on the request — matches
      // the contract: `authenticate` returning null = 401.
      router.get('/me', async (c) => {
        const principal = parseGuestBearer(c.req.raw, signingSecret);
        if (!principal) {
          return c.json({ error: 'unauthenticated' }, 401);
        }
        return c.json({ principal }, 200, { 'Cache-Control': 'no-store' });
      });

      // POST /auth/logout — tokens are stateless; no server-side
      // session to clear. Surfaced as a 200 + advisory so clients
      // can rely on the path existing. Future signing-secret
      // rotation could turn this into a blacklist write.
      router.post('/logout', (c) =>
        c.json(
          { ok: true, advice: 'discard the locally-stored guestToken' },
          200,
        ),
      );
    },
  };
}

interface GuestTokenPayload {
  readonly guestId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

function encodeGuestToken(
  payload: GuestTokenPayload,
  secret: string,
): string {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf-8').toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function decodeGuestToken(
  token: string,
  secret: string,
): GuestTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const presentedSig = token.slice(dot + 1);
  const expectedSig = createHmac('sha256', secret).update(body).digest('hex');
  const expectedBuf = Buffer.from(expectedSig, 'hex');
  let presentedBuf: Buffer;
  try {
    presentedBuf = Buffer.from(presentedSig, 'hex');
  } catch {
    return null;
  }
  if (presentedBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(expectedBuf, presentedBuf)) return null;
  let parsed: unknown;
  try {
    const json = Buffer.from(body, 'base64url').toString('utf-8');
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.guestId !== 'string' || p.guestId.length === 0) return null;
  if (typeof p.issuedAt !== 'number') return null;
  if (typeof p.expiresAt !== 'number') return null;
  return {
    guestId: p.guestId,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
  };
}

function parseGuestBearer(req: Request, secret: string): Principal | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/.exec(header.trim());
  if (!m) return null;
  const decoded = decodeGuestToken(m[1] ?? '', secret);
  if (!decoded) return null;
  if (decoded.expiresAt < Date.now()) return null;
  return {
    kind: 'guest',
    guestId: decoded.guestId,
    issuedAt: decoded.issuedAt,
    expiresAt: decoded.expiresAt,
  };
}

// ─── createBearerTokenAuth ───────────────────────────────────────────────────

export interface BearerTokenAuthOptions {
  /**
   * Map from bearer token value → user identity. Tokens are matched
   * via constant-time comparison (no early-exit on first byte diff)
   * to avoid timing-based discovery. Static only — JWT / JWKS /
   * OAuth flows live in `@ggui-ai/agent-server-auth-extras` (#289).
   */
  readonly tokens: Record<
    string,
    {
      readonly userId: string;
      readonly claims?: Record<string, unknown>;
    }
  >;
}

/**
 * Minimal authenticated adapter — reads `Authorization: Bearer <t>`
 * and looks the token up in a static map. Returns `null` (→ 401) on
 * missing / unknown token.
 *
 * Suitable for sample apps, CI fixtures, and small-scale self-hosts.
 * Production deployments should use a real authentication backend
 * (JWT, OAuth) once #289 lands.
 */
export function createBearerTokenAuth(
  opts: BearerTokenAuthOptions,
): AuthAdapter {
  // Pre-compute Buffers for constant-time comparison so the hot
  // path doesn't allocate per request.
  const entries = Object.entries(opts.tokens).map(([token, identity]) => ({
    bufFromToken: Buffer.from(token, 'utf-8'),
    identity,
  }));

  function lookupBearer(req: Request): Principal | null {
    const header = req.headers.get('authorization');
    if (!header) return null;
    const m = /^Bearer\s+(.+)$/.exec(header.trim());
    if (!m) return null;
    const presentedBuf = Buffer.from(m[1] ?? '', 'utf-8');
    for (const entry of entries) {
      if (entry.bufFromToken.length !== presentedBuf.length) continue;
      if (timingSafeEqual(entry.bufFromToken, presentedBuf)) {
        if (entry.identity.claims) {
          return {
            kind: 'user',
            userId: entry.identity.userId,
            claims: entry.identity.claims,
          };
        }
        return { kind: 'user', userId: entry.identity.userId };
      }
    }
    return null;
  }

  return {
    async authenticate(req) {
      const principal = lookupBearer(req);
      if (!principal) return null;
      return { principal };
    },
    mount(router) {
      // GET /auth/me only — bearer-token model has no minting
      // surface (tokens come from operator config) and no logout
      // (token lifecycle is external).
      router.get('/me', (c) => {
        const principal = lookupBearer(c.req.raw);
        if (!principal) {
          return c.json({ error: 'unauthenticated' }, 401);
        }
        return c.json({ principal }, 200, { 'Cache-Control': 'no-store' });
      });
    },
  };
}
