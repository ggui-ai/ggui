/**
 * Tasks MCP server.
 *
 * Registers the seven canonical tools locked in stateful-MCP strategy
 * §9.2 — the six `<entity>_*` CRUD+search tools plus the one per-MCP
 * domain tool (`tasks_complete` — the status transition that lets the
 * blueprint negotiator distinguish "edit task" from "mark done").
 *
 * Wiring layers:
 *
 *   1. `registerTool` — SDK attaches the raw-shape inputs to
 *      tools/list. MCP's own zod wrap parses the shape permissively
 *      (unknown fields passed through).
 *   2. Handler body — re-parses via the `z.strictObject` alias so we
 *      reject unknown fields loudly. Tests rely on this — "invalid
 *      input should fail" is a contract.
 *   3. Handler delegates to `store`. Store trusts its input.
 *   4. Handler wraps the store result in `{ structuredContent, content }`
 *      (the canonical MCP tool-result shape).
 *
 * The server is **not** aware of HTTP / Stdio transports — callers wire
 * a transport themselves. Contract tests use `InMemoryTransport`; a
 * future standalone process-mode could use `StdioServerTransport`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
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
  TasksCompleteInput,
  TasksCreateInput,
  TasksDeleteInput,
  TasksGetInput,
  TasksListInput,
  TasksSearchInput,
  TasksUpdateInput,
} from './schema.js';
import type { TasksStore } from './store.js';

export interface CreateTasksMcpServerOptions {
  readonly store: TasksStore;
  /** Optional override for tools/list `name` + `version`. */
  readonly info?: { readonly name?: string; readonly version?: string };
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: structured,
    content: [
      { type: 'text', text: JSON.stringify(structured) },
    ],
  };
}

export function createTasksMcpServer(
  opts: CreateTasksMcpServerOptions,
): McpServer {
  const { store } = opts;
  const server = new McpServer({
    name: opts.info?.name ?? 'tasks-mcp-fixture',
    version: opts.info?.version ?? '0.1.0',
  });

  server.registerTool(
    'tasks_list',
    {
      title: 'List tasks',
      description:
        'List tasks with optional filter (status, assignee, priority, due-date window), sort, and cursor-based pagination.',
      inputSchema: tasksListInputShape,
      outputSchema: tasksListOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksListInput.parse(raw);
      const result = store.list(parsed);
      return ok(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'tasks_get',
    {
      title: 'Get task',
      description:
        'Retrieve a single task by id. Returns `{ item: null }` when no task with that id exists.',
      inputSchema: tasksGetInputShape,
      outputSchema: tasksGetOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksGetInput.parse(raw);
      const item = store.get(parsed.id);
      return ok({ item });
    },
  );

  server.registerTool(
    'tasks_create',
    {
      title: 'Create task',
      description:
        'Create a new task. `status` defaults to `todo`, `priority` to `medium`. The new item is returned in full.',
      inputSchema: tasksCreateInputShape,
      outputSchema: tasksCreateOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksCreateInput.parse(raw);
      const item = store.create(parsed.input);
      return ok({ item });
    },
  );

  server.registerTool(
    'tasks_update',
    {
      title: 'Update task',
      description:
        "Patch a task's fields. Pass `null` in `assigneeId` / `dueDate` / `linkedNoteId` to clear. Status transitions may also flow here OR through `tasks_complete`. Returns `{ item: null }` when no task with that id exists.",
      inputSchema: tasksUpdateInputShape,
      outputSchema: tasksUpdateOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksUpdateInput.parse(raw);
      const item = store.update(parsed.id, parsed.patch);
      return ok({ item });
    },
  );

  server.registerTool(
    'tasks_delete',
    {
      title: 'Delete task',
      description:
        'Delete a task by id. Idempotent: `deleted: false` when no task with that id existed.',
      inputSchema: tasksDeleteInputShape,
      outputSchema: tasksDeleteOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksDeleteInput.parse(raw);
      const deleted = store.delete(parsed.id);
      return ok({ deleted });
    },
  );

  server.registerTool(
    'tasks_search',
    {
      title: 'Search tasks',
      description:
        'Case-insensitive substring search over task titles, with optional filter composition. Returns matched items up to `limit` plus `totalMatches` (unbounded count).',
      inputSchema: tasksSearchInputShape,
      outputSchema: tasksSearchOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksSearchInput.parse(raw);
      const result = store.search(parsed);
      return ok(result as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'tasks_complete',
    {
      title: 'Complete task',
      description:
        'Mark a task as done. Distinct from a generic `tasks_update({status:"done"})` so the blueprint negotiator can tell "edit task" apart from "mark done". Returns `{ item: null }` when no task with that id exists.',
      inputSchema: tasksCompleteInputShape,
      outputSchema: tasksCompleteOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = TasksCompleteInput.parse(raw);
      const item = store.complete(parsed.id);
      return ok({ item });
    },
  );

  return server;
}

/**
 * The canonical tool name list, ordered to match server registration.
 * Exported so contract tests can assert on `tools/list` completeness
 * without hard-coding the order in the test body.
 */
export const TASKS_TOOL_NAMES = [
  'tasks_list',
  'tasks_get',
  'tasks_create',
  'tasks_update',
  'tasks_delete',
  'tasks_search',
  'tasks_complete',
] as const;

// Re-exported to keep the SDK's type in the public surface when callers
// want to narrow transport results. Unused by the fixture directly.
export type { CallToolResult, ServerResult };
