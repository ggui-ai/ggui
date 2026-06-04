/**
 * Playground fixture Tasks mount — 3 happy-path tools + 2 pathological
 * test tools (Slice 11.5 C7 runtime-contract coverage).
 *
 * ## Shape convention — flat, not `{input: {...}}`
 *
 * Unlike the Slice-6 `tasks-mount-via-serve` fixture (which is
 * consumed ONLY through MCP `tools/call` and uses the SDK's
 * `arguments: {input: {...}}` wrapping convention), THIS fixture is
 * consumed through the Slice-11.5 `wiredActionRouter`. The router
 * invokes handlers in-process, passing the `data:submit` envelope's
 * `payload.data` verbatim as the handler's first argument:
 *
 *   - Blueprint calls `useAction('createTask')({title: 'foo'})`
 *   - `payload.data` is `{title: 'foo'}`
 *   - Router calls `handler({title: 'foo'}, ctx)`
 *
 * The inputSchemas + handlers are therefore FLAT — no `{input}`
 * wrapper. This divergence from the MCP convention is intentional
 * and scoped to this fixture; if the fixture is ever exercised via
 * `tools/call` the caller passes `arguments: {title: '...'}` flat too.
 *
 * ## Tools
 *
 *   - `tasks_list`             — return every task in the store.
 *   - `tasks_create`           — append a new task (status 'todo').
 *   - `tasks_complete`         — toggle a task's status by id.
 *   - `tasks_broken`           — always throws; used by `contract-probe`
 *                                to exercise TOOL_THREW.
 *   - `tasks_malformed_list`   — returns `{wrong: 'shape'}` instead of
 *                                `{items: Task[]}`; used by
 *                                `contract-probe` as a channel refresh
 *                                to exercise SCHEMA_VIOLATION.
 *   - `hanging_tool`           — sleeps past the wiredActionRouter's
 *                                configured timeout; used by
 *                                `contract-probe` to exercise
 *                                TOOL_TIMEOUT. Tool name matches the
 *                                conformance fixture
 *                                `wired-action-tool-timeout.json`'s
 *                                `expectedBehavior.toolName`, which the
 *                                Lane-1 spec asserts as `data-tool` on
 *                                the contract-error row. The
 *                                companion fixture's TOOL_NOT_FOUND
 *                                path declares an action whose `tool`
 *                                names `doesNotExist` (deliberately
 *                                NOT registered here), so the router's
 *                                `has()` check fails and emits
 *                                TOOL_NOT_FOUND before invoking.
 *
 * Entry-point contract per `packages/project-config/src/mcp-mount-
 * discovery.ts`: export `createGguiMcpMount()` returning
 * `{ name, handlers: SharedHandler[] }`. `outputSchema` MUST declare
 * the fields the handler returns (MCP SDK strips unknowns).
 */
import { z } from 'zod';

const TaskItem = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['todo', 'done']),
});

