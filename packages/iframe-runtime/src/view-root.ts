/**
 * The view's key root (ggui#1415): what the parse captures from a render
 * slice, and which root the view proves its app-only runtime calls with.
 *
 * A slice that carries a `viewKey` roots it in its `wsToken`: `K` is
 * derived by the server from `P`, the token's payload segment. The parse
 * takes the pair before an expired credential is dropped from the meta
 * ({@link viewRootOf}), and {@link createViewRootHolder} decides whether a
 * later slice's root replaces the one the view holds.
 */
import {
  VIEW_PROOF_ROOT_MAX_CHARS,
  decodeViewRootClaims,
  type McpAppAiGguiRenderMeta,
  type ViewRootClaims,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ViewRoot } from './types.js';

/**
 * The slice's key root: `P` from its `wsToken`, `K` from its `viewKey`.
 * `undefined` when either is absent, since a key means nothing without the
 * token it is rooted in. The protocol parser already keeps a `viewKey` only
 * beside its ws envelope and only in its shape.
 */
export function viewRootOf(
  meta: Pick<McpAppAiGguiRenderMeta, 'wsToken' | 'viewKey'>,
): ViewRoot | undefined {
  const { wsToken, viewKey } = meta;
  if (typeof viewKey !== 'string' || viewKey.length === 0) return undefined;
  if (typeof wsToken !== 'string' || wsToken.length === 0) return undefined;
  return { root: wsToken.split('.')[0] ?? '', key: viewKey };
}

/** A held root, with the claims its `P` decoded to. */
export interface HeldViewRoot extends ViewRoot {
  readonly claims: ViewRootClaims;
}

/**
 * Why an offered root was not adopted. `no_key`: the slice carried none (a
 * `/state` poll, a keyless door). `oversize`: `P` is longer than a proof can
 * carry. `malformed`: `P` does not decode to ws claims. `session_mismatch`:
 * `P` names another session than the slice. `not_newer`: the view already
 * holds a root for this session at the same or a later `iat`.
 */
export type ViewRootRefusal = 'no_key' | 'oversize' | 'malformed' | 'session_mismatch' | 'not_newer';

export type ViewRootOffer =
  | { readonly adopted: true }
  | { readonly adopted: false; readonly reason: ViewRootRefusal };

export interface ViewRootHolder {
  /** Offer the root a slice for `sessionId` carried. */
  offer(sessionId: string, root: ViewRoot | undefined): ViewRootOffer;
  /** The held root, only when it was adopted for `sessionId`. */
  current(sessionId: string): HeldViewRoot | undefined;
}

/**
 * One view's key root. It adopts a root only when `P` fits a proof and
 * decodes to the offering slice's own session. For the session it already
 * holds, it adopts only a greater `iat`, so a replayed or reordered slice
 * never winds the root back. A slice for another session replaces it: a
 * view proves calls only for the session they name.
 */
export function createViewRootHolder(): ViewRootHolder {
  let held: HeldViewRoot | undefined;
  return {
    offer(sessionId, root) {
      if (root === undefined) return { adopted: false, reason: 'no_key' };
      if (root.root.length > VIEW_PROOF_ROOT_MAX_CHARS) return { adopted: false, reason: 'oversize' };
      const claims = decodeViewRootClaims(root.root);
      if (typeof claims === 'string') return { adopted: false, reason: 'malformed' };
      if (claims.sessionId !== sessionId) return { adopted: false, reason: 'session_mismatch' };
      if (held !== undefined && held.claims.sessionId === sessionId && claims.iat <= held.claims.iat) {
        return { adopted: false, reason: 'not_newer' };
      }
      held = { root: root.root, key: root.key, claims };
      return { adopted: true };
    },
    current(sessionId) {
      return held !== undefined && held.claims.sessionId === sessionId ? held : undefined;
    },
  };
}
