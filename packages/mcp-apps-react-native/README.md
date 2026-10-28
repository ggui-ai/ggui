# @ggui-ai/mcp-apps-react-native

MCP Apps host helper for React Native, from [GGUI](https://ggui.ai) — the interface layer
between AI agents and humans. Agents describe UIs in natural language
over MCP; GGUI generates ephemeral interfaces. This package lets you
embed those interfaces in a React Native or Expo app.

## Install

```bash
npm install @ggui-ai/mcp-apps-react-native
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
import { McpAppIframe } from "@ggui-ai/mcp-apps-react-native";

export function AgentCard({ toolResult }) {
  const resource = toolResult.content.find((c) => c.type === "resource")?.resource;
  const meta = toolResult._meta?.["ai.ggui/render"];
  if (!resource) return null;
  return <McpAppIframe resource={resource} meta={meta} />;
}
```

The component works for any MCP Apps-conformant UI, not only GGUI
renders — it has zero GGUI-specific coupling.

To build a chat experience around those cards, drive the Streamable
Invoke Protocol with `useInvoke` and group the resulting turns with the
`chat-helpers` subpath.

The package also exports a React Native theme system (`ThemeProvider`,
`useTheme`, mirroring the web design tokens) and app-state hooks.

## Entry points

| Import path                                   | Contents                 |
| --------------------------------------------- | ------------------------ |
| `@ggui-ai/mcp-apps-react-native`              | Components, hooks, theme |
| `@ggui-ai/mcp-apps-react-native/chat-helpers` | Message-grouping helpers |

## Trust boundary — who may speak to the host

The host (`<McpAppIframe>`) accepts bridge traffic only from the shim it
injected into the WebView's main frame. Every envelope the shim forwards is
stamped with a nonce the host minted for that mount; `onMessage` dispatches an
envelope only when the nonce matches, and drops everything else silently. The
nonce lives in the shim's closure, never on `window`, and the shim runs in the
main frame only.

The boundary is the card's **origin**, which gives two doors with one check
each:

- A **same-origin child** the card's own code creates (`srcdoc`, `about:blank`)
  calls `parent.postMessage` and reaches the shim's override, which stamps the
  envelope — by design, that child is the card.
- A **cross-origin child** cannot reach the shim: its `parent.postMessage` is
  the browser's native method, so it lands as a DOM `MessageEvent` whose
  `source` is the child, which the view-side listeners drop; anything that
  reaches the host by another route arrives without the nonce and is dropped.

A host composing its own receiver around `buildInjectedBridgeScript` mints a
nonce the same way (`{ nonce }` is required) and checks it in its own
`onMessage`. The served card is not a party: card code still calls plain
`postMessage`, so a card from any server version is unaffected.

## License

Apache-2.0
