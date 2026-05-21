# @ggui-ai/chat-self-hosted

Chat storage adapter for self-hosted [ggui](https://ggui.ai) servers.

Implements the `FullChatStorageAdapter` contract against the
`@ggui-ai/mcp-server` persistent-thread HTTP + SSE surface, so a host
can treat self-hosted and managed origins uniformly — one adapter per
origin.

## Install

```bash
npm install @ggui-ai/chat-self-hosted
```

## Usage

```ts
import { createSelfHostedGguiAdapter } from "@ggui-ai/chat-self-hosted";

const adapter = createSelfHostedGguiAdapter({
  baseUrl: "http://192.168.1.5:4567",
  pairingToken: "<pairing-bearer-token>",
});
```

The returned adapter is structurally assignable to the
`FullChatStorageAdapter` type from `@ggui-ai/react-native/chat-thread`.

Thread-level operations (`createSelfHostedThread`,
`getSelfHostedThread`, `listSelfHostedThreads`) are also exported for
hosts that manage a multi-thread chat experience.

> **Durability note:** the server's default in-memory thread store
> loses state on restart. Pair the server with a durable thread store
> for persistence. The adapter itself is correct either way — it is
> the store that is in-memory, not the contract.

## License

Apache-2.0
