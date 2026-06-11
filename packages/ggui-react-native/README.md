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
- `react-native-webview` (>= 13) — used by the WebView renderer
- `@react-native-async-storage/async-storage` (2.x) — offline thread storage
- `@modelcontextprotocol/sdk`

Network-state awareness is injected, not bundled: the package never
imports `@react-native-community/netinfo`. If your app wants real
online/offline signals, wire netinfo yourself and pass them in via
`useChatThread({ isOnline })` (or `WebSocketManager`'s
`netInfoSubscribe` option).

## Quick start

Wrap your app in `<GguiProvider>` and mount a `<GguiRender>`:

```tsx
import { GguiProvider, GguiRender } from "@ggui-ai/react-native";

export function App() {
  return (
    <GguiProvider appId="my-app">
      <GguiRender sessionId="session-123">{/* render state */}</GguiRender>
    </GguiProvider>
  );
}
```

The package also exports a React Native theme system (`ThemeProvider`,
`useTheme`, mirroring the web design tokens), hooks (`useWebSocket`,
`useInvoke`, `useAppState`), and `<McpAppIframe>` for hosting any
MCP Apps-conformant UI.

## Entry points

| Import path                          | Contents                             |
| ------------------------------------ | ------------------------------------ |
| `@ggui-ai/react-native`              | Components, hooks, theme             |
| `@ggui-ai/react-native/chat-helpers` | Message-grouping helpers             |
| `@ggui-ai/react-native/chat-thread`  | Thread-backed chat (`useChatThread`) |

## License

Apache-2.0
