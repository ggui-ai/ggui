/**
 * MCP tool registrations for the todo MCP server.
 *
 * Four tools matching a minimal CRUD surface:
 *   - `todo_list`    — read all todos for the owner
 *   - `todo_add`     — append a new todo, returns the created row
 *   - `todo_toggle`  — flip a todo's `done` boolean by id
 *   - `todo_delete`  — remove a todo by id
 *
 * Every handler is fully synchronous over the in-memory store; no
 * persistence, no fan-out. Designed for e2e scenarios that assert
 * "the click really changed real state" — push a UI, click Add, then
 * call todo_list and see the new row.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TodoStore } from './store.js';

export interface RegisterTodoToolsOptions {
  readonly store: TodoStore;
  /**
   * Owner id used for every call routed through this server. The
   * standalone bin pins it to `"default"`; future multi-tenant
   * variants could derive from request headers.
   */
  readonly ownerId: string;
}

export function registerTodoTools(
  server: McpServer,
  opts: RegisterTodoToolsOptions,
): void {
  const { store, ownerId } = opts;

  server.registerTool(
    'todo_list',
    {
      title: 'Todo · List',
      description:
        'Returns every todo in the current list. Empty list returns an empty array. Use as the data source when an agent wants to render a todo UI.',
      inputSchema: {},
      outputSchema: {
        todos: z.array(
          z.object({
            id: z.string(),
            text: z.string(),
            done: z.boolean(),
            createdAt: z.string(),
          }),
        ),
      },
    },
    async () => {
      const todos = store.list(ownerId);
      return {
        structuredContent: { todos },
        content: [
          {
            type: 'text',
            text: JSON.stringify({ todos }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'todo_add',
    {
      title: 'Todo · Add',
      description:
        'Append a new todo with the given text. Returns the created row including its server-assigned id + createdAt. Use after the user submits an add-todo form.',
      inputSchema: {
        text: z
          .string()
          .min(1, 'text is required')
          .describe('Free text describing the todo. Required, non-empty.'),
      },
      outputSchema: {
        todo: z.object({
          id: z.string(),
          text: z.string(),
          done: z.boolean(),
          createdAt: z.string(),
        }),
      },
    },
    async (input) => {
      const text = String(input.text);
      const todo = store.add(ownerId, text);
      return {
        structuredContent: { todo },
        content: [
          {
            type: 'text',
            text: JSON.stringify({ todo }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'todo_toggle',
    {
      title: 'Todo · Toggle',
      description:
        'Flip a todo\'s `done` boolean by id. Returns the updated row, or `{ todo: null }` if no todo matches. Use after the user clicks a checkbox.',
      inputSchema: {
        id: z.string().min(1).describe('The todo\'s server-assigned id.'),
      },
      outputSchema: {
        todo: z
          .object({
            id: z.string(),
            text: z.string(),
            done: z.boolean(),
            createdAt: z.string(),
          })
          .nullable(),
      },
    },
    async (input) => {
      const id = String(input.id);
      const todo = store.toggle(ownerId, id);
      return {
        structuredContent: { todo },
        content: [
          {
            type: 'text',
            text: JSON.stringify({ todo }),
          },
        ],
      };
    },
  );

  server.registerTool(
    'todo_delete',
    {
      title: 'Todo · Delete',
      description:
        'Remove a todo by id. Returns `{ deleted: true }` on success, `{ deleted: false }` if no todo matches. Use after the user clicks a delete affordance.',
      inputSchema: {
        id: z.string().min(1).describe('The todo\'s server-assigned id.'),
      },
      outputSchema: {
        deleted: z.boolean(),
      },
    },
    async (input) => {
      const id = String(input.id);
      const deleted = store.remove(ownerId, id);
      return {
        structuredContent: { deleted },
        content: [
          {
            type: 'text',
            text: JSON.stringify({ deleted }),
          },
        ],
      };
    },
  );
}
