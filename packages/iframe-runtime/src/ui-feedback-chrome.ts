/**
 * In-iframe UI-feedback chrome mount (ggui#244).
 *
 * Mounts {@link import('./system-cards/UiFeedbackCard.js').UiFeedbackCard}
 * in its own container ADJACENT to the session root (appended to
 * `document.body`, so it sits below the rendered UI) — the same
 * append-my-own-root posture as `status-dom.ts#ensureStatusDom`.
 * Interaction egress is the existing `ggui:observe` renderer → host
 * postMessage envelope: the card builds a `ui-feedback`
 * {@link import('./observability.js').ObservabilityEvent} arm and hands
 * it to the injected emitter (production binds
 * `postObservabilityToParent`).
 *
 * Sink-reachability gate — never render a dead affordance:
 *
 *   - `window.parent !== window` → a parent window exists, the
 *     `ggui:observe` envelope has somewhere to go → mount. Parents
 *     that don't understand the envelope ignore it (best-effort emit;
 *     one postMessage of cost).
 *   - `window.parent === window` → top-level tab (the `/r/<shortCode>`
 *     share-link viewer) → NO mount. There is no parent to receive
 *     the envelope, so a rendered affordance would drop every click
 *     on the floor.
 *
 * Hosts that own DOM chrome around the iframe wire exactly ONE
 * feedback surface: either their own chrome (`onUiFeedback` on the
 * host-side SDK components) or this in-iframe affordance's
 * `ui-feedback` arm via `onObserve` — never both.
 *
 * The card + react-dom are dynamic-imported so this module stays
 * feather-weight in the runtime's base graph (mirrors the system-card
 * branch in `render-item.ts`); the import cost is only paid when the
 * gate passes.
 */
import { createElement } from 'react';
import type { ObservabilityEmitter } from './observability.js';

export interface UiFeedbackChromeOptions {
  /**
   * Observability sink the card emits `ui-feedback` events into.
   * Production passes the boot path's emitter (default
   * `postObservabilityToParent`); tests inject a recorder.
   */
  readonly emit: ObservabilityEmitter;
  /** GguiSession id stamped onto every emitted event, when known. */
  readonly sessionId?: string;
  /** Producing tool name stamped onto every emitted event, when known. */
  readonly toolName?: string;
  /**
   * Window whose `parent` is consulted for the sink-reachability
   * gate. Defaults to the global `window`; tests inject fakes so the
   * gate is exercisable without mutating jsdom's window graph.
   */
  readonly win?: Window;
}

export interface UiFeedbackChromeHandle {
  /** The appended `[data-ggui-ui-feedback-chrome]` container. */
  readonly container: HTMLElement;
  /** Tear down the React root + remove the container. */
  unmount(): void;
}

/**
 * Mount the in-iframe UI-feedback affordance, or do nothing.
 *
 * Returns `null` without touching the DOM when the gate fails (no
 * parent window — top-level tab / non-browser environment). Otherwise
 * appends a `<div data-ggui-ui-feedback-chrome>` to `doc.body` (after
 * the session root, which the boot path appended first) and renders
 * the card into it. Idempotent per document: a re-entrant mount
 * replaces any previous chrome container — one affordance per
 * document, never two.
 *
 * Fire-and-forget from the boot path's perspective: chrome must never
 * block or fail the boot, so callers `void` the promise.
 */
export async function mountUiFeedbackChrome(
  doc: Document,
  opts: UiFeedbackChromeOptions,
): Promise<UiFeedbackChromeHandle | null> {
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined);
  // Gate: mount only when a parent window exists to receive the
  // `ggui:observe` envelope. `win.parent === win` is the top-level-tab
  // signature; a nullish parent means a detached/nonstandard context.
  if (win === undefined || win.parent === null || win.parent === win) {
    return null;
  }

  const [reactDomClient, cardMod] = await Promise.all([
    import('react-dom/client'),
    import('./system-cards/UiFeedbackCard.js'),
  ]);

  // Idempotency: a re-entrant mount replaces the previous chrome
  // container wholesale (remove + fresh element) rather than calling
  // `createRoot` twice on one node — React warns on double-rooting a
  // container, and chrome carries no state worth preserving.
  doc.querySelector('[data-ggui-ui-feedback-chrome]')?.remove();
  const container = doc.createElement('div');
  container.setAttribute('data-ggui-ui-feedback-chrome', '');
  doc.body.appendChild(container);

  const root = reactDomClient.createRoot(container);
  root.render(
    createElement(cardMod.UiFeedbackCard, {
      emit: opts.emit,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.toolName !== undefined ? { toolName: opts.toolName } : {}),
    }),
  );

  return {
    container,
    unmount() {
      root.unmount();
      container.remove();
    },
  };
}
