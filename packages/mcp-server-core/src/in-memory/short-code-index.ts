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
   * Reverse map backing {@link findBySessionId}. Maintained in lockstep
   * with `store` by every {@link put} — the forward store is the truth
   * (multiple renders could previously share a shortCode via rebind),
   * but for the reverse side we want "latest shortCode bound to this
   * render" which is exactly `sessionIdToShortCode.get(sessionId)`.
   */
  private readonly sessionIdToShortCode = new Map<string, string>();

  async put(shortCode: string, binding: ShortCodeBinding): Promise<void> {
    if (!shortCode) {
      throw new Error('InMemoryShortCodeIndex.put: shortCode is required');
    }
    // Rebind hygiene: if this shortCode was previously bound to a
    // DIFFERENT sessionId, clear that render's reverse entry so
    // `findBySessionId(oldSessionId)` doesn't keep returning the
    // rebound shortCode. Matches the last-writer-wins contract in
    // `short-code-index.ts`.
    const previous = this.store.get(shortCode);
    if (previous && previous.sessionId !== binding.sessionId) {
      const stillPointsHere =
        this.sessionIdToShortCode.get(previous.sessionId) === shortCode;
      if (stillPointsHere) {
        this.sessionIdToShortCode.delete(previous.sessionId);
      }
    }
    this.store.set(shortCode, { ...binding });
    // Reverse side is last-writer-wins per sessionId: if a render
    // had an earlier shortCode, the new one takes over. The old
    // shortCode stays valid on the forward side — operators who
    // typed it before the rebind still resolve correctly.
    this.sessionIdToShortCode.set(binding.sessionId, shortCode);
  }

  async lookup(shortCode: string): Promise<ShortCodeBinding | null> {
    const entry = this.store.get(shortCode);
    if (!entry) return null;
    // Defensive copy — callers may mutate.
    return {
      sessionId: entry.sessionId,
      appId: entry.appId,
    };
  }

  async findBySessionId(sessionId: string): Promise<string | null> {
    if (!sessionId) return null;
    return this.sessionIdToShortCode.get(sessionId) ?? null;
  }

  async revoke(shortCode: string): Promise<void> {
    if (!shortCode) return;
    const entry = this.store.get(shortCode);
    if (!entry) return;
    this.store.delete(shortCode);
    // Only clear the reverse pointer if it still points at THIS code
    // (a later rebind may have overwritten it).
    if (this.sessionIdToShortCode.get(entry.sessionId) === shortCode) {
      this.sessionIdToShortCode.delete(entry.sessionId);
    }
  }

  async revokeBySessionId(sessionId: string): Promise<number> {
    if (!sessionId) return 0;
    let count = 0;
    // Iterate forward map — multiple shortCodes may share a sessionId
    // (the reverse map only tracks the latest). Collect-then-delete
    // pattern avoids mutation-during-iteration.
    const codesToRevoke: string[] = [];
    for (const [code, binding] of this.store.entries()) {
      if (binding.sessionId === sessionId) {
        codesToRevoke.push(code);
      }
    }
    for (const code of codesToRevoke) {
      this.store.delete(code);
      count += 1;
    }
    this.sessionIdToShortCode.delete(sessionId);
    return count;
  }

  /** Live entry count. Useful for tests + introspection. */
  get size(): number {
    return this.store.size;
  }
}
