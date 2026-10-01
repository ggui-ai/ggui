# @ggui-ai/live-channel

Transport-negotiated channel registry for [GGUI](https://ggui.ai) clients.

A framework-agnostic library — no React, no iframe assumptions. It
separates three concerns that are easy to tangle together in a client:

- **Transport** — how frames physically reach the client (WebSocket vs
  HTTP polling). Decided once at `bind()` time from what the render
  bootstrap declares; a WebSocket failure can transparently fail over
  to polling at runtime.
- **Channel** — a logical stream of typed payloads. Each channel knows
  its WebSocket frame discriminator and, optionally, a polling-fallback
  descriptor (URL + interval + parser).
- **Handler** — what to do with a payload. The library carries no
  business logic; handlers close over consumer state.

## Install

```bash
pnpm add @ggui-ai/live-channel
```

## Usage

```ts
import { ChannelRegistry } from "@ggui-ai/live-channel";

// The library stays protocol-version-agnostic: the consumer supplies
// the exact subscribe frame its server expects. The factory is called
// on every WebSocket open (initial connect AND each reconnect), so
// reconnect-resume semantics live in this closure.
const registry = new ChannelRegistry({
  subscribeFrameBuilder: () => ({
    type: "subscribe",
    payload: { sessionId, appId, wsToken },
  }),
  // Optional: tell the WebSocket transport what your server's frames mean
  // for its retry budget. "accepted" (your subscribe acknowledgement)
  // resets the budget; "refused-terminal" (a refusal no retry of the same
  // subscribe can fix, such as an expired credential) fails the transport
  // at once so the registry moves to its next transport. Without it, the
  // budget resets whenever a socket opens, so a server that opens and then
  // refuses every subscribe is retried indefinitely.
  classifyFrame: (frame) =>
    frame.type === "ack" ? "accepted" : isAuthRefusal(frame) ? "refused-terminal" : undefined,
});
registry.register(propsUpdateHandler);
registry.register(drainAckHandler);
registry.register(channelPayloadHandler);

// Transport is chosen here: WebSocket when the bootstrap declares a
// `wsUrl` + `wsToken`, otherwise HTTP polling. A hard WebSocket failure
// swaps in the polling transport transparently.
const handle = await registry.bind({ bootstrap, logger });

// Later — when the iframe re-mounts or unloads:
await handle.dispose();
```

`WSTransport` and `PollingTransport` are also exported directly for
callers that want to drive a single channel without the registry.

## License

Apache-2.0
