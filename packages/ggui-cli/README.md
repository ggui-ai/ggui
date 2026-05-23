# @ggui-ai/cli

> Open `ggui` CLI — the local dev + serve + pair + bench binary for the `ggui` protocol. OSS and self-hosted workflows end-to-end. **No account required.**

[![npm version](https://img.shields.io/npm/v/@ggui-ai/cli.svg)](https://www.npmjs.com/package/@ggui-ai/cli)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

This package ships the `ggui` binary. It's a thin shell over `@ggui-ai/dev-stack` (shared dev engine), `@ggui-ai/mcp-server` (OSS MCP runtime), and `@ggui-ai/agent-runtime` (agent-framework adapter seam).

`ggui` is the **protocol**. `Guuey` is the **hosted platform** built on top of it. The closed `guuey` binary (shipped as `@guuey/cli`) handles hosted-control-plane commands like `guuey login` / `guuey deploy`. This binary handles everything you need to run the protocol on your own machine.

## Install

```bash
npm install -g @ggui-ai/cli
# or, without global install:
npx @ggui-ai/cli --help
```

For a new project, install this package and start `ggui serve` with `--mcp-only` (no `ggui.json` required) to get a server you can pair against:

```bash
mkdir my-app && cd my-app
npm init -y
npm install @ggui-ai/cli
npx ggui serve --mcp-only       # boots http://127.0.0.1:6781
```

To declare a project (blueprints, primitives, theme, agent entry), drop a `ggui.json` at the project root — see the [samples](https://github.com/ggui-ai/ggui/tree/main/samples/gguis) for runnable shapes.

## Commands

### `ggui serve`

Run the OSS self-hosted personal-mode server: MCP at `/mcp`, session viewer at `/s/<shortCode>`, pairing endpoints, and a live-channel WebSocket. Supervises the agent declared in `ggui.json#agent.entry`.

```bash
ggui serve                          # default: http://127.0.0.1:6781
ggui serve --port 0                 # OS-assigned free port
ggui serve --host 0.0.0.0           # bind all interfaces
ggui serve --mcp-only               # skip agent supervision
```

**Scope today:**

- ✅ Local server, viewer, cookie-authenticated WebSocket subscribe/ack all work end-to-end.
- ✅ `ggui_push` mints shortCodes and lands on the same-origin viewer.
- ✅ Component-code generation is wired on the OSS path via `createUiGenerator()` from `@ggui-ai/ui-gen` — the same harness the hosted runtime uses. `ggui_push` returns `codeReady: false` only when no BYOK credentials resolve (no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc.); supply a key to get full generation locally.
- 🔒 Default auth is dev-mode (any bearer → `builder`). Swap in a real `AuthAdapter` via `createGguiServer({ auth })` before exposing beyond `127.0.0.1`.

### `ggui dev`

Start the local UI registry + compile-on-demand dev hub, optionally supervising a local agent runtime. See `ggui dev --help` for the full flag list (agent adapter, tunnel provider, browser auto-open).

## Configuration

`ggui.json` is the single source of truth. Minimum shape:

```json
{
  "schema": "1",
  "protocol": "<current PROTOCOL_VERSION>",
  "app": { "slug": "my-app", "name": "My App" },
  "agent": { "entry": "./agent.ts" }
}
```

Set `protocol` to the value of `PROTOCOL_VERSION` exported by `@ggui-ai/protocol` in the version you install (or omit the field — the CLI will fall back to the installed protocol version).

Optional blocks include `storage` (sessions / vectors / threads via `memory` or `sqlite`), `primitives`, `theme`, `adapters`, and `blueprints`. See [`@ggui-ai/project-config`](../project-config) for the full schema.

## MCP config for your agent runtime

Point any MCP-compatible agent at the local endpoint `ggui serve` exposes:

```json
{
  "mcpServers": {
    "ggui": {
      "url": "http://127.0.0.1:6781/mcp",
      "headers": { "Authorization": "Bearer dev" }
    }
  }
}
```

## Links

- [Repo](https://github.com/ggui-ai/ggui) — source, examples, issue tracker
- [OSS Quickstart](https://github.com/ggui-ai/ggui#oss-quickstart--run-the-protocol-locally)
- [`@ggui-ai/mcp-server`](https://www.npmjs.com/package/@ggui-ai/mcp-server) — OSS MCP runtime library
- [`@ggui-ai/protocol`](https://www.npmjs.com/package/@ggui-ai/protocol) — wire-type contracts

## License

Apache 2.0
