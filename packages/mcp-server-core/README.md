# @ggui-ai/mcp-server-core

Core interfaces and reference storage adapters for the **ggui protocol** MCP server.

This package defines the narrow seams that an MCP server for ggui is built on —
`UiGenerator`, `GguiSessionStore`, `BlueprintProvider`, `AuthAdapter`, plus the
negotiator / embedding / vector / kv storage contracts — and ships reference
implementations of each.

Each seam is a small interface so storage backends and hosting environments can be
swapped independently. [`@ggui-ai/mcp-server`](https://www.npmjs.com/package/@ggui-ai/mcp-server)
binds these interfaces to its in-memory and SQLite defaults; production deployments
and community adapters (Postgres/pgvector, Redis, and so on) implement the same
seams against their own backends.

## Subpath exports

| Import                                    | Contents                                                     |
| ----------------------------------------- | ------------------------------------------------------------ |
| `@ggui-ai/mcp-server-core`                | The interface definitions and shared types.                  |
| `@ggui-ai/mcp-server-core/in-memory`      | Zero-config in-memory reference adapters.                    |
| `@ggui-ai/mcp-server-core/sqlite`         | SQLite-backed adapters (optional `better-sqlite3` peer).     |
| `@ggui-ai/mcp-server-core/plaintext`      | Plaintext storage helpers.                                   |
| `@ggui-ai/mcp-server-core/contract-tests` | Reusable contract-test suites for verifying custom adapters. |

The SQLite adapters require [`better-sqlite3`](https://www.npmjs.com/package/better-sqlite3)
— it is an **optional peer dependency**, so install it only if you use the `/sqlite`
subpath. Servers that never touch SQLite fall back to the in-memory store.

## License

Apache-2.0