export function createGguiMcpMount() {
  const store = new Map();
  store.set('seed-1', {
    id: 'seed-1',
    title: 'Try the wired Todo blueprint',
    status: 'todo',
  });
  store.set('seed-2', {
    id: 'seed-2',
    title: 'Click a checkbox to fire tasks_complete',
    status: 'todo',
  });

  return {
    name: 'tasks',
    handlers: [
      {
        name: 'tasks_list',
        title: 'List tasks',
        description: 'Return every task in the store.',
        inputSchema: {},
        outputSchema: { items: z.array(TaskItem) },
        async handler() {
          return { items: Array.from(store.values()) };
        },
      },
      {
        name: 'tasks_create',
        title: 'Create task',
        description: 'Append a new task with status "todo".',
        inputSchema: { title: z.string().min(1) },
        outputSchema: { item: TaskItem },
        async handler(raw) {
          const title =
            raw && typeof raw === 'object' && typeof raw.title === 'string'
              ? raw.title
              : undefined;
          if (typeof title !== 'string' || title.length === 0) {
            throw new Error(
              'tasks_create: `title` must be a non-empty string',
            );
          }
          const id = `local-${store.size + 1}`;
          const item = { id, title, status: 'todo' };
          store.set(id, item);
          return { item };
        },
      },
      {
        name: 'tasks_complete',
        title: 'Toggle task completion',
        description:
          'Flip the task between "todo" and "done" by id. Idempotent when the target status matches.',
        inputSchema: {
          id: z.string().min(1),
          status: z.enum(['todo', 'done']).optional(),
        },
        outputSchema: { item: TaskItem },
        async handler(raw) {
          const id =
            raw && typeof raw === 'object' && typeof raw.id === 'string'
              ? raw.id
              : undefined;
          if (typeof id !== 'string' || id.length === 0) {
            throw new Error(
              'tasks_complete: `id` must be a non-empty string',
            );
          }
          const existing = store.get(id);
          if (!existing) {
            throw new Error(`tasks_complete: no task with id "${id}"`);
          }
          const desired =
            raw && typeof raw === 'object' && raw.status
              ? raw.status
              : existing.status === 'done'
                ? 'todo'
                : 'done';
          const next = { ...existing, status: desired };
          store.set(id, next);
          return { item: next };
        },
      },
      {
        // Slice 11.5 C7 pathological tool — always throws so a blueprint
        // action wired to `tasks_broken` exercises the TOOL_THREW
        // envelope path in `wiredActionRouter`.
        name: 'tasks_broken',
        title: 'Broken tool (test-only)',
        description:
          'Always throws. Used to prove `_ggui:contract-error` TOOL_THREW emission + session survival.',
        inputSchema: {},
        outputSchema: { ok: z.literal(true) },
        async handler() {
          throw new Error(
            'tasks_broken: intentional failure for contract-error coverage',
          );
        },
      },
      {
        // Slice 11.5 C7 pathological tool — returns a shape that does
        // NOT satisfy the `tasks` channel schema (`{items: array}`),
        // so a blueprint declaring this as a channel refresh tool
        // exercises the SCHEMA_VIOLATION envelope path.
        //
        // `outputSchema` still matches what we actually return — MCP
        // SDK's registerTool strips fields not in outputSchema, and
        // we need `{wrong: 'shape'}` to reach the router intact.
        name: 'tasks_malformed_list',
        title: 'Malformed list (test-only)',
        description:
          'Returns `{wrong: "shape"}` instead of `{items: Task[]}` to prove the router emits SCHEMA_VIOLATION when a refresh-tool return violates the declared channel schema.',
        inputSchema: {},
        outputSchema: { wrong: z.string() },
        async handler() {
          return { wrong: 'shape' };
        },
      },
      {
        // Pathological tool — sleeps 30s, well past any reasonable
        // wired-tool timeout. Used by `contract-probe` to exercise
        // TOOL_TIMEOUT. Tool name (`hanging_tool`) is locked to match
        // the conformance fixture `wired-action-tool-timeout.json`'s
        // `expectedBehavior.toolName`, which the Lane-1 spec asserts
        // verbatim on the contract-error row's `data-tool`.
        //
        // The Lane-1 spec lowers the wiredActionRouter timeout via
        // `GGUI_WIRED_TIMEOUT_MS` (forwarded into the spawned `ggui
        // serve` process) so the probe fires within a small budget;
        // the 30s sleep here is a safety margin — anything well above
        // the configured timeout works.
        //
        // The router does NOT cancel the underlying promise (handlers
        // are trusted to clean up their own resources per
        // `render-channel.ts::invokeWithTimeout`), so leaving the
        // setTimeout reference unattached is correct for a fixture —
        // process tear-down clears it.
        name: 'hanging_tool',
        title: 'Hanging tool (test-only)',
        description:
          'Sleeps past the wiredActionRouter timeout. Used to prove TOOL_TIMEOUT envelope emission + session survival.',
        inputSchema: {},
        outputSchema: { ok: z.literal(true) },
        async handler() {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          return { ok: true };
        },
      },
    ],
  };
}
