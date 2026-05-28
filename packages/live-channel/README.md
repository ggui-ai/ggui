# @ggui-ai/live-channel

Transport-negotiated channel registry for [ggui](https://ggui.ai) clients.

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

const registry = new ChannelRegistry();
registry.register(propsUpdateHandler);
registry.register(drainAckHandler);
registry.register(channelPayloadHandler);

// Transport is chosen here: WebSocket when the bootstrap declares a
// `wsUrl` + `token`, otherwise HTTP polling. A hard WebSocket failure
// swaps in the polling transport transparently.
const handle = await registry.bind({ bootstrap, logger });

// Later — when the iframe re-mounts or unloads:
await handle.dispose();
```

`WSTransport` and `PollingTransport` are also exported directly for
callers that want to drive a single channel without the registry.

## License

Apache-2.0
