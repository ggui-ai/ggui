# @ggui-ai/react

React SDK for [ggui](https://ggui.ai) — the interface layer between AI
agents and humans. Agents describe UIs in natural language over MCP;
ggui generates ephemeral interfaces. This package lets you embed those
interfaces in a React web app.

## Install

```bash
npm install @ggui-ai/react react react-dom
```

`react` and `react-dom` are peer dependencies (React 18 or 19).
`@modelcontextprotocol/sdk` is also a peer dependency.
`@tanstack/react-query` is an optional peer — install it only if you
use the `@ggui-ai/react/query` entry point.

To host a render's sandboxed iframe you also need `@mcp-ui/client`
(install it directly; ggui does not re-export it):

```bash
npm install @mcp-ui/client
```

## Quick start

An agent emits UI as MCP Apps-conformant renders. In a React app you
drive the conversation with the `useMcpAppsChat` hook and host each
render's sandboxed iframe with `<AppRenderer>`:

```tsx
import { AppRenderer } from "@mcp-ui/client";
import { useMcpAppsChat } from "@ggui-ai/react/chat-helpers";

function Chat({ agentUrl }: { agentUrl: string }) {
  const { entries, sessions, send, handleAppMessage } = useMcpAppsChat({
    chatEndpoint: `${agentUrl}/agent`,
    snapshotEndpoint: `${agentUrl}/agent`,
  });

  // - render `entries` as chat bubbles; call `send(prompt)` to talk to the agent
  // - mount the latest `sessions` entry with <AppRenderer> — it needs the
  //   sandbox-proxy origin + onReadResource / onCallTool relay + onMessage={handleAppMessage}
}
```

`<AppRenderer>`'s sandbox + resource-read + tool-call relay wiring is
non-trivial (it implements the MCP Apps host contract). The complete,
runnable reference — including auth — is the
[`ggui-basic-web`](../../samples/apps/ggui-basic-web) sample. **Start there.**

The package also exports hooks (`useWebSocket`, `useInvoke`) and a
client-side data-binding tools system (`defineTool`, `useTool`,
`useBindings`). It pairs with `<AppRenderer>` from `@mcp-ui/client`
for hosting an MCP Apps render in a sandboxed iframe — install that
package directly; ggui does not re-export it. (React Native's
equivalent host is `<McpAppIframe>` from `@ggui-ai/react-native`.)

## Entry points

| Import path                               | Contents                                      |
| ----------------------------------------- | --------------------------------------------- |
| `@ggui-ai/react`                          | Components, hooks, tools                      |
| `@ggui-ai/react/query`                    | TanStack Query integration                    |
| `@ggui-ai/react/testing`                  | Test helpers and mock tools                   |
| `@ggui-ai/react/chat-helpers`             | Message-grouping and render helpers           |
| `@ggui-ai/react/chat-thread`              | Thread-backed chat (`useChatThread`)          |
| `@ggui-ai/react/chat-thread/shells/chat`  | Thread-backed reference chat UI (`ChatShell`) |
| `@ggui-ai/react/chat-thread/shells/agent` | AgentShell types (component not yet shipped)  |

## License

Apache-2.0
