/**
 * View-origin proof v1 (ggui#1415): the wire grammar and the exact bytes a
 * view signs and a server verifies, for the app-only runtime tools.
 *
 * An iframe view proves that a `tools/call` came from the view the server
 * delivered: it holds `(P, K)` from its `ai.ggui/render` slice (`P` is the
 * payload segment of its ws envelope, `K` the slice's `viewKey`) and sends
 * one string at `params._meta["ai.ggui/view"]` on the request. A relay
 * forwards that string verbatim; the server recomputes `K` from `P` and
 * its secret and checks two HMAC tags.
 *
 * This module holds no crypto: the HMAC runs in `@ggui-ai/mcp-server-core`
 * (`node:crypto`) and in the iframe runtime. It fixes the names, the
 * shapes and the bytes both sides MAC, so the two implementations cannot
 * drift apart. {@link VIEW_PROOF_V1_VECTORS} pins them with known answers.
 */
import canonicalize from 'canonicalize';
import type { JsonObject, JsonValue } from '../types/data-contract.js';

/** The request `_meta` key a view's proof rides at. The value is one string. */
export const MCP_APP_AI_GGUI_VIEW_META_KEY = 'ai.ggui/view' as const;

/**
 * The longest proof a relay door admits, for every version. A v1 proof is
 * at most {@link VIEW_PROOF_V1_MAX_CHARS} characters; the rest is headroom.
 */
export const VIEW_PROOF_MAX_CHARS = 1024;

/**
 * The relay door shape, fixed for every version: ASCII, no escaping needed
 * in JSON, a URL, a header or a log line. A relay MAY check it and MAY log
 * the value; it MUST NOT alter, trim, case-fold, re-encode or truncate it.
 * The version tag and the fields belong to the verifier, not to this shape.
 */
export const VIEW_PROOF_RELAY_SHAPE = /^[A-Za-z0-9._-]{1,1024}$/;

/** The v1 grammar: `v1.root.nonce.vtime.flags.argmac.callmac`. */
export const VIEW_PROOF_V1_PATTERN =
  /^v1\.([A-Za-z0-9_-]{16,768})\.([A-Za-z0-9_-]{22})\.([1-9][0-9]{0,14})\.([0-9a-f]{1,2})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

/** The longest v1 proof: 2+1+768+1+22+1+15+1+2+1+43+1+43. */
export const VIEW_PROOF_V1_MAX_CHARS = 901;

/**
 * The longest root `P` (the ws envelope's payload segment) a proof can
 * carry. `P` grows with `sessionId` and `appId`, neither of which protocol
 * caps, so a minting door issues no view key for a longer `P`.
 */
export const VIEW_PROOF_ROOT_MAX_CHARS = 768;

/** Bit 0 of `flags`: the gesture carried transient user activation (dispatch). */
export const VIEW_PROOF_FLAG_USER_ACTIVATION = 0x1;

/** The label a view key is derived under: `HMAC(secret, label ‖ 0x00 ‖ P)`. */
export const VIEW_KEY_LABEL_V1 = 'ai.ggui/view-key/v1';
/** The label a secret's default key id is derived under. */
export const VIEW_KID_LABEL_V1 = 'ai.ggui/kid/v1';
/** The label the bound arguments are MACed under. */
export const VIEW_ARGS_LABEL_V1 = 'ai.ggui/view-args/v1';
/** The label the call is MACed under. */
export const VIEW_CALL_LABEL_V1 = 'ai.ggui/view-call/v1';

/**
 * The Plane-3 result code a runtime tool answers when a proof is required
 * and not valid (SPEC §7.9: a result field on the tool's closed output,
 * never thrown). Declared on `ggui_runtime_submit_action` and
 * `ggui_runtime_sync_context` one release before any server emits it. It
 * is not an auth-class refusal: the caller owns the session, and the
 * runtime acts on it by re-mounting.
 */
export const VIEW_ORIGIN_UNPROVEN = 'VIEW_ORIGIN_UNPROVEN' as const;

