/**
 * Persistent-chat handler family (`@ggui-ai/mcp-server-handlers/threads`).
 *
 * Thin functional layer over {@link ThreadStore}. Every handler:
 *   - takes `(deps, input, ctx)` where `deps.threads` is a store impl.
 *   - parses request shape and throws
 *     {@link InvalidThreadRequestError} on failure.
 *   - delegates the load-bearing work to the store, which enforces
 *     ownership, idempotency, sequencing, and state-machine rules.
 *   - surfaces the store's typed errors ({@link ThreadNotFoundError},
 *     {@link InvalidThreadActionError},
 *     {@link ThreadActionInvalidStateError}) without re-wrapping.
 *
 * Pure functions, no transport coupling. HTTP routing (Step 4) and SSE
 * (Step 5) mount these directly; non-HTTP transports (e.g. a future
 * MCP resource) can reuse them identically.
 */

export { createThread } from './create-thread.js';
export type { CreateThreadDeps } from './create-thread.js';

export { getThread } from './get-thread.js';
export type { GetThreadDeps, GetThreadInput } from './get-thread.js';

export { listThreads } from './list-threads.js';
export type { ListThreadsDeps } from './list-threads.js';

export { appendMessage } from './append-message.js';
export type { AppendMessageDeps } from './append-message.js';

export { listMessages } from './list-messages.js';
export type {
  ListMessagesDeps,
  ListMessagesInput,
} from './list-messages.js';

export { applyThreadAction } from './apply-thread-action.js';
export type {
  ApplyThreadActionDeps,
  ApplyThreadActionInput,
} from './apply-thread-action.js';

export { observeMessages } from './observe-messages.js';
export type {
  ObserveMessagesDeps,
  ObserveMessagesInput,
} from './observe-messages.js';

export type { ThreadHandlerContext } from './context.js';
export {
  InvalidThreadActionError,
  InvalidThreadRequestError,
  ThreadActionInvalidStateError,
  ThreadNotFoundError,
} from './errors.js';
