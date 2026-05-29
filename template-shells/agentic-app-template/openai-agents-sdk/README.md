# Agentic App Template — OpenAI Agents SDK

Build **agentic apps** where the agent renders its own interactive UI — on the
[ggui protocol](https://github.com/ggui-ai/ggui), powered by OpenAI's
[Agents SDK](https://www.npmjs.com/package/@openai/agents).

> Don't clone this folder directly. Use the create tool:
>
> ```bash
> npx @ggui-ai/create-agentic-app --agent openai-agents-sdk my-app
> ```

## What you get

A pnpm monorepo with three backend servers + one frontend SPA, ready to run:

| Directory             | What it is                                                          |
| --------------------- | ------------------------------------------------------------------- |
| `servers/agent`       | The agent — `@openai/agents` + an HTTP API the frontend hits.       |
| `servers/ggui`        | A `ggui serve` config — turns the agent's render calls into a live UI. |
| `servers/mcps/todo`   | A standalone MCP server (todo CRUD) — the agent's domain tools.     |
| `apps/web`            | A Vite SPA frontend that mounts the agent's renders in iframes.     |

Together they demonstrate the full loop: you chat → the agent calls domain
tools and renders a React UI → you click in that UI → the agent reacts.

## Quick start

```bash
pnpm install
cp .env.example .env.local   # add your OPENAI_API_KEY + ANTHROPIC_API_KEY
pnpm dev                     # starts all four servers, then opens the app
```

`pnpm dev` brings up the ggui server, your MCP servers, the agent, and the web
app together (labeled `[ggui] [mcps] [agent] [web]` logs) and opens
**http://localhost:6890** once it's ready. Prefer separate terminals? Run
`pnpm dev:ggui`, `pnpm dev:mcps` (every `servers/mcps/*`), `pnpm dev:agent`,
and `pnpm dev:web` individually.

Why two LLM keys? In the default config, the **agent** runs on OpenAI and the
**ggui server** generates UI via Claude. Set both, or change ggui.json's
`generation.model` to an OpenAI model and drop `ANTHROPIC_API_KEY`.

## Deploy to Railway

```bash
pnpm deploy:railway          # add -- --dry-run first to preview
```

One command provisions all four services on Railway, wires the public/private
URLs between them, and pushes the API keys from `.env.local`. It needs a
`RAILWAY_API_TOKEN` (an **account** token from
https://railway.com/account/tokens) set in `.env.local`. Run
`pnpm deploy:railway -- --dry-run` first to see exactly what it will do.
Implementation: `scripts/deploy-railway.mjs`.

## How to build your app

You own four layers — and, when you want them, two ggui power features.

### 1. Develop your agent

Your agent lives in `servers/agent`. Start with its **system prompt**: that is
where the agent's personality and domain reasoning live. A restaurant agent
greets diners and reasons about menus; a support agent triages tickets. Write
the prompt for *your* domain.

Keep the prompt about *posture*, not mechanics — the ggui render flow teaches
itself through the MCP tool descriptions.

### 2. Give your agent tools — as MCP servers

`servers/mcps/todo` is the example: a small, standalone MCP server exposing a
todo CRUD surface. Copy it to `servers/mcps/<domain>/`, rename it, and
implement your own tools. Or, if a tool already exists in the world as an
**MCP server, connect to it directly** instead of writing your own.

Either way, `pnpm dev` already starts every `servers/mcps/*` and the agent
auto-registers each from a `GGUI_<NAME>_MCP_URL` env var — no wiring code. See
`.reference/writing-mcp-tools.md` for the full path.

### 3. Customize the frontend

`apps/web` is a Vite SPA that talks to your agent backend over HTTP. It uses
`@ggui-ai/react`'s `<AppRenderer>` to mount the agent's renders in iframes.
Edit `apps/web/src/App.tsx` to tweak the chat shell.

### 4. Customize the ggui server

`servers/ggui/ggui.json` configures `ggui serve`. Set your default UI model,
theme, declared blueprints + gadgets. See https://ggui.ai/docs/cli for the
full reference.

### Blueprints — cache your common screens

A **blueprint** is a cached UI template for a recurring pattern (a login
screen, an order summary). Author one with **`/blueprint`** (inside Claude
Code), or by hand: `ggui blueprint create`, implement the TSX,
`ggui blueprint publish`, `ggui blueprint install`.

### Gadgets — give the generator client-side libraries

A **gadget** wraps a browser library or capability — maps, charts, camera,
clipboard — as a stable React hook/component the generated UI can use.
Author one with **`/gadget`**, or by hand.

## Reference

- [ggui docs](https://ggui.ai/docs) — protocol, blueprints, gadgets, CLI.
- [OpenAI Agents SDK](https://www.npmjs.com/package/@openai/agents)
- [ggui on GitHub](https://github.com/ggui-ai/ggui)
- `.mcp.json` wires `https://mcp.ggui.ai/docs` as a project MCP server so
  Claude Code can query the ggui docs MCP directly while you work.
