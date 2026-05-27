/**
 * Host-context emitter.
 *
 * Responsibilities:
 *
 *   1. Hold the latest `HostContextProjection` the runtime has captured.
 *      Seeded from the iframe's `ui/initialize` response (Reading-A
 *      path, via `parseMetaFromUiInitialize`); updated on every
 *      `ui/notifications/host-context-changed` postMessage from the host.
 *   2. Echo each fresh value as a `type: 'host_context_observed'`
 *      WebSocket envelope so the server can persist it on
 *      `RenderRecord.hostContext` for agent visibility.
 *   3. Suppress no-op re-emissions (via deep-equality on the projection
 *      shape) — avoids server-side write traffic when a notification
 *      arrives but no projection-visible field actually changed (e.g.,
 *      the host's `theme` updated but ggui doesn't project theme).
 *
 * Lifecycle:
 *
 *   - Initial seed: `seed(projection, renderId)` called from
 *     `bootProduction` right after the WS transport is attached and we
 *     know the initial projection from `parseMetaFromUiInitialize.hostContext`.
 *   - Live updates: `attachListener()` installs a `window`-scoped
 *     `message` listener for the spec-defined notification method
 *     `'ui/notifications/host-context-changed'`. The notification's
 *     `params` carry a partial `McpUiHostContext`; we merge into the
 *     held projection and emit if changed.
 *   - Teardown: `detach()` removes the listener and clears state.
 *     Used by tests + future host-switch flows.
 *
 * Why a dedicated module:
 *
 *   - `runtime.ts` is already ~3100 lines; adding another postMessage
 *     listener + state slot bloats it.
 *   - The emission policy (seed + change-merge + dedupe) is testable in
 *     isolation without the WS transport / slice-meta parse / DOM mount.
 *   - Future widening (echo more fields, debounce burst changes, etc.)
 *     happens in one place.
 */
import {
  hostContextProjectionsEqual,
  projectHostContext,
  type HostContextObservedPayload,
  type HostContextProjection,
} from '@ggui-ai/protocol';

// =============================================================================
// Send seam
// =============================================================================

/**
 * Function the emitter calls to ship a `host_context_observed` envelope.
 * Wired by `bootProduction` to the live WS transport's `send` —
 * typically `(msg) => handle.handle.send(msg)` after subscribe ack.
 *
 * The emitter does NOT buffer pre-WS-up emissions: `seed()` MUST only
 * be called once the send seam is live. If seed is called before send
 * is wired, the initial echo is silently dropped (the WS hasn't been
 * established; the server isn't listening). This matches the
 * fire-and-forget posture of the protocol — agent visibility is
 * eventually-consistent, never blocking.
 */
export type HostContextSendFn = (msg: {
  readonly type: 'host_context_observed';
  readonly payload: HostContextObservedPayload;
}) => void;

// =============================================================================
// Module state (single-instance — one runtime per iframe)
// =============================================================================

interface EmitterState {
  readonly renderId: string;
  readonly send: HostContextSendFn;
  current: HostContextProjection;
  listener: ((ev: MessageEvent) => void) | null;
}

let state: EmitterState | null = null;

// =============================================================================
// Public surface
// =============================================================================

/**
 * Seed the emitter with the initial projection captured at boot time +
 * the live WS send seam. Idempotent: a re-seed (e.g. on reconnect with
 * the same projection) suppresses the duplicate emission via the
 * equality check.
 *
 * Re-seeding with a DIFFERENT `renderId` is undefined behavior; the
 * iframe-runtime is one-render-per-mount by construction. Tests
 * exercising multi-render flows MUST call `detach()` between seeds.
 */
export function seed(args: {
  readonly renderId: string;
  readonly send: HostContextSendFn;
  readonly initial: HostContextProjection;
}): void {
  // First seed — record state + emit initial.
  if (state === null) {
    state = {
      renderId: args.renderId,
      send: args.send,
      current: args.initial,
      listener: null,
    };
    emit();
    return;
  }
  // Re-seed — only emit if the projection actually changed. Keep the
  // existing listener registration if any.
  if (!hostContextProjectionsEqual(state.current, args.initial)) {
    state.current = args.initial;
    emit();
  }
}

/**
 * Install the `host-context-changed` notification listener on the
 * iframe `window`. Safe to call multiple times — duplicate listeners
 * are deduped via `state.listener !== null` guard.
 *
 * Detaches when `detach()` is called or when the module is torn down.
 */
