/**
 * Bootstrap & session token mint / verify.
 *
 * Two tiny credential shapes for the live-channel bootstrap flow. Neither
 * is MCP-Apps-specific — the only integration using them today is MCP
 * Apps outbound delivery, but any future bootstrap mechanism (signed-URL
 * share, short-code auto-login, etc.) can reuse the same primitives.
 *
 *   - **Bootstrap token** — short-TTL, single-use, minted by
 *     `ggui_push` (or equivalent), consumed at first live-channel
 *     subscribe. The MCP Apps iframe receives it via
 *     `_meta.ggui.bootstrap.token`.
 *
 *   - **Session token** — longer-TTL, reusable, minted by the session-
 *     channel server on the FIRST successful bootstrap-auth subscribe
 *     and returned in `AckPayload.sessionToken`. The iframe uses it for
 *     live-channel reconnects (over the standard bearer path) so the
 *     original bootstrap source doesn't need to re-mint.
 *
 * **Format.** Compact `<payload>.<sig>` where `payload` is
 * base64url-encoded JSON and `sig` is the base64url of
 * `HMAC-SHA256(payload, secret)`. Not a full JWT — no header, no
 * cryptographic algorithm negotiation, no nested claims. Pre-launch
 * discipline: keep the shape small, revisit only when multiple
 * signing keys or asymmetric sigs become real needs.
 *
 * **Replay resistance.** Bootstrap tokens are intended to be
 * single-use; the session-channel layer tracks consumed token ids in
 * memory (see `session-channel.ts`) to reject re-use within the TTL
 * window. Session tokens ARE reusable by design (reconnects).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token kinds carried in the `kind` claim. Each discriminator defines
 * a distinct verify surface — a bootstrap token CAN'T verify as a
 * session token even with matching signature + payload.
 *
 *   - `'bootstrap'`   — short-TTL, single-use, ggui_push → iframe.
 *   - `'session'`     — longer-TTL, reusable, reconnect credential.
 *   - `'console-session'` — longer-TTL, reusable, issued by the
 *     same-origin console cookie endpoint. Scoped narrowly: only
 *     verified at the live-channel upgrade by console's cookie-auth
 *     hook. NEVER verified on `/mcp` or any bearer ingress.
 */
export type TokenKind = 'bootstrap' | 'session' | 'console-session';

/** Claims carried in a bootstrap, session, or console-session token. */
export interface BootstrapTokenClaims {
  /** Session id the token is scoped to. */
  readonly sessionId: string;
  /** App (tenant) id the token is scoped to. */
  readonly appId: string;
  /** Kind discriminator — distinguishes mint/verify surfaces. */
  readonly kind: TokenKind;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
  /** Expires-at, epoch seconds. */
  readonly exp: number;
  /** Random token id — enables single-use enforcement on bootstrap tokens. */
  readonly jti: string;
}

/** Default TTLs (seconds). Operators override via mint-call options. */
export const DEFAULT_BOOTSTRAP_TOKEN_TTL_SEC = 120;
export const DEFAULT_SESSION_TOKEN_TTL_SEC = 60 * 60 * 4; // 4 hours
/**
 * Default console cookie TTL (8 hours). Matches the design note
 * §6.2 — "bound to the server's origin, short-lived (e.g., 8 hours)."
 * Same-origin operator convenience: long enough to cover a working
 * session, short enough to bound exposure after the operator walks
 * away from the machine.
 */
export const DEFAULT_DEVTOOL_SESSION_TTL_SEC = 60 * 60 * 8;

export interface MintTokenInput {
  readonly sessionId: string;
  readonly appId: string;
  /** Token lifetime in seconds. Defaults per-kind. */
  readonly ttlSec?: number;
}

function base64url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input: string): Buffer {
  // Pad to a multiple of 4.
  const pad = input.length % 4 === 0 ? 0 : 4 - (input.length % 4);
  const padded =
    input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(padded, 'base64');
}

function sign(payloadB64: string, secret: string): string {
  const mac = createHmac('sha256', secret).update(payloadB64).digest();
  return base64url(mac);
}

function mintToken(
  input: MintTokenInput & { kind: TokenKind; defaultTtlSec: number },
  secret: string,
): { token: string; claims: BootstrapTokenClaims } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? input.defaultTtlSec;
  const claims: BootstrapTokenClaims = {
    sessionId: input.sessionId,
    appId: input.appId,
    kind: input.kind,
    iat: now,
    exp: now + ttl,
    jti: base64url(randomBytes(12)),
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(claims), 'utf8'));
  const sig = sign(payloadB64, secret);
  return { token: `${payloadB64}.${sig}`, claims };
}

/**
 * Mint a short-TTL single-use bootstrap token.
 *
 * Intended for the live-channel bootstrap flow: the token travels inside
 * `_meta.ggui.bootstrap.token` on a `ggui_push` tool result, is
 * consumed at the iframe's first `subscribe`, and is rejected on any
 * re-use (enforced by the session-channel server's replay tracker).
 */
