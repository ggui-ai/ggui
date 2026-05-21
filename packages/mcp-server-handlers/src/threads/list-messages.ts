/**
 * `listMessages` — read a thread's messages in seq-ASC order.
 *
 * Thin over {@link ThreadStore.listMessages}. The store enforces
 * ordering, ownership, and fromSeq/cursor paging. This handler splits
 * the `threadId` path parameter from the query-string-shaped options
 * so transports (Step 4) can wire them directly from URL segments +
 * query params without bespoke parsing.
 *
 * Failure modes:
 *   - {@link InvalidThreadRequestError} — malformed options.
 *   - {@link ThreadNotFoundError} — thread missing or wrong owner.
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type {
  ListMessagesOptions,
  ListMessagesResult,
} from '@ggui-ai/protocol';
import type { ThreadHandlerContext } from './context.js';
import { listMessagesOptionsSchema, parseWithSchema } from './schemas.js';

export interface ListMessagesDeps {
  readonly threads: ThreadStore;
}

export interface ListMessagesInput {
  readonly threadId: string;
  readonly options?: unknown;
}

export async function listMessages(
  deps: ListMessagesDeps,
  input: ListMessagesInput,
  ctx: ThreadHandlerContext,
): Promise<ListMessagesResult> {
  const options: ListMessagesOptions = parseWithSchema(
    listMessagesOptionsSchema,
    input.options ?? {},
    'list-messages options',
  );
  return deps.threads.listMessages(ctx.ownerId, input.threadId, options);
}
