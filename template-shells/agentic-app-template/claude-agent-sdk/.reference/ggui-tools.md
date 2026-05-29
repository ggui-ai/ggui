# Reference — the `ggui_*` render tools

> These are the MCP tools `servers/ggui` exposes. The agent discovers them via
> the standard MCP handshake (zero glue in `servers/agent`) and the **tool
> descriptions themselves teach the agent how to use them** — you rarely think
> about them directly. This is the map, for when you do.

## The turn cycle

```
ggui_handshake → ggui_render → … user interacts … → ggui_consume → ggui_render → …
```

| Tool | What it does |
| ---- | ------------ |
| `ggui_handshake` | Negotiate the contract/blueprint for a surface before rendering. |
| `ggui_render` | Materialize **one** render from a natural-language UI description (+ data). The core call. (Replaced the old `ggui_push`.) |
| `ggui_update` | Mutate the current render's **props** in place (no full re-render). |
| `ggui_emit` | Push **live/streaming** data into the current render (e.g. status ticks). |
| `ggui_consume` | **Long-poll** for the next user action (a click/submit). The agent awaits this, then reasons on the next turn. |
| `ggui_get_render` | Read the current render, including the latest **observed UI state** (form drafts, selections). |
| `ggui_list_renders` | List the renders in the session. |

(Runtime-only tools like `ggui_runtime_submit_action` / `ggui_runtime_sync_context`
are the iframe→host plumbing — the model never calls them.)

## How a click becomes the next turn

1. `ggui_render` draws a surface whose interactive bits are declared as
   **actions** (turn-driving) and whose live state is **observed** (read between
   turns).
2. The user clicks → the iframe relays the action to the agent backend.
3. The agent's pending `ggui_consume` resolves with that action → it calls the
   relevant domain tool → `ggui_render`s the update.

## Mental model for tool authors
- A **commit** (submit order, advance status) is an **action** — it drives the
  next turn.
- **Live draft state** (a quantity being stepped, a selection before commit) is
  **observed**, not an action.
- Steppers, animations, trackers are **component behavior** ggui generates — not
  things you model in your tool's inputs/outputs.

Deeper protocol detail (the four specs — props/stream/action/context) lives in
the `ggui-docs` MCP (`.mcp.json`) / https://docs.ggui.ai.
