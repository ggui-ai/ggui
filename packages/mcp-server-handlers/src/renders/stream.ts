/**
 * `createGguiEmitHandler` — emit a new delivery on a declared
 * channel of the resolved render's `streamSpec`.
 *
 * Wraps the `handleStream` helper with a `SharedHandler` shape so
 * every deployment — cloud and standalone alike — shares one entry
 * point.
 *
 * Acceptance is at the server boundary — `sendEnvelope` may fan
 * out to live subscribers or buffer for replay. No-subscriber is
 * NOT an error; the envelope is still considered accepted.
 *
 * Post-Phase-B (flatten-render-identity): the wire input collapsed
 * from `{sessionId, channel, payload, complete?, stackItemId?}` to
 * `{sessionId, channel, payload, complete?}` — every render IS the
 * addressable scope.
 */

import { z } from 'zod';
import type {
  ComponentGguiSession,
  GguiEmitInput,
  GguiEmitOutput,
  StreamEnvelope,
} from '@ggui-ai/protocol';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';
import {
  handleStream,
  type GguiSessionStreamTarget,
  type SendEnvelopeFn,
} from './handle-stream.js';

const inputSchema = {
  sessionId: z.string().min(1),
  channel: z.string().min(1),
  payload: z.unknown(),
  complete: z.boolean().optional(),
} as const;

const outputSchema = {
  accepted: z.boolean(),
} as const;

export interface GguiEmitHandlerDeps {
  readonly renderStore: GguiSessionStore;
  /**
   * Caller-supplied envelope sink. Invoked after `handleStream`
   * validates + stamps. OSS hosts wrap an in-process render
   * channel; cloud wraps API Gateway + a stream buffer (with
   * fanout for cross-pod live tail). Errors propagate to the
   * tool handler — `handleStream` does not wrap them.
   */
  readonly sendEnvelope: SendEnvelopeFn;
  /**
   * Optional observer-notification seam. Cloud uses it to fan a
   * `ggui_emit` tool-call event onto its WebSocket so builders
   * watching a render see emissions. OSS leaves absent.
   */
  readonly observerNotifier?: StreamObserverNotifier;
}

export interface StreamObserverNotifier {
  notifyToolCall(args: {
    readonly appId: string;
    readonly sessionId: string;
    readonly channel: string;
    readonly hasPayload: boolean;
    readonly complete: boolean;
    readonly accepted: boolean;
  }): void;
}

export function createGguiEmitHandler(
  deps: GguiEmitHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiEmitOutput> {
  return {
    name: 'ggui_emit',
    title: 'Stream',
    audience: ['agent'],
    description:
      "Emit a new delivery on a declared channel of the GguiSession's streamSpec. The agent supplies {sessionId, channel, payload, complete?}; the server derives mode from the channel's declared mode and stamps the canonical StreamEnvelope. Validates the payload against the channel's schema and rejects undeclared channels. Acceptance is at the server boundary — no-subscriber is not an error.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiEmitOutput> {
      const { sessionId, channel, payload, complete } = z
        .object(inputSchema)
        .parse(rawInput);

      // Tenancy gate. Cross-tenant + missing surface uniformly as
      // GguiSessionNotFoundError so cross-tenant existence isn't leaked.
      const stored = await deps.renderStore.get(sessionId);
      if (!stored || stored.appId !== ctx.appId) {
        throw new GguiSessionNotFoundError(sessionId);
      }

      // Extract the streamSpec from the resolved render (component
      // variant only; system + mcpApps don't carry streamSpec).
      const streamSpec =
        stored.render.type === undefined ||
        stored.render.type === 'component'
          ? (stored.render as ComponentGguiSession).streamSpec
          : undefined;

      const target: GguiSessionStreamTarget = {
        sessionId,
        ...(streamSpec !== undefined ? { streamSpec } : {}),
      };

      const input: GguiEmitInput = {
        sessionId,
        channel,
        payload: payload as StreamEnvelope['payload'],
        ...(complete === true ? { complete: true as const } : {}),
      };

      const out = await handleStream(input, {
        render: target,
        sendEnvelope: deps.sendEnvelope,
      });

      // Best-effort observer fan-out — only fires when wired.
      if (deps.observerNotifier) {
        try {
          deps.observerNotifier.notifyToolCall({
            appId: ctx.appId,
            sessionId,
            channel,
            hasPayload: payload !== undefined,
            complete: complete === true,
            accepted: out.accepted,
          });
        } catch {
          // Intentionally swallowed — observer is fire-and-forget.
        }
      }

      return out;
    },
  };
}

