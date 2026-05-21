# @ggui-ai/mcp-server-handlers

MCP tool handler logic for the **ggui protocol**.

This package implements the actual behavior behind every ggui MCP tool — session
lifecycle, the contract handshake, UI push, blueprint management, threads, app
discovery, and the operator (`ggui_ops_*`) tools. The handlers are written purely
over the seam interfaces in
[`@ggui-ai/mcp-server-core`](https://www.npmjs.com/package/@ggui-ai/mcp-server-core),
so they never import AWS, HTTP transports, or CLI concerns — the host supplies the
storage backends and transport.

[`@ggui-ai/mcp-server`](https://www.npmjs.com/package/@ggui-ai/mcp-server) runs
these handlers with in-memory adapters by default. Other hosts bind the same
handlers to their own context and storage.

## Audience routes

Every handler carries an `audience` tag (`agent`, `runtime`, `protocol`, or `ops`)
that determines which route it surfaces on and its wire-name prefix —
`ggui_*` / `ggui_runtime_*` / `ggui_protocol_*` / `ggui_ops_*`.

## Subpath exports

Handler families are also available behind subpath exports — for example
`@ggui-ai/mcp-server-handlers/blueprints`, `/session-mutations`, `/threads`,
`/credits`, `/app-discovery`, and the `/ops-*` families — so consumers can import
exactly the family they need.

## License

Apache-2.0
