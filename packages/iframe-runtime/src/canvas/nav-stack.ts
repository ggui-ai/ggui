/**
 * NavStackModel.
 *
 * Canvas-local navigation stack. **Distinct from the server's
 * `StackModel`**:
 *
 *   - Server's `StackModel` (`@ggui-ai/iframe-runtime/stack.ts`)
 *     tracks every stack item the agent has pushed in this session.
 *     The durable shape; mutated only by server-side push/pop/replace
 *     deliveries.
 *   - NavStackModel tracks the USER'S NAVIGATION HISTORY through
 *     those items. When the user back-navigates, the popped item
 *     leaves navStack but stays in server's StackModel.
 *
 * These can diverge:
 *
 *   ```
 *   server StackModel:  [a, b, c]   ← all items the agent has pushed
 *   navStack:           [a, b]      ← user has back-navigated away from c
 *   activeItem:         b           ← top of navStack; the mounted screen
 *   ```
 *
 * The server-side `activeStackItemId` field (on AckPayload +
 * SessionRecord) follows navStack-top via `canvas_navigated` outbound
 * envelopes, so `ggui_consume` returns actions for the active item
 * regardless of what the agent has pushed since.
 *
 * Pure model — no DOM, no React. Methods return the new state (or
 * mutate in-place; v1 mutates for simplicity since the canvas shell
 * holds the only reference). The renderer consumes the model via a
 * version counter (bumped on every mutation) so React picks up
 * changes without deep equality.
 *
 * Two listener seams (distinct semantics):
 *
 *   - `onMutation` fires on EVERY state mutation including in-place
 *     replace (ggui_update patch). The canvas shell uses this to
 *     re-read the version counter and re-render — without it, a
 *     props-only update on the active item bumps the version but
 *     React never schedules a render and the screen shows stale props.
 *   - `onNavChange` fires only when the active item actually changes
 *     (new push, pop, reset that lands on a different top). The
 *     live-channel `canvas_navigated` envelope is emitted from here, so
 *     an in-place replace doesn't spuriously tell the server the
 *     user back-navigated.
 */

import type { SessionStackEntry } from '@ggui-ai/protocol';

/**
 * Listener for nav-changing mutations (push of new id, pop, reset to
 * a different top). The canvas shell threads this into the live-channel
 * `canvas_navigated` envelope so the server can update
 * `activeStackItemId` and abort in-flight cold-gen for items the user
 * has navigated away from.
 */
export type NavStackChangeListener = (event: {
  readonly direction: 'forward' | 'back';
  readonly activeItemId: string | null;
  readonly previousActiveItemId: string | null;
}) => void;

/**
 * Listener for any state mutation. Distinct from
 * {@link NavStackChangeListener} so React consumers can bridge to a
 * version counter — in-place replaces (ggui_update) mutate state
 * without changing the active item, and React still needs to re-render
 * to pick up the new props.
 */
export type NavStackMutationListener = () => void;

export class NavStackModel {
  private items: SessionStackEntry[] = [];
  private mutationListener: NavStackMutationListener | null = null;
  private navChangeListener: NavStackChangeListener | null = null;
  private versionCounter = 0;

  /**
   * Replace the entire nav stack. Used on subscribe ack to seed
   * navStack from the server's `activeStackItemId` + the snapshot's
   * stack array.
   */
  reset(items: readonly SessionStackEntry[]): void {
    const previous = this.peek();
    this.items = [...items];
    this.versionCounter += 1;
    this.mutationListener?.();
    this.navChangeListener?.({
      direction: 'forward',
      activeItemId: this.peek()?.id ?? null,
      previousActiveItemId: previous?.id ?? null,
    });
  }

  /**
   * Append an item to the top. Called when a `stack_item_appended`
   * envelope arrives (server pushed a new item).
   *
   * If an item with the same id already exists, the existing entry is
   * REPLACED IN PLACE (preserves nav position) — matches the server-
   * side StackModel's upsert semantics so `ggui_update` patches don't
   * shift the user's nav state. The mutation listener still fires (so
   * React re-renders with the new props) but the nav-change listener
   * is suppressed (active item hasn't changed).
   */
  push(item: SessionStackEntry): void {
    const existingIdx = this.items.findIndex((i) => i.id === item.id);
    if (existingIdx >= 0) {
      this.items[existingIdx] = item;
      this.versionCounter += 1;
      this.mutationListener?.();
      return;
    }
    const previous = this.peek();
    this.items.push(item);
    this.versionCounter += 1;
    this.mutationListener?.();
    this.navChangeListener?.({
      direction: 'forward',
      activeItemId: item.id,
      previousActiveItemId: previous?.id ?? null,
    });
  }

  /**
   * Pop the top item. Returns the new active item (or null if the
   * stack is now empty). No-op if already empty.
   */
  pop(): SessionStackEntry | null {
    if (this.items.length === 0) return null;
    const popped = this.items.pop() ?? null;
    this.versionCounter += 1;
    const active = this.peek();
    this.mutationListener?.();
    this.navChangeListener?.({
      direction: 'back',
      activeItemId: active?.id ?? null,
      previousActiveItemId: popped?.id ?? null,
    });
    return active;
  }

  /** Top of the nav stack (the currently-mounted item), or null when empty. */
  peek(): SessionStackEntry | null {
    return this.items[this.items.length - 1] ?? null;
  }

  /** Read-only snapshot of the full nav stack in order (root → top). */
  snapshot(): readonly SessionStackEntry[] {
    return this.items;
  }

  /** Item count. */
  size(): number {
    return this.items.length;
  }

  /**
   * Monotonic mutation counter — bumped on every push/pop/reset.
   * React consumers can use this as the `useSyncExternalStore`
   * snapshot value: comparing version numbers is O(1).
   */
  version(): number {
    return this.versionCounter;
  }

  /**
   * Install a listener that fires on every state mutation (push, pop,
   * reset, in-place replace). React consumers bridge this to a
   * version-counter `useState` so the component re-renders for every
   * change — including in-place replaces from `ggui_update` patches
   * where the active item is unchanged but its props have moved.
   *
   * Single-subscriber model — the canvas shell is the only caller.
   * Returns an unsubscribe function.
   */
  onMutation(listener: NavStackMutationListener): () => void {
    this.mutationListener = listener;
    return () => {
      if (this.mutationListener === listener) this.mutationListener = null;
    };
  }

  /**
   * Install a listener that fires only on nav-changing mutations
   * (push of new id, pop, reset). Used by the canvas shell to emit
   * the live-channel `canvas_navigated` envelope so the server can
   * update `activeStackItemId` and abort in-flight cold-gen for the
   * previous active item.
   *
   * In-place replaces from `ggui_update` patches do NOT fire this
   * listener — the active item hasn't moved. Use {@link onMutation}
   * for React re-render signaling.
   *
   * Single-subscriber model. Returns an unsubscribe function.
   */
  onNavChange(listener: NavStackChangeListener): () => void {
    this.navChangeListener = listener;
    return () => {
      if (this.navChangeListener === listener) this.navChangeListener = null;
    };
  }
}
