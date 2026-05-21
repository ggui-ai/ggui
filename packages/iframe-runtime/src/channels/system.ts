/**
 * `system` channel handler — emits the `auth-required` observability
 * event when the server signals an OAuth consent flow.
 *
 * Absorbed from `handleObservableMessage` in `runtime.ts`. The
 * handler is now the sole dispatch surface for `system` frames in
 * the iframe runtime; other system actions (e.g.
 * `credential_ready`) have downstream listeners elsewhere and are
 * intentionally skipped at this layer.
 *
 * Skip conditions (all silent — host gets no row, which is the
 * correct behaviour: a system frame the host can't act on shouldn't
 * surface as a spurious consent overlay trigger):
 *   - `action !== 'auth_required'` — e.g. `'credential_ready'` is a
 *     different downstream signal.
 *   - `consentUrl` absent — the host cannot redirect the user without
 *     it, so there's nothing actionable to surface.
 *   - `onObserve` absent — the observation has nowhere to go.
 */

import type { ChannelHandler } from '@ggui-ai/channel-client';
import type { SystemPayload } from '@ggui-ai/protocol';

import type {
  ObservabilityEmitter,
  ObservabilityEvent,
} from '../observability.js';

export interface SystemHandlerDeps {
  readonly onObserve?: ObservabilityEmitter;
}

export function createSystemHandler(
  deps: SystemHandlerDeps,
): ChannelHandler<SystemPayload> {
  return {
    type: 'system',
    onMessage: (payload) => {
      if (deps.onObserve === undefined) return;
      emitAuthRequiredFromSystemFrame(payload, deps.onObserve);
    },
  };
}

function emitAuthRequiredFromSystemFrame(
  payload: SystemPayload,
  emit: ObservabilityEmitter,
): void {
  if (payload.action !== 'auth_required') return;
  if (typeof payload.consentUrl !== 'string' || payload.consentUrl.length === 0) return;
  const event: ObservabilityEvent = {
    kind: 'auth-required',
    provider: payload.serviceId,
    authUrl: payload.consentUrl,
    ...(payload.displayName !== undefined ? { displayName: payload.displayName } : {}),
    ...(payload.scopes !== undefined ? { scopes: payload.scopes } : {}),
    ...(payload.message !== undefined ? { message: payload.message } : {}),
  };
  emit(event);
}
