/**
 * `createThread` — open a new persistent chat.
 *
 * Thin over {@link ThreadStore.createThread}. The store owns id
 * generation, initial field seeding (lastSeq=0, unreadCount=0,
 * status='active'), title-hint truncation, and metadata cloning.
 *
 * Failure modes:
 *   - {@link InvalidThreadRequestError} — malformed body (missing
 *     appId, extra unknown fields, wrong type).
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type { CreateThreadInput, Thread } from '@ggui-ai/protocol';
import type { ThreadHandlerContext } from './context.js';
import { createThreadInputSchema, parseWithSchema } from './schemas.js';

export interface CreateThreadDeps {
  readonly threads: ThreadStore;
}

export async function createThread(
  deps: CreateThreadDeps,
  input: unknown,
  ctx: ThreadHandlerContext,
): Promise<Thread> {
  const parsed: CreateThreadInput = parseWithSchema(
    createThreadInputSchema,
    input,
    'create-thread request',
  );
  return deps.threads.createThread(ctx.ownerId, parsed);
}
