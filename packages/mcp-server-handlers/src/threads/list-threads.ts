/**
 * `listThreads` — enumerate the caller's threads, owner-scoped.
 *
 * Thin over {@link ThreadStore.listThreads}. The store enforces
 * partitioning by ownerId, ordering (most-recent-first), and
 * limit/cursor semantics. This handler only validates request shape.
 *
 * Failure modes:
 *   - {@link InvalidThreadRequestError} — malformed filter.
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type {
  ListThreadsFilter,
  ListThreadsResult,
} from '@ggui-ai/protocol';
import type { ThreadHandlerContext } from './context.js';
import { listThreadsFilterSchema, parseWithSchema } from './schemas.js';

export interface ListThreadsDeps {
  readonly threads: ThreadStore;
}

export async function listThreads(
  deps: ListThreadsDeps,
  input: unknown,
  ctx: ThreadHandlerContext,
): Promise<ListThreadsResult> {
  const filter: ListThreadsFilter = parseWithSchema(
    listThreadsFilterSchema,
    input ?? {},
    'list-threads filter',
  );
  return deps.threads.listThreads(ctx.ownerId, filter);
}
