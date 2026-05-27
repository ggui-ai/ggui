/**
 * SQLite-backed reference adapters. OSS default for `ggui serve`
 * when the operator wants durable local state that survives
 * process restart.
 *
 * Scope:
 *   - {@link SqliteRenderStore}   — persistent renders + event history.
 *   - {@link SqliteVectorStore}   — persistent RAG vector index.
 *   - {@link SqliteThreadStore}   — persistent chat threads + messages.
 *
 * `better-sqlite3` is an optional peer dependency. Consumers who
 * stay in-memory-only pay nothing. Consumers who import `@ggui-ai/
 * mcp-server-core/sqlite` MUST install `better-sqlite3` in their own
 * package.json.
 */

export { SqliteRenderStore } from './render-store.js';
export type { SqliteRenderStoreOptions } from './render-store.js';
export { SqlitePendingEventConsumer } from './pending-event-consumer.js';
export type { SqlitePendingEventConsumerOptions } from './pending-event-consumer.js';
export { SqliteShortCodeIndex } from './short-code-index.js';
export type { SqliteShortCodeIndexOptions } from './short-code-index.js';
export { SqliteVectorStore } from './vector-store.js';
export type { SqliteVectorStoreOptions } from './vector-store.js';
export { SqliteThreadStore } from './thread-store.js';
export type { SqliteThreadStoreOptions } from './thread-store.js';