export function mintBootstrapToken(
  input: MintTokenInput,
  secret: string,
): { token: string; claims: BootstrapTokenClaims } {
  return mintToken(
    {
      ...input,
      kind: 'bootstrap',
      defaultTtlSec: DEFAULT_BOOTSTRAP_TOKEN_TTL_SEC,
    },
    secret,
  );
}

/**
 * Mint a longer-TTL reusable session token.
 *
 * Issued by the session-channel server on the FIRST successful
 * bootstrap-auth subscribe and returned in `AckPayload.sessionToken`.
 * The iframe persists it (sessionStorage / equivalent) and uses it
 * on reconnects via the standard `Authorization: Bearer <...>` or
 * `?token=<...>` paths. Not single-use.
 */
export function mintSessionToken(
  input: MintTokenInput,
  secret: string,
): { token: string; claims: BootstrapTokenClaims } {
  return mintToken(
    {
      ...input,
      kind: 'session',
      defaultTtlSec: DEFAULT_SESSION_TOKEN_TTL_SEC,
    },
    secret,
  );
}

/**
 * Mint an console session token — the same HMAC shape as
 * bootstrap / session, but with `kind: 'console-session'` so it
 * NEVER verifies as a bootstrap or session token. Consumed by
 * console's same-origin cookie at live-channel upgrade.
 *
 * Reusable (not single-use). Default TTL is `DEFAULT_DEVTOOL_SESSION_TTL_SEC`
 * (8h); caller may shorten via `input.ttlSec`.
 */
export function mintDevtoolSessionToken(
  input: MintTokenInput,
  secret: string,
): { token: string; claims: BootstrapTokenClaims } {
  return mintToken(
    {
      ...input,
      kind: 'console-session',
      defaultTtlSec: DEFAULT_DEVTOOL_SESSION_TTL_SEC,
    },
    secret,
  );
}

export type VerifyTokenFailure =
  | 'invalid_format'
  | 'invalid_signature'
  | 'expired'
  | 'wrong_kind'
  | 'malformed_claims';

export type VerifyTokenResult =
  | { readonly ok: true; readonly claims: BootstrapTokenClaims }
  | { readonly ok: false; readonly reason: VerifyTokenFailure };

/**
 * Verify a token's signature + expiry + kind.
 *
 * Returns a discriminated result — callers decide how to surface
 * failures (401 vs distinct error codes). Timing-safe signature
 * comparison; don't short-circuit on the first byte mismatch.
 */
export function verifyToken(
  token: string,
  secret: string,
  expectedKind: TokenKind,
): VerifyTokenResult {
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'invalid_format' };
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) {
    return { ok: false, reason: 'invalid_format' };
  }

  const expectedSig = sign(payloadB64, secret);
  // timingSafeEqual requires equal-length buffers — bail cheaply if
  // lengths differ to avoid a throw.
  if (expectedSig.length !== sigB64.length) {
    return { ok: false, reason: 'invalid_signature' };
  }
  const ok = timingSafeEqual(
    Buffer.from(expectedSig, 'utf8'),
    Buffer.from(sigB64, 'utf8'),
  );
  if (!ok) return { ok: false, reason: 'invalid_signature' };

  let claims: BootstrapTokenClaims;
  try {
    const json = base64urlDecode(payloadB64).toString('utf8');
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof raw.sessionId !== 'string' ||
      typeof raw.appId !== 'string' ||
      typeof raw.iat !== 'number' ||
      typeof raw.exp !== 'number' ||
      typeof raw.jti !== 'string' ||
      (raw.kind !== 'bootstrap' &&
        raw.kind !== 'session' &&
        raw.kind !== 'console-session')
    ) {
      return { ok: false, reason: 'malformed_claims' };
    }
    claims = {
      sessionId: raw.sessionId,
      appId: raw.appId,
      kind: raw.kind,
      iat: raw.iat,
      exp: raw.exp,
      jti: raw.jti,
    };
  } catch {
    return { ok: false, reason: 'malformed_claims' };
  }

  if (claims.kind !== expectedKind) {
    return { ok: false, reason: 'wrong_kind' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims };
}

/**
 * Small in-memory used-jti tracker for single-use bootstrap-token
 * enforcement. Bounded — entries age out once past their `exp`.
 *
 * Sized for single-process OSS deployments. Multi-process / multi-
 * host deployments would swap this for a shared store (Redis set,
 * DynamoDB conditional-write, etc.).
 */
export class BootstrapTokenReplayCache {
  private readonly seen = new Map<string, number>();

  /** Returns `true` when the jti was NEW (record succeeded). */
  claim(jti: string, exp: number): boolean {
    this.gc();
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, exp);
    return true;
  }

  size(): number {
    this.gc();
    return this.seen.size;
  }

  private gc(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of this.seen) {
      if (exp <= now) this.seen.delete(jti);
    }
  }
}
