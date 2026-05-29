# @ggui-ai/agent-server

> Brand-agnostic Hono-based HTTP backend for ggui-aware agents.

[![npm version](https://img.shields.io/npm/v/@ggui-ai/agent-server.svg)](https://www.npmjs.com/package/@ggui-ai/agent-server)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

This package owns everything a ggui-aware MCP-Apps host needs to expose an agent over HTTP — the wire shape, MCP discovery, tool-result resource inlining, directive synthesis for `_meta["ai.ggui/userAction"]`, server-allocated chat ids — so each per-SDK integration only has to implement a thin `AgentAdapter` (prompt + chatId in → normalized message stream out).

Pairs with [`@ggui-ai/react/chat-helpers`](https://www.npmjs.com/package/@ggui-ai/react) on the frontend.

## Install

```bash
npm install @ggui-ai/agent-server
```

## Usage

```ts
import { startAgentServer, type AgentAdapter } from "@ggui-ai/agent-server";

const adapter: AgentAdapter = {
  name: "my-sdk",
  async *run(input) {
    // input.prompt — string the LLM should see (directive already synthesized)
    // input.chatId — server-allocated stable id for this conversation
    // input.mcpServers — { name → { url, bearer } } map
    // input.abortSignal — fires on client disconnect
    // ... yield NormalizedMessage values (assistant text, tool_use, tool_result, result) ...
  },
};

await startAgentServer({
  port: 6790,
  sandboxProxyPort: 7790,
  mcpServers: { ggui: { url: "http://localhost:6781/mcp" } },
  adapter,
});
```

## What's inside

| Area                    | Exports                                                 |
| ----------------------- | ------------------------------------------------------- |
| Server bootstrap        | `startAgentServer`, `AgentServerOptions`                |
| Adapter contract        | `AgentAdapter`, `AgentInput`, `NormalizedMessage`       |
| MCP routing             | `McpServerConfig`, `discoverMcpTools`                   |
| Tool-result interceptor | `interceptToolResults` — inlines `_meta.ui.resourceUri` |
| Directive synthesis     | `synthesizeUserActionPrompt`                            |
| Chat snapshot           | `ChatStore`, `ChatStateSnapshot`                        |

## License

Apache-2.0
