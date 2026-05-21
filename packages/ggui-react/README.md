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

Mount a ggui session with `<GguiApp>` — it wraps the provider and
renders a prebuilt shell:

```tsx
import { GguiApp } from "@ggui-ai/react";

export function App() {
  return <GguiApp appId="my-app" shell="chat" />;
}
```

The `shell` prop accepts a string shorthand (`"agent"`, `"chat"`,
`"fullscreen"`), a component reference, or a render function:

```tsx
import { GguiApp, ChatShell } from "@ggui-ai/react";

<GguiApp appId="my-app" shell={ChatShell} />;
```

## Lower-level building blocks

For full control, compose the pieces yourself:

```tsx
import { GguiProvider, GguiSession } from "@ggui-ai/react";

<GguiProvider appId="my-app">
  <GguiSession>{/* render session state */}</GguiSession>
</GguiProvider>;
```

The package also exports hooks (`useWebSocket`, `useInvoke`,
`useGenerate`, `useStackNavigation`), a client-side data-binding tools
system (`defineTool`, `useTool`, `useBindings`), and `<McpAppIframe>`
for hosting any MCP Apps-conformant session in an iframe.

## Entry points

| Import path                   | Contents                                |
| ----------------------------- | --------------------------------------- |
| `@ggui-ai/react`              | Components, hooks, tools, shells        |
| `@ggui-ai/react/query`        | TanStack Query integration              |
| `@ggui-ai/react/testing`      | Test helpers and mock tools             |
| `@ggui-ai/react/chat-helpers` | Message-grouping and stack-item helpers |
| `@ggui-ai/react/chat-thread`  | Thread-backed chat (`useChatThread`)    |

## License

Apache-2.0
