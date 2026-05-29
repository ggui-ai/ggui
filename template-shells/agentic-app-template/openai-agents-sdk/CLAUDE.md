# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

A template for building **agentic apps** on the **ggui protocol** — apps where
the agent doesn't just reply in text but renders an interactive UI, reads the
user's clicks back, and reacts. It is a pnpm monorepo with three backend
servers + a frontend SPA, all present and runnable. The agent is built on
OpenAI's [`@openai/agents`](https://openai.github.io/openai-agents-js/) SDK.

## First-run housekeeping

If the root `package.json` still says `"name": "agentic-app-template"`, the
user has just scaffolded this from the template and the project still has its
template identity. Run **`/bootstrap`** to rename the workspace, tailor the
docs, and delete this section.

## Architecture — the ggui loop

```
Browser SPA (apps/web) ──HTTP──▶ servers/agent ──MCP──▶ servers/ggui      generates + serves the UI
   ▲                                  │        └─MCP──▶ servers/mcps/todo  domain tools
   └─ embeds servers/ggui's /r/<shortCode> in <AppRenderer>
```

1. The user types a prompt in `apps/web`.
2. The SPA POSTs it to `servers/agent` over SSE.
3. The agent has **no built-in tools** — only the MCP tools exposed by the
   servers it points at: `ggui_*` (render UI) and `todo_*` (domain logic).
4. To answer, the LLM calls domain tools, then `ggui_handshake` →
   `ggui_render`. `servers/ggui` generates the React UI and serves it at
   `/r/<shortCode>`; the SPA embeds that route in an iframe via
   `<AppRenderer>` from `@ggui-ai/react`.
5. The user clicks something in that UI. The interaction is forwarded to
   the agent backend via `POST /relay/tools-call`.
6. Next turn, the agent drains it with `ggui_consume`, calls the relevant
   domain tool, and `ggui_render`-s an updated UI.

**"Zero Agent Code":** the only ggui-specific thing in `servers/agent` is the
MCP server URL. Every `ggui_*` tool is discovered via the standard MCP
handshake — see `servers/agent/src/agent.ts`.

## Building your app

You own four layers. The template gives you a working version of each — make
them yours.

### 1. The agent — its system prompt

`servers/agent/src/` holds the agent loop. The **system prompt** sets the
agent's *domain posture*. Edit it for your domain.

Keep it posture-only. The ggui wire flow (`handshake → render → consume`) is
taught by the MCP tools' own descriptions — don't restate it in the prompt.

### 2. Tools — MCP servers

An agent is only as capable as its tools, and tools arrive as **MCP servers**.
`servers/mcps/todo` is the worked example: a standalone MCP exposing
`todo_list/add/toggle/delete`.

Copy `servers/mcps/todo` → `servers/mcps/<domain>`, rename the package,
implement your tools, register its URL in `servers/agent/src/agent.ts`. Or
point the agent at an **existing third-party MCP**.

### 3. The frontend

`apps/web` is a Vite SPA that calls the agent backend and mounts its renders
in iframes via `<AppRenderer>`. Edit `apps/web/src/App.tsx` to tweak the chat
shell.

### 4. The ggui server

`servers/ggui` is a stock `ggui serve` config. Shape the shell via
`ggui.json` (theme, declared blueprints + gadgets). Both blueprints (cached
common screens) and gadgets (client-side libraries the generator can use)
are how you steer what the LLM produces. Author with `/blueprint` and
`/gadget` inside Claude Code.

### Hosting

`railway.toml` declares four Railway services. Create a project from this
repo, set your `OPENAI_API_KEY` + `ANTHROPIC_API_KEY` (ggui defaults to
Claude for UI generation), and open the `web` service's public URL.

## Layout

| Path                 | Role                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| `servers/agent`      | The agent — `@openai/agents` HTTP API.                                     |
| `servers/ggui`       | Vendored `ggui serve` operator config (`ggui.json`). Renders agent UI.     |
| `servers/mcps/todo`  | Vendored MCP server — `todo_list/add/toggle/delete`. Copy when authoring your own domain MCP. |
| `apps/web`           | Vite SPA frontend — `@ggui-ai/react` `<AppRenderer>` + `useMcpAppsChat`.   |
| `blueprints/*`       | Blueprints you author with `/blueprint`.                                   |
| `gadgets/*`          | Gadgets you author with `/gadget`.                                         |

## Running locally

Four processes, four terminals:

```bash
pnpm dev:ggui    # ggui MCP server   → http://localhost:6781/mcp
pnpm dev:todo    # todo MCP server   → http://localhost:6782/mcp
pnpm dev:agent   # agent backend     → http://localhost:6791
pnpm dev:web     # frontend SPA      → http://localhost:6890
```

Open http://localhost:6890 and type a prompt.

### Environment

Set in `.env.local` (copy from `.env.example`).

| Var                       | Required | Default                     | Purpose                                            |
| ------------------------- | -------- | --------------------------- | -------------------------------------------------- |
| `OPENAI_API_KEY`          | yes      | —                           | LLM credential for the agent. |
| `ANTHROPIC_API_KEY`       | yes      | —                           | LLM credential for ggui's UI generator (default ggui.json picks Claude). |
| `GGUI_TODO_MCP_URL`       | demo     | —                           | Set to `http://localhost:6782/mcp` to wire the todo tools into the agent. |
| `GGUI_MCP_URL`            | no       | `http://localhost:6781/mcp` | Where the agent finds the ggui MCP.                |
| `GGUI_MCP_BEARER`         | no       | `dev`                       | Bearer for the ggui MCP. |
| `MODEL`                   | no       | `gpt-4o-mini`               | OpenAI model the AGENT runs on. |
| `PORT`                    | no       | `6791`                      | Agent backend port. |
| `VITE_AGENT_ENDPOINT_URL` | no       | `http://localhost:6791`     | Where the SPA reaches the agent backend. |

## Conventions

- **pnpm workspace**, packages under `servers/*` + `apps/*`. ESM everywhere.
- TypeScript run via `tsx` in dev; `tsc -b` for builds.
- The `@ggui-ai/*` dependencies resolve from npm.

## Reference

- **ggui docs MCP** — `.mcp.json` wires `https://mcp.ggui.ai/docs` as a
  project MCP server. Query it for ggui protocol details before guessing.
- ggui — https://github.com/ggui-ai/ggui
- OpenAI Agents SDK — https://openai.github.io/openai-agents-js/
- `ggui` CLI — from `@ggui-ai/cli`.
