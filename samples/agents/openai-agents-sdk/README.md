# Sample Agent — OpenAI Agents SDK ↔ ggui

Reference implementation of an MCP-host agent built with the OpenAI Agents SDK (`@openai/agents`), pointed at a ggui MCP server.

**The agent core is a small amount of TypeScript.** No ggui agent-side wrapper, no scaffold. The only ggui-specific configuration is the MCP server URL — every ggui tool (`ggui_handshake`, `ggui_render`, `ggui_update`, `ggui_consume`, etc.) is discovered by the LLM via the standard MCP `tools/list` handshake.

This is "Zero Agent Code" with GPT-5.5 as the driver.

## What it does

Boots a small HTTP server (default port `6791`) that serves a chat UI with:

- **Left pane** — chat textarea + history of agent turns (assistant text, tool calls, errors).
- **Right pane** — iframe that loads the rendered ggui UI as soon as the agent calls `ggui_render`.

Identical UX to the Claude sample — the chat shell, iframe host, and event log are shared code; only `src/agent.ts` differs.

## Running standalone

```bash
# 1. Boot a ggui MCP server in another terminal
ggui serve --port 6781 --mcp-only

# 2. Set your OpenAI API key
export OPENAI_API_KEY=sk-...

# 3. Boot the sample agent
pnpm --filter @ggui-samples/agent-openai-sdk start
# → http://localhost:6791
```

### Env vars

| Var                 | Default                     | Purpose                                                   |
| ------------------- | --------------------------- | --------------------------------------------------------- |
| `PORT`              | `6791`                      | Chat-UI HTTP port                                         |
| `GGUI_MCP_URL`      | `http://localhost:6781/mcp` | Where the agent's MCP client connects                     |
| `GGUI_TODO_MCP_URL` | —                           | Optional second MCP for domain tools (todo demo)          |
| `OPENAI_MODEL`      | `gpt-5.5-2026-04-23`        | OpenAI model ID                                           |
| `OPENAI_API_KEY`    | —                           | Required; the agent fails-fast on first `/chat` if absent |
| `GGUI_MCP_BEARER`   | `dev`                       | Sent as `Authorization: Bearer <token>` on every MCP req  |

## Wire diagram

```
       ┌──────────────────────┐
       │ Browser (chat UI)    │
       │ dist-ui/index.html   │
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
       │ run(agent, prompt, { │
       │   stream: true,      │
       │ })                   │
       │  ├─ Agent({          │
       │  │    model,         │
       │  │    instructions,  │
       │  │    mcpServers: [  │
       │  │      new MCPServer│
       │  │      StreamableHtt│
       │  │      p({url,...}) │
       │  │    ],             │
       │  │  })               │
       └──────────┬───────────┘
                  │ MCP JSON-RPC + OpenAI Responses API
                  ▼
       ┌──────────────────────┐
       │ ggui serve           │  (separate process)
       │ @ggui-ai/cli         │
       └──────────────────────┘
```

The browser parses each SSE frame as a [normalized envelope](./src/agent.ts) shaped like the Claude sample's `SDKMessage` so the shared `src-ui/` consumes one event format across all sample agents:

- `assistant` text → chat bubble
- `assistant` `tool_use` → compact tool-call notation
- `user` `tool_result` containing a `/r/...` URL → `iframe.src = url`
- `result` → end marker

## File layout

```
src/
  agent.ts      runAgent() AsyncIterable normalizes OpenAI stream events
  server.ts     HTTP server + /chat SSE + /relay/tools-call (shared shape)
  index.ts      boot entry
src-ui/         React chat client (shared with other sample agents)
index.html      Vite HTML entry
```

## Not used for

Not a published library. Not a scaffold. Not a framework. This file exists to be **read** by external developers building their own OpenAI-driven ggui agents — the patterns here transfer directly to any MCP-host code path on top of `@openai/agents`.
