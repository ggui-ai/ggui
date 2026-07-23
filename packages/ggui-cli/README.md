# @ggui-ai/cli

> Open `ggui` CLI — the local dev + serve + authoring binary for the `ggui` protocol. OSS and self-hosted workflows end-to-end. **No account required.**

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

Run the OSS self-hosted personal-mode server: MCP at `/mcp`, render viewer at `/s/<shortCode>`, pairing endpoints, and a live-channel WebSocket. Supervises the agent declared in `ggui.json#agent.entry`.

```bash
ggui serve                          # default: http://127.0.0.1:6781
ggui serve --port 0                 # OS-assigned free port
ggui serve --host 0.0.0.0           # bind all interfaces
ggui serve --mcp-only               # skip agent supervision
```

**Scope today:**

- ✅ Local server, viewer, cookie-authenticated WebSocket subscribe/ack all work end-to-end.
- ✅ `ggui_render` mints shortCodes and lands on the same-origin viewer.
- ✅ Component-code generation is wired on the OSS path via `createUiGenerator()` from `@ggui-ai/ui-gen` — the same harness the hosted runtime uses. When no LLM credentials resolve (no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc.), `ggui_render` returns an `isError: true` tool result whose `structuredContent.error.code` is `NO_CREDENTIALS`, with a message naming which key to set; supply a key to get full generation locally.
- 🔒 Default auth is strict pairing — only pair-minted bearer tokens authenticate `/mcp` (pair via the landing page or `POST /pair`). `--dev-allow-all` (local dev / tunnel smoke) and `--public-demo` (rate-limited, operator-paid public demo) relax `/mcp` to any-bearer; `--multi-tenant` keeps strict auth with per-user provider-key scoping; `--oauth` mounts the OAuth 2.1 + DCR routes MCP custom-connector hosts (claude.ai, ChatGPT) need. Custom adapters via `createGguiServer({ auth })`.

### `ggui dev`

Start the local UI registry + compile-on-demand dev hub, optionally supervising a local agent runtime. Run `ggui --help` for the flag list (agent adapter, tunnel provider, browser auto-open).

#### Tunnel-provider plugins

`ggui dev` exposes the local stack through a `TunnelProvider` seam. Real providers (cloudflared bindings, ngrok, hosted tunnels) plug in without changing the CLI:

1. Set `GGUI_TUNNEL_PROVIDER=<module specifier>` (a package name or path resolvable from your project).
2. The module exports a `createTunnelProvider()` factory (preferred) or a default export returning a `TunnelProvider`.
3. Type the module against the published contract: `import type { TunnelProvider, TunnelProviderModule } from '@ggui-ai/cli/tunnel-provider'`.

When the variable is unset, or the module fails shape validation, the CLI falls back to the null provider (`status: 'unavailable'` with a reason) instead of crashing the dev loop.

### Everything else

| Command             | What it does                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ggui login`        | Sign into ggui.ai (device flow); tokens stored in `~/.ggui/auth.json`.                                                         |
| `ggui logout`       | Discard the local ggui.ai session.                                                                                             |
| `ggui whoami`       | Print the authenticated user.                                                                                                  |
| `ggui keys`         | Manage `ggui_user_*` connector keys (list / create / revoke).                                                                  |
| `ggui create`       | Create cloud resources tied to this project (`create app` writes `appId` into `ggui.json`).                                    |
| `ggui gadget`       | Author gadgets for the ggui marketplace (`gadget create <scope/name>` scaffolds a repo).                                       |
| `ggui blueprint`    | Author UI blueprints for the ggui marketplace (`blueprint create <scope/name>` scaffolds a repo).                              |
| `ggui theme`        | Validate + inspect operator-authored DTCG themes (`theme validate <path>`).                                                    |
| `ggui export-pool`  | Export this deployment's reusable blueprints as a shareable pool directory; load elsewhere via `ggui serve --seed-pool <dir>`. |
| `ggui push`         | Compile + bulk-push blueprints to a ggui.ai cloud app (requires `ggui login`).                                                 |
| `ggui deploy`       | Provision + wire a ggui.ai cloud app for this project (idempotent).                                                            |
| `ggui provider-key` | Manage provider API keys for a cloud ggui app (`provider-key set --app <appId>`).                                              |

Run `ggui --help` for per-command flags.

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

Optional blocks include `storage` (renders / vectors / threads via `memory` or `sqlite`), `primitives`, `theme`, `blueprints`, `generation`, and `mcpMounts`. See [`@ggui-ai/project-config`](../project-config) for the full schema.

## MCP config for your agent runtime

Point any MCP-compatible agent at the local endpoint `ggui serve` exposes:

```json
{
  "mcpServers": {
    "ggui": {
      "url": "http://127.0.0.1:6781/mcp",
      "headers": { "Authorization": "Bearer <paired-bearer>" }
    }
  }
}
```

Mint the bearer by pairing (landing page or `POST /pair`). Under `ggui serve --dev-allow-all`, any non-empty bearer (e.g. `dev`) authenticates.

## Links

- [Repo](https://github.com/ggui-ai/ggui) — source, examples, issue tracker
- [OSS Quickstart](https://github.com/ggui-ai/ggui#oss-quickstart--run-the-protocol-locally)
- [`@ggui-ai/mcp-server`](https://www.npmjs.com/package/@ggui-ai/mcp-server) — OSS MCP runtime library
- [`@ggui-ai/protocol`](https://www.npmjs.com/package/@ggui-ai/protocol) — wire-type contracts

## License

Apache 2.0