/**
 * The arguments each tool's proof binds, frozen for v1. `bound(tool, args)`
 * is the object of the listed keys that are present and not `undefined`.
 * Bound: every field the protocol forbids a relay to change. Left out:
 * `ggui_runtime_pull`'s `wait`, which a relay MUST clamp to its own
 * timeout. Changing this table is a new label (`/v2`).
 */
export const VIEW_PROOF_V1_BOUND_ARGS = {
  ggui_runtime_submit_action: ['kind', 'payload', 'sessionId', 'appId', 'actionId', 'firedAt'],
  ggui_runtime_sync_context: ['sessionId', 'appId', 'snapshot'],
  ggui_runtime_pull: ['sessionId', 'sinceSequence', 'limit'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** A tool whose calls carry a view proof. */
export type ViewProofTool = keyof typeof VIEW_PROOF_V1_BOUND_ARGS;

/** Whether `name` is a tool whose calls carry a view proof. */
export function isViewProofTool(name: string): name is ViewProofTool {
  return Object.hasOwn(VIEW_PROOF_V1_BOUND_ARGS, name);
}

/** The bound arguments: the listed keys of `args` that are present and not `undefined`. */
export function viewProofBoundArgs(tool: ViewProofTool, args: JsonObject): JsonObject {
  const bound: { [key: string]: JsonValue } = {};
  for (const key of VIEW_PROOF_V1_BOUND_ARGS[tool]) {
    const value = args[key];
    if (value !== undefined) bound[key] = value;
  }
  return bound;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const LF = new Uint8Array([0x0a]);
const NUL = new Uint8Array([0x00]);

/**
 * The message a view key is the HMAC of: `label ‖ 0x00 ‖ P`, keyed by the
 * UTF-8 secret that signed `P`.
 */
export function viewKeyInputBytes(root: string): Uint8Array {
  return concat([utf8(VIEW_KEY_LABEL_V1), NUL, utf8(root)]);
}

/**
 * `A`, the bytes `argmac` MACs: `label ‖ LF ‖ JCS(bound(tool, args))`,
 * over the arguments' JSON values (RFC 8785 canonical JSON). A signer
 * normalizes first (`JSON.parse(JSON.stringify(...))`) and sends the
 * normalized arguments. Throws on a value JCS cannot encode.
 */
export function viewProofArgsBytes(tool: ViewProofTool, args: JsonObject): Uint8Array {
  const canonical = canonicalize(viewProofBoundArgs(tool, args));
  if (canonical === undefined) {
    throw new TypeError(`viewProofArgsBytes: the bound arguments of ${tool} have no canonical JSON form`);
  }
  return concat([utf8(VIEW_ARGS_LABEL_V1), LF, utf8(canonical)]);
}

/** The fields of a call `callmac` covers, besides the tool name. */
export interface ViewProofCallFields {
  readonly toolName: string;
  readonly nonce: string;
  readonly vtime: string;
  readonly flags: string;
  readonly argmac: string;
}

/**
 * `M`, the bytes `callmac` MACs:
 * `label ‖ LF ‖ toolName ‖ LF ‖ nonce ‖ LF ‖ vtime ‖ LF ‖ flags ‖ LF ‖ argmac`.
 */
export function viewProofCallBytes(call: ViewProofCallFields): Uint8Array {
  return concat([
    utf8(VIEW_CALL_LABEL_V1),
    LF,
    utf8(call.toolName),
    LF,
    utf8(call.nonce),
    LF,
    utf8(call.vtime),
    LF,
    utf8(call.flags),
    LF,
    utf8(call.argmac),
  ]);
}

/**
 * The key-issuing doors a root can name in its `src` claim: `result` (a
 * render or update tool result) and `read` (a view's `resources/read`).
 * The only list of them. A closed set: a root naming any other value is
 * refused (`parseViewProof` reads it `malformed`, the ws token verifier
 * `malformed_claims`). So a new door's value is added here one release
 * BEFORE any door mints with it, and a door mints it only once no replica
 * that refuses it is left in the roll (VERSION-POLICY §3.6, the sender
 * obligation). Adding a value and minting with it in one release makes
 * every older replica in a roll refuse that door's tokens.
 */
export const VIEW_ROOT_SRC = ['result', 'read'] as const;
export type ViewRootSrc = (typeof VIEW_ROOT_SRC)[number];

/** Whether a value is one of {@link VIEW_ROOT_SRC}. */
export function isViewRootSrc(value: unknown): value is ViewRootSrc {
  return value === 'result' || value === 'read';
}

/** The claims a proof's root `P` carries, as the verifier reads them. */
export interface ViewRootClaims {
  readonly sessionId: string;
  readonly appId: string;
  readonly kind: 'ws';
  readonly iat: number;
  readonly exp: number;
  readonly jti: string;
  readonly kid: string;
  /** The key-issuing door: one of {@link VIEW_ROOT_SRC}, a closed set (read its rule before widening it). */
  readonly src?: ViewRootSrc;
}

/** A parsed v1 proof: its fields, and the claims its root decodes to (not yet authenticated). */
export interface ParsedViewProofV1 {
  readonly version: 'v1';
  readonly root: string;
  readonly nonce: string;
  readonly vtime: string;
  readonly flags: string;
  readonly argmac: string;
  readonly callmac: string;
  readonly claims: ViewRootClaims;
}

/**
 * Why a proof could not be parsed. `malformed`: not a string, longer than
 * the door admits, off the door shape or the v1 grammar, or a root that is
 * not a claims object. `version_unknown`: door-shaped with a version tag
 * other than `v1`. `wrong_kind`: a root whose `kind` is not `ws`.
 */
export type ViewProofParseFailure = 'malformed' | 'version_unknown' | 'wrong_kind';

export type ViewProofParse =
  | { readonly ok: true; readonly proof: ParsedViewProofV1 }
  | { readonly ok: false; readonly reason: ViewProofParseFailure };

const VERSION_TAG = /^v([0-9]+)\./;

function base64UrlDecode(segment: string): string | undefined {
  try {
    const padded = segment.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((segment.length + 3) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not base64url, or not UTF-8: the caller reports the root malformed.
    return undefined;
  }
}

/** A root the v1 grammar can carry: the `root` group of {@link VIEW_PROOF_V1_PATTERN}. */
const VIEW_ROOT_V1_SHAPE = /^[A-Za-z0-9_-]{16,768}$/;

/**
 * Decode a root `P` to the claims it carries, unauthenticated: what
 * {@link parseViewProof} reads from a proof's root, and what a view reads
 * from its own root before it signs with it. `malformed`: not a root the v1
 * grammar can carry (base64url, 16 to {@link VIEW_PROOF_ROOT_MAX_CHARS}
 * characters), or not a claims object; `wrong_kind`: a root whose `kind`
 * is not `ws`. Never throws.
 */
export function decodeViewRootClaims(root: string): ViewRootClaims | ViewProofParseFailure {
  if (!VIEW_ROOT_V1_SHAPE.test(root)) return 'malformed';
  const text = base64UrlDecode(root);
  if (text === undefined) return 'malformed';
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A root that is not JSON is malformed; nothing else can be said of it.
    return 'malformed';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'malformed';
  const { sessionId, appId, kind, iat, exp, jti, kid, src } = parsed;
  if (
    typeof sessionId !== 'string' ||
    typeof appId !== 'string' ||
    typeof jti !== 'string' ||
    typeof kid !== 'string' ||
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    (src !== undefined && !isViewRootSrc(src))
  ) {
    return 'malformed';
  }
  if (kind !== 'ws') return 'wrong_kind';
  return { sessionId, appId, kind, iat, exp, jti, kid, ...(src !== undefined ? { src } : {}) };
}

/**
 * Parse a proof value without authenticating it. The root's claims are
 * decoded only so a verifier can pick a secret and name a reason; nothing
 * here is trusted until `callmac` checks.
 */
export function parseViewProof(value: JsonValue | undefined): ViewProofParse {
  if (typeof value !== 'string' || !VIEW_PROOF_RELAY_SHAPE.test(value)) return { ok: false, reason: 'malformed' };
  const tag = VERSION_TAG.exec(value);
  if (tag !== null && tag[1] !== '1') return { ok: false, reason: 'version_unknown' };
  const m = VIEW_PROOF_V1_PATTERN.exec(value);
  if (m === null) return { ok: false, reason: 'malformed' };
  const [, root, nonce, vtime, flags, argmac, callmac] = m;
  if (
    root === undefined ||
    nonce === undefined ||
    vtime === undefined ||
    flags === undefined ||
    argmac === undefined ||
    callmac === undefined
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const claims = decodeViewRootClaims(root);
  if (typeof claims === 'string') return { ok: false, reason: claims };
  return { ok: true, proof: { version: 'v1', root, nonce, vtime, flags, argmac, callmac, claims } };
}

/** Assemble a v1 proof string from its fields. */
export function formatViewProofV1(fields: Omit<ParsedViewProofV1, 'version' | 'claims'>): string {
  return ['v1', fields.root, fields.nonce, fields.vtime, fields.flags, fields.argmac, fields.callmac].join('.');
}

/**
 * Known-answer vectors for v1, derived with `node:crypto` from the byte
 * builders above. A signer and a verifier each reproduce them: the key,
 * both tags and the proof.
 */
export const VIEW_PROOF_V1_VECTORS = [
  {
    name: 'submit_action dispatch, render_<uuid> session',
    secret: 'test-secret-do-not-use',
    kid: 'a_lK9Gzz',
    root: 'eyJzZXNzaW9uSWQiOiJyZW5kZXJfM2YyYTljMWUtN2I0ZC00ZThhLTljMmYtMGQxZTJmM2E0YjVjIiwiYXBwSWQiOiJhcHBfZGVtbyIsImtpbmQiOiJ3cyIsImlhdCI6MTc5MDAwMDAwMCwiZXhwIjoxNzkwMDAwMTgwLCJqdGkiOiJBQUVDQXdRRkJnY0lDUW9MIiwia2lkIjoiYV9sSzlHenoiLCJzcmMiOiJyZXN1bHQifQ',
    toolName: 'ggui_runtime_submit_action',
    args: {
      kind: 'dispatch',
      payload: { intent: 'submit', actionData: { answer: 'yes' }, uiContext: { draft: '' } },
      sessionId: 'render_3f2a9c1e-7b4d-4e8a-9c2f-0d1e2f3a4b5c',
      appId: 'app_demo',
      actionId: 'a3f2b1d4',
      firedAt: '2026-09-28T10:00:00.000Z',
    },
    canonicalArgs:
      '{"actionId":"a3f2b1d4","appId":"app_demo","firedAt":"2026-09-28T10:00:00.000Z","kind":"dispatch","payload":{"actionData":{"answer":"yes"},"intent":"submit","uiContext":{"draft":""}},"sessionId":"render_3f2a9c1e-7b4d-4e8a-9c2f-0d1e2f3a4b5c"}',
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    vtime: '1790000123456',
    flags: '1',
    viewKey: 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A',
    argmac: 'UfHB9A4ceFnIrNTe9E7ZS8rMsbyxreQ2RpNLAyWFJeI',
    callmac: '_6gyTylA8UEEKcv6e9DYZKKwtUf_0GDJ0NyEYu5hqkE',
    proof:
      'v1.eyJzZXNzaW9uSWQiOiJyZW5kZXJfM2YyYTljMWUtN2I0ZC00ZThhLTljMmYtMGQxZTJmM2E0YjVjIiwiYXBwSWQiOiJhcHBfZGVtbyIsImtpbmQiOiJ3cyIsImlhdCI6MTc5MDAwMDAwMCwiZXhwIjoxNzkwMDAwMTgwLCJqdGkiOiJBQUVDQXdRRkJnY0lDUW9MIiwia2lkIjoiYV9sSzlHenoiLCJzcmMiOiJyZXN1bHQifQ.AAECAwQFBgcICQoLDA0ODw.1790000123456.1.UfHB9A4ceFnIrNTe9E7ZS8rMsbyxreQ2RpNLAyWFJeI._6gyTylA8UEEKcv6e9DYZKKwtUf_0GDJ0NyEYu5hqkE',
  },
] as const;
