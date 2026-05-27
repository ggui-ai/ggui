# Sample Agent — Claude Agent SDK ↔ ggui

Reference implementation of an MCP-host agent built with the Anthropic Claude Agent SDK, pointed at a ggui MCP server.

**The agent core is a small, readable amount of TypeScript.** No ggui agent-side wrapper, no `defineAgent` helper, no scaffold. The only ggui-specific configuration is the MCP server URL — every ggui tool (`ggui_handshake`, `ggui_render`, `ggui_update`, `ggui_consume`, etc.) is discovered by the LLM via the standard MCP `tools/list` handshake.

This is "Zero Agent Code" made concrete.

## What it does

Boots a small HTTP server (default port 6790) that serves a chat UI with:

- **Left pane** — chat textarea + history of agent turns (assistant text, tool calls, errors).
- **Right pane** — iframe that loads the rendered ggui UI as soon as the agent calls `ggui_render`.

```
┌──────────────────────────┬────────────────────────────────┐
│ Chat                     │                                │
│                          │     ggui-rendered UI           │
│ user: show weather…      │     (LLM-generated React,      │
│ → ggui_handshake(...)  │      served from ggui serve    │
│ → ggui_handshake(...)    │      at /r/<shortCode>)        │
│ → ggui_render(...)         │                                │
│ ← UI ready               │                                │
│ assistant: Here's the…   │                                │
│                          │                                │
│ [textarea]      [Send]   │                                │
└──────────────────────────┴────────────────────────────────┘
```

## Running standalone

```bash
# 1. Boot a ggui MCP server in another terminal
ggui serve --port 6781 --mcp-only

# 2. Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# 3. Boot the sample agent
pnpm --filter @ggui-samples/agent-claude-sdk start
# → http://localhost:6790

# 4. Open http://localhost:6790, type a prompt, watch the right pane render
```

### Env vars

| Var                 | Default                     | Purpose                                                   |
| ------------------- | --------------------------- | --------------------------------------------------------- |
| `PORT`              | `6790`                      | Chat-UI HTTP port                                         |
| `GGUI_MCP_URL`      | `http://localhost:6781/mcp` | Where the agent's MCP client connects                     |
| `ANTHROPIC_API_KEY` | —                           | Required; the agent fails-fast on first `/chat` if absent |

## Wire diagram

```
       ┌──────────────────────┐
       │ Browser (chat UI)    │
       │ public/index.html    │
       └──────────┬───────────┘
                  │ POST /chat (JSON)
                  ▼
       ┌──────────────────────┐
       │ server.ts            │
       │ /chat → SSE stream   │
       └──────────┬───────────┘
                  │ for await msg of runAgent(prompt)
                  ▼
       ┌──────────────────────┐
       │ agent.ts             │
       │ query({              │
       │   prompt,            │
       │   mcpServers: {      │
       │     ggui: {http,url} │
       │   },                 │
       │   allowedTools:[…],  │
       │ })                   │
       └──────────┬───────────┘
                  │ MCP JSON-RPC
                  ▼
       ┌──────────────────────┐
       │ ggui serve           │  (separate process)
       │ @ggui-ai/cli         │
       └──────────────────────┘
```

The browser also reads SSE events back and parses each `SDKMessage`:

- `assistant` text → chat bubble
- `assistant` `tool_use` → compact tool-call notation
- `user` `tool_result` containing a `/r/...` URL → `iframe.src = url`
- `result` → end marker

## Used by

The end-to-end suite spawns this sample as the agent side of its test scenarios, pairing it with the `samples/gguis/*` operator configurations (`default`, `canvas-demo`, `leaflet-demo`, `mapbox-demo`).

## Not used for

Not a published library. Not a scaffold. Not a framework. This file exists to be **read** by external developers building their own agents — the patterns here transfer directly to any MCP-host code path.

## File layout

```
src/
  agent.ts      runAgent() AsyncIterable over Claude SDK query()
  server.ts     HTTP server + /chat SSE + /relay/tools-call
  index.ts      boot entry
src-ui/         React chat client (built with Vite)
  main.tsx      entry
  Chat.tsx      chat shell + Render panel
  Render.tsx    <AppRenderer> host for each rendered UI
  useChat.ts    SSE client + bootstrap forwarding
  types.ts      shared UI types
  styles.css    styling
index.html      Vite HTML entry
```
