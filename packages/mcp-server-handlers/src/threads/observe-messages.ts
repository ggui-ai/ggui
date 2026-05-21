/**
 * `observeMessages` — subscribe to appended messages on a thread.
 *
 * Thin over {@link ThreadStore.observeMessages}. The store owns
 * snapshot+tail semantics, ordering, fromSeq skip, and
 * throw-on-wrong-owner (from the iterator's first pull). This
 * handler only parses options + forwards.
 *
 * Returns an `AsyncIterable<ThreadMessage>` — the SSE transport
 * (Step 5) iterates it and serializes each message as a
 * {@link ThreadStreamEvent}. Non-SSE consumers (tests, future
 * WebSocket transports) iterate it the same way.
 *
 * Failure modes:
 *   - {@link InvalidThreadRequestError} — malformed options.
 *   - {@link ThreadNotFoundError} — thrown from the iterator's
 *     first `next()`, NOT from this function synchronously. Callers
 *     MUST handle the rejection on the first pull.
 */
import type { ThreadStore } from '@ggui-ai/mcp-server-core';
import type { ThreadMessage } from '@ggui-ai/protocol';
import type { ObserveMessagesOptions } from '@ggui-ai/mcp-server-core';
import type { ThreadHandlerContext } from './context.js';
import {
  observeMessagesOptionsSchema,
  parseWithSchema,
} from './schemas.js';

export interface ObserveMessagesDeps {
  readonly threads: ThreadStore;
}

export interface ObserveMessagesInput {
  readonly threadId: string;
  readonly options?: unknown;
}

export function observeMessages(
  deps: ObserveMessagesDeps,
  input: ObserveMessagesInput,
  ctx: ThreadHandlerContext,
): AsyncIterable<ThreadMessage> {
  const options: ObserveMessagesOptions = parseWithSchema(
    observeMessagesOptionsSchema,
    input.options ?? {},
    'observe-messages options',
  );
  return deps.threads.observeMessages(ctx.ownerId, input.threadId, options);
}
