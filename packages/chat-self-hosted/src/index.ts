/**
 * @ggui-ai/chat-self-hosted — chat storage adapter for
 * self-hosted `@ggui-ai/mcp-server` origins.
 *
 * Implements the `FullChatStorageAdapter` contract against the
 * server's persistent-thread HTTP + SSE surface, so a host can pick
 * one adapter per origin and treat self-hosted and managed origins
 * uniformly.
 *
 * Note: the server's default `InMemoryThreadStore` loses thread
 * state on restart. This adapter is correct either way — it's the
 * store that is in-memory, not the contract; pair it with a durable
 * thread store (e.g. the SQLite reference impl) for persistence.
 */

export {
  createSelfHostedGguiAdapter,
  type SelfHostedAdapterOptions,
} from './adapter.js';

export type {
  FullChatStorageAdapter,
  MessageStorageAdapter,
  ThreadActionsAdapter,
  StoredMessage,
  ThreadStateAction,
} from './types.js';

export { ThreadTransportError } from './errors.js';
export type { ThreadTransportErrorInit } from './errors.js';

export {
  createSelfHostedThread,
  getSelfHostedThread,
  listSelfHostedThreads,
  type CreateSelfHostedThreadInput,
  type SelfHostedThreadOpsOptions,
} from './thread-ops.js';
