/**
 * The last time stamped per key, forgotten after a retention (ggui#1485).
 *
 * A stamp older than `retentionMs` reads `undefined`, and each new stamp
 * prunes the ones past it, oldest first, so the map holds only the stamps
 * from the `retentionMs` before the latest one. The Map keeps insertion
 * order and a re-stamp moves its key to the end, so pruning stops at the
 * first stamp still inside the retention: each stamp is deleted at most
 * once, and `stamp` is amortized O(1).
 *
 * Internal to the in-memory active-consumer registry; not on the package
 * barrel.
 */
export class RetainedStamps {
  private readonly stamps = new Map<string, number>();

  constructor(private readonly retentionMs: number) {}

  stamp(key: string, now: number): void {
    this.stamps.delete(key);
    this.stamps.set(key, now);
    for (const [k, at] of this.stamps) {
      if (now - at <= this.retentionMs) break;
      this.stamps.delete(k);
    }
  }

  /** Ms since `key` was last stamped, or `undefined` when never or past the retention. */
  age(key: string, now: number): number | undefined {
    const at = this.stamps.get(key);
    if (at === undefined) return undefined;
    const age = Math.max(0, now - at);
    return age > this.retentionMs ? undefined : age;
  }

  /** How many stamps the map holds. */
  get size(): number {
    return this.stamps.size;
  }
}
