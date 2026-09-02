/**
 * Connection store — the in-document external store behind
 * `useRender().isConnected` (ggui#670).
 *
 * Why a store and not a stream: the wire config is built exactly once
 * per mount (build-once invariant) and `useRender` returned a literal
 * `true` for `isConnected` — a taught liveness read that was a
 * constant lie. A `{ subscribe, getSnapshot }` seam lets the runtime
 * WRITE the truth (the relay latch's two edges) while only subscribing
 * components re-render (`useSyncExternalStore`), the config object
 * stays stable, and a late reader lands on the current value
 * synchronously (no first-frame flash). It is in-document only —
 * nothing on the wire can reach it, so it cannot be forged; it is not
 * a reserved stream channel and adds no protocol surface.
 *
 * Contract (parties: the runtime writes, wire reads, components read
 * an already-taught field): `set` notifies only on a real transition
 * (one notification per edge, structurally); default `true` means
 * "no transition has happened" — today's behavior exactly. The value
 * is PRESENTATIONAL truth: readers MUST NOT suppress dispatch on
 * `false` (the attempt is the runtime's self-heal sensor).
 */
export interface ConnectionStore {
  /** Subscribe to transitions; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Current value, synchronously. */
  readonly getSnapshot: () => boolean;
  /** Runtime-side writer. Notifies only when the value changes. */
  readonly set: (connected: boolean) => void;
}

export function createConnectionStore(initial = true): ConnectionStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return value;
    },
    set(connected) {
      if (connected === value) return;
      value = connected;
      for (const l of listeners) l();
    },
  };
}

/**
 * The document's connection store — the runtime is its only writer
 * (the relay latch's two edges); `useRender()` is its reader.
 */
export const connectionStore: ConnectionStore = createConnectionStore(true);
