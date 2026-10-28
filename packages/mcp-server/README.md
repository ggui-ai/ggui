# @ggui-ai/mcp-server

Self-hosted [MCP](https://modelcontextprotocol.io) server for the **GGUI protocol** —
the interface layer that lets AI agents describe UIs in natural language and have
GGUI generate ephemeral interfaces for them.

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
(or SQLite when `better-sqlite3` is installed), strict pairing auth, and every UI
declared in `ggui.json` surfaced through the blueprint tools. Under strict pairing
only pair-minted bearers reach `/mcp`: pair with the code on the boot banner
(landing page or `POST /pair`), or pass `--dev-allow-all` to admit any bearer, or
none, during local development.

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

Without an `auth` option, `createGguiServer()` admits any bearer, or a request with
no `Authorization` header, as the single `builder` identity. That is a
local-development default: pass your own `AuthAdapter` before you expose the server
beyond `127.0.0.1`. (`ggui serve` passes a strict `InMemoryAuthAdapter` with pairing
on.)

## Scope

This package deliberately does **not** embed cloud-specific wiring (AWS, DynamoDB,
Redis). Tool logic, the session reference stores and the pairing service, and UI
generation live in separate packages. This package binds them to HTTP, and itself
implements the opt-in OAuth 2.1 authorization server (Dynamic Client Registration,
PKCE, consent), OAuth and email login, the pairing routes, and a few HTTP-side
stores (a filesystem code store, in-memory OAuth storage).

## TypeScript build

### `tsc` under `moduleResolution: NodeNext` reports errors inside `node_modules/@modelcontextprotocol/ext-apps`

Your own code is fine; the errors sit in a dependency's declarations. With `moduleResolution: "NodeNext"` (or `Node16`), `tsc` reports TS2834 and TS2339 inside `node_modules/@modelcontextprotocol/ext-apps/dist/src/app.d.ts`, and, before #847, TS2305 / TS2460 on `@ggui-ai/protocol`'s `host-context.d.ts` for the three names it then re-exported from there.

**Cause.** `@modelcontextprotocol/ext-apps` 1.7.5 ships extensionless relative specifiers in its own `.d.ts` files — a defect in the published package, tracked upstream at [modelcontextprotocol/ext-apps#704](https://github.com/modelcontextprotocol/ext-apps/issues/704). `@ggui-ai/mcp-server` and `@ggui-ai/iframe-runtime` depend on ext-apps, so the defect surfaces in a program that includes them (`@ggui-ai/protocol` alone no longer references ext-apps, #847). Every `@ggui-ai/*` declaration itself carries explicit `.js` extensions since 0.15.0.

**Scope.** The errors come from ext-apps' own declarations, which this package (and `@ggui-ai/iframe-runtime`) depends on. `@ggui-ai/protocol` alone does not: its declarations reference nothing from ext-apps, so a NodeNext consumer of the protocol package typechecks clean without the switch.

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
