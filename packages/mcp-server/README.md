# @ggui-ai/mcp-server

Self-hosted [MCP](https://modelcontextprotocol.io) server for the **ggui protocol** —
the interface layer that lets AI agents describe UIs in natural language and have
ggui generate ephemeral interfaces for them.

This package is the HTTP/MCP binding layer. It composes
[`@ggui-ai/mcp-server-handlers`](https://www.npmjs.com/package/@ggui-ai/mcp-server-handlers)
(the tool handler logic) with the reference adapters from
[`@ggui-ai/mcp-server-core`](https://www.npmjs.com/package/@ggui-ai/mcp-server-core)
(in-memory, SQLite, and filesystem storage) to produce a runnable server. No business
logic lives here — to change tool behavior, edit the handler package.

## Run it with the CLI

The simplest way to start a server is the `ggui` CLI:

```bash
npx ggui serve
```

`ggui serve` boots this package with the OSS defaults — in-memory session store
(or SQLite when `better-sqlite3` is installed), no-auth dev posture, and every UI
declared in `ggui.json` surfaced through the blueprint tools.

## Embed it directly

```ts
import { createGguiServer } from "@ggui-ai/mcp-server";

const server = createGguiServer();
await server.listen(4567);
```

`createGguiServer` accepts a `CreateGguiServerOptions` bundle to swap in your own
auth adapter, storage backends, blueprint provider, rate limiter, and more. Every
seam is an interface from `@ggui-ai/mcp-server-core`, so production deployments bind
their own implementations without forking this package.

## Scope

This package deliberately does **not** embed cloud-specific wiring (AWS, DynamoDB,
Redis), and it does not implement authoring, pairing, or UI generation — those are
separate packages and protocol flows.

## License

Apache-2.0
