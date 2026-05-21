/**
 * In-memory todo store keyed by ownerId.
 *
 * Used by `@ggui-samples/mcp-todo` to give e2e scenarios real backing
 * state to mutate + assert against. Single-process, single-instance —
 * not durable, not safe across server restarts. That matches what
 * the conformance suite needs: each test boots a fresh server, no
 * cleanup between cases beyond `clear()`.
 *
 * **`ownerId` semantics.** The MCP transport does NOT thread session
 * identity to tools natively; the bin script binds every request to
 * a single global ownerId (`"default"`) which is the right call for
 * the e2e harness — one server instance, one todo list, every test
 * resets via clear(). When the sample agent connects, it's the only
 * caller, so the global owner is effectively the agent's todo list.
 */

export interface Todo {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly createdAt: string;
}

export interface TodoStore {
  list(ownerId: string): readonly Todo[];
  add(ownerId: string, text: string): Todo;
  toggle(ownerId: string, id: string): Todo | null;
  remove(ownerId: string, id: string): boolean;
  clear(ownerId?: string): void;
}

export function createInMemoryTodoStore(): TodoStore {
  const byOwner = new Map<string, Todo[]>();
  let nextId = 1;

  // Implementation note for `clear()`: a full reset (no ownerId) wipes
  // both the map AND the counter so tests start from `todo-1`. A
  // per-owner clear only empties that owner's list — leaving nextId
  // intact is the safe choice because other owners' ids must keep
  // monotonic with prior allocations.
  function get(ownerId: string): Todo[] {
    let list = byOwner.get(ownerId);
    if (list === undefined) {
      list = [];
      byOwner.set(ownerId, list);
    }
    return list;
  }

  return {
    list(ownerId) {
      return [...get(ownerId)];
    },
    add(ownerId, text) {
      const todo: Todo = {
        id: `todo-${nextId++}`,
        text,
        done: false,
        createdAt: new Date().toISOString(),
      };
      get(ownerId).push(todo);
      return todo;
    },
    toggle(ownerId, id) {
      const list = get(ownerId);
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0) return null;
      const next: Todo = { ...list[idx]!, done: !list[idx]!.done };
      list[idx] = next;
      return next;
    },
    remove(ownerId, id) {
      const list = get(ownerId);
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0) return false;
      list.splice(idx, 1);
      return true;
    },
    clear(ownerId) {
      if (ownerId === undefined) {
        byOwner.clear();
        nextId = 1;
      } else {
        byOwner.delete(ownerId);
      }
    },
  };
}