export function attachListener(targetWindow: Window = window): void {
  if (state === null) {
    // Not yet seeded — listener can't usefully fire (no send seam).
    // Caller should `seed()` first; this defensive bail keeps the
    // surface idempotent rather than throwing.
    return;
  }
  if (state.listener !== null) return;

  const listener = (ev: MessageEvent): void => {
    handleHostContextChangedMessage(ev.data);
  };
  state.listener = listener;
  targetWindow.addEventListener('message', listener);
}

/**
 * Tear down: remove the listener, clear module state. Called from
 * unit tests between scenarios and from the future host-switch flow.
 */
export function detach(targetWindow: Window = window): void {
  if (state !== null && state.listener !== null) {
    targetWindow.removeEventListener('message', state.listener);
  }
  state = null;
  // Reset the local subscriber set too — module-level state is the
  // singleton's identity, and tests need clean isolation between
  // scenarios. Without this, a subscriber registered in test 1 leaks
  // into test 2's seed and fires against a stale closure.
  localSubscribers.clear();
}

/**
 * Test-only read of the current held projection. Production code
 * MUST NOT depend on this; the emitter is fire-and-forget by design.
 * @internal
 */
export function _peekCurrent(): HostContextProjection | undefined {
  return state?.current;
}

/**
 * Subscribe to local projection updates so
 * iframe-side consumers (canvas mount handle's display-mode state)
 * can react to `host-context-changed` notifications without re-
 * parsing the postMessage envelope themselves.
 *
 * Fires:
 *   - Immediately on subscribe IF `state` is already seeded (so the
 *     subscriber doesn't have to also read `parsed.hostContext`).
 *   - On every `host-context-changed` notification that updates
 *     `state.current` (post-projection, post-equality-check).
 *
 * Returns an unsubscribe function. Multi-subscriber by design —
 * tests + production canvas mount can coexist.
 */
const localSubscribers = new Set<(p: HostContextProjection) => void>();
export function subscribeLocal(
  listener: (projection: HostContextProjection) => void,
): () => void {
  localSubscribers.add(listener);
  // Fire immediately if seed has already happened.
  if (state !== null) listener(state.current);
  return () => {
    localSubscribers.delete(listener);
  };
}

// =============================================================================
// Internals
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Process an incoming postMessage payload. Filters to JSON-RPC
 * notifications with method `ui/notifications/host-context-changed`;
 * everything else is ignored. The notification's `params` is a partial
 * `McpUiHostContext` — we project and merge into the held value.
 *
 * Exported via `attachListener` indirection; isolated here so it's
 * unit-testable without dispatching real `MessageEvent`s.
 */
function handleHostContextChangedMessage(raw: unknown): void {
  if (state === null) return;
  if (!isPlainObject(raw)) return;
  if (raw['method'] !== 'ui/notifications/host-context-changed') return;
  const params = raw['params'];
  if (!isPlainObject(params)) return;

  // Spec: the notification's params carry a partial McpUiHostContext.
  // Project it (defensive — malformed inputs drop to undefined fields)
  // and merge with the held projection so a partial update overlays
  // unchanged fields cleanly.
  const partial = projectHostContext(params);
  if (partial === undefined) return;
  const merged: HostContextProjection = { ...state.current, ...partial };
  if (hostContextProjectionsEqual(state.current, merged)) return;
  state.current = merged;
  emit();
}

function emit(): void {
  if (state === null) return;
  try {
    state.send({
      type: 'host_context_observed',
      payload: {
        renderId: state.renderId,
        hostContext: state.current,
      },
    });
  } catch {
    // Send seam errored (WS detached, host disconnected, etc.). The
    // emitter is fire-and-forget; swallow + carry on. The next change
    // notification will retry. Server-side agent visibility is
    // eventually-consistent, not transactional.
  }
  // Fan out to local iframe-side subscribers
  // (canvas mount's display-mode state). Independent from the
  // WS-send try/catch above — a send failure must not skip the
  // local fan-out, and a subscriber throwing must not skip other
  // subscribers.
  for (const listener of localSubscribers) {
    try {
      listener(state.current);
    } catch {
      // Subscriber threw — swallow to keep the broadcast loop alive.
    }
  }
}
