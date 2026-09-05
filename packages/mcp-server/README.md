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

The simplest way to start a server is the `ggui` CLI shipped by `@ggui-ai/cli`:

```bash
npx @ggui-ai/cli serve
```

`ggui serve` boots this package with the OSS defaults — in-memory render store
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

## TypeScript build

### `tsc` under `moduleResolution: NodeNext` reports errors inside `node_modules/@modelcontextprotocol/ext-apps`

Your own code is fine; the errors sit in a dependency's declarations. With `moduleResolution: "NodeNext"` (or `Node16`), `tsc` reports TS2834 and TS2339 inside `node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts`, and TS2305 / TS2460 on `@ggui-ai/protocol`'s `host-context.d.ts` for the three names it re-exports from there (`McpUiDisplayMode`, `McpUiHostContext`, `McpUiHostCapabilities`).

**Cause.** `@modelcontextprotocol/ext-apps` 1.7.5 ships extensionless relative specifiers in its own `.d.ts` files — a defect in the published package, tracked upstream at [modelcontextprotocol/ext-apps#704](https://github.com/modelcontextprotocol/ext-apps/issues/704). `@ggui-ai/*` re-exports those names rather than forking a frozen spec surface, so the defect surfaces on our line. Every `@ggui-ai/*` declaration itself carries explicit `.js` extensions since 0.15.0.

**Fix.** Until ext-apps ships the upstream fix, set the TypeScript switch for third-party declaration defects in your `tsconfig.json`:

```json
{
  "compilerOptions": {
    "skipLibCheck": true
  }
}
```

`skipLibCheck` skips type-checking of `.d.ts` files only — your own sources still typecheck fully. The dependency bump follows the day the upstream fix is published; nothing in your code changes.

## License

Apache-2.0
