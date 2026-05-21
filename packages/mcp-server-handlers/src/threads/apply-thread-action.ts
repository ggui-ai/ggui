/**
 * `applyThreadAction` — mutate thread-level state (pin/archive/…).
 *
 * Thin over {@link ThreadStore.applyAction}. The store owns the full
 * action state-machine:
 *   - 9-action vocabulary (pin/unpin/mute/unmute/archive/unarchive/
 *     mark_read/request_delete/restore)
 *   - `restore` requires `status === 'pending_delete'`
 *   - `archive`/`unarchive` reject on `pending_delete`
 *   - idempotent no-ops leave `updatedAt` stable
 *
 * Handlers MUST NOT re-implement any of those checks — duplicating
 * state-machine rules is how they drift.
 *
 * Failure modes:
 *   - {@link InvalidThreadRequestError} — malformed body OR unknown
 *     action value (the request-shape rejection path).
 *   - {@link InvalidThreadActionError} — reachable only when the
 *     store's own validator catches a bypass; normally the request
 *     shape parser rejects first.
 *   - {@link ThreadActionInvalidStateError} — action valid but
 *     not permitted from the current status.
 *   - {@link ThreadNotFoundError} — thread missing or wrong owner.
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type { Thread } from '@ggui-ai/protocol';
import type { ThreadHandlerContext } from './context.js';
import { applyThreadActionInputSchema, parseWithSchema } from './schemas.js';

export interface ApplyThreadActionDeps {
  readonly threads: ThreadStore;
}

export interface ApplyThreadActionInput {
  readonly threadId: string;
  readonly body: unknown;
}

export async function applyThreadAction(
  deps: ApplyThreadActionDeps,
  input: ApplyThreadActionInput,
  ctx: ThreadHandlerContext,
): Promise<Thread> {
  const parsed = parseWithSchema(
    applyThreadActionInputSchema,
    input.body,
    'apply-thread-action request',
  );
  return deps.threads.applyAction(ctx.ownerId, input.threadId, parsed.action);
}
