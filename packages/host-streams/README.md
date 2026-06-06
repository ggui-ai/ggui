# @ggui-ai/host-streams

Host-side stream mediator for [ggui](https://ggui.ai).

**Status**: early scaffold. The public interface (type-only exports
plus the `createHostStreamManager` factory) is stable, but the runtime
implementation is not yet wired — calling the manager's methods throws
until the runtime port lands.

## Why this package exists

The MCP Apps spec model is host-mediated: hosts own network surfaces,
iframes own UI. Today's ggui iframes open their own WebSocket to the
ggui server to receive `streamSpec` channel payloads — that works
inside first-party hosts but violates the spec posture and fails in
sandboxed Web Resource frames (claude.ai, Claude Desktop).

`@ggui-ai/host-streams` moves WS ownership to the host. The iframe
sends a single `ui/extensions/ggui/stream-subscribe` postMessage per
channel; the host decides WS-subscribe vs `tools/call` polling and
fans payloads back via `ui/extensions/ggui/stream-frame`.

```
Without host-streams (today):
  ggui server  ←WS─→  iframe ←postMessage→ host

With host-streams:
  ggui server  ←WS─→  host  ←postMessage→  iframe
                       │
                       └← falls back to tools/call polling per channel
```

## Public surface

```ts
import { createHostStreamManager } from "@ggui-ai/host-streams";

const streams = createHostStreamManager({
  ws: { url: "wss://ggui.example.com/ws", bearer: process.env.WS_BEARER },
  callMcpTool: (name, args) => myMcpClient.callTool(name, args),
  streamWebSocketLocalTools: () => serverCapabilities.streamWebSocketLocalTools,
});

// On every <McpAppIframe> mount:
const unbind = streams.bindIframe(iframeEl, {
  sessionId,
  appId,
});

// On unmount:
unbind();
```

## postMessage envelopes

All four envelopes are JSON-RPC notifications under the
`ui/extensions/ggui/*` namespace:

| Direction     | Method                                  | Purpose                         |
| ------------- | --------------------------------------- | ------------------------------- |
| iframe → host | `ui/extensions/ggui/stream-subscribe`   | Announce a channel subscription |
| iframe → host | `ui/extensions/ggui/stream-unsubscribe` | Drop a channel                  |
| host → iframe | `ui/extensions/ggui/stream-frame`       | One payload from WS or poll     |
| host → iframe | `ui/extensions/ggui/stream-error`       | Subscription failed             |

See `src/envelopes.ts` for the canonical type definitions + the
`isStreamExtensionEnvelope` / `isStreamFrameNotification` /
`isStreamSubscribeNotification` type guards.

## License

Apache-2.0.
