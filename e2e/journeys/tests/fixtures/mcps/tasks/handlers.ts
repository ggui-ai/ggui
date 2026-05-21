/**
 * Tasks MCP — `SharedHandler` bundle for direct mount on a ggui
 * server's `/mcp` surface.
 *
 * Purpose: let the OSS `createGguiServer({ mcpMounts: [...] })` seam
 * aggregate the tasks tool surface alongside ggui-native tools
 * (`ggui_push`, etc.) without spawning a subprocess or opening a
 * second HTTP/MCP endpoint. The existing `createTasksMcpServer`
 * factory in `./server.ts` stays as the standalone MCP entry-point
 * (used by the 48 contract tests + any future process-mode
 * consumer); this module is the ggui-runtime wire-up.
 *
 * Zero new business logic: every tool reuses the same
 *
 *   - strict `z.strictObject` aliases (for handler-body re-parse),
 *   - raw zod shapes (for `SharedHandler.inputSchema` /
 *     `outputSchema`),
 *   - `TasksStore` method,
 *
 * that `createTasksMcpServer` wires. The `handlers.test.ts` contract
 * suite grep-asserts surface parity with `TASKS_TOOL_NAMES` so any
 * drift fails loudly.
 *
 * Not-found signaling convention (mirrors the standalone server):
 *
 *   - `tasks_get` / `tasks_update` / `tasks_complete` return
 *     `{ item: TaskEntity | null }` where `null` means not-found —
 *     a clean structured signal, NOT a thrown JSON-RPC error and NOT
 *     an `isError: true` tool result. `isError` is reserved for
 *     input-validation failures.
 *   - `tasks_delete` returns `{ deleted: boolean }` where `false`
 *     means idempotent not-found.
 *
 * SDK-permissive-strip note: MCP SDK's `registerTool` zod parse is
 * permissive (unknown top-level fields get stripped before the
 * handler runs). The handler re-parses via the strict alias so the
 * tool surface still rejects unknown fields loudly. Field-level
 * strictness (enums, regex, min-length) carries through both paths.
 * Documented in `server.test.ts` strip-test as the same future-SDK-
 * upgrade tripwire.
 *
 * See:
 *   - `docs/plans/2026-04-21-oss-full-generation-port.md` §4 Slice 6
 *   - `docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md`
 *     §9 (trio surface)
 *   - `packages/mcp-server/src/mcp-mounts.ts` (the seam this feeds)
 */
import type { SharedHandler } from '@ggui-ai/mcp-server-handlers';
import type { ZodRawShape } from 'zod';
import {
  TasksCompleteInput,
  TasksCreateInput,
  TasksDeleteInput,
  TasksGetInput,
  TasksListInput,
  TasksSearchInput,
  TasksUpdateInput,
  tasksCompleteInputShape,
  tasksCompleteOutputShape,
  tasksCreateInputShape,
  tasksCreateOutputShape,
  tasksDeleteInputShape,
  tasksDeleteOutputShape,
  tasksGetInputShape,
  tasksGetOutputShape,
  tasksListInputShape,
  tasksListOutputShape,
  tasksSearchInputShape,
  tasksSearchOutputShape,
  tasksUpdateInputShape,
  tasksUpdateOutputShape,
} from './schema.js';
import type { TasksStore } from './store.js';

/**
 * Narrowed alias so the bundle-construction signature is uniform
 * across the 7 handlers. Matches what
 * `composeHandlersWithMounts` expects.
 */
type TasksSharedHandler = SharedHandler<ZodRawShape, ZodRawShape>;

export interface CreateTasksSharedHandlersOptions {
  /**
   * Backing store shared with the standalone `createTasksMcpServer`
   * consumers + any caller that holds the raw sqlite handle (e.g.
   * tests that `reset()` / `seed()` between scenarios).
   */
  readonly store: TasksStore;
}

/**
 * Build the tasks-mount bundle. Every handler is a thin dispatch
 * over the supplied `TasksStore`; the factory never captures hidden
 * state of its own. Safe to call once per server composition.
 */
