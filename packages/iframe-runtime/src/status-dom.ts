/**
 * In-iframe runtime status surface.
 *
 * Used to inject a visible `<div data-ggui-status>` banner ("Initializing
 * renderer…", "Connected (1 item)", etc.) into the iframe body alongside
 * the user-rendered React tree. End users saw it as a stray label above
 * their UI — production-unfriendly. As of the displayMode-divergence
 * close-out we route status transitions to `console.log` and inject ONLY
 * the React mount-target div (no banner, no list-item placeholder text).
 *
 * The exported names (`setStatus`, `setConnectedStatus`,
 * `refreshStackDom`, `StatusRefs`) are preserved so the channel handlers
 * + runtime keep their import shape; `setStatus` / `setConnectedStatus`
 * are now `console.log` shims, and `refreshStackDom` is a no-op for the
 * renderer-wired (production) path. The placeholder render path —
 * exercised by `boot.test.ts` without a renderer hook — still writes
 * its `<li data-ggui-stack-item>` rows into the mount-target div for
 * the spec assertions that count items on the stack.
 */
import type { StackModel } from './stack.js';
import { renderStackInto } from './stack.js';

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
 * document, so production iframes carry no diagnostic banner. `stack`
 * is the React mount target — appended to `document.body` so renderer
 * wiring + the placeholder render path both have a container.
 */
export interface StatusRefs {
  readonly status: HTMLElement;
  readonly stack: HTMLElement;
}

/**
 * Build the React mount target. Reuses pre-existing `[data-ggui-stack]`
 * if the shell already wrote one (cf. `buildSelfContainedShell`); else
 * creates a fresh `<ul data-ggui-stack>` and appends it to `<body>`.
 * The companion `status` element is created detached and never
 * appended — consumers that still pass it through `StatusRefs` see no
 * visible effect.
 */
export function ensureStatusDom(doc: Document): StatusRefs {
  const existingStack = doc.querySelector<HTMLElement>('[data-ggui-stack]');
  const stack =
    existingStack ??
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
  return { status, stack };
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
 * Log the "connected (N items)" transition. Calculates the count from
 * the live stack model so consumers (devtools, e2e specs intercepting
 * `console.log`) get the up-to-date stack size on every fold.
 */
export function setConnectedStatus(refs: StatusRefs, model: StackModel): void {
  const size = model.size();
  setStatus(
    refs,
    `Connected (${size} item${size === 1 ? '' : 's'}).`,
    'connected',
  );
}

/**
 * Render the stack model's items into the mount-target as
 * `<li data-ggui-stack-item>` rows. Only invoked on the placeholder
 * path (no renderer wired) — the renderer-wired production path uses
 * `<div data-ggui-stack-item-root>` containers via `containerFor` and
 * never goes through here.
 */
export function refreshStackDom(refs: StatusRefs, model: StackModel): void {
  renderStackInto(refs.stack, model);
}
