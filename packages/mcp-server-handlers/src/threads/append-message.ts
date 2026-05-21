/**
 * `appendMessage` — persist a message idempotently on (threadId, key).
 *
 * Thin over {@link ThreadStore.appendMessage}. The store owns:
 *   - idempotency (first-write-wins on (threadId, key))
 *   - seq assignment (monotonic, gap-free, from 1)
 *   - unread counter (bumps only on non-user authors)
 *   - ownership enforcement
 *
 * Handlers MUST NOT re-implement any of the above. A retry that
 * returns the originally stored message (with stable seq/at) is the
 * contract — transports surface it as a normal 200/201, not a
 * conflict.
 *
 * Failure modes:
 *   - {@link InvalidThreadRequestError} — malformed body.
 *   - {@link ThreadNotFoundError} — thread missing or wrong owner.
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type {
  AppendThreadMessageInput,
  ThreadMessage,
} from '@ggui-ai/protocol';
import type { ThreadHandlerContext } from './context.js';
import {
  appendThreadMessageInputSchema,
  parseWithSchema,
} from './schemas.js';

export interface AppendMessageDeps {
  readonly threads: ThreadStore;
}

export async function appendMessage(
  deps: AppendMessageDeps,
  input: unknown,
  ctx: ThreadHandlerContext,
): Promise<ThreadMessage> {
  const parsed: AppendThreadMessageInput = parseWithSchema(
    appendThreadMessageInputSchema,
    input,
    'append-message request',
  );
  return deps.threads.appendMessage(ctx.ownerId, parsed);
}
