/**
 * Renderer-side emission of MCP App lifecycle events — the postMessage
 * envelope the iframe posts to its parent on every mount-state
 * transition. Mirrors the `<McpAppIframe>` host's outer-DOM mirror
 * (`data-ggui-mcp-app-iframe-lifecycle="<state>"`); together they form
 * a first-class wire surface so observers (E2E tests, accessibility
 * scanners, third-party hosts, console inspectors) can read mount
 * state without reaching into iframe-internal DOM.
 *
 * Lives here (not in `runtime.ts`) so spec-level tests can import the
 * helper without dragging in the runtime's autostart side effects.
 *
 * **Producer obligations** (locked by
 * {@link import('@ggui-ai/protocol/integrations/mcp-apps').McpAppLifecycleMessage}):
 *   - `mounting` MUST fire before bundle eval / first WS attempt.
 *   - Exactly one terminal state (`code-ready` or `error`) MUST follow
 *     for every successful boot attempt.
 *   - `disconnected` MAY follow `code-ready` on WS close; a subsequent
 *     `code-ready` MAY follow on successful reconnect (not required).
 *
 * @public
 */
import {
  MCP_APP_LIFECYCLE_TYPE,
  type McpAppLifecycleEvent,
  type McpAppLifecycleMessage,
  type McpAppLifecycleState,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Caller sink for lifecycle events. Mirrors the
 * {@link import('./observability.js').ObservabilityEmitter} posture —
 * tests inject a recorder; production binds the postMessage-to-parent
 * default {@link postLifecycleToParent}.
 *
 * Handlers MUST NOT throw — lifecycle events are fire-and-forget. A
 * throwing handler would mask the underlying state transition (the
 * renderer has already committed to the new state by the time emit
 * runs).
 *
 * @public
 */
export type LifecycleEmitter = (event: McpAppLifecycleEvent) => void;

/**
 * Default emitter — posts a {@link McpAppLifecycleMessage} envelope to
 * `window.parent`. Mirrors `postObservabilityToParent` /
 * `postBootFailure` posture: swallows postMessage failure when the
 * parent is unreachable so a detached parent doesn't crash the iframe.
 *
 * Non-browser import graphs (vitest+jsdom before a window mock lands)
 * have no `window.parent`; the early return guards that case so tests
 * importing this helper can do so before staging their `window` mocks.
 *
 * @public
 */
export function postLifecycleToParent(event: McpAppLifecycleEvent): void {
  if (typeof window === 'undefined' || window.parent === null) return;
  const message: McpAppLifecycleMessage = { type: MCP_APP_LIFECYCLE_TYPE, event };
  try {
    window.parent.postMessage(message, '*');
  } catch {
    // Parent unreachable (detached window) — best-effort fire-and-
    // forget. Matches postObservabilityToParent's swallow posture.
  }
}

/**
 * Build a lifecycle event payload. Centralises the `state` →
 * `McpAppLifecycleEvent` projection so call sites in
 * `runtime.ts` don't repeat the `{state, ...optional}` shape and so
 * the additive-extension semantic of `sessionId` / `error` is
 * single-sourced.
 *
 * @public
 */
export function makeLifecycleEvent(
  state: McpAppLifecycleState,
  options?: {
    readonly sessionId?: string;
    readonly error?: { readonly code: string; readonly message: string };
  },
): McpAppLifecycleEvent {
  // Avoid emitting `undefined` keys — the protocol's structural lock
  // (mcp-apps.test.ts "shape lock") asserts a populated event has
  // exactly state + sessionId + error keys, not an Object.keys-
  // observable `undefined` field.
  if (options === undefined) return { state };
  const { sessionId, error } = options;
  return {
    state,
    ...(typeof sessionId === 'string' && sessionId.length > 0
      ? { sessionId }
      : {}),
    ...(error !== undefined ? { error } : {}),
  };
}
