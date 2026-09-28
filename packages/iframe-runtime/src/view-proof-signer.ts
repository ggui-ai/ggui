/**
 * The view's prover (ggui#1415): the one wrapper every `tools/call` of the
 * three app-only runtime tools goes through.
 *
 * {@link ViewProver.withViewProof} sends the JSON-normalized arguments and,
 * when the view holds a key root for the call's session, a v1 proof at
 * `_meta["ai.ggui/view"]`, the only `_meta` key it sets. Any other tool
 * passes through untouched. It never throws and never changes whether or
 * where a call is sent: a failure means the call goes without a proof.
 *
 * The HMAC is synchronous (`@noble/hashes`), so wrapping a raw send keeps
 * its place in the send order, and it works where `crypto.subtle` is absent
 * (a plain-http self-host).
 */
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_PROOF_FLAG_USER_ACTIVATION,
  VIEW_PROOF_V1_PATTERN,
  formatViewProofV1,
  isViewProofTool,
  viewProofArgsBytes,
  viewProofCallBytes,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { JsonObject, JsonValue } from '@ggui-ai/protocol/wire';
import type { ViewRootHolder } from './view-root.js';

/** A `tools/call` request's params, as a view sends them. */
export interface ViewToolCall<A> {
  readonly name: string;
  readonly arguments: A;
  readonly _meta?: { readonly [MCP_APP_AI_GGUI_VIEW_META_KEY]: string };
}

export interface ViewProofOptions {
  /**
   * Whether the gesture carried transient user activation, read at dispatch
   * entry (`navigator.userActivation.isActive`). Sets flag bit 0. Measured,
   * never enforced: any holder of the key can set it.
   */
  readonly userActivation?: boolean;
}

export interface ViewProver {
  withViewProof<A extends object>(name: string, args: A, opts?: ViewProofOptions): ViewToolCall<A | JsonObject>;
}

export interface ViewProverDeps {
  readonly roots: ViewRootHolder;
  /** Epoch milliseconds. Defaults to the clock captured when this module loaded. */
  readonly now?: () => number;
  /** Fills `bytes` with random values. Defaults to the source captured when this module loaded. */
  readonly randomBytes?: (bytes: Uint8Array) => void;
}

// Captured when the runtime bundle evaluates, before any card code runs in
// this realm, so a card that replaces these globals later does not reach
// the prover.
const capturedNow: () => number = Date.now.bind(Date);
const capturedCrypto: Crypto | undefined = typeof crypto !== 'undefined' ? crypto : undefined;
const capturedGetRandomValues = capturedCrypto?.getRandomValues.bind(capturedCrypto);

function capturedRandomBytes(bytes: Uint8Array): void {
  if (capturedGetRandomValues === undefined) throw new Error('no random source');
  capturedGetRandomValues(bytes);
}

const NONCE_BYTES = 16;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

function fromBase64Url(text: string): Uint8Array {
  if (!BASE64URL.test(text)) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  return Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The arguments as JSON carries them, or `undefined` when JSON cannot carry them. */
function normalize(args: object): JsonObject | undefined {
  try {
    const text = JSON.stringify(args);
    if (text === undefined) return undefined;
    const value: JsonValue = JSON.parse(text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    // A BigInt or a cycle: JSON cannot carry these arguments, so there is
    // nothing to sign, and the call goes as the caller built it.
    return undefined;
  }
}

/** A prover over the view's key root holder. */
export function createViewProver(deps: ViewProverDeps): ViewProver {
  const now = deps.now ?? capturedNow;
  const randomBytes = deps.randomBytes ?? capturedRandomBytes;
  return {
    withViewProof(name, args, opts) {
      if (!isViewProofTool(name)) return { name, arguments: args };
      const normalized = normalize(args);
      if (normalized === undefined) return { name, arguments: args };
      const sessionId = normalized['sessionId'];
      const root = typeof sessionId === 'string' ? deps.roots.current(sessionId) : undefined;
      if (root === undefined) return { name, arguments: normalized };
      try {
        const key = fromBase64Url(root.key);
        const argmac = toBase64Url(hmac(sha256, key, viewProofArgsBytes(name, normalized)));
        const nonceBytes = new Uint8Array(NONCE_BYTES);
        randomBytes(nonceBytes);
        const nonce = toBase64Url(nonceBytes);
        const vtime = String(Math.trunc(now()));
        const flags = (opts?.userActivation === true ? VIEW_PROOF_FLAG_USER_ACTIVATION : 0).toString(16);
        const callmac = toBase64Url(hmac(sha256, key, viewProofCallBytes({ toolName: name, nonce, vtime, flags, argmac })));
        const proof = formatViewProofV1({ root: root.root, nonce, vtime, flags, argmac, callmac });
        // A clock or a key outside the grammar makes a string no verifier
        // would parse: send none rather than one that can only fail.
        if (!VIEW_PROOF_V1_PATTERN.test(proof)) return { name, arguments: normalized };
        return { name, arguments: normalized, _meta: { [MCP_APP_AI_GGUI_VIEW_META_KEY]: proof } };
      } catch {
        // Total by contract: a failed mint sends the call without a proof,
        // which the server counts as `missing`, never a failed call.
        return { name, arguments: normalized };
      }
    },
  };
}
