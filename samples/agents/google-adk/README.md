# Sample Agent — Google ADK ↔ ggui

Reference implementation of an MCP-host agent built with [Google ADK for TypeScript](https://adk.dev/get-started/typescript/) (`@google/adk`), pointed at a ggui MCP server.

**The agent core is a small amount of TypeScript.** No ggui agent-side wrapper, no scaffold. The only ggui-specific configuration is the MCP server URL — every ggui tool (`ggui_handshake`, `ggui_render`, `ggui_update`, `ggui_consume`, etc.) is discovered by Gemini via the standard MCP `tools/list` handshake.

This is "Zero Agent Code" with Gemini as the driver.

## What it does

Boots a small HTTP server (default port `6792`) that serves a chat UI with:

- **Left pane** — chat textarea + history of agent turns (assistant text, tool calls, errors).
- **Right pane** — iframe that loads the rendered ggui UI as soon as the agent calls `ggui_render`.

Identical UX to the Claude / OpenAI samples — the chat shell, iframe host, and event log are shared code; only `src/agent.ts` differs.

## Running standalone

```bash
# 1. Boot a ggui MCP server in another terminal
ggui serve --port 6781 --mcp-only

# 2. Set your Gemini API key
export GEMINI_API_KEY=...

# 3. Boot the sample agent
pnpm --filter @ggui-samples/agent-google-adk start
# → http://localhost:6792
```

### Env vars

| Var                 | Default                     | Purpose                                                  |
| ------------------- | --------------------------- | -------------------------------------------------------- |
| `PORT`              | `6792`                      | Chat-UI HTTP port                                        |
| `GGUI_MCP_URL`      | `http://localhost:6781/mcp` | Where the agent's MCP client connects                    |
| `GGUI_TODO_MCP_URL` | —                           | Optional second MCP for domain tools (todo demo)         |
| `GEMINI_MODEL`      | `gemini-3.5-flash`          | Gemini model ID                                          |
| `GEMINI_API_KEY`    | —                           | Required; `GOOGLE_API_KEY` accepted as fallback          |
| `GGUI_MCP_BEARER`   | `dev`                       | Sent as `Authorization: Bearer <token>` on every MCP req |

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
       │ Runner.runAsync({    │
       │   renderId,         │
       │   userId,            │
       │   newMessage         │
       │ })                   │
       │  ├─ LlmAgent({       │
       │  │    model,         │
       │  │    instruction,   │
       │  │    tools: [       │
       │  │      new MCPTool- │
       │  │      set({type:   │
       │  │      'SseConn…',  │
       │  │      url, headers})│
       │  │    ],             │
       │  │  })               │
       └──────────┬───────────┘
                  │ MCP JSON-RPC + Gemini generateContent
                  ▼
       ┌──────────────────────┐
       │ ggui serve           │  (separate process)
       │ @ggui-ai/cli         │
       └──────────────────────┘
```

The browser parses each SSE frame as a [normalized envelope](./src/agent.ts) shaped like the Claude sample's `SDKMessage` so the shared `src-ui/` consumes one event format across all sample agents.

## Transport note

ADK's `SseConnectionParams` carries the `Accept: application/json, text/event-stream` content-negotiation header — the same one MCP Streamable HTTP servers use to choose between unary JSON and SSE responses. So a single `SseConnectionParams` configuration speaks to both classic SSE MCP servers and modern Streamable HTTP MCP servers like ggui's `/mcp` endpoint.

## File layout

```
src/
  agent.ts      runAgent() AsyncIterable normalizes ADK Runner events
  server.ts     HTTP server + /chat SSE + /relay/tools-call (shared shape)
  index.ts      boot entry
src-ui/         React chat client (shared with other sample agents)
index.html      Vite HTML entry
```

## Not used for

Not a published library. Not a scaffold. Not a framework. This file exists to be **read** by external developers building their own ADK-driven ggui agents — the patterns here transfer directly to any MCP-host code path on top of `@google/adk`.
