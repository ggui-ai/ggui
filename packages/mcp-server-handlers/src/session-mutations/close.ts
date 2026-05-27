/**
 * `createGguiCloseHandler` — mark a render as completed.
 *
 * Calls `renderStore.appendEvent({type: 'session.closed'})` — the
 * in-memory and SQLite `RenderStore` impls flip the bucket's
 * terminal flag on this event, which then surfaces as
 * `status: 'completed'` on subsequent `list({status})` queries.
 * The event-type string preserves the legacy spelling so existing
 * subscribers continue to receive it.
 *
 * Shared by every deployment — a cloud server composes this same
 * factory with its own `RenderStore` plus an optional
 * `observerNotifier` for WebSocket fan-out.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from `{sessionId}`
 * to `{renderId}` — every render IS the addressable scope.
 */

import { z } from 'zod';
import type { GguiCloseOutput } from '@ggui-ai/protocol';
import type {
  PendingEventConsumer,
  RenderStore,
  ShortCodeIndex,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { RenderNotFoundError } from './errors.js';

const inputSchema = {
  renderId: z
    .string()
    .min(1)
    .describe('The render to mark completed'),
} as const;

const outputSchema = {
  success: z.boolean(),
} as const;

/**
 * Optional observer-notification seam for `ggui_close`. Cloud uses
 * this to fan a `render_closed` event to its observer WebSocket so
 * builders watching a render see the close. OSS leaves absent.
 */
export interface CloseObserverNotifier {
  notifyRenderClosed(args: {
    readonly appId: string;
    readonly renderId: string;
  }): void;
}

export interface GguiCloseHandlerDeps {
  readonly renderStore: RenderStore;
  readonly observerNotifier?: CloseObserverNotifier;
  /**
   * Optional close primitive. When set, the handler invokes this in
   * place of `renderStore.appendEvent({type: 'session.closed'})`.
   * Returns `true` on success, `false` when the underlying row had
   * already disappeared (the response surfaces the boolean verbatim).
   *
   * Cloud wires this to its `markRenderCompleted` DDB UpdateItem so
   * the close path stays on cloud's existing primitive without needing
   * a fully-wired `RenderStore.appendEvent` on its DynamoRenderStore
   * adapter.
   *
   * OSS leaves absent — falls back to `renderStore.appendEvent`.
   */
  readonly markCompleted?: (renderId: string) => Promise<boolean> | boolean;
  /**
   * Optional pipe handle. When wired, the closing render's
   * pending-events pipe is deleted via `markDeleted` so the agent's
   * long-poll loop terminates (consume sees
   * `PendingPipeNotFoundError`, falls through to status:
   * 'completed', and returns).
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  /**
   * Optional shortCode index. When wired, every `/r/<code>` URL
   * bound to the closing render is revoked. Outstanding render URLs
   * stop resolving the moment the render is marked completed — the
   * capability URL stops being a capability. Best-effort: index
   * hiccups don't fail the close.
   */
  readonly shortCodeIndex?: ShortCodeIndex;
}

export function createGguiCloseHandler(
  deps: GguiCloseHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiCloseOutput> {
  return {
    name: 'ggui_close',
    title: 'Close render',
    audience: ['agent'],
    description:
      "Mark a render as completed. Future ggui_consume calls return status: 'completed' so the agent's long-poll loop terminates. Call when the user is done with the render — the row is preserved for analytics; TTL reaps eventually.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiCloseOutput> {
      const { renderId } = z.object(inputSchema).parse(rawInput);

      const stored = await deps.renderStore.get(renderId);
      if (!stored || stored.appId !== ctx.appId) {
        // Tenancy + missing both surface uniformly so cross-tenant
        // existence is not leaked.
        throw new RenderNotFoundError(renderId);
      }

      // Flip the render to its terminal `completed` state. Two paths:
      //
      //   - `markCompleted` seam (cloud): the host owns the close
      //     primitive (e.g. DDB UpdateItem on `renderStatus`).
      //     Returns `false` when the row vanished between the
      //     tenancy gate and the write — handler surfaces that
      //     verbatim. Returns `true` on a successful close.
      //   - `renderStore.appendEvent` (OSS default): writes the
      //     terminal `session.closed` event; InMemory + Sqlite
      //     RenderStore observe it and flip their internal `closed`
      //     flag. Idempotent — re-close on an already-closed render
      //     throws inside the store, which we treat as success
      //     (post-condition holds: render is closed).
      let success = true;
      if (deps.markCompleted) {
        success = await deps.markCompleted(renderId);
      } else {
        try {
          await deps.renderStore.appendEvent({
            renderId,
            type: 'session.closed',
            data: {},
          });
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.toLowerCase().includes('closed')
          ) {
            // Already closed — that's the desired terminal state.
          } else {
            throw err;
          }
        }
      }

      // Close the renderId-keyed pending-events pipe. The agent's
      // `ggui_consume` long-poll terminates: the next consumeAndClear
      // sees `PendingPipeNotFoundError`, which the handler catches as
      // status: 'completed' and returns. Best-effort: failures don't
      // block the user-visible close.
      if (deps.pendingEventConsumer?.markDeleted) {
        try {
          deps.pendingEventConsumer.markDeleted(renderId);
        } catch {
          // Per-pipe failures are swallowed.
        }
      }

      // Revoke every /r/<code> URL bound to the closing render.
      // Single bulk call drops all bindings via the render-scoped
      // revoke. Best-effort: silent on index errors.
      if (deps.shortCodeIndex) {
        try {
          await deps.shortCodeIndex.revokeBySessionId(renderId);
        } catch {
          // Intentionally swallowed.
        }
      }

      // Best-effort observer fan-out. Errors swallowed — the close
      // already succeeded.
      if (deps.observerNotifier) {
        try {
          deps.observerNotifier.notifyRenderClosed({
            appId: ctx.appId,
            renderId,
          });
        } catch {
          // Intentionally swallowed.
        }
      }

      return { success };
    },
  };
}
