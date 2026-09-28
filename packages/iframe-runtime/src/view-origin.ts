/**
 * The document's view origin (ggui#1415): its one key-root holder, the
 * prover over it, and the user-activation reading a dispatch signs with.
 *
 * One per document, like the mount it proves for. The boot and every later
 * tool result offer their slice's root to {@link documentViewRoots}; every
 * `tools/call` of the three app-only runtime tools goes through
 * {@link withViewProof}. Everything here is held in this module's closure
 * and captured when the runtime bundle evaluates, before card code runs.
 */
import type { JsonObject } from '@ggui-ai/protocol/wire';
import { createViewRootHolder, type ViewRootHolder } from './view-root.js';
import { createViewProver, type ViewProofOptions, type ViewToolCall } from './view-proof-signer.js';

/** The document's view key root. */
export const documentViewRoots: ViewRootHolder = createViewRootHolder();

const documentProver = createViewProver({ roots: documentViewRoots });

/**
 * The one wrapper for a view's `tools/call`: the normalized arguments, and a
 * proof at `_meta["ai.ggui/view"]` for the three app-only runtime tools when
 * the document holds a root for the call's session. Any other tool passes
 * through untouched. Never throws.
 */
export function withViewProof<A extends object>(
  name: string,
  args: A,
  opts?: ViewProofOptions,
): ViewToolCall<A | JsonObject> {
  return documentProver.withViewProof(name, args, opts);
}

// `navigator.userActivation` and its `isActive` getter, captured before card
// code can replace either.
const capturedActivation: UserActivation | undefined =
  typeof navigator !== 'undefined' && navigator.userActivation !== undefined ? navigator.userActivation : undefined;
const capturedIsActive: (() => unknown) | undefined =
  capturedActivation !== undefined
    ? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(capturedActivation), 'isActive')?.get
    : undefined;

/**
 * Whether the current task carries transient user activation, read through
 * the accessor captured at load. `false` where the browser does not expose
 * it. A dispatch reads it at entry and signs it as flag bit 0: measured,
 * never enforced.
 */
export function userActivationIsActive(): boolean {
  if (capturedActivation === undefined) return false;
  if (capturedIsActive !== undefined) return capturedIsActive.call(capturedActivation) === true;
  return capturedActivation.isActive;
}
