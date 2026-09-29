/**
 * The canonical bytes of what a `ggui_runtime_submit_action` dispatch MEANS
 * (ggui#1519): its `intent` and its `actionData`, in RFC 8785 canonical JSON
 * (JCS), the same canonical form the view proof binds arguments with, so
 * "the same payload" means one thing across both features.
 *
 * A server derives a dispatch's gesture digest from these bytes, so that a
 * retry of the same gesture under one `actionId` can be told from the id
 * reused for a different one. `uiContext` is deliberately not an input: it
 * is the view's surrounding state when the gesture fired, not the gesture,
 * and a view's own retry may carry a newer draft.
 */
import canonicalize from 'canonicalize';
import type { JsonValue } from '../types/data-contract.js';

/** The domain label the gesture bytes open with. */
export const DISPATCH_GESTURE_LABEL_V1 = 'ai.ggui/dispatch-gesture/v1';

/**
 * `label ‖ LF ‖ JCS({intent, actionData})`. An absent `actionData` is `null`,
 * the envelope's own default. Throws on a value JCS cannot encode.
 */
export function dispatchGestureBytes(intent: string, actionData: JsonValue | null | undefined): Uint8Array {
  const canonical = canonicalize({ intent, actionData: actionData ?? null });
  if (canonical === undefined) {
    throw new TypeError('dispatchGestureBytes: the gesture has no canonical JSON form');
  }
  return new TextEncoder().encode(`${DISPATCH_GESTURE_LABEL_V1}\n${canonical}`);
}

/**
 * `ggui_runtime_submit_action`'s answer to a dispatch whose `actionId` its
 * session already recorded for a DIFFERENT gesture (ggui#1519): the id was
 * reused, the first gesture stands, and nothing of the second was recorded.
 * The view's runtime shows the user an error toast on it, as on any
 * `ok: false` (it sends no `ui/message`), so the user sees the gesture did
 * not go through; the second gesture does not reach the agent.
 *
 * DECLARED ONE RELEASE BEFORE IT IS EMITTED. The tool's output `code` is a
 * closed enum that reaches `tools/list`, so a client holding the previous
 * list must be able to parse it first. Until then, a server answers such a
 * dispatch as it answers a duplicate, and logs it.
 */
export const ACTION_ID_REUSED = 'ACTION_ID_REUSED' as const;
