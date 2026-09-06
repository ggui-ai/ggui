/**
 * Connection store — the in-document external store behind
 * `useRender().isConnected` (ggui#670), split into a READ view and a
 * CLAIMED writer (ggui#843).
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
 * Parties (ggui#843): the WRITER is a deployment's runtime — the
 * iframe-runtime claims it once, eagerly at boot, under its own name;
 * the READERS are `useRender()`, generated component code (through the
 * root barrel, and so through `globalThis.__ggui__.wire`) and tests.
 * Readers get {@link ConnectionSource} only; the writer is claimed through
 * `@ggui-ai/wire/internal`, which the root barrel never re-exports, so a
 * component cannot write the connection state it reads.
 *
 * ONE store per DOCUMENT, not per module copy: a deployment's runtime is a
 * bundle, and a document can evaluate the bundle — and this module — more
 * than once. The store is therefore anchored on `globalThis` under the
 * ONLY shared surface, `Symbol.for('ai.ggui.wire/connection-store')`; every
 * copy of this module adopts the store already there, which is what makes
 * the duplicate-bundle conflict below real. Cross-copy contract: whatever
 * sits at that key MUST be a connection store by shape ({@link isConnectionStore}
 * — `source.subscribe`, `source.getSnapshot`, `claim`); a value that is not
 * is REFUSED at module load with {@link ConnectionStoreSlotError}, never
 * adopted and never overwritten — the second copy must not silently win any
 * more than the second claimant may.
 *
 * Contract: `set` notifies only on a real transition (one notification
 * per edge, structurally); default `true` means "no transition has
 * happened" — today's behavior exactly. The value is PRESENTATIONAL
 * truth: readers MUST NOT suppress dispatch on `false` (the attempt is
 * the runtime's self-heal sensor; tier-0 `connection-suppression` pins
 * it). Exactly one live writer per document: a second claim throws
 * {@link ConnectionWriterConflictError} naming both parties — and when
 * they are the same name, that is two copies of the runtime in one
 * document (a duplicate bundle), which the error says in words. A
 * released writer that writes again throws
 * {@link ConnectionWriterReleasedError}. Neither failure touches the
 * store.
 */

/** The read view every reader may hold. */
export interface ConnectionSource {
  /** Subscribe to transitions; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Current value, synchronously. */
  readonly getSnapshot: () => boolean;
}

/** The claimed writer — one live holder per store. */
export interface ConnectionWriter {
  /** Write the connection state. Notifies only when the value changes. */
  readonly set: (connected: boolean) => void;
  /** Give the claim back; idempotent. The writer is inert afterwards. */
  readonly release: () => void;
}

/** A store instance: its read view and the one claim on its writer. */
export interface ConnectionStore {
  readonly source: ConnectionSource;
  /**
   * Claim the writer under `claimant`'s name. Throws
   * {@link ConnectionWriterConflictError} while another claim is held.
   */
  readonly claim: (claimant: string) => ConnectionWriter;
}

/** A second claim on a writer that is held. `owner === attemptedBy` is a duplicate bundle of the runtime. */
export class ConnectionWriterConflictError extends Error {
  readonly owner: string;
  readonly attemptedBy: string;
  constructor(owner: string, attemptedBy: string) {
    super(
      owner === attemptedBy
        ? `connection writer: '${owner}' already holds the claim and '${attemptedBy}' is claiming it again — two copies of '${owner}' in one document (a duplicate bundle of the runtime)`
        : `connection writer: '${owner}' holds the claim; '${attemptedBy}' cannot take it — exactly one party writes the connection state`,
    );
    this.name = 'ConnectionWriterConflictError';
    this.owner = owner;
    this.attemptedBy = attemptedBy;
  }
}

/**
 * `name`-detection of {@link ConnectionWriterConflictError} across module
 * copies: the store's `claim` closure belongs to the copy that created the
 * store, so a second copy catching the conflict holds a different class
 * object — the name, not `instanceof`, is what every copy shares.
 */
export function isConnectionWriterConflictError(err: unknown): err is ConnectionWriterConflictError {
  return (
    err instanceof Error &&
    err.name === 'ConnectionWriterConflictError' &&
    typeof Reflect.get(err, 'owner') === 'string' &&
    typeof Reflect.get(err, 'attemptedBy') === 'string'
  );
}

/** A write through a writer that released its claim. */
export class ConnectionWriterReleasedError extends Error {
  readonly claimant: string;
  constructor(claimant: string) {
    super(`connection writer: '${claimant}' released its claim and cannot set the connection state`);
    this.name = 'ConnectionWriterReleasedError';
    this.claimant = claimant;
  }
}

/** The one shared surface between copies of this module in a document. */
const DOCUMENT_STORE_KEY: unique symbol = Symbol.for('ai.ggui.wire/connection-store');

/** A value at the document slot that is not a connection store — refused, not adopted, not overwritten. */
export class ConnectionStoreSlotError extends Error {
  constructor(readonly key: symbol) {
    super(
      `connection store: the document slot ${String(key)} holds a value that is not a connection store — another copy of @ggui-ai/wire with an incompatible shape, or a foreign object. Refusing to adopt or overwrite it.`,
    );
    this.name = 'ConnectionStoreSlotError';
  }
}

/** The shape every copy of this module expects at the document slot. */
export function isConnectionStore(value: unknown): value is ConnectionStore {
  if (typeof value !== 'object' || value === null) return false;
  const source = Reflect.get(value, 'source');
  if (typeof source !== 'object' || source === null) return false;
  return (
    typeof Reflect.get(value, 'claim') === 'function' &&
    typeof Reflect.get(source, 'subscribe') === 'function' &&
    typeof Reflect.get(source, 'getSnapshot') === 'function'
  );
}

/** Build an isolated store — the test-isolation seam; the document's store is {@link connectionSource} + `claimConnectionWriter`. */
export function createConnectionStore(initial = true): ConnectionStore {
  let value = initial;
  let owner: string | undefined;
  const listeners = new Set<() => void>();
  const source: ConnectionSource = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return value;
    },
  };
  return {
    source,
    claim(claimant) {
      if (owner !== undefined) throw new ConnectionWriterConflictError(owner, claimant);
      owner = claimant;
      let released = false;
      return {
        set(connected) {
          if (released) throw new ConnectionWriterReleasedError(claimant);
          if (connected === value) return;
          value = connected;
          for (const l of listeners) l();
        },
        release() {
          if (released) return;
          released = true;
          owner = undefined;
        },
      };
    },
  };
}

/** Adopt the document's store from the slot, or create it once; refuse a foreign value. */
function documentConnectionStore(): ConnectionStore {
  const existing = Reflect.get(globalThis, DOCUMENT_STORE_KEY);
  if (existing !== undefined) {
    if (isConnectionStore(existing)) return existing;
    throw new ConnectionStoreSlotError(DOCUMENT_STORE_KEY);
  }
  const created = createConnectionStore(true);
  Reflect.set(globalThis, DOCUMENT_STORE_KEY, created);
  return created;
}

const documentStore = documentConnectionStore();

/**
 * The document's connection read view — what `useRender()` reads and the
 * only connection surface generated component code can reach.
 */
export const connectionSource: ConnectionSource = documentStore.source;

/**
 * Claim the document's connection writer (`@ggui-ai/wire/internal` only).
 * A deployment's runtime calls this once, eagerly at boot, under its own
 * name; the claim is the party's proof that it is the one runtime in this
 * document — a second copy of the runtime finds the same store (the
 * document slot) and fails here, naming itself.
 */
export function claimConnectionWriter(claimant: string): ConnectionWriter {
  return documentStore.claim(claimant);
}
