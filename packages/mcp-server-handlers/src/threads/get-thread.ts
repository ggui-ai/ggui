/**
 * `getThread` — fetch a single thread by id, owner-scoped.
 *
 * Thin over {@link ThreadStore.getThread}. The store already partitions
 * by ownerId (wrong-owner → null, same surface as missing). This
 * handler promotes `null` to a typed {@link ThreadNotFoundError} so
 * transports have exactly one "thread not found" mapping to 404 —
 * no optional-return logic branches at the HTTP layer.
 *
 * Failure modes:
 *   - {@link ThreadNotFoundError} — thread missing or wrong owner.
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type { Thread } from '@ggui-ai/protocol';
import type { ThreadHandlerContext } from './context.js';
import { ThreadNotFoundError } from './errors.js';

export interface GetThreadDeps {
  readonly threads: ThreadStore;
}

export interface GetThreadInput {
  readonly threadId: string;
}

export async function getThread(
  deps: GetThreadDeps,
  input: GetThreadInput,
  ctx: ThreadHandlerContext,
): Promise<Thread> {
  const thread = await deps.threads.getThread(ctx.ownerId, input.threadId);
  if (!thread) throw new ThreadNotFoundError(input.threadId);
  return thread;
}
