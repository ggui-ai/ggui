/**
 * Stack state + structural-placeholder DOM rendering.
 *
 * This module owns the placeholder render path: each stack item is
 * drawn as a structural placeholder showing id + description/prompt.
 * The React mount path that executes `componentCode` lives elsewhere
 * and swaps in over the same DOM seam.
 *
 * The model + the DOM render are split so:
 *   - `StackModel` is testable in isolation (no DOM needed for unit
 *     tests around upsert / replace / clear semantics);
 *   - `renderStackInto(el, model)` is the only place that touches DOM,
 *     making it the seam the React mount path swaps out without
 *     disturbing the WS message handler.
 *
 * Stack ordering follows the wire shape: the ack's initial `stack` is
 * displayed in array order; each `push` either replaces an item with
 * the same id (preserving its position) or appends at the tail.
 */
import type { SessionStackEntry } from '@ggui-ai/protocol';

/**
 * Construction options for {@link StackModel}.
 *
 * @public
 */
export interface StackModelOptions {
  /**
   * When present, the model renders only the single stack entry with
   * this `id` — the rest of the session stack is filtered out on
   * `setAll` and `upsert` ignores every entry whose id ≠ this value.
   * Enables single-item renderer mode, driven by the
   * `bootstrap.stackItemId` field set on a per-item session
   * resource.
   *
   * Absent → multi-item mode: the model renders the entire stack as
   * the server delivers it.
   *
   * The filter is immutable for a model's lifetime (no setter).
   * Consumers that need a different filter MUST construct a new
   * model — matches the "model is the truth" doctrine below and
   * makes filter-change intent explicit in code review.
   */
  readonly filterToItemId?: string;
}

/**
 * In-memory model of the visible stack. Owned by the runtime; mutated
 * via the methods (no setter — keeps the "model is the truth" doctrine
 * obvious in code reviews).
 */
export class StackModel {
  private items: SessionStackEntry[] = [];
  private readonly filterToItemId: string | undefined;

  constructor(options: StackModelOptions = {}) {
    this.filterToItemId = options.filterToItemId;
  }

  /**
   * Replace the entire stack — used after the subscribe ack lands.
   *
   * Under `filterToItemId` (single-item mode), the incoming list is
   * filtered to just the matching entry. If no entry matches, the
   * model ends up empty — the server no longer includes the pinned
   * item and the renderer's empty-state is the correct surface.
   */
  setAll(items: readonly SessionStackEntry[]): void {
    if (this.filterToItemId !== undefined) {
      const target = this.filterToItemId;
      this.items = items.filter((item) => item.id === target);
      return;
    }
    this.items = [...items];
  }

  /**
   * Upsert a stack item. If an entry with the same id already exists
   * its slot is replaced in place (preserves ordering); otherwise the
   * item is appended at the tail. Mirrors `GguiSession.tsx`'s push
   * reducer.
   *
   * Under `filterToItemId` (single-item mode): entries whose id does
   * not match the filter are ignored. The renderer's live-channel
   * subscription still delivers every push for the session (subscribe
   * remains session-scoped); this filter is the client-side pin that
   * keeps the per-card iframe bound to its one stack entry.
   */
  upsert(item: SessionStackEntry): void {
    if (this.filterToItemId !== undefined && item.id !== this.filterToItemId) {
      return;
    }
    const idx = this.items.findIndex((existing) => existing.id === item.id);
    if (idx >= 0) {
      const next = [...this.items];
      next[idx] = item;
      this.items = next;
      return;
    }
    this.items = [...this.items, item];
  }

  /** Read-only view — callers MUST NOT mutate. */
  snapshot(): readonly SessionStackEntry[] {
    return this.items;
  }

  /** Item count — convenience for status-line rendering. */
  size(): number {
    return this.items.length;
  }
}

/**
 * Best-effort textual label for a stack item — title-ish for the
 * placeholder UI. Tries `description` → `prompt` → a generic fallback.
 *
 * The wire shape keeps these fields optional on every entry kind
 * (generated, McpApps), so the absence-handling has to be honest.
 */
function labelFor(item: SessionStackEntry): string {
  if (typeof item.description === 'string' && item.description.length > 0) {
    return item.description;
  }
  // Only generated component items carry `prompt`. McpApps + system
  // variants surface their own description (or a generic fallback).
  if (item.type !== 'mcpApps' && item.type !== 'system') {
    if (typeof item.prompt === 'string' && item.prompt.length > 0) {
      return item.prompt;
    }
  }
  return '(untitled stack item)';
}

/**
 * Render the stack model into the target list element as structural
 * `<li data-ggui-stack-item="<id>">` placeholders. Idempotent — every
 * call replaces the element's children based on the current model.
 *
 * The DOM shape (data attributes + classnames) is intentionally
 * stable: E2E tests and the React-mount path both need to address
 * stack-item rows by `data-ggui-stack-item` selector.
 */
export function renderStackInto(target: HTMLElement, model: StackModel): void {
  // Replace children rather than mutate-in-place — the placeholder
  // doesn't need diffing, and the wire-frame burst rate is low enough
  // (push events arrive roughly per agent turn) that full-replace is
  // cheap.
  target.replaceChildren();

  const items = model.snapshot();
  if (items.length === 0) {
    const empty = target.ownerDocument.createElement('li');
    empty.textContent = '(no stack items yet)';
    empty.setAttribute('data-ggui-empty', 'true');
    target.appendChild(empty);
    return;
  }

  for (const item of items) {
    const li = target.ownerDocument.createElement('li');
    li.setAttribute('data-ggui-stack-item', item.id);

    const idEl = target.ownerDocument.createElement('span');
    idEl.className = 'id';
    idEl.textContent = item.id;
    li.appendChild(idEl);

    const labelEl = target.ownerDocument.createElement('span');
    labelEl.className = 'label';
    labelEl.textContent = labelFor(item);
    li.appendChild(labelEl);

    target.appendChild(li);
  }
}
