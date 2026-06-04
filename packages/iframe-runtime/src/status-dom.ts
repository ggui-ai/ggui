/**
 * In-iframe runtime status surface.
 *
 * Used to inject a visible `<div data-ggui-status>` banner ("Initializing
 * renderer…", "Connected", etc.) into the iframe body alongside the
 * user-rendered React tree. End users saw it as a stray label above
 * their UI — production-unfriendly. As of the displayMode-divergence
 * close-out we route status transitions to `console.log` and inject ONLY
 * the React mount-target div (no banner, no list-item placeholder text).
 *
 * Post-stack-removal (2026-05-27): the iframe holds exactly one mounted
 * render for its lifetime. The `setConnectedStatus` helper no longer takes
 * a stack-model arg — there's nothing to count — and the placeholder
 * `<li data-ggui-stack-item>` render path is gone.
 *
 * The exported names (`setStatus`, `setConnectedStatus`, `StatusRefs`)
 * are preserved so the channel handlers + runtime keep their import
 * shape.
 */

/**
 * Closed union of values the iframe's status surface carries. Kept on
 * the runtime side as the canonical state vocabulary even though it no
 * longer surfaces visibly.
 *
 *   - `idle` — initial state before any boot IO.
 *   - `initializing` — legacy alias for `idle`.
 *   - `connecting` — ui/initialize fired or WS handshake in flight.
 *   - `connected` — first ack landed + every subsequent successful
 *     push.
 *   - `reconnecting` — WS dropped; reconnect ladder running.
 *   - `disconnected` — terminal close + ladder exhausted.
 *   - `upgrade-required` — version handshake failed.
 *   - `error` — every other failure.
 *
 * Surfaces on `console.log` prefixed `[ggui:<state>]`; consumers
 * (operators, e2e specs) MAY install a `console.log` interceptor or
 * read `notifyParent('ggui:bootstrap-failed', …)` for failure paths.
 */
export type StatusKind =
  | 'idle'
  | 'initializing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'upgrade-required'
  | 'error';

/**
 * Refs handed back from {@link ensureStatusDom}. `status` is a detached
 * element kept for backward compatibility with channel handlers that
 * still pass `refs.status` through; it is NEVER appended to the
 * document, so production iframes carry no diagnostic banner.
 * `renderRoot` is the React mount target — appended to `document.body`
 * so renderer wiring has a container.
 */
export interface StatusRefs {
  readonly status: HTMLElement;
  readonly renderRoot: HTMLElement;
}

/**
 * Build the React mount target. Reuses pre-existing `[data-ggui-stack]`
 * if the shell already wrote one (cf. `buildSelfContainedShell`); else
 * creates a fresh `<ul data-ggui-stack>` and appends it to `<body>`.
 * The companion `status` element is created detached and never
 * appended — consumers that still pass it through `StatusRefs` see no
 * visible effect.
 *
 * The `<ul>` element name is preserved (legacy from the stack-of-N
 * placeholder render path) but only ever holds a single React mount
 * subtree post-stack-removal.
 */
export function ensureStatusDom(doc: Document): StatusRefs {
  const existingRoot = doc.querySelector<HTMLElement>('[data-ggui-stack]');
  const renderRoot =
    existingRoot ??
    (() => {
      const el = doc.createElement('ul');
      el.setAttribute('data-ggui-stack', '');
      doc.body.appendChild(el);
      return el;
    })();
  // Detached placeholder so legacy `setStatus(refs, …)` calls have
  // somewhere to write without touching the visible DOM. `aria-hidden`
  // + zero size belt-and-braces in case any path appends it later.
  const status = doc.createElement('div');
  status.setAttribute('data-ggui-status', 'idle');
  status.setAttribute('aria-hidden', 'true');
  return { status, renderRoot };
}

/**
 * Log a status transition. The element is mutated for backward compat
 * (some tests still hold a `refs.status` reference), but production
 * users never see it because the element is detached from `document`.
 */
export function setStatus(
  refs: StatusRefs,
  text: string,
  state: StatusKind,
): void {
  refs.status.textContent = text;
  refs.status.setAttribute('data-ggui-status', state);
  // eslint-disable-next-line no-console
  console.log(`[ggui:${state}]`, text);
}

/**
 * Log the "connected" transition. Post-stack-removal the iframe always
 * holds exactly one item; the message stays bare ("Connected.") since
 * there's no count to surface. Consumers (devtools, e2e specs
 * intercepting `console.log`) get a stable string on every push.
 */
export function setConnectedStatus(refs: StatusRefs): void {
  setStatus(refs, 'Connected.', 'connected');
}
