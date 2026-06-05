/**
 * Host-context emitter + DOM application.
 *
 * Responsibilities:
 *
 *   1. Hold the latest `HostContextProjection` the runtime has captured.
 *      Seeded from the App's `ui/initialize` capture
 *      (`app.getHostContext()`); updated on every
 *      `ui/notifications/host-context-changed` postMessage from the host.
 *   2. Echo each fresh value as a `type: 'host_context_observed'`
 *      WebSocket envelope so the server can persist it on
 *      `RenderRecord.hostContext` for agent visibility.
 *   3. Suppress no-op re-emissions (via deep-equality on the projection
 *      shape) — avoids server-side write traffic when a notification
 *      arrives but no projection-visible field actually changed (e.g.,
 *      the host's `theme` updated but ggui doesn't project theme).
 *   4. Apply host theme + styles + fonts to the iframe DOM via the
 *      spec-canonical {@link applyDocumentTheme} /
 *      {@link applyHostStyleVariables} / {@link applyHostFonts} helpers
 *      from `@modelcontextprotocol/ext-apps`. Fires on EVERY raw
 *      `McpUiHostContext` the runtime observes (initial + change
 *      notifications). The application path is INDEPENDENT of the
 *      WS-echo path — projection drops `theme` / `styles` (they live in
 *      ggui's own theming pipeline), but the DOM still needs them to
 *      render the host's native primitives consistently.
 *
 * Lifecycle:
 *
 *   - Initial seed: `seed(projection, sessionId)` called from
 *     `bootProduction` right after the WS transport is attached and we
 *     know the initial projection from `projectHostContext(app.getHostContext())`.
 *     {@link applyHostContextStyling} fires separately from
 *     `bootSequence` against the RAW `app.getHostContext()` so the
 *     spec-canonical helpers see the full `McpUiHostContext`
 *     (projection drops fields they need).
 *   - Live updates: `attachListener()` installs a `window`-scoped
 *     `message` listener for the spec-defined notification method
 *     `'ui/notifications/host-context-changed'`. The notification's
 *     `params` carry a partial `McpUiHostContext`; we apply the raw
 *     fields to the DOM, merge the projection into the held value,
 *     and WS-echo if the projection changed.
 *   - Teardown: `detach()` removes the listener and clears state.
 *     Used by tests + future host-switch flows.
 *
 * Why a dedicated module:
 *
 *   - `runtime.ts` is already ~3500 lines; adding another postMessage
 *     listener + state slot bloats it.
 *   - The emission policy (seed + change-merge + dedupe) + DOM-apply
 *     policy is testable in isolation without the WS transport /
 *     slice-meta parse / DOM mount.
 *   - Future widening (echo more fields, debounce burst changes, etc.)
 *     happens in one place.
 */
import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type App,
  type McpUiHostContext,
  type McpUiHostContextChangedNotification,
} from '@modelcontextprotocol/ext-apps';
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

/**
 * Inbound-listener handle. Either the legacy raw `window.message`
 * listener (kept for tests + degraded modes where no App is wired) or
 * the spec-canonical `app.removeEventListener` cleanup closure when
 * the listener was bound via App's event surface.
 */
type ListenerHandle =
  | { readonly kind: 'window'; readonly off: () => void }
  | { readonly kind: 'app'; readonly off: () => void };

