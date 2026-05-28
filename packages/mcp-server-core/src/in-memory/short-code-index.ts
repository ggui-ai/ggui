/**
 * InMemoryShortCodeIndex — reference implementation of
 * {@link ShortCodeIndex}.
 *
 * Backing store is a single `Map<shortCode, ShortCodeBinding>` —
 * unbounded, process-local, loss on restart. Matches the design
 * comment in `short-code-index.ts`: the console's launch story is
 * single-process `ggui dev`, so durability would be over-engineering
 * here.
 */
import type {
  ShortCodeBinding,
  ShortCodeIndex,
} from '../short-code-index.js';

export class InMemoryShortCodeIndex implements ShortCodeIndex {
  private readonly store = new Map<string, ShortCodeBinding>();
  /**
   * Reverse map backing {@link findByRenderId}. Maintained in lockstep
   * with `store` by every {@link put} — the forward store is the truth
   * (multiple renders could previously share a shortCode via rebind),
   * but for the reverse side we want "latest shortCode bound to this
   * render" which is exactly `renderIdToShortCode.get(renderId)`.
   */
  private readonly renderIdToShortCode = new Map<string, string>();

  async put(shortCode: string, binding: ShortCodeBinding): Promise<void> {
    if (!shortCode) {
      throw new Error('InMemoryShortCodeIndex.put: shortCode is required');
    }
    // Rebind hygiene: if this shortCode was previously bound to a
    // DIFFERENT renderId, clear that render's reverse entry so
    // `findByRenderId(oldRenderId)` doesn't keep returning the
    // rebound shortCode. Matches the last-writer-wins contract in
    // `short-code-index.ts`.
    const previous = this.store.get(shortCode);
    if (previous && previous.renderId !== binding.renderId) {
      const stillPointsHere =
        this.renderIdToShortCode.get(previous.renderId) === shortCode;
      if (stillPointsHere) {
        this.renderIdToShortCode.delete(previous.renderId);
      }
    }
    this.store.set(shortCode, { ...binding });
    // Reverse side is last-writer-wins per renderId: if a render
    // had an earlier shortCode, the new one takes over. The old
    // shortCode stays valid on the forward side — operators who
    // typed it before the rebind still resolve correctly.
    this.renderIdToShortCode.set(binding.renderId, shortCode);
  }

  async lookup(shortCode: string): Promise<ShortCodeBinding | null> {
    const entry = this.store.get(shortCode);
    if (!entry) return null;
    // Defensive copy — callers may mutate.
    return {
      renderId: entry.renderId,
      appId: entry.appId,
    };
  }

  async findByRenderId(renderId: string): Promise<string | null> {
    if (!renderId) return null;
    return this.renderIdToShortCode.get(renderId) ?? null;
  }

  async revoke(shortCode: string): Promise<void> {
    if (!shortCode) return;
    const entry = this.store.get(shortCode);
    if (!entry) return;
    this.store.delete(shortCode);
    // Only clear the reverse pointer if it still points at THIS code
    // (a later rebind may have overwritten it).
    if (this.renderIdToShortCode.get(entry.renderId) === shortCode) {
      this.renderIdToShortCode.delete(entry.renderId);
    }
  }

  async revokeByRenderId(renderId: string): Promise<number> {
    if (!renderId) return 0;
    let count = 0;
    // Iterate forward map — multiple shortCodes may share a renderId
    // (the reverse map only tracks the latest). Collect-then-delete
    // pattern avoids mutation-during-iteration.
    const codesToRevoke: string[] = [];
    for (const [code, binding] of this.store.entries()) {
      if (binding.renderId === renderId) {
        codesToRevoke.push(code);
      }
    }
    for (const code of codesToRevoke) {
      this.store.delete(code);
      count += 1;
    }
    this.renderIdToShortCode.delete(renderId);
    return count;
  }

  /** Live entry count. Useful for tests + introspection. */
  get size(): number {
    return this.store.size;
  }
}
