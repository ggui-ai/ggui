/**
 * A bounded "seen before?" set, for a log line that should fire once per key
 * per server process without growing with the number of keys.
 *
 * Insertion-ordered: at capacity, the oldest key is forgotten, so a key
 * offered again after `capacity` newer keys counts as new and its line fires
 * a second time. A reader of such a line takes the earliest per key.
 */
export interface FirstSeen {
  /** True the first time `key` is offered (or once it has been forgotten); false after. */
  first(key: string): boolean;
}

export function createFirstSeen(capacity: number): FirstSeen {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }
  const seen = new Set<string>();
  return {
    first(key) {
      if (seen.has(key)) return false;
      if (seen.size >= capacity) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      seen.add(key);
      return true;
    },
  };
}
