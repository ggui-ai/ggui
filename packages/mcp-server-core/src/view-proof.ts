/**
 * View-origin proof v1, the server side (ggui#1415): the view key a
 * key-issuing door mints beside a ws envelope, and the verification of a
 * proof a view sends at `params._meta["ai.ggui/view"]`.
 *
 * The bytes are protocol's (`@ggui-ai/protocol/integrations/mcp-apps`,
 * `view-proof.ts`); this module is their HMAC. `P` is a ws envelope's
 * payload segment. The view key is `K = HMAC(secret, "ai.ggui/view-key/v1"
 * ‖ 0x00 ‖ P)`, recomputed from `P` on every call: stateless, and any
 * replica holding the secret can verify.
 *
 * At this release one secret signs every envelope, and a proof names it
 * by its default key id (`defaultViewKid`). A ring of secrets is the next
 * release's change.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_KID_LABEL_V1,
  VIEW_PROOF_FLAG_USER_ACTIVATION,
  VIEW_PROOF_ROOT_MAX_CHARS,
  parseViewProof,
  viewKeyInputBytes,
  viewProofArgsBytes,
  viewProofCallBytes,
  type ViewProofParseFailure,
  type ViewProofTool,
  type ViewRootSrc,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { JsonObject } from '@ggui-ai/protocol';

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

const hmac = (key: string | Uint8Array, msg: string | Uint8Array): Buffer =>
  createHmac('sha256', typeof key === 'string' ? Buffer.from(key, 'utf8') : key)
    .update(msg)
    .digest();

/**
 * The key id a secret carries by default: the first 8 characters of
 * `base64url(HMAC(secret, "ai.ggui/kid/v1"))`. A proof whose root names
 * another id was signed under another secret (another deployment, or a
 * process whose ephemeral secret has since changed): `unknown_key`, never
 * `bad_mac`.
 */
export function defaultViewKid(secret: string): string {
  return b64u(hmac(secret, VIEW_KID_LABEL_V1)).slice(0, 8);
}

/** The view key `K` for root `P` under `secret`: 32 bytes. */
export function deriveViewKey(root: string, secret: string): Buffer {
  return hmac(secret, viewKeyInputBytes(root));
}

/**
 * Why a verdict is `missing`: `meta_absent` when the request carried no
 * `params._meta` at all, `key_absent` when its `_meta` has no
 * `"ai.ggui/view"` key.
 */
export type ViewProofMissingReason = 'meta_absent' | 'key_absent';

/** Why a verdict is `invalid`. The first failing check names it. */
export type ViewProofInvalidReason =
  | ViewProofParseFailure
  | 'unknown_key'
  | 'bad_mac'
  | 'session_mismatch'
  | 'app_mismatch'
  | 'args_mismatch'
  | 'verifier_error';

/** What a valid proof lets the server observe; none of it gates. */
export interface ViewProofObservations {
  readonly kid: string;
  readonly src?: ViewRootSrc;
  /** The root envelope's issued-at and expiry, epoch seconds. */
  readonly rootIat: number;
  readonly rootExp: number;
  /** The view's clock, epoch ms: diagnostics only, never a gate. */
  readonly vtime: number;
  /** Whether the gesture carried transient user activation (flags bit 0). */
  readonly userActivation: boolean;
  /** The proof's nonce, for the repeat cache. */
  readonly nonce: string;
}

/**
 * The verdict on one call: `valid`, `missing` or `invalid`, a closed set.
 * A `verifier_error` names the class of what was thrown (`errorClass`, at
 * most 64 characters) and nothing else of it.
 */
export type ViewProofVerdict =
  | ({ readonly verdict: 'valid' } & ViewProofObservations)
  | { readonly verdict: 'missing'; readonly reason: ViewProofMissingReason }
  | { readonly verdict: 'invalid'; readonly reason: Exclude<ViewProofInvalidReason, 'verifier_error'> }
  | { readonly verdict: 'invalid'; readonly reason: 'verifier_error'; readonly errorClass: string };

/** One call to verify: the proof as received, and what the server knows of the call. */
export interface VerifyViewProofInput {
  /**
   * The request's `params._meta` as received (a handler's
   * `ctx.requestMeta`); `undefined` when the request carried none. The
   * proof is its `"ai.ggui/view"` key.
   */
  readonly requestMeta: Readonly<Record<string, unknown>> | undefined;
  readonly toolName: ViewProofTool;
  /** The call's arguments after the server's own input validation. */
  readonly args: JsonObject;
  /** The session the call names (`args.sessionId`). */
  readonly sessionId: string;
  /** The caller's proved app (`ctx.appId`), never the app the arguments declare. */
  readonly appId: string;
}

/**
 * Compare a received tag with the expected one as their canonical
 * base64url strings, in constant time. Comparing decoded bytes would
 * accept a non-canonical last character (base64url ignores its low bits),
 * so two different proof strings could carry one tag.
 */
