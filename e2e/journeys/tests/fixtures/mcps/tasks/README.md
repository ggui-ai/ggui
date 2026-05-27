# Tasks MCP fixture

The first stateful MCP fixture — the "Tasks" domain — per the OSS
stateful-MCP strategy
(`docs/plans/2026-04-21-oss-generation-stateful-mcp-strategy.md` §8).

Ships **only** as a test fixture. Not a product surface. Not published.

## Scope

| In                                       | Out (by design)                                     |
| ---------------------------------------- | --------------------------------------------------- |
| Strict zod schemas for every tool        | Production-grade search (LIKE is enough)            |
| Real sqlite persistence (`:memory:` def) | Multi-user / permissions — fixtures are single-user |
| The seven canonical tools (§9.2)         | Foreign-key validation across fixtures              |
| Deterministic `seed()` + `reset()`       | Runtime wiring into OSS `ggui serve`                |

Entity shape (locked per strategy §8.1):

```
Task = {
  id, title,
  status: 'todo' | 'doing' | 'done' | 'blocked',
  priority: 'low' | 'medium' | 'high',
  assigneeId?: string | null,
  dueDate?: YYYY-MM-DD | null,
  linkedNoteId?: string | null,
  createdAt, updatedAt
}
```

## Tool surface

Seven tools — the six canonical `<entity>_*` tools plus `tasks_complete`
(the status-transition tool that lets the blueprint negotiator tell
"edit task" apart from "mark done"):

| Tool             | Input                               | Output                            |
| ---------------- | ----------------------------------- | --------------------------------- |
| `tasks_list`     | `{filter?, sort?, cursor?, limit?}` | `{items, nextCursor?}`            |
| `tasks_get`      | `{id}`                              | `{item: TaskEntity \| null}`      |
| `tasks_create`   | `{input: TaskCreateInput}`          | `{item}`                          |
| `tasks_update`   | `{id, patch: TaskUpdatePatch}`      | `{item: TaskEntity \| null}`      |
| `tasks_delete`   | `{id}`                              | `{deleted: boolean}` (idempotent) |
| `tasks_search`   | `{query, filter?, limit?}`          | `{items, totalMatches}`           |
| `tasks_complete` | `{id}`                              | `{item: TaskEntity \| null}`      |

## Using from tests

```ts
import { TasksStore } from "./fixtures/mcps/tasks/store.js";
import { createTasksMcpServer } from "./fixtures/mcps/tasks/server.js";
import { TASKS_SEED } from "./fixtures/mcps/tasks/seed.js";
import { connectMcpInMemory } from "./fixtures/mcps/_shared/mcp-test-client.js";

const store = new TasksStore({ filename: ":memory:" });
store.seed(TASKS_SEED);

const server = createTasksMcpServer({ store });
const { client, close } = await connectMcpInMemory(server);

try {
  const result = await client.callTool({
    name: "tasks_list",
    arguments: { filter: { status: ["todo"] } },
  });
  // …assert on result.structuredContent…
} finally {
  await close();
}
```

## Running the contract tests

From the repo root:

```sh
pnpm --filter @ggui-private/e2e-oss test:mcp-fixtures
```

Pure vitest (Lane 3 per strategy §4.3). No browser, no CLI spawn,
no LLM.

## What this slice does NOT do

- Wire the fixture into OSS `ggui serve` as a hosted MCP proxy. That
  is Slice 6 (`mcpProxies` runtime wiring) — separate and deferred.
- Ship Notes or Contacts. Those are Slices 6.2 / 6.3 — the shapes in
  `_shared/` are kept generic with those slices in mind, but no code
  for them lands here.
- Add a Playwright spec. An honest browser proof of "OSS generates UI
  backed by a tasks MCP" requires the Slice 6 wiring so one agent
  session sees both `ggui_render` and `tasks_*` tools on one MCP
  connection — see strategy doc §14.4.
