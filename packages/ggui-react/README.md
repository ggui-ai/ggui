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

## Quick start

A ggui render is an MCP Apps-conformant UI. Mount one in your React
tree with `<GguiProvider>` + `<GguiRender>`:

```tsx
import { GguiProvider, GguiRender, RenderRenderer } from "@ggui-ai/react";

export function App({ renderId }: { renderId: string }) {
  return (
    <GguiProvider appId="my-app">
      <GguiRender renderId={renderId}>
        {(api) => api.render && <RenderRenderer render={api.render} />}
      </GguiRender>
    </GguiProvider>
  );
}
```

For a full agent chat loop (prompt → render → action → re-render), use
the `useMcpAppsChat` hook with `<AppRenderer>` — see the
[`ggui-basic-web`](../../samples/apps/ggui-basic-web) sample for a
complete example.

The package also exports hooks (`useWebSocket`, `useInvoke`,
`useGenerate`), a client-side data-binding tools
system (`defineTool`, `useTool`, `useBindings`), and `<McpAppIframe>`
for hosting any MCP Apps-conformant UI in an iframe.

## Entry points

| Import path                   | Contents                             |
| ----------------------------- | ------------------------------------ |
| `@ggui-ai/react`              | Components, hooks, tools             |
| `@ggui-ai/react/query`        | TanStack Query integration           |
| `@ggui-ai/react/testing`      | Test helpers and mock tools          |
| `@ggui-ai/react/chat-helpers` | Message-grouping and render helpers  |
| `@ggui-ai/react/chat-thread`  | Thread-backed chat (`useChatThread`) |

## License

Apache-2.0
