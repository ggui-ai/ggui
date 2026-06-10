/**
 * `data` channel handler — validates inbound stream-envelope payloads
 * against the active render's `streamSpec`, then fans the validated
 * envelope out via `streamBus`. Invalid payloads drop silently
 * (matching `GguiRender.handleServerMessage`'s surfacing policy —
 * the violation is already logged by the validator).
 *
 * Post-stack-removal (2026-05-27): the active render is read through
 * the caller-supplied `getCurrentGguiSession` thunk instead of via a
 * `StackModel.snapshot()` walk — the iframe holds exactly one mounted
 * render, so the lookup is direct.
 */

import type { ChannelHandler } from '@ggui-ai/live-channel';
import type { GguiSession, StreamEnvelope } from '@ggui-ai/protocol';
import type { GguiSessionSeedInput } from '../types.js';

import {
  validateInboundStreamPayload,
  type RendererValidatorContext,
} from '../validation.js';
import type { StreamBus } from '../wire-config.js';

export interface DataHandlerDeps {
  /**
   * Read the currently-mounted render. Returns `null` when no render
   * has been mounted yet — data frames received pre-mount have no
   * streamSpec to validate against and silently drop.
   */
  readonly getCurrentGguiSession: () => GguiSession | GguiSessionSeedInput | null;
  readonly streamBus: StreamBus;
  readonly validatorCtx: RendererValidatorContext;
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

      // Active render carries the streamSpec — mirrors
      // `GguiRender.handleServerMessage`.
      const activeRender = deps.getCurrentGguiSession();
      const streamSpec =
        activeRender !== null &&
        activeRender.type !== 'mcpApps' &&
        activeRender.type !== 'system'
          ? activeRender.streamSpec
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