function tagEquals(expected: Buffer, received: string): boolean {
  const want = Buffer.from(b64u(expected), 'ascii');
  const got = Buffer.from(received, 'ascii');
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Verify a view proof, in the order that names the first failure:
 * presence (`missing`), grammar, key id, `callmac` (from here the nonce,
 * the view clock, the flags and `argmac` are authenticated), the session,
 * the app, and last `argmac`, whose canonicalization runs only after
 * `callmac` passed. Never throws: an internal failure is `verifier_error`.
 *
 * The root's expiry is not checked, by design: a proof shows that a view
 * this server keyed signed the call, and a view outlives its first ws
 * token. `rootIat` and `rootExp` are reported for the line.
 */
export function verifyViewProof(input: VerifyViewProofInput, secret: string): ViewProofVerdict {
  try {
    if (input.requestMeta === undefined) return { verdict: 'missing', reason: 'meta_absent' };
    const raw = input.requestMeta[MCP_APP_AI_GGUI_VIEW_META_KEY];
    if (raw === undefined) return { verdict: 'missing', reason: 'key_absent' };
    if (typeof raw !== 'string') return { verdict: 'invalid', reason: 'malformed' };
    const parsed = parseViewProof(raw);
    if (!parsed.ok) return { verdict: 'invalid', reason: parsed.reason };
    const { proof } = parsed;
    if (proof.claims.kid !== defaultViewKid(secret)) return { verdict: 'invalid', reason: 'unknown_key' };
    const K = deriveViewKey(proof.root, secret);
    const expectedCall = hmac(
      K,
      viewProofCallBytes({
        toolName: input.toolName,
        nonce: proof.nonce,
        vtime: proof.vtime,
        flags: proof.flags,
        argmac: proof.argmac,
      }),
    );
    if (!tagEquals(expectedCall, proof.callmac)) return { verdict: 'invalid', reason: 'bad_mac' };
    if (proof.claims.sessionId !== input.sessionId) return { verdict: 'invalid', reason: 'session_mismatch' };
    if (proof.claims.appId !== input.appId) return { verdict: 'invalid', reason: 'app_mismatch' };
    const expectedArgs = hmac(K, viewProofArgsBytes(input.toolName, input.args));
    if (!tagEquals(expectedArgs, proof.argmac)) return { verdict: 'invalid', reason: 'args_mismatch' };
    const flags = Number.parseInt(proof.flags, 16);
    return {
      verdict: 'valid',
      kid: proof.claims.kid,
      ...(proof.claims.src !== undefined ? { src: proof.claims.src } : {}),
      rootIat: proof.claims.iat,
      rootExp: proof.claims.exp,
      vtime: Number(proof.vtime),
      userActivation: (flags & VIEW_PROOF_FLAG_USER_ACTIVATION) !== 0,
      nonce: proof.nonce,
    };
  } catch (err) {
    // An internal failure is a verdict, never a thrown call; its class is
    // named so a drift can be told from an input the canonicalizer cannot
    // take (for example arguments nested deeper than its stack).
    const errorClass = err instanceof Error ? err.name : typeof err;
    return { verdict: 'invalid', reason: 'verifier_error', errorClass: errorClass.slice(0, 64) };
  }
}

/** Whether a root `P` is short enough to carry a view key. */
export function viewRootFits(root: string): boolean {
  return root.length <= VIEW_PROOF_ROOT_MAX_CHARS;
}

/**
 * A replica-local record of `(sessionId, nonce)` pairs seen within a
 * window, for the `viewProofRepeat` observation: a lower bound on replays,
 * never a census, and never a gate. Bounded: at most `maxEntries`
 * observations are held, and the oldest go first. Each observation costs
 * O(1) amortized: eviction pops the head of an insertion-ordered queue and
 * never walks the map (a `Map` iterated from its start after deletions
 * walks every deleted slot until it rehashes).
 */
export class ViewProofRepeatCache {
  /** The latest observation of each pair: when, and its sequence number. */
  private readonly latest = new Map<string, { readonly at: number; readonly seq: number }>();
  /** Every held observation, oldest first, from `head`. */
  private readonly queue: Array<{ readonly key: string; readonly at: number; readonly seq: number }> = [];
  private head = 0;
  private seq = 0;

  constructor(
    private readonly windowMs: number = 10 * 60 * 1000,
    private readonly maxEntries: number = 10_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record the pair; true when it was already seen within the window. */
  observe(sessionId: string, nonce: string): boolean {
    const t = this.now();
    const key = `${sessionId}\u0000${nonce}`;
    const last = this.latest.get(key);
    this.seq += 1;
    this.latest.set(key, { at: t, seq: this.seq });
    this.queue.push({ key, at: t, seq: this.seq });
    this.prune(t);
    return last !== undefined && t - last.at < this.windowMs;
  }

  /** How many distinct pairs are held. */
  get size(): number {
    return this.latest.size;
  }

  private prune(t: number): void {
    while (this.head < this.queue.length) {
      const oldest = this.queue[this.head];
      if (oldest === undefined) break;
      if (this.queue.length - this.head <= this.maxEntries && t - oldest.at < this.windowMs) break;
      this.head += 1;
      // Only the pair's latest observation forgets it; an older one is spent.
      if (this.latest.get(oldest.key)?.seq === oldest.seq) this.latest.delete(oldest.key);
    }
    // Drop the spent prefix once it is most of the array: O(1) amortized.
    if (this.head > 1024 && this.head * 2 > this.queue.length) {
      this.queue.splice(0, this.head);
      this.head = 0;
    }
  }
}
