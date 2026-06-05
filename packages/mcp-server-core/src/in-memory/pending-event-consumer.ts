/**
 * In-memory `PendingEventConsumer` for OSS dev/test.
 *
 * Backed by a `Map<sessionId, {events, status, lastActivityAt}>`
 * struct with per-render mutex serialization on `consumeAndClear`
 * and `append` so concurrent callers can't race the buffer.
 *
 * Lifecycle (sessionId-keyed):
 *   - `markCreated(sessionId)` opens a pipe so subsequent
 *     `append` / `consumeAndClear` work. Called by the `ggui_render`
 *     handler the moment a render is committed — so events queued
 *     BEFORE the agent's first `ggui_consume` (e.g. the user clicks
 *     before the agent starts polling) still land in the pipe.
 *   - `append(sessionId, event)` enqueues an action envelope.
 *     Throws `PendingPipeNotFoundError` if the pipe wasn't opened.
 *   - `consumeAndClear(sessionId, ttlMs)` atomically drains the
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
  /** Per-sessionId mutex — `consumeAndClear` and `append` chain on
   *  this so atomicity is preserved under concurrent callers. */
  private readonly mutexes = new Map<string, Promise<void>>();

  async consumeAndClear(
    sessionId: string,
    ttlMs: number,
  ): Promise<PendingEventConsumeResult> {
    return this.withMutex(sessionId, async () => {
      const entry = this.pipes.get(sessionId);
      if (!entry) {
        throw new PendingPipeNotFoundError(sessionId);
      }
      const events = entry.events;
      entry.events = [];
      entry.lastActivityAt = Date.now();
      entry.expiresAt = entry.lastActivityAt + ttlMs;
      return { events, status: entry.status };
    });
  }

  async append(
    sessionId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    return this.withMutex(sessionId, async () => {
      const entry = this.pipes.get(sessionId);
      if (!entry) {
        throw new PendingPipeNotFoundError(sessionId);
      }
      entry.events.push(event);
      entry.lastActivityAt = Date.now();
    });
  }

  /** Test / handler-side hook: open a pipe so subsequent appends +
   *  consumes work. Idempotent — calling on an existing pipe resets
   *  nothing. */
  markCreated(sessionId: string, ttlMs = Number.MAX_SAFE_INTEGER): void {
    if (this.pipes.has(sessionId)) return;
    const now = Date.now();
    this.pipes.set(sessionId, {
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
  markStatus(sessionId: string, status: GguiSessionStatus): void {
    const entry = this.pipes.get(sessionId);
    if (!entry) return;
    entry.status = status;
    entry.lastActivityAt = Date.now();
  }

  /**
   * Tear down the pipe for `sessionId`. Subsequent `append` /
   * `consumeAndClear` calls throw {@link PendingPipeNotFoundError}
   * exactly as if the pipe had never been opened. Idempotent —
   * deleting a non-existent pipe is a no-op.
   */
  markDeleted(sessionId: string): void {
    this.pipes.delete(sessionId);
    this.mutexes.delete(sessionId);
  }

  /** Inspector for tests: how many events are queued? */
  pendingCount(sessionId: string): number {
    return this.pipes.get(sessionId)?.events.length ?? 0;
  }

  private async withMutex<T>(
    sessionId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.mutexes.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(
      sessionId,
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
