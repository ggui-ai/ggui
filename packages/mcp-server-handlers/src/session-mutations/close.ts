/**
 * `createGguiCloseHandler` — mark a session as completed.
 *
 * Calls `sessionStore.appendEvent({type: 'session.closed'})` — the
 * in-memory and SQLite `SessionStore` impls flip the bucket's
 * terminal flag on this event, which then surfaces as
 * `status: 'completed'` on subsequent `list({status})` queries.
 *
 * Shared by every deployment — a cloud server composes this same
 * factory with its own `SessionStore` plus an optional
 * `observerNotifier` for WebSocket fan-out.
 */

import { z } from 'zod';
import type { GguiCloseOutput } from '@ggui-ai/protocol';
import type {
  PendingEventConsumer,
  SessionStore,
  ShortCodeIndex,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { SessionNotFoundError } from './errors.js';

const inputSchema = {
  sessionId: z
    .string()
    .min(1)
    .describe('The session to mark completed'),
} as const;

const outputSchema = {
  success: z.boolean(),
} as const;

/**
 * Optional observer-notification seam for `ggui_close`. Cloud uses
 * this to fan a `session_closed` event to its observer WebSocket so
 * builders watching a session see the close. OSS leaves absent.
 */
export interface CloseObserverNotifier {
  notifySessionClosed(args: {
    readonly appId: string;
    readonly sessionId: string;
  }): void;
}

export interface GguiCloseHandlerDeps {
  readonly sessionStore: SessionStore;
  readonly observerNotifier?: CloseObserverNotifier;
  /**
   * Optional close primitive. When set, the handler invokes this in
   * place of `sessionStore.appendEvent({type: 'session.closed'})`.
   * Returns `true` on success, `false` when the underlying row had
   * already disappeared (the response surfaces the boolean verbatim).
   *
   * Cloud wires this to its `markSessionCompleted` DDB UpdateItem so
   * the close path stays on cloud's existing primitive without needing
   * a fully-wired `SessionStore.appendEvent` on its DynamoSessionStore
   * adapter (currently NotImplementedInDynamoAdapter).
   *
   * OSS leaves absent — falls back to `sessionStore.appendEvent`.
   */
  readonly markCompleted?: (sessionId: string) => Promise<boolean> | boolean;
  /**
   * Optional pipe handle. When wired, every stack item in the closing
   * session has its pending-events pipe deleted via `markDeleted` so
   * the agent's long-poll loop on any of them terminates (consume
   * sees `PendingPipeNotFoundError`, falls through to status:
   * 'completed', and returns).
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  /**
   * Optional shortCode index. When wired, every `/r/<code>` URL
   * bound to ANY stack item of the closing session is revoked.
   * Outstanding render URLs stop resolving the moment the session
   * is marked completed — the capability URL stops being a
   * capability. Best-effort: index hiccups don't fail the close.
   */
  readonly shortCodeIndex?: ShortCodeIndex;
}

export function createGguiCloseHandler(
  deps: GguiCloseHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiCloseOutput> {
  return {
    name: 'ggui_close',
    title: 'Close session',
    audience: ['agent'],
    description:
      "Mark a session as completed. Future ggui_consume calls return status: 'completed' so the agent's long-poll loop terminates. Call when the user is done with the session — the row is preserved for render URLs and analytics; TTL reaps eventually.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiCloseOutput> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      const session = await deps.sessionStore.get(sessionId);
      if (!session || session.appId !== ctx.appId) {
        // Tenancy + missing both surface uniformly so cross-tenant
        // existence is not leaked.
        throw new SessionNotFoundError(
          `ggui_close: session "${sessionId}" not found, expired, or owned by a different appId.`,
        );
      }

      // Flip the session to its terminal `completed` state. Two paths:
      //
      //   - `markCompleted` seam (cloud): the host owns the close
      //     primitive (e.g. DDB UpdateItem on `sessionStatus`).
      //     Returns `false` when the row vanished between the
      //     tenancy gate and the write — handler surfaces that
      //     verbatim. Returns `true` on a successful close.
      //   - `sessionStore.appendEvent` (OSS default): writes the
      //     terminal `session.closed` event; InMemory + Sqlite
      //     SessionStore observe it and flip their internal `closed`
      //     flag. Idempotent — re-close on an already-closed session
      //     throws inside the store, which we treat as success
      //     (post-condition holds: session is closed).
      let success = true;
      if (deps.markCompleted) {
        success = await deps.markCompleted(sessionId);
      } else {
        try {
          await deps.sessionStore.appendEvent({
            sessionId,
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

      // Close every stackItem-keyed pending-events pipe (Model C).
      // The agent's `ggui_consume` long-poll on any of them
      // terminates: the next consumeAndClear sees
      // `PendingPipeNotFoundError`, which the handler catches as
      // status: 'completed' and returns. Best-effort: failures don't
      // block the user-visible close.
      if (deps.pendingEventConsumer?.markDeleted) {
        try {
          const stack = session.stack ?? [];
          for (const item of stack) {
            const id = (item as { id?: unknown }).id;
            if (typeof id === 'string' && id.length > 0) {
              try {
                deps.pendingEventConsumer.markDeleted(id);
              } catch {
                // Per-item failures are swallowed.
              }
            }
          }
        } catch {
          // Stack iteration failures don't block close.
        }
      }

      // Revoke every /r/<code> URL bound to the closing session.
      // Single bulk call drops all bindings via the session-scoped
      // revoke. Best-effort: silent on index errors.
      if (deps.shortCodeIndex) {
        try {
          await deps.shortCodeIndex.revokeBySessionId(sessionId);
        } catch {
          // Intentionally swallowed.
        }
      }

      // Best-effort observer fan-out. Errors swallowed — the close
      // already succeeded.
      if (deps.observerNotifier) {
        try {
          deps.observerNotifier.notifySessionClosed({
            appId: ctx.appId,
            sessionId,
          });
        } catch {
          // Intentionally swallowed.
        }
      }

      return { success };
    },
  };
}
