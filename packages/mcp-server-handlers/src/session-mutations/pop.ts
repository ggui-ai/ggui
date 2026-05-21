/**
 * `createGguiPopHandler` — remove the top stack entry from a session.
 *
 * Uses the `SessionStore.popStackItem` method. Shared by every
 * deployment — cloud and standalone alike compose this one factory
 * over their own `SessionStore` implementation.
 */

import { z } from 'zod';
import type { GguiPopOutput } from '@ggui-ai/protocol';
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
    .describe('Session to pop the top stack entry from'),
} as const;

const outputSchema = {
  poppedId: z.string().nullable(),
  stackSize: z.number().int().nonnegative(),
} as const;

export interface GguiPopHandlerDeps {
  readonly sessionStore: SessionStore;
  /**
   * Optional pipe handle. When wired, the popped stackItemId's
   * pending-events pipe is closed via `markDeleted` so leftover
   * gestures (e.g. a late `ggui_runtime_submit_action` arriving after
   * the user clicked away) don't accumulate on a stack item no one's
   * watching. Idempotent — calling on an unknown stackItemId is a
   * no-op.
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  /**
   * Optional shortCode index. When wired, any `/r/<code>` URL bound
   * to the popped stack item is revoked — subsequent lookups return
   * null, the render route 404s. Capability-URL hardening: a URL
   * outlives the visible UI only when the operator chooses durable
   * indexing without revoke-on-pop, which they shouldn't.
   */
  readonly shortCodeIndex?: ShortCodeIndex;
}

export function createGguiPopHandler(
  deps: GguiPopHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiPopOutput> {
  return {
    name: 'ggui_pop',
    title: 'Pop stack item',
    audience: ['agent'],
    description:
      'Remove the top entry from the session stack. Returns the popped entry id (or null if the stack was empty) plus the new stack size. Empty stack is NOT an error — the call is idempotent at the bottom.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiPopOutput> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      // Tenancy gate. Cross-tenant + missing both surface as
      // SessionNotFoundError so cross-tenant existence isn't leaked.
      const session = await deps.sessionStore.get(sessionId);
      if (!session || session.appId !== ctx.appId) {
        throw new SessionNotFoundError(
          `ggui_pop: session "${sessionId}" not found, expired, or owned by a different appId.`,
        );
      }

      const result = await deps.sessionStore.popStackItem(sessionId);

      // Close the pipe for the popped stackItem (Model C). Safe even
      // when `poppedId` is null (empty-stack pop) — markDeleted on
      // an unknown id is a no-op on every impl.
      if (result.poppedId !== null && deps.pendingEventConsumer?.markDeleted) {
        try {
          deps.pendingEventConsumer.markDeleted(result.poppedId);
        } catch {
          // Pipe close failures are non-fatal.
        }
      }

      // Revoke any /r/<code> URLs bound to the popped stack item.
      // Best-effort: index hiccups don't fail the pop (the user-visible
      // outcome — entry gone from stack — already holds).
      if (result.poppedId !== null && deps.shortCodeIndex) {
        try {
          await deps.shortCodeIndex.revokeByStackItemId(result.poppedId);
        } catch {
          // Intentionally swallowed.
        }
      }

      return { poppedId: result.poppedId, stackSize: result.stackSize };
    },
  };
}
