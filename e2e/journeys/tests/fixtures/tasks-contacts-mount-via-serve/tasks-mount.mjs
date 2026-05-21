/**
 * Tasks half of the Slice 6.4 two-MCP composition fixture.
 *
 * Pairs with `./contacts-mount.mjs` — the two mount modules are
 * declared side-by-side in `./ggui.json#mcpMounts`, so a single
 * `ggui serve` boot aggregates BOTH domains onto the same `/mcp`
 * surface. This is the FIRST time the OSS operator path uses
 * `mcpMounts` with a two-entry array (Tasks + Notes + Contacts
 * each shipped as single-entry mounts in their prior slices).
 *
 * Why this mount is narrower than the Slice 6 Tasks mount fixture:
 *
 *   - This slice proves domain COMPOSITION, not full task surface
 *     coverage. Three tools — `tasks_list`, `tasks_get`,
 *     `tasks_create` — are the minimum needed to assert the
 *     assignee cross-ref + admit a mutation round-trip.
 *   - The full 7-tool TS Tasks fixture at `../mcps/tasks/` stays the
 *     source of truth for per-tool contract coverage.
 *
 * Seed alignment with `./contacts-mount.mjs`:
 *
 *   - Two tasks with `assigneeId = 'alice'` — exactly the task ids
 *     that the contacts mount's `alice` row carries in
 *     `linkedTaskIds`. The composition spec asserts these two views
 *     agree on the same relationship (relational truth across MCPs).
 *   - One task with `assigneeId = null` — confirms the cross-ref is
 *     optional on the Tasks side.
 *
 * zod is resolved from `e2e/ggui-oss/node_modules` via Node's
 * walk-up-from-CWD resolver (the harness pins CWD to this fixture
 * dir). `outputSchema` is declared non-empty on every handler so
 * `composeHandlersWithMounts`' Slice-6.2 guardrail stays satisfied.
 */
import { z } from 'zod';

/**
 * Task shape shared between `tasks_list.items[]` + `tasks_get.item` +
 * `tasks_create.item`. Includes `assigneeId` (the cross-ref to
 * Contacts) as the load-bearing field for the composition proof.
 */
const TaskItem = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  assigneeId: z.string().nullable(),
});

export function createGguiMcpMount() {
  const store = new Map();
  // Two tasks assigned to alice — match `linkedTaskIds` in the
  // contacts mount. Composition spec asserts bidirectional agreement.
  store.set('seed-task-1', {
    id: 'seed-task-1',
    title: 'Ship Slice 6.4 composition proof',
    status: 'doing',
    assigneeId: 'alice',
  });
  store.set('seed-task-2', {
    id: 'seed-task-2',
    title: 'Draft the launch announcement',
    status: 'todo',
    assigneeId: 'alice',
  });
  // One unassigned task — keeps the cross-ref optional on the Tasks
  // side. Without this row the `assigneeId: string | null` nullability
  // is theoretical-only.
  store.set('seed-task-3', {
    id: 'seed-task-3',
    title: 'Unblock the Phase 5 CI flake',
    status: 'blocked',
    assigneeId: null,
  });

  return {
    name: 'tasks',
    handlers: [
      {
        name: 'tasks_list',
        title: 'List tasks',
        description:
          'Return every seeded task. The composition spec uses this to scan for assigneeId cross-refs against the contacts mount.',
        inputSchema: {},
        outputSchema: { items: z.array(TaskItem) },
        async handler() {
          return { items: Array.from(store.values()) };
        },
      },
      {
        name: 'tasks_get',
        title: 'Get task',
        description:
          'Retrieve a single task by id. Returns `{ item: null }` when no task with that id exists.',
        inputSchema: { id: z.string().min(1) },
        outputSchema: { item: TaskItem.nullable() },
        async handler(raw) {
          const id =
            raw && typeof raw === 'object' && typeof raw.id === 'string'
              ? raw.id
              : '';
          if (id.length === 0) {
            throw new Error('tasks_get: `id` must be a non-empty string');
          }
          const item = store.get(id) ?? null;
          return { item };
        },
      },
      {
        name: 'tasks_create',
        title: 'Create task',
        description:
          'Append a new task. Accepts an optional `assigneeId` so the composition spec can mutate the cross-ref graph and verify the contacts mount agrees on the new relationship.',
        inputSchema: {
          input: z.object({
            title: z.string().min(1),
            assigneeId: z.string().min(1).optional(),
          }),
        },
        outputSchema: { item: TaskItem },
        async handler(raw) {
          const input =
            raw && typeof raw === 'object' && 'input' in raw
              ? /** @type {{ title?: unknown; assigneeId?: unknown }} */ (
                  raw.input
                )
              : {};
          const title =
            input && typeof input === 'object' ? input.title : undefined;
          if (typeof title !== 'string' || title.length === 0) {
            throw new Error(
              'tasks_create: `input.title` must be a non-empty string',
            );
          }
          const assigneeId =
            input &&
            typeof input === 'object' &&
            typeof input.assigneeId === 'string'
              ? input.assigneeId
              : null;
          const id = `local-task-${store.size + 1}`;
          const item = { id, title, status: 'todo', assigneeId };
          store.set(id, item);
          return { item };
        },
      },
    ],
  };
}
