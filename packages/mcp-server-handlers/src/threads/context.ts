/**
 * Per-request context threaded through every thread handler.
 *
 * Narrower than the tool-shaped {@link HandlerContext} in this package's
 * root: thread handlers are partition-scoped by `ownerId` (the identity
 * the auth layer resolved upstream), not by `appId`. `appId` is still
 * present on individual `Thread` rows but it's carried as data through
 * request shapes (e.g. {@link CreateThreadInput}), not through handler
 * context.
 */
import type { ThreadOwnerId } from '@ggui-ai/protocol';

export interface ThreadHandlerContext {
  /**
   * Resolved owner id — the thread-partition key. Upstream auth proves
   * this; handlers forward it verbatim to {@link ThreadStore}. Tests
   * that bypass auth inject it directly.
   *
   * Wrong-owner + missing-thread both surface as
   * {@link ThreadNotFoundError}; handlers never distinguish them.
   */
  readonly ownerId: ThreadOwnerId;
  /** Per-request correlation id. Used for log lines; transport-owned. */
  readonly requestId: string;
}
