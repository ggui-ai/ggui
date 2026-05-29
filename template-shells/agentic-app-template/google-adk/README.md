# Agentic App Template — Google ADK

Build **agentic apps** where the agent renders its own interactive UI — on the
[ggui protocol](https://github.com/ggui-ai/ggui), powered by Google's
[ADK (TypeScript)](https://www.npmjs.com/package/@google/adk).

> Don't clone this folder directly. Use the create tool:
>
> ```bash
> npx @ggui-ai/create-agentic-app --agent google-adk my-app
> ```

## What you get

A pnpm monorepo with three backend servers + one frontend SPA, ready to run:

| Directory             | What it is                                                          |
| --------------------- | ------------------------------------------------------------------- |
| `servers/agent`       | The agent — `@google/adk` + an HTTP API the frontend hits.          |
| `servers/ggui`        | A `ggui serve` config — turns the agent's render calls into a live UI. |
| `servers/mcps/todo`   | A standalone MCP server (todo CRUD) — the agent's domain tools.     |
| `apps/web`            | A Vite SPA frontend that mounts the agent's renders in iframes.     |

Together they demonstrate the full loop: you chat → the agent calls domain
tools and renders a React UI → you click in that UI → the agent reacts.

## Quick start

```bash
pnpm install
cp .env.example .env.local
# add your GEMINI_API_KEY + ANTHROPIC_API_KEY to .env.local
pnpm dev:ggui    # terminal 1 — ggui MCP server   → http://localhost:6781/mcp
pnpm dev:todo    # terminal 2 — todo MCP server   → http://localhost:6782/mcp
pnpm dev:agent   # terminal 3 — agent backend     → http://localhost:6792
pnpm dev:web     # terminal 4 — frontend SPA      → http://localhost:6890
```

Open http://localhost:6890 and type a prompt.

Why two LLM keys? In the default config, the **agent** runs on Gemini and the
**ggui server** generates UI via Claude. Set both, or change ggui.json's
`generation.model` to a Gemini model and drop `ANTHROPIC_API_KEY`.

## Deploy to Railway

`railway.toml` declares four services (`agent`, `ggui`, `todo`, `web`) wired
together via Railway's internal DNS. Create a new Railway project from this
repo, set `GEMINI_API_KEY` on the `agent` service + `ANTHROPIC_API_KEY` on
the `ggui` service, and open the public URL of the `web` service.

See `railway.toml` for the full config.

## How to build your app

You own four layers — and, when you want them, two ggui power features.

### 1. Develop your agent

Your agent lives in `servers/agent`. Start with its **system prompt** — write
it for your domain (a restaurant agent reasons about menus; a support agent
triages tickets). Keep it posture-only; the ggui render flow teaches itself
through the MCP tool descriptions.

### 2. Give your agent tools — as MCP servers

`servers/mcps/todo` is the example. Copy it to `servers/mcps/<domain>/`,
rename it, and implement your own tools. Or point the agent at an
**existing third-party MCP** instead.

### 3. Customize the frontend

`apps/web` is a Vite SPA that talks to your agent backend over HTTP. It uses
`@ggui-ai/react`'s `<AppRenderer>` to mount the agent's renders in iframes.
Edit `apps/web/src/App.tsx` to tweak the chat shell.

### 4. Customize the ggui server

`servers/ggui/ggui.json` configures `ggui serve`. Set your default UI model,
theme, declared blueprints + gadgets. See https://ggui.ai/docs/cli for the
full reference.

### Blueprints — cache your common screens

A **blueprint** is a cached UI template for a recurring pattern. Author one
with **`/blueprint`** (inside Claude Code), or by hand.

### Gadgets — give the generator client-side libraries

A **gadget** wraps a browser library or capability as a stable React hook
the generated UI can use. Author one with **`/gadget`**, or by hand.

## Reference

- [ggui docs](https://ggui.ai/docs) — protocol, blueprints, gadgets, CLI.
- [Google ADK (TypeScript)](https://www.npmjs.com/package/@google/adk)
- [ggui on GitHub](https://github.com/ggui-ai/ggui)
- `.mcp.json` wires `https://mcp.ggui.ai/docs` as a project MCP server so
  Claude Code can query the ggui docs MCP directly while you work.
