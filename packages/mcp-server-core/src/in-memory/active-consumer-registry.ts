/**
 * In-process reference-count `ActiveConsumerRegistry` implementation.
 * Single-instance per server process — fine for OSS (one Node process
 * per MCP server) and for the cloud pod (one pod per render).
 * Multi-pod deployments that need cross-instance consumer awareness
 * should wire a Redis-backed implementation against the same
 * interface.
 *
 * Operations are O(1) (Map.get / set / delete). Not thread-safe by
 * design — Node's single-threaded event loop is the synchronization
 * primitive; concurrent `enter` / `exit` calls interleave only around
 * `await` boundaries, but each individual Map mutation is atomic.
 *
 * @public
 */

import type { ActiveConsumerRegistry } from '../active-consumer-registry.js';

export class InMemoryActiveConsumerRegistry implements ActiveConsumerRegistry {
  private readonly counts = new Map<string, number>();

  enter(renderId: string): void {
    this.counts.set(renderId, (this.counts.get(renderId) ?? 0) + 1);
  }

  exit(renderId: string): void {
    const next = (this.counts.get(renderId) ?? 0) - 1;
    if (next <= 0) {
      this.counts.delete(renderId);
    } else {
      this.counts.set(renderId, next);
    }
  }

  hasActive(renderId: string): boolean {
    return (this.counts.get(renderId) ?? 0) > 0;
  }
}
