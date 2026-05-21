/**
 * In-memory `PendingEventConsumer` for OSS dev/test.
 *
 * Backed by a `Map<stackItemId, {events, status, lastActivityAt}>`
 * struct with per-stackItem mutex serialization on `consumeAndClear`
 * and `append` so concurrent callers can't race the buffer.
 *
 * Lifecycle (Model C, stackItemId-keyed):
 *   - `markCreated(stackItemId)` opens a pipe so subsequent
 *     `append` / `consumeAndClear` work. Called by the `ggui_push`
 *     handler the moment a stack item is appended — so events queued
 *     BEFORE the agent's first `ggui_consume` (e.g. the user clicks
 *     before the agent starts polling) still land in the pipe.
 *   - `append(stackItemId, event)` enqueues an action envelope.
 *     Throws `PendingPipeNotFoundError` if the pipe wasn't opened.
 *   - `consumeAndClear(stackItemId, ttlMs)` atomically drains the
 *     buffer and bumps the pipe's heartbeat.
 *   - `markStatus(stackItemId, 'completed')` flips the observed
 *     status so the long-poll loop short-circuits.
 *   - `markDeleted(stackItemId)` removes the pipe; subsequent ops
 *     throw. Called by `ggui_pop` / `ggui_close`.
 */

import type { SessionStatus } from '@ggui-ai/protocol';
import {
  type PendingEventConsumeResult,
  type PendingEventConsumer,
  PendingPipeNotFoundError,
} from '../pending-event-consumer.js';

interface PipeEntry {
  events: Array<Record<string, unknown>>;
  status: SessionStatus;
  lastActivityAt: number;
  expiresAt: number;
}

export class InMemoryPendingEventConsumer implements PendingEventConsumer {
  private readonly pipes = new Map<string, PipeEntry>();
  /** Per-stackItemId mutex — `consumeAndClear` and `append` chain on
   *  this so atomicity is preserved under concurrent callers. */
  private readonly mutexes = new Map<string, Promise<void>>();

  async consumeAndClear(
    stackItemId: string,
    ttlMs: number,
  ): Promise<PendingEventConsumeResult> {
    return this.withMutex(stackItemId, async () => {
      const entry = this.pipes.get(stackItemId);
      if (!entry) {
        throw new PendingPipeNotFoundError(stackItemId);
      }
      const events = entry.events;
      entry.events = [];
      entry.lastActivityAt = Date.now();
      entry.expiresAt = entry.lastActivityAt + ttlMs;
      return { events, status: entry.status };
    });
  }

  async append(
    stackItemId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    return this.withMutex(stackItemId, async () => {
      const entry = this.pipes.get(stackItemId);
      if (!entry) {
        throw new PendingPipeNotFoundError(stackItemId);
      }
      entry.events.push(event);
      entry.lastActivityAt = Date.now();
    });
  }

  /** Test / handler-side hook: open a pipe so subsequent appends +
   *  consumes work. Idempotent — calling on an existing pipe resets
   *  nothing. */
  markCreated(stackItemId: string, ttlMs = Number.MAX_SAFE_INTEGER): void {
    if (this.pipes.has(stackItemId)) return;
    const now = Date.now();
    this.pipes.set(stackItemId, {
      events: [],
      status: 'active',
      lastActivityAt: now,
      expiresAt: now + ttlMs,
    });
  }

  /** Update the pipe's observed status — e.g. `'completed'` so
   *  the next consume returns the terminal flag and ends the agent's
   *  long-poll loop. */
  markStatus(stackItemId: string, status: SessionStatus): void {
    const entry = this.pipes.get(stackItemId);
    if (!entry) return;
    entry.status = status;
  }

  /** Remove the pipe — subsequent ops throw
   *  `PendingPipeNotFoundError`. */
  markDeleted(stackItemId: string): void {
    this.pipes.delete(stackItemId);
    this.mutexes.delete(stackItemId);
  }

  /** Inspector for tests: how many events are queued? */
  pendingCount(stackItemId: string): number {
    return this.pipes.get(stackItemId)?.events.length ?? 0;
  }

  private async withMutex<T>(
    stackItemId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.mutexes.get(stackItemId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexes.set(
      stackItemId,
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
