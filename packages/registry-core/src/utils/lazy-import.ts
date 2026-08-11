/**
 * Memoizing wrapper around a lazy async load. Caches the in-flight (or
 * already-resolved) promise so concurrent and later callers share one
 * load — but clears the cache on rejection, so a failed attempt
 * doesn't poison every later call for the rest of the process.
 *
 * A rejected promise is still a defined value, so a bare
 * `cached ??= loader()` would cache the failure permanently: every
 * later call would re-throw the same stale rejection even once
 * whatever caused it (a transient resolution failure, a missing
 * optional dependency on first use, …) is no longer true. This
 * wrapper resets the cache to `undefined` on rejection so the next
 * call starts a fresh attempt, while still deduping callers that
 * arrive while an attempt is in flight.
 */
export function memoizedRetryingImport<T>(loader: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return (): Promise<T> => {
    if (cached === undefined) {
      cached = loader().catch((err: unknown) => {
        cached = undefined;
        throw err;
      });
    }
    return cached;
  };
}