export function createTasksSharedHandlers(
  opts: CreateTasksSharedHandlersOptions,
): ReadonlyArray<TasksSharedHandler> {
  const { store } = opts;

  const tasksList: TasksSharedHandler = {
    name: 'tasks_list',
    title: 'List tasks',
    description:
      'List tasks with optional filter (status, assignee, priority, due-date window), sort, and cursor-based pagination.',
    inputSchema: tasksListInputShape,
    outputSchema: tasksListOutputShape,
    async handler(raw) {
      const parsed = TasksListInput.parse(raw);
      return store.list(parsed) as unknown as Record<string, unknown>;
    },
  };

  const tasksGet: TasksSharedHandler = {
    name: 'tasks_get',
    title: 'Get task',
    description:
      'Retrieve a single task by id. Returns `{ item: null }` when no task with that id exists.',
    inputSchema: tasksGetInputShape,
    outputSchema: tasksGetOutputShape,
    async handler(raw) {
      const parsed = TasksGetInput.parse(raw);
      return { item: store.get(parsed.id) };
    },
  };

  const tasksCreate: TasksSharedHandler = {
    name: 'tasks_create',
    title: 'Create task',
    description:
      'Create a new task. `status` defaults to `todo`, `priority` to `medium`. The new item is returned in full.',
    inputSchema: tasksCreateInputShape,
    outputSchema: tasksCreateOutputShape,
    async handler(raw) {
      const parsed = TasksCreateInput.parse(raw);
      return { item: store.create(parsed.input) };
    },
  };

  const tasksUpdate: TasksSharedHandler = {
    name: 'tasks_update',
    title: 'Update task',
    description:
      "Patch a task's fields. Pass `null` in `assigneeId` / `dueDate` / `linkedNoteId` to clear. Status transitions may also flow here OR through `tasks_complete`. Returns `{ item: null }` when no task with that id exists.",
    inputSchema: tasksUpdateInputShape,
    outputSchema: tasksUpdateOutputShape,
    async handler(raw) {
      const parsed = TasksUpdateInput.parse(raw);
      return { item: store.update(parsed.id, parsed.patch) };
    },
  };

  const tasksDelete: TasksSharedHandler = {
    name: 'tasks_delete',
    title: 'Delete task',
    description:
      'Delete a task by id. Idempotent: `deleted: false` when no task with that id existed.',
    inputSchema: tasksDeleteInputShape,
    outputSchema: tasksDeleteOutputShape,
    async handler(raw) {
      const parsed = TasksDeleteInput.parse(raw);
      return { deleted: store.delete(parsed.id) };
    },
  };

  const tasksSearch: TasksSharedHandler = {
    name: 'tasks_search',
    title: 'Search tasks',
    description:
      'Case-insensitive substring search over task titles, with optional filter composition. Returns matched items up to `limit` plus `totalMatches` (unbounded count).',
    inputSchema: tasksSearchInputShape,
    outputSchema: tasksSearchOutputShape,
    async handler(raw) {
      const parsed = TasksSearchInput.parse(raw);
      return store.search(parsed) as unknown as Record<string, unknown>;
    },
  };

  const tasksComplete: TasksSharedHandler = {
    name: 'tasks_complete',
    title: 'Complete task',
    description:
      'Mark a task as done. Distinct from a generic `tasks_update({status:"done"})` so the blueprint negotiator can tell "edit task" apart from "mark done". Returns `{ item: null }` when no task with that id exists.',
    inputSchema: tasksCompleteInputShape,
    outputSchema: tasksCompleteOutputShape,
    async handler(raw) {
      const parsed = TasksCompleteInput.parse(raw);
      return { item: store.complete(parsed.id) };
    },
  };

  // Order matches `TASKS_TOOL_NAMES` in `./server.ts` so callers
  // can grep-assert parity across the two surfaces. Any new tool
  // MUST land here AND in `./server.ts` AND in `TASKS_TOOL_NAMES`
  // in the same slice.
  return [
    tasksList,
    tasksGet,
    tasksCreate,
    tasksUpdate,
    tasksDelete,
    tasksSearch,
    tasksComplete,
  ];
}
