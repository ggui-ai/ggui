/**
 * `data` channel handler — validates inbound stream-envelope payloads
 * against the active stack item's `streamSpec`, then fans the validated
 * envelope out via `streamBus`. Invalid payloads drop silently
 * (matching `GguiSession.handleServerMessage`'s surfacing policy —
 * the violation is already logged by the validator).
 *
 * Also fires `contract-error-emitted` on the optional observability
 * sink when the envelope arrives on the reserved
 * `CONTRACT_ERROR_CHANNEL`. Absorbed from `handleObservableMessage`
 * in `runtime.ts` as part of the B3b cleanup — the handler is now the
 * sole dispatch surface for `data` frames.
 *
 * Factored out of `handleRendererMessage` as part of the B3a handler
 * extraction; expanded in B3b to absorb the observability-axis
 * emission previously fired in parallel from `bootSequence`.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import {
  CONTRACT_ERROR_CHANNEL,
  type SessionStackEntry,
  type StreamEnvelope,
} from '@ggui-ai/protocol';

import type {
  ObservabilityEmitter,
  ObservabilityEvent,
} from '../observability.js';
import type { StackModel } from '../stack.js';
import {
  validateInboundStreamPayload,
  type RendererValidatorContext,
} from '../validation.js';
import type { StreamBus } from '../wire-config.js';

export interface DataHandlerDeps {
  readonly stackModel: StackModel;
  readonly streamBus: StreamBus;
  readonly validatorCtx: RendererValidatorContext;
  /**
   * Optional observability sink. When present, every envelope on the
   * reserved `_ggui:contract-error` channel fires a
   * {@link ContractErrorEmittedEvent}. Absent = the observation skips
   * silently (matches the pre-B3b posture when no `onObserve` is
   * bound).
   */
  readonly onObserve?: ObservabilityEmitter;
}

export function createDataHandler(
  deps: DataHandlerDeps,
): ChannelHandler<StreamEnvelope> {
  return {
    type: 'data',
    onMessage: (envelope) => {
      if (
        envelope === undefined ||
        envelope === null ||
        typeof envelope.channel !== 'string'
      ) {
        return;
      }

      // Observability-axis emission for the reserved contract-error
      // channel. Fires BEFORE validation because the envelope shape
      // is owned by the server's reserved validator
      // (`BUILTIN_RESERVED_VALIDATORS`) — invalid payloads at this
      // boundary are server-side bugs the host inspector should still
      // surface, not silently drop.
      if (
        envelope.channel === CONTRACT_ERROR_CHANNEL &&
        deps.onObserve !== undefined
      ) {
        emitContractErrorFromDataFrame(envelope, deps.onObserve);
      }

      // Active stack item carries the streamSpec — mirrors
      // `GguiSession.handleServerMessage`. Top of stack only.
      const snapshot = deps.stackModel.snapshot();
      const activeItem = snapshot[snapshot.length - 1] as
        | SessionStackEntry
        | undefined;
      const streamSpec =
        activeItem !== undefined &&
        activeItem.type !== 'mcpApps' &&
        activeItem.type !== 'system'
          ? activeItem.streamSpec
          : undefined;
      const result = validateInboundStreamPayload(
        streamSpec,
        envelope.channel,
        envelope.payload,
        deps.validatorCtx,
      );
      if (!result.valid) return;
      deps.streamBus.emit(envelope);
    },
  };
}

/**
 * Narrow a contract-error envelope and emit
 * {@link ContractErrorEmittedEvent}. Malformed envelopes silently
 * skip (trust-boundary posture — host inspector gets a row only when
 * the wire payload carries the required discriminator fields).
 */
function emitContractErrorFromDataFrame(
  envelope: StreamEnvelope,
  emit: ObservabilityEmitter,
): void {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return;
  }
  const shaped = payload as {
    readonly toolName?: unknown;
    readonly actionName?: unknown;
    readonly error?: { readonly code?: unknown };
  };
  const code =
    shaped.error !== undefined &&
    shaped.error !== null &&
    typeof shaped.error === 'object' &&
    typeof shaped.error.code === 'string'
      ? shaped.error.code
      : undefined;
  const toolName =
    typeof shaped.toolName === 'string' ? shaped.toolName : undefined;
  if (code === undefined || toolName === undefined) return;
  const event: ObservabilityEvent = {
    kind: 'contract-error-emitted',
    code,
    toolName,
    ...(typeof shaped.actionName === 'string'
      ? { actionName: shaped.actionName }
      : {}),
  };
  emit(event);
}
