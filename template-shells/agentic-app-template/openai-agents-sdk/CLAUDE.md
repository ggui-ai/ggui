# CLAUDE.md

Guidance for Claude Code working in this repository.

<!-- bootstrap:onboarding -->
## Start here

If the root `package.json` still says `"name": "agentic-app-template"`, this was
just scaffolded and hasn't been made yours yet. Run **`/bootstrap`** — it shows
you the app working, helps you pick what to build, scaffolds your first tool,
and themes it. (`/bootstrap` deletes this section when you're done.)
<!-- /bootstrap:onboarding -->

## What this is

A template for building **agentic apps** on the **ggui protocol** — apps where
the agent doesn't just reply in text, it renders an interactive UI, reads the
user's clicks back, and reacts. It's a pnpm monorepo with three backend servers
+ a frontend SPA, all present and runnable. The agent here is built on OpenAI's
[`@openai/agents`](https://openai.github.io/openai-agents-js/) SDK.

## The one idea: you only build TOOLS

ggui is **invisible infrastructure**. You never write UI code, no SDK to import
in the agent, no polling loops, no event handlers. You give the agent **tools**
(MCP servers) and a **system prompt**; ggui generates the interface for each
turn from the agent's natural-language description, and routes the user's
interactions back. The whole skill is: *expose good tools, write a good posture
prompt.*

## How the ggui loop works

```
apps/web (browser SPA)                          servers/agent (LLM backend)
   │  prompt ───────────────────────────────────▶  │ ──MCP──▶ servers/ggui      (renders the UI)
   │                                                │ ──MCP──▶ servers/mcps/*    (your domain tools)
   │  ◀── reply with the UI inlined ────────────────┘
   └─ mounts it with <AppRenderer> (@ggui-ai/react); the rendered iframe loads
      ggui's runtime + a live channel directly from servers/ggui
   │  user clicks ── action relayed to the agent ──▶ agent drains it, re-renders
```

1. The user types a prompt in `apps/web`; it POSTs to `servers/agent`.
2. The agent has **no built-in tools** — only the MCP tools of the servers it
   connects to: `ggui_*` (render) and your domain tools (e.g. `todo_*`).
3. To answer, the agent calls a domain tool for data, then **`ggui_render`**,
   *describing the UI in natural language*. `servers/ggui` generates a React UI
   and returns it as an MCP **resource**; the agent backend reads it
   (`resources/read`) and inlines it into the reply.
4. `apps/web` mounts that UI with **`<AppRenderer>`**. The sandboxed iframe then
   loads ggui's runtime bundle + opens a live channel **directly from
   `servers/ggui`** (so ggui must be reachable from the browser).
5. The user clicks something; the interaction is relayed back to the agent.
6. Next turn, the agent drains it with **`ggui_consume`**, calls the relevant
   domain tool, and `ggui_render`s an updated UI.

The agent-facing render tools (discovered via the standard MCP handshake, so
they need zero glue in `servers/agent`): `ggui_handshake` → `ggui_render` (draw
a surface) → `ggui_update` / `ggui_emit` (mutate or stream into it) →
`ggui_consume` (await the next user action) → `ggui_get_render` (read current
state). You rarely think about these — the tool descriptions teach the agent;
you just write tools + a posture prompt.

## Building your app — four layers

The template ships a working version of each. Make them yours.

### 1. The agent — its system prompt
`servers/agent/src/` holds the loop. The **system prompt** sets the agent's
*domain posture* (a restaurant agent greets diners and reasons about menus; a
support agent triages tickets). Edit it for your domain. Keep it posture-only —
the ggui wire flow is taught by the tools' own descriptions; don't restate it.
If the agent calls a tool wrong, fix the tool's **description**, not the prompt.

### 2. Tools = MCP servers
An agent is only as capable as its tools, and tools arrive as **MCP servers**.
`servers/mcps/todo` is the worked example (`todo_list/add/toggle/delete`). To
add your own:
1. Copy `servers/mcps/todo` → `servers/mcps/<domain>`, rename the package.
2. Implement your tools in `src/handlers.ts` (zod input schema + a handler that
   returns `structuredContent`). Write **user-facing tool descriptions** — the
   agent reads them to decide what to call.
3. Register it with the agent: add its URL env var in `servers/agent/src/index.ts`.
   See `.reference/writing-mcp-tools.md` for the exact wiring.

Or skip authoring and point the agent at an **existing third-party MCP** — just
add its URL to the agent's MCP config.

### 3. The frontend
`apps/web` is a Vite SPA that calls the agent backend and mounts renders via
`<AppRenderer>`. Edit `apps/web/src/App.tsx` to tweak the chat shell (header,
layout). It owns no secrets and runs no server logic.

### 4. The ggui server
`servers/ggui` is a stock `ggui serve` config — the UI is generated at runtime;
you shape the *shell* via `servers/ggui/ggui.json`. Three levers:
- **Theme** — `ggui.json#theme` (a preset, or a custom DTCG `theme.json`). ggui's
  two-layer theming means the agent-generated UI adopts your brand with zero UI
  code — the `/bootstrap` "make it yours" moment. Full guide + a valid starter:
  `.reference/theming.md` + `.reference/theme.example.json`.
- **Blueprints** — cached UI templates for recurring screens. ggui matches a
  blueprint first (fast) and only generates on a miss, so a known screen is
  cheap, fast, and visually consistent. Author with **`/blueprint`**.
- **Gadgets** — wrap a browser library (maps, charts, camera, clipboard) as a
  stable component the generated UI can use. Author with **`/gadget`**.

## Running locally

One command starts all four and opens the app in your browser once it's ready —
server logs are hidden by default, so add `pnpm dev --verbose` to stream them:

```bash
pnpm dev
```

Prefer separate terminals (to read one server's logs in isolation)? The agent
connects to the MCP servers and the SPA hits the agent, so this start order is
the most predictable (`dev:mcps` starts every `servers/mcps/*` at once):

```bash
pnpm dev:ggui    # ggui MCP server   → http://localhost:6781/mcp
pnpm dev:todo    # todo MCP server   → http://localhost:6782/mcp
pnpm dev:agent   # agent backend     → http://localhost:6790
pnpm dev:web     # frontend SPA      → http://localhost:6890
```

Open http://localhost:6890 and type a prompt.

### Environment
Set in `.env.local` (copy from `.env.example`). The agent and `pnpm dev:ggui`
both read it via `dotenv-cli`.

| Var                       | Required | Purpose                                                          |
| ------------------------- | -------- | ---------------------------------------------------------------- |
| `OPENAI_API_KEY`          | yes      | LLM credential for BOTH the agent (`@openai/agents`) and ggui's UI generation. |
| `RAILWAY_API_TOKEN`       | deploy   | Account token for `pnpm deploy:railway` (see Deploy).            |
| `GGUI_TODO_MCP_URL`       | demo     | `http://localhost:6782/mcp` — wires the todo tools into the agent. |
| `GGUI_MCP_URL`            | no       | Where the agent finds the ggui MCP (default `…:6781/mcp`).       |
| `MODEL`                   | no       | OpenAI model the agent runs on (default `gpt-5.5`).          |
| `PORT`                    | no       | Agent backend port (default 6790).                               |
| `VITE_AGENT_ENDPOINT_URL` | no       | Where the browser bundle reaches the agent backend.              |

The ggui server reads its model from `servers/ggui/ggui.json#generation.model`,
not an env var.

## Deploy

`pnpm deploy:railway` — one command. It reads `.env.local`, creates a Railway
project, provisions all four services, wires the public/private URLs between
them, pushes your API keys, and gives the web + agent + ggui services public
domains. Requires `RAILWAY_API_TOKEN` (an **account** token from
https://railway.com/account/tokens). Run `pnpm deploy:railway -- --dry-run`
first to see exactly what it will do. Implementation: `scripts/deploy-railway.mjs`.

## Layout

| Path                | Role                                                                  |
| ------------------- | --------------------------------------------------------------------- |
| `servers/agent`     | The agent — `@openai/agents` HTTP API.                                |
| `servers/ggui`      | Vendored `ggui serve` config (`ggui.json`). Renders the agent's UI.   |
| `servers/mcps/todo` | Worked-example MCP server. **Copy this** to author your own domain MCP. |
| `apps/web`          | Vite SPA — `@ggui-ai/react` `<AppRenderer>`.                          |
| `blueprints/*`      | Blueprints you author with `/blueprint` (empty until you create one). |
| `gadgets/*`         | Gadgets you author with `/gadget` (empty until you create one).       |

## Conventions

- **pnpm workspace**; packages under `servers/*` + `apps/*`. ESM everywhere.
- TypeScript via `tsx` in dev; `tsc -b` for builds. `pnpm typecheck` checks all.
- `@ggui-ai/*` dependencies resolve from npm.

## Reference

- **`.reference/`** — local GGUI guides for this template (the Claude Code here
  can't read ggui's source, so read these first): `ggui-overview.md` (the loop),
  `ggui-tools.md`, `writing-mcp-tools.md`, `ggui-json.md`, `theming.md`
  (+ `theme.example.json`). Index: `.reference/README.md`.
- **ggui docs MCP** — `.mcp.json` wires `https://mcp.ggui.ai/docs` as the
  `ggui-docs` project MCP server (pre-approved). Query it for protocol / API /
  blueprint / gadget details before guessing.
- Docs — **https://docs.ggui.ai** · ggui — https://github.com/ggui-ai/ggui
- OpenAI Agents SDK — https://openai.github.io/openai-agents-js/
- Each server's own `README.md` has standalone run instructions.
