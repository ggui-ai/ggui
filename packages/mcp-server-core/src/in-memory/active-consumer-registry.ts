/**
 * In-process reference-count `ActiveConsumerRegistry` implementation.
 * Single-instance per server process — fine for a single-process server
 * and for a multi-replica deployment whose session affinity keeps one
 * render's traffic on one replica.
 * Multi-replica deployments that need cross-instance consumer awareness
 * should wire a Redis-backed implementation against the same
 * interface.
 *
 * Operations are O(1) (Map.get / set / delete); `exit` is amortized
 * O(1), because its pruning deletes each stamp at most once. Not thread-safe by
 * design — Node's single-threaded event loop is the synchronization
 * primitive; concurrent `enter` / `exit` calls interleave only around
 * `await` boundaries, but each individual Map mutation is atomic.
 *
 * @public
 */

import type { ActiveConsumerRegistry } from '../active-consumer-registry.js';
import { RetainedStamps } from './retained-stamps.js';

/**
 * How long an exit stays readable through `msSinceLastExit`, in ms
 * (ggui#1485). Past it the exit reads `undefined`, and each new exit prunes
 * the ones past it, so the exit map holds the exits of the minute before
 * the latest one instead of one entry per session that ever had a
 * consumer.
 *
 * It is at least both windows `ggui_runtime_submit_action`'s grace compares
 * against, and a test there holds it so: an exit younger than 10 s takes
 * the long wait, and with no exit on record, a render younger than 60 s
 * does; any other exit takes the short wait. So forgetting an exit changes
 * no wait while the render's `createdAt` is older than the exit: the
 * forgotten exit is over 60 s old, the render is older still, and both
 * arms give the short wait. One case does change. A session re-rendered in
 * place after its consumer exited, on a store that keeps the new render's
 * `createdAt` (a `ggui_render` reuse), now takes the long wait for 60 s
 * after the re-render, as a fresh render does, where it took the short one.
 */
export const ACTIVE_CONSUMER_EXIT_RETENTION_MS = 60_000;

export class InMemoryActiveConsumerRegistry implements ActiveConsumerRegistry {
  private readonly counts = new Map<string, number>();
  private readonly lastExitAt = new RetainedStamps(ACTIVE_CONSUMER_EXIT_RETENTION_MS);
  private readonly waiters = new Map<string, Set<() => void>>();

  enter(sessionId: string): void {
    this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1);
    // Wake every parked waitForConsumer — the answer just became true.
    const set = this.waiters.get(sessionId);
    if (set !== undefined) {
      this.waiters.delete(sessionId);
      for (const wake of set) wake();
    }
  }

  exit(sessionId: string): void {
    const next = (this.counts.get(sessionId) ?? 0) - 1;
    if (next <= 0) {
      this.counts.delete(sessionId);
    } else {
      this.counts.set(sessionId, next);
    }
    this.lastExitAt.stamp(sessionId, Date.now());
  }

  hasActive(sessionId: string): boolean {
    return (this.counts.get(sessionId) ?? 0) > 0;
  }

  waitForConsumer(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (this.hasActive(sessionId)) return Promise.resolve(true);
    if (timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiters.get(sessionId)?.delete(wake);
        resolve(false);
      }, timeoutMs);
      const wake = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const set = this.waiters.get(sessionId) ?? new Set<() => void>();
      set.add(wake);
      this.waiters.set(sessionId, set);
    });
  }

  msSinceLastExit(sessionId: string): number | undefined {
    return this.lastExitAt.age(sessionId, Date.now());
  }
}
