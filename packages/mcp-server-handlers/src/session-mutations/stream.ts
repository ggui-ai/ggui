/**
 * `createGguiEmitHandler` — emit a new delivery on a declared
 * channel of the active (or pinned) stack item's `streamSpec`.
 *
 * Wraps the `handleStream` helper with a `SharedHandler` shape so
 * every deployment — cloud and standalone alike — shares one entry
 * point.
 *
 * Acceptance is at the server boundary — `sendEnvelope` may fan
 * out to live subscribers or buffer for replay. No-subscriber is
 * NOT an error; the envelope is still considered accepted.
 */

import { z } from 'zod';
import type {
  GguiEmitInput,
  GguiEmitOutput,
  StackItem,
  StreamEnvelope,
  StreamSpec,
} from '@ggui-ai/protocol';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { SessionNotFoundError } from './errors.js';
import {
  handleStream,
  type SendEnvelopeFn,
  type StreamSessionTarget,
} from './handle-stream.js';

const inputSchema = {
  sessionId: z.string().min(1),
  channel: z.string().min(1),
  payload: z.unknown(),
  complete: z.boolean().optional(),
  stackItemId: z.string().min(1).optional(),
} as const;

const outputSchema = {
  accepted: z.boolean(),
} as const;

export interface GguiEmitHandlerDeps {
  readonly sessionStore: SessionStore;
  /**
   * Caller-supplied envelope sink. Invoked after `handleStream`
   * validates + stamps. OSS hosts wrap an in-process session
   * channel; cloud wraps API Gateway + a stream buffer (with
   * fanout for cross-pod live tail). Errors propagate to the
   * tool handler — `handleStream` does not wrap them.
   */
  readonly sendEnvelope: SendEnvelopeFn;
  /**
   * Optional observer-notification seam. Cloud uses it to fan a
   * `ggui_emit` tool-call event onto its WebSocket so builders
   * watching a session see emissions. OSS leaves absent.
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
      "Emit a new delivery on a declared channel of the active stack item's streamSpec. The agent supplies {sessionId, channel, payload, complete?, stackItemId?}; the server derives mode from the channel's declared mode and stamps the canonical StreamEnvelope. Validates the payload against the channel's schema and rejects undeclared channels. Acceptance is at the server boundary — no-subscriber is not an error.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiEmitOutput> {
      const { sessionId, channel, payload, complete, stackItemId } = z
        .object(inputSchema)
        .parse(rawInput);

      // Tenancy gate. Cross-tenant + missing surface uniformly as
      // SessionNotFoundError so cross-tenant existence isn't leaked.
      const session = await deps.sessionStore.get(sessionId);
      if (!session || session.appId !== ctx.appId) {
        throw new SessionNotFoundError(
          `ggui_emit: session "${sessionId}" not found, expired, or owned by a different appId.`,
        );
      }

      // Project the Session.stack onto the minimal shape handleStream
      // reads (`id` + optional `streamSpec`). Both OSS and cloud satisfy
      // this naturally.
      type StreamItem = Partial<StackItem> & {
        readonly id: string;
        readonly streamSpec?: StreamSpec;
      };
      const stack = (session.stack as unknown as StreamItem[]).filter(
        (item): item is StreamItem => typeof item?.id === 'string',
      );
      const target: StreamSessionTarget = {
        sessionId,
        stack,
        currentStackIndex: session.currentStackIndex,
      };

      const input: GguiEmitInput = {
        sessionId,
        channel,
        payload: payload as StreamEnvelope['payload'],
        ...(complete === true ? { complete: true as const } : {}),
        ...(stackItemId !== undefined ? { stackItemId } : {}),
      };

      const out = await handleStream(input, {
        session: target,
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
