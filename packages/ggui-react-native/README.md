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
- `@modelcontextprotocol/sdk`

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

To build a chat experience around those cards, drive the Streamable
Invoke Protocol with `useInvoke` and group the resulting turns with the
`chat-helpers` subpath.

The package also exports a React Native theme system (`ThemeProvider`,
`useTheme`, mirroring the web design tokens) and app-state hooks.

## Entry points

| Import path                          | Contents                 |
| ------------------------------------ | ------------------------ |
| `@ggui-ai/react-native`              | Components, hooks, theme |
| `@ggui-ai/react-native/chat-helpers` | Message-grouping helpers |

## License

Apache-2.0
