/**
 * WS-token mint / verify — the live-channel auth credential primitives.
 *
 * Two tiny credential shapes for the live-channel auth flow. Neither
 * is MCP-Apps-specific — the only integration using them today is MCP
 * Apps outbound delivery, but any future short-lived-credential
 * mechanism (signed-URL share, short-code auto-login, etc.) can reuse
 * the same primitives.
 *
 *   - **WS token** — short-TTL signed envelope, minted by
 *     `ggui_render` (or equivalent), consumed at live-channel subscribe.
 *     The MCP Apps iframe receives it on the
 *     `_meta["ai.ggui/render"].wsToken` slice field. **Reusable within TTL**
 *     (G14, 2026-05-23) so a transient WS drop can reconnect without a
 *     fresh handshake. After TTL expiry the view refreshes it through
 *     `ggui_runtime_refresh_ws_token`, an AUTHORIZED re-mint: the
 *     envelope is verified at any age ({@link verifyWsTokenSignature}),
 *     and the caller must be admitted to the session before anything is
 *     minted (ggui#1496 part B).
 *
 *   - **Session token** — longer-TTL, reusable, minted by the live-
 *     channel server on the FIRST successful ws-token-authed subscribe
 *     and returned in `AckPayload.sessionToken`. The iframe uses it for
 *     live-channel reconnects (over the standard bearer path) so the
 *     original token source doesn't need to re-mint.
 *
 * **Format.** Compact `<payload>.<sig>` where `payload` is
 * base64url-encoded JSON and `sig` is the base64url of
 * `HMAC-SHA256(payload, secret)`. Not a full JWT — no header, no
 * cryptographic algorithm negotiation, no nested claims. Pre-launch
 * discipline: keep the shape small, revisit only when multiple
 * signing keys or asymmetric sigs become real needs.
 *
 * **Threat model.**
 *   - PROTECTED: replay past the TTL window (signature still verifies
 *     but `now > exp` rejects with `'expired'`).
 *   - PROTECTED: tampering (any byte change → HMAC mismatch).
 *   - NOT PROTECTED (by design, bounded by TTL): a valid-but-stolen
 *     envelope within its TTL behaves like the legitimate iframe. Same
 *     risk as the pre-G14 single-use model — the attacker still had to
 *     intercept the envelope; the only thing G14 widens is the
 *     legitimate iframe's reconnect window.
 *   - NOT PROTECTED (by design): DoS via repeated subscribe attempts —
 *     transport-layer rate limiting is the right defense, not envelope
 *     state.
 *
 * **Constant-time comparison.** All HMAC compares go through
 * `crypto.timingSafeEqual` — no early-byte short-circuit.
 *
 * **Replay tracker** (`WsTokenReplayCache`) is still exported for
 * callers that need explicit single-use semantics (one-time-link share,
 * etc.). The default live-channel verify path does NOT use it post-
 * G14 — that's the whole point of the refresh design.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token kinds carried in the `kind` claim. Each discriminator defines
 * a distinct verify surface — a ws token CAN'T verify as a session
 * token even with matching signature + payload.
 *
 *   - `'ws'`              — short-TTL, multi-use within TTL (G14), ggui_render → iframe.
 *   - `'session'`         — longer-TTL, reusable, reconnect credential.
 *   - `'console-session'` — longer-TTL, reusable, issued by the
 *     same-origin console cookie endpoint. Scoped narrowly: only
 *     verified at the live-channel upgrade by console's cookie-auth
 *     hook. NEVER verified on `/mcp` or any bearer ingress.
 */
export type TokenKind = 'ws' | 'session' | 'console-session';

/** Claims carried in a ws, session, or console-session token. */
export interface WsTokenClaims {
  /** GguiSession id the token is scoped to. */
  readonly sessionId: string;
  /** App id the token is scoped to. */
  readonly appId: string;
  /** Kind discriminator — distinguishes mint/verify surfaces. */
  readonly kind: TokenKind;
  /** Issued-at, epoch seconds. */
  readonly iat: number;
  /** Expires-at, epoch seconds. */
  readonly exp: number;
  /**
   * Random token id. Reserved for callers that opt into single-use
   * semantics via {@link WsTokenReplayCache}; the default G14
   * live-channel verify path no longer claims it (multi-use within
   * TTL is the supported recovery posture).
   */
  readonly jti: string;
}