interface EmitterState {
  readonly sessionId: string;
  readonly send: HostContextSendFn;
  current: HostContextProjection;
  listener: ListenerHandle | null;
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
 * Re-seeding with a DIFFERENT `sessionId` is undefined behavior; the
 * iframe-runtime is one-render-per-mount by construction. Tests
 * exercising multi-render flows MUST call `detach()` between seeds.
 */
export function seed(args: {
  readonly sessionId: string;
  readonly send: HostContextSendFn;
  readonly initial: HostContextProjection;
}): void {
  // First seed — record state + emit initial.
  if (state === null) {
    state = {
      sessionId: args.sessionId,
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

export interface AttachListenerOptions {
  /**
   * Bind via the spec-canonical `App.addEventListener('hostcontextchanged')`
   * event surface. Production wires this — App's onEventDispatch
   * pre-merges the params into its internal `_hostContext` before
   * our handler runs, so `app.getHostContext()` is always fresh by
   * the time we project + WS-echo.
   *
   * When omitted, falls back to a raw `window.addEventListener('message')`
   * listener (the pre-1.19b.3 behavior). Tests rely on this — they
   * dispatch `MessageEvent`s directly instead of constructing a
   * connected App.
   */
  readonly app?: App;
  /**
   * Target window for the legacy raw-listener fallback. Ignored when
   * {@link AttachListenerOptions.app} is set. Defaults to `window`.
   */
  readonly targetWindow?: Window;
}

/**
 * Install the `host-context-changed` notification listener. When the
 * {@link AttachListenerOptions.app} handle is supplied, uses App's
 * spec-canonical event surface; otherwise falls back to a raw
 * `window.message` listener (tests use this).
 *
 * Safe to call multiple times — duplicate listeners are deduped via
 * `state.listener !== null` guard.
 *
 * Detaches when `detach()` is called or when the module is torn down.
 */
export function attachListener(
  optsOrWindow: AttachListenerOptions | Window = window,
): void {
  if (state === null) {
    // Not yet seeded — listener can't usefully fire (no send seam).
    // Caller should `seed()` first; this defensive bail keeps the
    // surface idempotent rather than throwing.
    return;
  }
  if (state.listener !== null) return;

  // Back-compat: callers that pass a bare `Window` (the pre-1.19b.3
  // signature, still used by tests) take the raw-listener path.
  const isWindowArg =
    optsOrWindow !== null
    && typeof optsOrWindow === 'object'
    && 'addEventListener' in (optsOrWindow as object)
    && 'removeEventListener' in (optsOrWindow as object)
    && !('app' in (optsOrWindow as object));
  const opts: AttachListenerOptions = isWindowArg
    ? { targetWindow: optsOrWindow as Window }
    : (optsOrWindow as AttachListenerOptions);

  if (opts.app !== undefined) {
    const handler = (
      params: McpUiHostContextChangedNotification['params'],
    ): void => {
      handleHostContextChangedParams(params as Record<string, unknown>);
    };
    opts.app.addEventListener('hostcontextchanged', handler);
    state.listener = {
      kind: 'app',
      off: () => opts.app!.removeEventListener('hostcontextchanged', handler),
    };
    return;
  }

  const targetWindow = opts.targetWindow ?? window;
  const listener = (ev: MessageEvent): void => {
    handleHostContextChangedMessage(ev.data);
  };
  targetWindow.addEventListener('message', listener);
  state.listener = {
    kind: 'window',
    off: () => targetWindow.removeEventListener('message', listener),
  };
}

/**
 * Tear down: remove the listener, clear module state. Called from
 * unit tests between scenarios and from the future host-switch flow.
 *
 * The `targetWindow` parameter is no longer used (the listener handle
 * carries its own cleanup closure); preserved as an optional arg for
 * back-compat with existing test code.
 */
export function detach(_targetWindow: Window = window): void {
  if (state !== null && state.listener !== null) {
    state.listener.off();
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
// DOM application — spec-canonical theme / styles / fonts.
// =============================================================================

/**
 * Apply the host's `theme`, `styles.variables`, `styles.css.fonts`, and
 * `safeAreaInsets` to the iframe DOM via the canonical
 * `@modelcontextprotocol/ext-apps` helpers. Defensive in two ways:
 *
 *   1. Accepts `unknown` so callers (the listener; `bootSequence`'s
 *      initial-application path) don't have to gate-check before calling.
 *   2. Per-field optionality is respected — every helper is called only
 *      when the corresponding field is present + structurally valid.
 *      Malformed input drops the field silently rather than throwing
 *      and breaking the boot.
 *
 * Fire-and-forget: a helper throwing (e.g. when running outside a
 * browser DOM context, or under jsdom limits) is caught + swallowed so
 * the WS-echo path stays alive. Theme application is a UX nicety,
 * never load-bearing for agent visibility.
 *
 * @public
 */
export function applyHostContextStyling(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  const ctx = raw as McpUiHostContext;
  try {
    if (ctx.theme === 'light' || ctx.theme === 'dark') {
      applyDocumentTheme(ctx.theme);
    }
  } catch {
    // jsdom may not implement every documentElement API the helper
    // touches; swallow + carry on with the remaining fields.
  }
  try {
    const variables = ctx.styles?.variables;
    if (variables !== undefined && variables !== null) {
      applyHostStyleVariables(variables);
    }
  } catch {
    // Same posture — best-effort. A subscriber throwing must not stop
    // the WS-echo half of the listener.
  }
  try {
    const fontsCss = ctx.styles?.css?.fonts;
    if (typeof fontsCss === 'string' && fontsCss.length > 0) {
      applyHostFonts(fontsCss);
    }
  } catch {
    // applyHostFonts injects a <style> tag; jsdom may reject the
    // operation under strict modes. Swallow.
  }
  // safeAreaInsets — the spec carries these for mobile chrome
  // letterboxing. ext-apps doesn't ship a canonical helper (apps
  // typically apply per-component); the system-card reference applies
  // as root padding. ggui's iframe contains LLM-generated UI which has
  // its own responsive concerns — skip safe-area for now; revisit when
  // a concrete mobile use case appears.
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
 * everything else is ignored. Delegates to {@link handleHostContextChangedParams}
 * once the envelope shape is validated.
 *
 * Used by the legacy `window.message` listener path; App's event surface
 * skips this filter (App's own dispatch has already matched the method).
 */
function handleHostContextChangedMessage(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  if (raw['method'] !== 'ui/notifications/host-context-changed') return;
  const params = raw['params'];
  if (!isPlainObject(params)) return;
  handleHostContextChangedParams(params);
}

/**
 * Apply a `ui/notifications/host-context-changed` params payload to
 * the iframe DOM + projection state + WS-echo. Called by both delivery
 * paths (raw window.message in tests / App's `hostcontextchanged`
 * event in production) once they've extracted the partial-context
 * payload.
 *
 * Exported (module-private) so the App listener can call directly
 * without re-validating the JSON-RPC envelope.
 */
function handleHostContextChangedParams(params: Record<string, unknown>): void {
  if (state === null) return;

  // Apply spec-canonical theme/styles/fonts to the iframe DOM BEFORE
  // the WS-echo path. The DOM-apply path covers fields the projection
  // drops (theme, styles) so the LLM-generated UI inside the iframe
  // re-paints to match a host theme switch even when nothing
  // projection-visible changed (e.g., dark/light toggle).
  applyHostContextStyling(params);

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
        sessionId: state.sessionId,
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
