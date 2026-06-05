/**
 * In-memory `PendingEventConsumer` for OSS dev/test.
 *
 * Backed by a `Map<renderId, {events, status, lastActivityAt}>`
 * struct with per-render mutex serialization on `consumeAndClear`
 * and `append` so concurrent callers can't race the buffer.
 *
 * Lifecycle (renderId-keyed):
 *   - `markCreated(renderId)` opens a pipe so subsequent
 *     `append` / `consumeAndClear` work. Called by the `ggui_render`
 *     handler the moment a render is committed — so events queued
 *     BEFORE the agent's first `ggui_consume` (e.g. the user clicks
 *     before the agent starts polling) still land in the pipe.
 *   - `append(renderId, event)` enqueues an action envelope.
 *     Throws `PendingPipeNotFoundError` if the pipe wasn't opened.
 *   - `consumeAndClear(renderId, ttlMs)` atomically drains the
 *     buffer and bumps the pipe's heartbeat.
 *
 * No explicit close. Pipes decay implicitly via TTL — when a render's
 * `expiresAt` elapses the pipe's status flips to `'expired'` and the
 * agent's long-poll loop terminates on the next consume.
 */

import type { GguiSessionStatus } from '@ggui-ai/protocol';
import {
  type PendingEventConsumeResult,
  type PendingEventConsumer,
  PendingPipeNotFoundError,
} from '../pending-event-consumer.js';

interface PipeEntry {
  events: Array<Record<string, unknown>>;
  status: GguiSessionStatus;
  lastActivityAt: number;
  expiresAt: number;
}

export class InMemoryPendingEventConsumer implements PendingEventConsumer {
  private readonly pipes = new Map<string, PipeEntry>();
  /** Per-renderId mutex — `consumeAndClear` and `append` chain on
   *  this so atomicity is preserved under concurrent callers. */
  private readonly mutexes = new Map<string, Promise<void>>();

  async consumeAndClear(
    renderId: string,
    ttlMs: number,
  ): Promise<PendingEventConsumeResult> {
    return this.withMutex(renderId, async () => {
      const entry = this.pipes.get(renderId);
      if (!entry) {
        throw new PendingPipeNotFoundError(renderId);
      }
      const events = entry.events;
      entry.events = [];
      entry.lastActivityAt = Date.now();
      entry.expiresAt = entry.lastActivityAt + ttlMs;
      return { events, status: entry.status };
    });
  }

  async append(
    renderId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    return this.withMutex(renderId, async () => {
      const entry = this.pipes.get(renderId);
      if (!entry) {
        throw new PendingPipeNotFoundError(renderId);
      }
      entry.events.push(event);
      entry.lastActivityAt = Date.now();
    });
  }

  /** Test / handler-side hook: open a pipe so subsequent appends +
   *  consumes work. Idempotent — calling on an existing pipe resets
   *  nothing. */
  markCreated(renderId: string, ttlMs = Number.MAX_SAFE_INTEGER): void {
    if (this.pipes.has(renderId)) return;
    const now = Date.now();
    this.pipes.set(renderId, {
      events: [],
      status: 'active',
      lastActivityAt: now,
      expiresAt: now + ttlMs,
    });
  }

  /**
   * Flip the pipe's lifecycle status without consuming events. Used
   * by handler-side close paths + tests that need to short-circuit
   * the long-poll loop. No-op on missing pipe (matches interface
   * semantics — callers shouldn't have to guard against vanished
   * renders).
   */
  markStatus(renderId: string, status: GguiSessionStatus): void {
    const entry = this.pipes.get(renderId);
    if (!entry) return;
    entry.status = status;
    entry.lastActivityAt = Date.now();
  }

  /**
   * Tear down the pipe for `renderId`. Subsequent `append` /
   * `consumeAndClear` calls throw {@link PendingPipeNotFoundError}
   * exactly as if the pipe had never been opened. Idempotent —
   * deleting a non-existent pipe is a no-op.
   */
  markDeleted(renderId: string): void {
    this.pipes.delete(renderId);
    this.mutexes.delete(renderId);
  }

  /** Inspector for tests: how many events are queued? */
  pendingCount(renderId: string): number {
    return this.pipes.get(renderId)?.events.length ?? 0;
  }

  private async withMutex<T>(
    renderId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.mutexes.get(renderId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(
      renderId,
      prev.then(() => next),
    );
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