/** Default TTLs (seconds). Operators override via mint-call options. */
export const DEFAULT_WS_TOKEN_TTL_SEC = 180;
export const DEFAULT_SESSION_TOKEN_TTL_SEC = 60 * 60 * 4; // 4 hours
/**
 * Reserved for bounding possession-only ws-token renewals (ggui#1496 part B,
 * slice 2): such a renewal will stay within
 * `root iat + DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER * ttl` seconds.
 * Nothing reads it at this release, and tokens carry no root-iat claim yet:
 * `GET /api/sessions/:id/state` still re-mints a fresh ws token for anyone
 * holding an unexpired one, with no bound. The authorized refresh
 * (`ggui_runtime_refresh_ws_token`) is not bounded by it either, because
 * each of its calls is authorized.
 */
export const DEFAULT_WS_TOKEN_REFRESH_WINDOW_MULTIPLIER = 2;
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
): { token: string; claims: WsTokenClaims } {
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSec ?? input.defaultTtlSec;
  const claims: WsTokenClaims = {
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
 * Mint a short-TTL WS auth token.
 *
 * Intended for the live-channel auth flow: the token travels on the
 * `_meta["ai.ggui/render"].wsToken` slice field of a `ggui_render` tool result,
 * is consumed at iframe `subscribe`, and remains valid for `ttlSec`
 * (default 180s) to absorb transient WS drops without a fresh
 * handshake (G14, 2026-05-23). Post-TTL: the view refreshes through
 * `ggui_runtime_refresh_ws_token`, an authorized re-mint gated on the
 * session (ggui#1496 part B); see {@link verifyWsTokenSignature}.
 */
export function mintWsToken(
  input: MintTokenInput,
  secret: string,
): { token: string; claims: WsTokenClaims } {
  return mintToken(
    {
      ...input,
      kind: 'ws',
      defaultTtlSec: DEFAULT_WS_TOKEN_TTL_SEC,
    },
    secret,
  );
}

/**
 * Mint a longer-TTL reusable session token.
 *
 * Issued by the live-channel server on the FIRST successful
 * ws-token-authed subscribe and returned in `AckPayload.sessionToken`.
 * The iframe persists it (sessionStorage / equivalent) and uses it
 * on reconnects via the standard `Authorization: Bearer <...>` or
 * `?token=<...>` paths. Not single-use.
 */
export function mintSessionToken(
  input: MintTokenInput,
  secret: string,
): { token: string; claims: WsTokenClaims } {
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
 * ws / session, but with `kind: 'console-session'` so it
 * NEVER verifies as a ws or session token. Consumed by
 * console's same-origin cookie at live-channel upgrade.
 *
 * Reusable (not single-use). Default TTL is `DEFAULT_DEVTOOL_SESSION_TTL_SEC`
 * (8h); caller may shorten via `input.ttlSec`.
 */
export function mintDevtoolSessionToken(
  input: MintTokenInput,
  secret: string,
): { token: string; claims: WsTokenClaims } {
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
  | { readonly ok: true; readonly claims: WsTokenClaims }
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
  const result = verifySignedClaims(token, secret, expectedKind);
  if (!result.ok) return result;
  const now = Math.floor(Date.now() / 1000);
  if (result.claims.exp <= now) return { ok: false, reason: 'expired' };
  return result;
}

/**
 * Verify a ws envelope's signature, shape and kind at ANY age: the expiry
 * is NOT checked (ggui#1496 part B).
 *
 * This is the first step of the authorized refresh
 * (`ggui_runtime_refresh_ws_token`): the envelope proves the view was
 * given a credential for its session, and the handler then authorizes the
 * CALLER against that session before minting anything. A possession
 * check alone never mints. `'expired'` is never returned.
 */
export function verifyWsTokenSignature(token: string, secret: string): VerifyTokenResult {
  return verifySignedClaims(token, secret, 'ws');
}

/** Signature (timing-safe), claim shape and kind — everything but the expiry. */
function verifySignedClaims(
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

  let claims: WsTokenClaims;
  try {
    const json = base64urlDecode(payloadB64).toString('utf8');
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (
      typeof raw.sessionId !== 'string' ||
      typeof raw.appId !== 'string' ||
      typeof raw.iat !== 'number' ||
      typeof raw.exp !== 'number' ||
      typeof raw.jti !== 'string' ||
      (raw.kind !== 'ws' &&
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
  return { ok: true, claims };
}

/**
 * Small in-memory used-jti tracker for callers that opt into single-
 * use ws-token enforcement (one-time share links, etc.). The
 * default live-channel verify path does NOT use this post-G14 —
 * the ws token is multi-use within TTL by design.
 *
 * Bounded — entries age out once past their `exp`. Sized for single-
 * process callers; multi-process / multi-host callers would swap this
 * for a shared store (Redis set, DynamoDB conditional-write, etc.).
 */
export class WsTokenReplayCache {
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
