/**
 * InMemoryRenderIdentityStore — reference implementation of
 * {@link RenderIdentityStore}.
 *
 * Backing store is a single `Map<sessionId, RenderIdentityRecord>` —
 * unbounded, process-local, lost on restart. That makes it a fit for
 * tests and dev, and a non-fit for the durability the record exists
 * to provide: a deployment that actually needs a render to outlive
 * its session row binds a store that survives restart.
 */
import type {
  RenderIdentityRecord,
  RenderIdentityStore,
} from '../render-identity-store.js';

export class InMemoryRenderIdentityStore implements RenderIdentityStore {
  /**
   * #457 — declared by the BINDER, defaulting to the honest answer for
   * process memory: `'ephemeral'`. A test double standing in for a
   * durable store (or an exotic replicated-memory deployment) may
   * declare `'durable'` — the declaration is the binder's promise that
   * records survive a restart, and the substrate gate takes it at its
   * word.
   */
  readonly durability: 'durable' | 'ephemeral';

  constructor(options: { readonly durability?: 'durable' | 'ephemeral' } = {}) {
    this.durability = options.durability ?? 'ephemeral';
  }

  private readonly records = new Map<string, RenderIdentityRecord>();

  async put(record: RenderIdentityRecord): Promise<void> {
    if (!record.sessionId) {
      throw new Error(
        'InMemoryRenderIdentityStore.put: sessionId is required',
      );
    }
    // Whole-record upsert, and a full copy of it: the caller keeps a
    // live reference to the record it just wrote (the cold-gen path
    // re-puts a merged version of it), so storing the object itself
    // would let later caller-side mutation rewrite history.
    this.records.set(record.sessionId, structuredClone(record));
  }

  async get(sessionId: string): Promise<RenderIdentityRecord | null> {
    if (!sessionId) return null;
    const record = this.records.get(sessionId);
    if (!record) return null;
    // Defensive copy — `props` is a nested object, so a shallow
    // spread would still hand out shared state.
    return structuredClone(record);
  }

  /** Live record count. Useful for tests + introspection. */
  get size(): number {
    return this.records.size;
  }
}
