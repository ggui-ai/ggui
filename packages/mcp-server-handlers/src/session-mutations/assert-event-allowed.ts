/**
 * Inbound-event allowlist / subscription gating.
 *
 * Rejects events whose `type` isn't in the active stack item's declared
 * `subscription.events` list. Enforced at live-channel ingress BEFORE any
 * buffering, agent forward, or endpoint auto-forward — so undeclared event
 * types can't leak into the agent's consume buffer or trigger downstream
 * side-effects.
 *
 * Distinct from `assertActionContract`:
 *   - `assertActionContract` validates the PAYLOAD of a declared action
 *     against its schema (tool='ggui_event', ContractViolationError).
 *   - `assertEventAllowed` (this) gates the EVENT TYPE itself against the
 *     session's declared subscription (EventNotAllowedError).
 *
 * The two are composed at the ingress call-site — allowlist first (cheap
 * membership check), payload contract second (schema walk). If allowlist
 * fails, payload validation doesn't run.
 *
 * Contract:
 *   - `subscription === undefined` → fall back to `DEFAULT_SUBSCRIPTION`
 *     (currently `['data:submit', 'lifecycle:session_end']`). Matches the
 *     protocol's default when no subscription was declared.
 *   - `eventType` in allowed list → no-op.
 *   - `eventType` not in allowed list → throw `EventNotAllowedError`.
 */
import {
  DEFAULT_SUBSCRIPTION,
  type EventSubscription,
} from '@ggui-ai/protocol';
import { EventNotAllowedError } from './errors.js';

export function assertEventAllowed(
  subscription: EventSubscription | undefined,
  eventType: string,
): void {
  const allowed = subscription?.events ?? DEFAULT_SUBSCRIPTION.events;
  if (!allowed.includes(eventType as (typeof allowed)[number])) {
    throw new EventNotAllowedError(eventType, allowed);
  }
}
