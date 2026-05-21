/**
 * Self-contained `ggui.json#mcpMounts` fixture for the `tasks-mount-
 * via-serve.spec.ts` E2E proof.
 *
 * Why it exists:
 *
 *   The Tasks MCP fixture at `../mcps/tasks/` is written in TypeScript
 *   (`handlers.ts` / `store.ts` / `schema.ts`) and relies on
 *   `better-sqlite3` — production `ggui serve` loads modules as plain
 *   Node ESM (no tsx loader injected) and the fixture can't be loaded
 *   through the real CLI subprocess without a build step. That build
 *   step is a follow-up, not a Slice 6 blocker.
 *
 *   This `.mjs` is the narrowest honest proof: a pure-ESM module with
 *   an in-memory Map store, seeded inline, exposing two handlers
 *   (`tasks_list` + `tasks_create`) — enough to assert the mount path
 *   is reachable through the operator's real `ggui.json` + real
 *   `ggui serve` binary. The TS Tasks fixture stays the source of
 *   truth for the full surface + blocking contract coverage.
 *
 * Entry-point contract (see
 * `packages/project-config/src/mcp-mount-discovery.ts`):
 *
 *   - Export a named `createGguiMcpMount` function.
 *   - Return `{ name: string, handlers: SharedHandler[] }`.
 *   - Each handler carries `name`, `description`, `inputSchema`
 *     (`ZodRawShape`), `outputSchema` (`ZodRawShape`), `handler`.
 *
 *   `outputSchema` MUST declare the fields the handler returns — the
 *   MCP SDK strips unknown fields from `structuredContent` against
 *   the declared zod shape, so `outputSchema: {}` silently returns
 *   `{}` on the wire even when the handler returns a populated
 *   object. We import zod from `e2e/ggui-oss/node_modules` (declared
 *   in that package's devDeps); Node's resolver walks up from this
 *   file's location at mount-import time and finds it there.
 *
 *   `createGguiMcpMount` runs once at CLI boot — the Map constructed
 *   here is the mount's backing state for the life of the process.
 */
import { z } from 'zod';

/**
 * Task item zod shape — shared between `tasks_list.items[]` and
 * `tasks_create.item`. Declaring it once keeps the two tool surfaces
 * aligned; drift would be a silent structuredContent mismatch.
 */
const TaskItem = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
});

export function createGguiMcpMount() {
  const store = new Map();
  // Deterministic seed so the E2E spec can assert `.items.length === 2`
  // after boot + round-trip `tasks_create` to 3.
  store.set('seed-1', {
    id: 'seed-1',
    title: 'Ship Slice 6 mount-via-serve',
    status: 'todo',
  });
  store.set('seed-2', {
    id: 'seed-2',
    title: 'Verify operator-facing mount path',
    status: 'todo',
  });

  return {
    name: 'tasks',
    handlers: [
      {
        name: 'tasks_list',
        title: 'List tasks',
        description:
          'Return every seeded task. Proves the mount reads from state declared in createGguiMcpMount().',
        inputSchema: {},
        outputSchema: { items: z.array(TaskItem) },
        async handler() {
          return { items: Array.from(store.values()) };
        },
      },
      {
        name: 'tasks_create',
        title: 'Create task',
        description:
          'Append a new task. Proves the mount handler dispatches writes through the real /mcp wire.',
        inputSchema: {
          input: z.object({ title: z.string().min(1) }),
        },
        outputSchema: { item: TaskItem },
        async handler(raw) {
          const input =
            raw && typeof raw === 'object' && 'input' in raw
              ? /** @type {{ title?: unknown }} */ (raw.input)
              : {};
          const title = input && typeof input === 'object' ? input.title : undefined;
          if (typeof title !== 'string' || title.length === 0) {
            throw new Error(
              'tasks_create: `input.title` must be a non-empty string',
            );
          }
          const id = `local-${store.size + 1}`;
          const item = { id, title, status: 'todo' };
          store.set(id, item);
          return { item };
        },
      },
    ],
  };
}
