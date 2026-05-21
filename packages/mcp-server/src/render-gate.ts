/**
 * `gateShortCode` — the single chokepoint for capability-URL routes.
 *
 * `/r/<code>` and `/api/bootstrap/<code>` are sibling surfaces that
 * expose the same render state via different content types (HTML
 * shell vs JSON bootstrap envelope). Before this gate, each route
 * implemented its own lookup + session resolve + 404 mapping, which
 * meant: hardening one route (revoke checks, sig verify, rate limit,
 * audit log) silently left the other unhardened. Capability URLs are
 * the credential — drift across the two routes is a defense gap.
 *
 * This module centralizes the gate logic. Routes ask the gate for
 * an outcome; content-type rendering stays on the route.
 *
 * Outcomes today:
 *   - `ok` — binding lookup + session resolve both succeeded
 *   - `not_found` — shortCode unknown OR revoked (lookup returned null)
 *   - `session_missing` — binding present but session record absent
 *
 * Outcomes reserved for future slices (sig verify, rate limit, etc.):
 *   - `invalid_signature` (HMAC slice)
 *   - `expired` (TTL slice)
 *   - `rate_limited` (per-code throttle slice)
 *
 * Each future slice extends the union; routes can map new codes to
 * appropriate status codes (403, 410, 429) without re-implementing
 * the lookup.
 */

import type { Session } from '@ggui-ai/protocol';
import type { ShortCodeIndex } from '@ggui-ai/mcp-server-core';
import type { RenderSigner } from './render-signing.js';

/** Minimal SessionStore surface the gate uses — narrower than the
 *  full interface so test fakes stay tiny. */
interface GateSessionStore {
  get(id: string): Promise<Session | null>;
}

/** The single failure surface the gate emits. New codes added here
 *  grow the discriminated union; consumers exhaustively match. */
export type RenderGateFailureCode =
  | 'not_found'
  | 'session_missing'
  | 'invalid_signature'
  | 'expired'
  | 'malformed_signature';

export type RenderGateOutcome =
  | {
      readonly ok: true;
      readonly binding: NonNullable<
        Awaited<ReturnType<ShortCodeIndex['lookup']>>
      >;
      readonly session: Session;
    }
  | {
      readonly ok: false;
      readonly code: RenderGateFailureCode;
      /** Optional context that's safe to pass to a structured logger
       *  but MUST NOT leak to the wire — error responses stay generic
       *  ("shortCode not recognised") to avoid info-leak amplification
       *  on brute-force attempts. */
      readonly logContext?: Record<string, unknown>;
    };

export interface GateShortCodeInput {
  readonly shortCode: string;
  readonly shortCodeIndex: ShortCodeIndex;
  readonly sessionStore: GateSessionStore;
  /**
   * Optional render-URL signer. When wired, the gate verifies the
   * incoming `sig`+`exp` query pair BEFORE lookup; an invalid or
   * expired signature short-circuits with a tagged failure code so
   * the route can map to an appropriate status (403/410). Absent =
   * signing disabled (legacy or `--no-render-signing` boot).
   */
  readonly signer?: RenderSigner;
  /**
   * Raw `sig`+`exp` from the request query string. When `signer` is
   * wired but these are missing, the gate fails with
   * `malformed_signature`. When `signer` is absent, both fields are
   * ignored.
   */
  readonly signedQuery?: {
    readonly sig?: string | undefined;
    readonly exp?: string | undefined;
  };
}

/**
 * Look up a shortCode + resolve its session. Idempotent + side-
 * effect-free; safe to call from any HTTP handler. Returns a tagged
 * outcome the caller maps to its content-type-appropriate response.
 *
 * Empty input MUST be caught upstream (path-param validation) — the
 * gate assumes a non-empty shortCode arrives because the route
 * pattern requires it.
 */
export async function gateShortCode(
  input: GateShortCodeInput,
): Promise<RenderGateOutcome> {
  // Signature verification runs BEFORE the lookup so a flood of
  // requests with garbage shortCodes can be rejected without hitting
  // the index. The signer also gates information-leak: revealing
  // "this code doesn't exist" vs "your sig is wrong" lets an
  // attacker probe shortCodes via timing differences. Rejecting on
  // signature first keeps the response timing uniform for any code
  // an attacker hasn't seen a valid sig for.
  if (input.signer) {
    const verify = input.signer.verify({
      shortCode: input.shortCode,
      sig: input.signedQuery?.sig,
      exp: input.signedQuery?.exp,
    });
    if (!verify.ok) {
      return {
        ok: false,
        code:
          verify.code === 'malformed'
            ? 'malformed_signature'
            : verify.code,
      };
    }
  }
  const binding = await input.shortCodeIndex.lookup(input.shortCode);
  if (!binding) {
    return { ok: false, code: 'not_found' };
  }
  const session = await input.sessionStore.get(binding.sessionId);
  if (!session) {
    return {
      ok: false,
      code: 'session_missing',
      logContext: {
        shortCode: input.shortCode,
        sessionId: binding.sessionId,
      },
    };
  }
  return { ok: true, binding, session };
}
