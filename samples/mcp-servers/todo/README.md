# @ggui-samples/mcp-todo

Reference sample: a minimal standalone MCP server exposing a todo-list CRUD surface.

Used by `e2e/scenarios/` to give the conformance suite real backing state to mutate + assert against. Pair with `@ggui-samples/ggui-default` (the ggui MCP server) and `@ggui-samples/agent-claude-sdk` (the sample agent) to exercise the full data round trip:

- Agent push: a UI listing todos + an add-todo form
- User click: `submit_action` pipe-appends a `{intent:'addTodo', data:{text:...}}` event
- Agent next turn: drains the pipe via `ggui_consume`, calls `todo_add` here
- Server state mutates
- Agent re-pushes: UI shows the new todo

## Run

```bash
pnpm --filter @ggui-samples/mcp-todo start
```

Listens on `http://localhost:6782/mcp` by default. Override with `PORT` env or `--port`.

## Tools

| Tool          | Purpose                           |
| ------------- | --------------------------------- |
| `todo_list`   | Return every todo                 |
| `todo_add`    | Append a new todo with `{ text }` |
| `todo_toggle` | Flip `done` boolean by `{ id }`   |
| `todo_delete` | Remove by `{ id }`                |

## Debug endpoints

- `GET /admin/state` — read the in-memory list without an MCP round trip
- `POST /admin/reset` — clear the store (between-scenario isolation)

Not published. Single-process, single-instance, in-memory store. Test fixture only.
