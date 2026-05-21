/**
 * HMAC-signed render URL helpers (capability-URL hardening).
 *
 * The shortCode IS the credential under the capability-URL model.
 * Signed render URLs add three properties on top of the base model
 * (entropy + revoke + parity gate):
 *
 *   1. **Time-bound.** Each minted URL carries `?exp=<unix>`. Past
 *      that timestamp, the gate refuses even if the binding still
 *      exists. A leaked URL stops working without operator action.
 *   2. **Tamper-evident.** Each minted URL carries `?sig=<hmac>` over
 *      `(shortCode, exp)`. Changing either invalidates the sig.
 *      Attackers who learn ONE valid shortCode can't generate URLs
 *      for shortCodes they're guessing.
 *   3. **Nuclear revoke (operational).** Rotating the signing secret
 *      invalidates every outstanding URL across the whole server in
 *      one move. Useful for incident response.
 *
 * **Threat model — what this is NOT.** The signature does not bind
 * the URL to a user, IP, or session. Anyone with the URL still has
 * full access until it expires. That's the Google-Docs-share-link
 * model. It's the only viable model when the URL must be embeddable
 * in cross-origin iframes (claude.ai), which can't attach auth
 * headers — see plan audit dated 2026-05-15.
 *
 * **Key lifecycle.** Operators set `--render-signing-secret <hex>` to
 * pin a stable key (URLs survive restarts; rotation is opt-in). When
 * omitted, the secret is auto-generated at boot — restart = every
 * outstanding URL dies. Document both behaviors so operators choose
 * deliberately.
 *
 * **Opt-out.** `--no-render-signing` (operator boots without a signer)
 * disables the layer entirely. The gate skips the verify step and
 * behavior reverts to plain (unsigned) capability URLs. Useful for
 * legacy hosts that strip query strings or tooling that pre-records
 * URLs.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Default TTL when the operator doesn't override. 24h matches the
 *  cloud pod's ShortCode row TTL — long enough for a back-to-the-tab
 *  user pattern, short enough that a leaked URL doesn't outlive a
 *  reasonable incident-response window. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export type RenderSignerVerifyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'invalid_signature' | 'expired' | 'malformed';
    };

export interface RenderSigner {
  /**
   * Mint a `{sig, exp}` pair for `shortCode`. `expSeconds` overrides
   * the configured TTL. The returned `exp` is a unix-epoch second
   * timestamp so URLs stay short.
   */
  sign(shortCode: string, expSecondsOverride?: number): {
    readonly sig: string;
    readonly exp: number;
  };

  /**
   * Verify a `sig` + `exp` against `shortCode`. Returns `{ok: true}`
   * on success; tagged failure otherwise. `malformed` covers missing
   * fields, non-numeric `exp`, sig-length mismatches — distinguishing
   * those from `invalid_signature` keeps the audit log informative
   * without leaking detail to the wire (the response code stays
   * uniform).
   */
  verify(args: {
    readonly shortCode: string;
    readonly sig: string | undefined;
    readonly exp: string | undefined;
  }): RenderSignerVerifyResult;

  /** Encode `{sig, exp}` as a `?sig=...&exp=...` query string suitable
   *  for appending to a render URL. Returns the suffix WITHOUT a
   *  leading `?` or `&` — callers join with whatever separator their
   *  URL already has. */
  toQuerySuffix(args: {
    readonly sig: string;
    readonly exp: number;
  }): string;
}

export interface CreateRenderSignerInput {
  /**
   * 32-byte hex key. When omitted, a fresh random key is minted —
   * stable for the lifetime of this process, lost on restart.
   * Operators wanting URLs that survive restarts MUST pass an
   * explicit key (typically from a sealed-secret store).
   */
  readonly secret?: string;
  /**
   * Default URL lifetime in seconds. Override per-call via
   * {@link RenderSigner.sign}'s `expSecondsOverride`.
   */
  readonly ttlSeconds?: number;
  /** Clock seam for tests. Defaults to `Date.now()`. */
  readonly now?: () => number;
}

/**
 * Build a {@link RenderSigner}. Memoize the result on the server-boot
 * scope; the secret rotates only when the operator restarts (or sets
 * a new explicit `--render-signing-secret`).
 */
export function createRenderSigner(
  input: CreateRenderSignerInput = {},
): RenderSigner {
  const secret =
    input.secret !== undefined && input.secret.length > 0
      ? input.secret
      : randomBytes(32).toString('hex');
  const ttl =
    input.ttlSeconds !== undefined && input.ttlSeconds > 0
      ? Math.floor(input.ttlSeconds)
      : DEFAULT_TTL_SECONDS;
  const now = input.now ?? (() => Date.now());

  const secretBuffer = Buffer.from(secret, 'utf8');

  function computeSig(shortCode: string, exp: number): string {
    // HMAC-SHA256 over `<shortCode>.<exp>`. Fixed separator + numeric
    // exp keeps the input unambiguous (no length-extension or
    // collision risk via overloaded encoding). Hex output stays
    // URL-safe without percent-encoding.
    return createHmac('sha256', secretBuffer)
      .update(`${shortCode}.${exp}`)
      .digest('hex');
  }

  return {
    sign(shortCode, expSecondsOverride) {
      const ttlForCall =
        expSecondsOverride !== undefined && expSecondsOverride > 0
          ? Math.floor(expSecondsOverride)
          : ttl;
      const exp = Math.floor(now() / 1000) + ttlForCall;
      return { sig: computeSig(shortCode, exp), exp };
    },

    verify({ shortCode, sig, exp }) {
      if (
        typeof sig !== 'string' ||
        typeof exp !== 'string' ||
        sig.length === 0 ||
        exp.length === 0
      ) {
        return { ok: false, code: 'malformed' };
      }
      const expNum = Number.parseInt(exp, 10);
      if (!Number.isFinite(expNum) || expNum <= 0) {
        return { ok: false, code: 'malformed' };
      }
      // Expired? Check BEFORE the HMAC compare. Expiry is a cheap
      // numeric compare; bailing here on stale URLs avoids the more
      // expensive constant-time sig compare on every drive-by stale
      // hit. Information-leak concern: an attacker can probe `exp`
      // independently of sig — but `exp` is already in the URL and
      // not secret.
      const nowSeconds = Math.floor(now() / 1000);
      if (expNum < nowSeconds) {
        return { ok: false, code: 'expired' };
      }
      const expected = computeSig(shortCode, expNum);
      // Constant-time compare. Buffer length mismatch → fail without
      // exposing length information via `timingSafeEqual` (which
      // throws on length mismatch).
      const a = Buffer.from(sig, 'hex');
      const b = Buffer.from(expected, 'hex');
      if (a.length !== b.length || a.length === 0) {
        return { ok: false, code: 'invalid_signature' };
      }
      return timingSafeEqual(a, b)
        ? { ok: true }
        : { ok: false, code: 'invalid_signature' };
    },

    toQuerySuffix({ sig, exp }) {
      return `sig=${sig}&exp=${exp}`;
    },
  };
}
