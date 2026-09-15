/**
 * The dismiss INTENT the card forwards and never acts on (ggui#1109).
 *
 * An MCP-Apps card is an iframe: a key pressed while focus is inside its
 * document never reaches the page around it. So a user who has just clicked
 * the card — the exact moment they press Escape to close it — presses it into
 * a document that has no reason to care and no way to pass it on. Before this,
 * the runtime had NO keydown listener at all, and the surrounding host could
 * add a perfect one and still never hear that gesture.
 *
 * What the card guarantees (protocol's docblock on `McpAppDismissMessage`, and
 * this module is its implementation): it emits on the gesture, at most ONE
 * intent per gesture — a held key auto-repeating is one gesture, so repeats are
 * skipped — it does NOT act on it (no unmount, no visual dismissal, no state
 * change), and it never learns whether the host honoured it. Ignoring is
 * conformant: the host owns the surface.
 */
import {
  MCP_APP_DISMISS_TYPE,
  type McpAppDismissMessage,
  type McpAppDismissReason,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/** The key that means "close this", as the platform names it. */
const ESCAPE_KEY = 'Escape';

let installed: ((ev: KeyboardEvent) => void) | null = null;

/** Post one intent to the embedding host. Best-effort, like every other parent post. */
export function postDismissIntent(reason: McpAppDismissReason): void {
  if (typeof window === 'undefined' || window.parent === null) return;
  const message: McpAppDismissMessage = { type: MCP_APP_DISMISS_TYPE, reason };
  try {
    window.parent.postMessage(message, '*');
  } catch {
    // Parent unreachable (detached window). Fire-and-forget — the same posture
    // every other outbound notification takes, and dismissing is the host's
    // decision anyway.
  }
}

/**
 * Listen for the dismiss gesture inside the card document and forward it.
 * Idempotent: a second call replaces the first listener rather than stacking a
 * second one, so a re-boot in the same document cannot double-post.
 */
export function installDismissIntentListener(doc: Document = document): void {
  removeDismissIntentListener(doc);
  const listener = (ev: KeyboardEvent): void => {
    if (ev.key !== ESCAPE_KEY) return;
    // A held key auto-repeating is ONE gesture (protocol's guarantee): a user
    // leaning on Escape must not flood the host with intents.
    if (ev.repeat) return;
    // The gesture is NOT consumed: no `preventDefault`, no `stopPropagation`.
    // Anything else inside the card that listens for Escape — a menu, a
    // combobox — keeps hearing it, and the host hears it too. The card
    // forwards; it does not decide.
    postDismissIntent('escape');
  };
  doc.addEventListener('keydown', listener);
  installed = listener;
}

/** Remove the listener (teardown; also the test seam). */
export function removeDismissIntentListener(doc: Document = document): void {
  if (installed === null) return;
  doc.removeEventListener('keydown', installed);
  installed = null;
}
