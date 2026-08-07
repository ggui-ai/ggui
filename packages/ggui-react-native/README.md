# @ggui-ai/react-native

React Native SDK for [ggui](https://ggui.ai) — the interface layer
between AI agents and humans. Agents describe UIs in natural language
over MCP; ggui generates ephemeral interfaces. This package lets you
embed those interfaces in a React Native or Expo app.

## Install

```bash
npm install @ggui-ai/react-native
```

Peer dependencies (install the ones your app uses):

- `react` (18 or 19) and `react-native` (>= 0.70)
- `react-native-webview` (>= 13) — used by `<McpAppIframe>`
- `@react-native-async-storage/async-storage` (2.x) — offline thread storage
- `@modelcontextprotocol/sdk`

Network-state awareness is injected, not bundled: the package never
imports `@react-native-community/netinfo`. If your app wants real
online/offline signals, wire netinfo yourself and pass them in via
`useChatThread({ isOnline })`.

## Quick start — mount an MCP-Apps card

`<McpAppIframe>` is the host primitive: the React Native analog of the
web's `<AppRenderer>` (from `@mcp-ui/client`). Give it the UI resource
from a tool result plus the render metadata carried on
`_meta["ai.ggui/render"]`, and it mounts the interface in a WebView,
speaking the standard MCP Apps host protocol (`ui/initialize`,
`ui/notifications/tool-result`, `tools/call`, `ui/open-link`,
`ui/resource-teardown`):

```tsx
import { McpAppIframe } from "@ggui-ai/react-native";

export function AgentCard({ toolResult }) {
  const resource = toolResult.content.find((c) => c.type === "resource")?.resource;
  const meta = toolResult._meta?.["ai.ggui/render"];
  if (!resource) return null;
  return <McpAppIframe resource={resource} meta={meta} />;
}
```

The component works for any MCP Apps-conformant UI, not only ggui
renders — it has zero ggui-specific coupling.

For a full chat experience around those cards, use the thread-backed
chat stack (`@ggui-ai/react-native/chat-thread`): `<ChatThreadProvider>`
with `useChatThread` and the chat shell, plus `useInvoke` driving the
Streamable Invoke Protocol.

The package also exports a React Native theme system (`ThemeProvider`,
`useTheme`, mirroring the web design tokens) and app-state hooks.

## Entry points

| Import path                          | Contents                             |
| ------------------------------------ | ------------------------------------ |
| `@ggui-ai/react-native`              | Components, hooks, theme             |
| `@ggui-ai/react-native/chat-helpers` | Message-grouping helpers             |
| `@ggui-ai/react-native/chat-thread`  | Thread-backed chat (`useChatThread`) |

## License

Apache-2.0
