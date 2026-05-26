/**
 * In-iframe status DOM. Extracted from `runtime.ts` in B3b so the
 * live-channel handlers can import the `setStatus` + status-refs
 * helpers without a circular dep on the runtime module (which imports
 * the handlers for registration at boot).
 *
 * Operators see the boot state at a glance; failures land here with a
 * prefix that makes them grep-able in dev consoles.
 *
 * The status DOM is a `<div data-ggui-status>` + `<ul data-ggui-stack>`
 * pair built once at boot and reused for the iframe's lifetime. The
 * `data-ggui-status` attribute carries a {@link StatusKind} value so
 * operator stylesheets + e2e specs can pin assertions against the
 * narrow union rather than reading the text content.
 */
import type { StackModel } from './stack.js';
import { renderStackInto } from './stack.js';

/**
 * Closed union of values the `data-ggui-status` attribute carries.
 *
 *   - `idle` — initial state before any boot IO. Default text reads
 *     "Initializing renderer…"; set by {@link ensureStatusDom}.
 *   - `initializing` — same as `idle` (legacy alias kept for the rare
 *     external CSS hook in `e2e/`).
 *   - `connecting` — ui/initialize fired or WS handshake in flight.
 *   - `connected` — first ack landed + every subsequent successful
 *     push. Text shows the live stack count.
 *   - `reconnecting` — WS dropped; the reconnect ladder is running.
 *   - `disconnected` — terminal close + ladder exhausted, or a graceful
 *     stop. Authors may layer reload UX here.
 *   - `upgrade-required` — version handshake failed; operator should
 *     upgrade the client.
 *   - `error` — every other failure (ui/initialize, bootstrap parse,
 *     WS handshake non-version).
 *
 * Closed at this layer; new values require a code change here PLUS
 * any e2e specs / CSS that pattern-match against the attribute.
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
 * Refs handed back from {@link ensureStatusDom}. Stays narrow (two
 * elements) so the channel handlers can close over them without
 * pulling other runtime state.
 */
export interface StatusRefs {
  readonly status: HTMLElement;
  readonly stack: HTMLElement;
}

/**
 * Build the minimum viable status DOM the runtime owns. Adopters can
 * style via the `data-ggui-status` / `data-ggui-stack` attributes; the
 * bundle ships zero CSS so hosts see only the structure.
 */
export function ensureStatusDom(doc: Document): StatusRefs {
  // Reuse pre-existing nodes if the thin shell wrote them — lets the
  // shell inline a status line if it wants to.
  const existingStatus = doc.querySelector<HTMLElement>('[data-ggui-status]');
  const existingStack = doc.querySelector<HTMLElement>('[data-ggui-stack]');
  if (existingStatus !== null && existingStack !== null) {
    return { status: existingStatus, stack: existingStack };
  }

  const root = doc.body;
  const status = doc.createElement('div');
  status.setAttribute('data-ggui-status', 'idle');
  status.textContent = 'Initializing renderer…';
  const stack = doc.createElement('ul');
  stack.setAttribute('data-ggui-stack', '');
  root.appendChild(status);
  root.appendChild(stack);
  return { status, stack };
}

/**
 * Set the status text + the `data-ggui-status` attribute. Centralised
 * so every caller stays consistent across the runtime + the channel
 * handlers (push handler keeps the count fresh on every fold).
 */
export function setStatus(refs: StatusRefs, text: string, state: StatusKind): void {
  refs.status.textContent = text;
  refs.status.setAttribute('data-ggui-status', state);
}

/**
 * Convenience — render the `connected (N items)` status line based on
 * the current stack model size. Used by the push handler on every
 * successful upsert + by the boot sequence on first ack.
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
 * Re-render the stack DOM into the placeholder element. Wraps the
 * standalone {@link renderStackInto} so callers can pass refs + model
 * without unpacking; the standalone export stays for the legacy
 * callers that have only the bare element in scope.
 */
export function refreshStackDom(refs: StatusRefs, model: StackModel): void {
  renderStackInto(refs.stack, model);
}
