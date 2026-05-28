<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg" />
    <img src=".github/logo-light.svg" alt="ggui — generative graphical user interface" width="480" />
  </picture>
</p>

<p align="center"><strong>ggui</strong> is the universal MCP-UI protocol — a runtime-negotiated data contract between AI agents and human users.</p>

<p align="center">
  <a href="https://docs.ggui.ai">Docs</a> ·
  <a href="https://github.com/ggui-ai/agentic-app-templates">Template repos</a> ·
  <a href="https://github.com/ggui-ai/ggui/releases">Releases</a>
</p>

> 🚧 **Active development — iterating on `v0.1.0` release candidates.** APIs are converging; pin exact versions (see badges below) and watch [Releases](https://github.com/ggui-ai/ggui/releases) for the next RC and the v0.1.0 final.

---

Agents describe what they need in natural language; ggui generates ephemeral, interactive interfaces over MCP. No frontend code, no React templates, no custom components — agents talk, users see UI.

This repo is the **open protocol + reference runtime**. Self-host with `ggui serve`; pair against any MCP-aware agent runtime (Claude Desktop, Claude Code, claude.ai, Cursor, ChatGPT desktop, Goose, your own). Zero account required, zero managed infrastructure required, zero cloud dependency.

---

## Quick start — pick your path

### 1. Build an agentic app from a template _(recommended for new apps)_

The fastest path if you want to **ship an agent end-to-end**. Each template scaffolds a chat UI + agent loop + sample MCP servers in one repo, pinned to one agent SDK.

```bash
npx @ggui-ai/create-agentic-app --agent claude-agent-sdk my-app
# or:  --agent openai-agents-sdk
# or:  --agent google-adk
cd my-app
cp .env.example .env.local   # add your LLM API key
pnpm dev:ggui                # terminal 1 — ggui MCP server
pnpm dev:todo                # terminal 2 — todo MCP server
pnpm dev:agent               # terminal 3 — agent + chat UI
```

Open `http://localhost:6790` (claude) / `6791` (openai) / `6792` (google) to chat.

The full loop runs locally: you type → the agent calls domain tools and renders a React UI → you click in that UI → the agent reacts. Browse the templates at [github.com/ggui-ai/agentic-app-templates](https://github.com/ggui-ai/agentic-app-templates) — each subdir is a complete project with its own README + CLAUDE.md walking through customisation (system prompt, domain MCP, blueprints, gadgets).

### 2. Self-host the OSS MCP server + test from claude.ai

For **testing the ggui protocol against a real chat host**. Localhost won't work from claude.ai — you need a public HTTPS URL, which [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) provides for free.

```bash
# terminal 1 — boot the OSS MCP server
npm install -g @ggui-ai/cli
ANTHROPIC_API_KEY=sk-… ggui serve --mcp-only       # http://127.0.0.1:6781/mcp

# terminal 2 — expose it to the public internet (no Cloudflare account needed)
cloudflared tunnel --url http://127.0.0.1:6781     # prints https://<random>.trycloudflare.com
```

Then in **claude.ai → Settings → Connectors → Add custom connector**, paste `https://<random>.trycloudflare.com/mcp`. Ask Claude to render any UI; the server generates the component and serves it back as a rich rendered card inside the chat.

Install cloudflared via your package manager: `brew install cloudflared` (macOS), `apt install cloudflared` (Debian), or grab a binary from [cloudflare.com/products/tunnel](https://www.cloudflare.com/products/tunnel/).

### 3. Use the hosted ggui.ai cloud — `mcp.ggui.ai` _(deploying soon)_

For **production**, sign up at [ggui.ai](https://ggui.ai) → create an app → get a managed MCP URL (form: `https://mcp.ggui.ai/<app-id>/mcp`). Paste into your chat host's connector settings — no self-hosting, no tunnel, no key management.

🚧 _The hosted endpoint is deploying — coming in a follow-up rc. Use path 1 or 2 in the meantime._

---

## The `ggui` CLI

`@ggui-ai/cli` ships the `ggui` binary — the single entrypoint for every OSS workflow. Five verbs cover the full lifecycle:

| Verb             | What it does                                                                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ggui serve`     | Boot the OSS MCP server (`/mcp`), session viewer (`/r/<shortCode>`), pairing endpoints, and live-channel WebSocket. `--mcp-only` skips agent supervision — fastest first-run. `--port`, `--host` adjust binding. |
| `ggui dev`       | Local UI registry + compile-on-demand dev hub for iterating on a `ggui.json` project. Optional tunnel, agent supervision, browser auto-open. Run `ggui dev --help` for the full flag list.                       |
| `ggui blueprint` | Author + publish + install cached UI templates — `create`, `publish`, `install`. Blueprints make a known screen cheap, fast, and visually consistent by matching before falling back to full LLM generation.     |
| `ggui gadget`    | Author + publish + install client-side libraries (maps, charts, camera, clipboard, anything) wrapped as ggui hooks/components so the generator can use them — `create`, `publish`, `install`.                    |
| `ggui theme`     | Validate and inspect `ggui.json#theme` DTCG documents — `ggui theme validate <path>`. Catches schema errors before they reach the runtime.                                                                       |

Plus auth verbs for the hosted path: `ggui login` / `ggui logout` / `ggui whoami` / `ggui keys`. Run `ggui --help` for the top-level overview, or `ggui <verb> --help` for per-command flags.

Full CLI reference: [`@ggui-ai/cli` README](./packages/ggui-cli/README.md).

---

## Runnable examples

[`samples/`](https://github.com/ggui-ai/ggui/tree/main/samples) holds end-to-end examples you can clone:

- [`samples/gguis/`](https://github.com/ggui-ai/ggui/tree/main/samples/gguis) — ready-to-run project configs (`default`, `leaflet-demo`, `mapbox-demo`, `canvas-demo`) showing how a `ggui.json` is shaped.
- [`samples/agents/`](https://github.com/ggui-ai/ggui/tree/main/samples/agents) — reference agents per SDK (Claude Agent SDK, OpenAI Agents SDK, Google ADK) talking to ggui as an MCP server. These same samples are what the template repo's `/bootstrap` fetches.
- [`samples/gadgets/`](https://github.com/ggui-ai/ggui/tree/main/samples/gadgets) — example component / hook gadgets for the marketplace.
- [`samples/mcp-servers/`](https://github.com/ggui-ai/ggui/tree/main/samples/mcp-servers) — minimal domain MCP servers (e.g. a todo server) you can pair against.

### Honest scope today

- ✅ Local server, viewer, cookie-authenticated WebSocket subscribe → ack all work end-to-end.
- ✅ `ggui_render` mints shortCodes and lands on the same-origin viewer.
- ✅ Component-code generation is wired on the OSS path via `createUiGenerator()` from `@ggui-ai/ui-gen` (the same harness the hosted runtime uses). `ggui_render` returns `codeReady: false` only when no BYOK credentials resolve (no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc.); supply a key to get full generation locally.
- 🔒 Default auth is dev-mode (any non-empty bearer → `builder`). Swap in a real `AuthAdapter` via `createGguiServer({ auth })` before exposing beyond `127.0.0.1`.

## How it works

```
┌─────────┐     MCP Tools      ┌──────────┐     WebSocket     ┌──────────┐
│  Your   │ ────────────────→  │  ggui    │ ────────────────→ │  User's  │
│  Agent  │   ggui_render      │  server  │   real-time UI    │  browser │
│         │   ggui_update      │          │   updates         │          │
│         │ ←────────────────  │          │ ←──────────────── │          │
│         │   user events      │          │   clicks, forms   │          │
└─────────┘                    └──────────┘                   └──────────┘
```

Your agent uses MCP tools to push UIs and receive user events. The protocol is defined by `@ggui-ai/protocol`; the reference server lives in `@ggui-ai/mcp-server`; embedding primitives ship in `@ggui-ai/react`.

### MCP tools (primary surface)

| Tool             | Description                                               |
| ---------------- | --------------------------------------------------------- |
| `ggui_render`    | Render a UI for the user (natural-language prompt + data) |
| `ggui_update`    | Update props on an existing UI (no regeneration, ~200ms)  |
| `ggui_handshake` | Initial session bootstrap                                 |
| `ggui_consume`   | Long-poll for user gestures (clicks, form submits)        |

Plus a blueprint family (`ggui_search_blueprints`, `ggui_render_blueprint`, `ggui_list_featured_blueprints`, …) for catalogue lookups. Full reference: [MCP Protocol Reference](https://docs.ggui.ai/api/mcp-protocol/).

### Zero agent code (MCP config only)

If your agent runtime supports MCP natively, skip the SDK entirely. Add `ggui serve` as an MCP server:

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

The runtime's native tool-calling loop discovers `ggui_render`, `ggui_update`, `ggui_consume`, and the blueprint catalogue tools directly. Working examples per framework: [Claude](https://docs.ggui.ai/examples/claude-agent/), [OpenAI](https://docs.ggui.ai/examples/openai-agent/), [Gemini](https://docs.ggui.ai/examples/gemini-agent/), [generic MCP](https://docs.ggui.ai/examples/generic-mcp/).

## Embedding UIs

`<McpAppIframe>` is the canonical consumer primitive. It takes an MCP Apps resource and mounts the ggui render inside a same-origin iframe. The iframe owns the WebSocket lifecycle, renderer bundle, and render mount — host code does not touch `Render` / WebSocket / renderer internals.

```tsx
import { McpAppIframe, type ProtocolError } from "@ggui-ai/react";
import { useEffect, useState } from "react";

function App({ renderId }: { renderId: string }) {
  const [resource, setResource] = useState<{ uri: string; mimeType: string; text: string } | null>(
    null
  );

  useEffect(() => {
    // Fetch the render-resource envelope from your MCP host. On the
    // OSS path the renderer route at /r/<shortCode> embeds the
    // bootstrap inline, so a resource with just `{ uri }` is enough.
    fetchRenderResource(renderId).then((r) => setResource(r.contents[0]));
  }, [renderId]);

  if (!resource) return <p>Loading…</p>;

  return <McpAppIframe resource={resource} onError={(err: ProtocolError) => console.error(err)} />;
}
```

Implementer references for the full protocol: [Architecture overview](https://docs.ggui.ai/architecture/overview/), [MCP Apps support](https://docs.ggui.ai/api/mcp-apps/), [WebSocket protocol](https://docs.ggui.ai/api/websocket-protocol/).

For non-React frameworks, embed the viewer directly:

```html
<iframe src="http://127.0.0.1:6781/r/{shortCode}" width="100%" height="600"></iframe>
```

## Packages

Consumer-facing surface — what you `npm install`:

| Package                                                 | Purpose                                                            | npm                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [`@ggui-ai/cli`](./packages/ggui-cli)                   | The `ggui` binary — `serve`, `dev`, `blueprint`, `gadget`, `theme` | [![npm](https://img.shields.io/npm/v/@ggui-ai/cli)](https://npmjs.com/package/@ggui-ai/cli)                   |
| [`@ggui-ai/mcp-server`](./packages/mcp-server)          | Reference OSS server (programmatic embedding)                      | [![npm](https://img.shields.io/npm/v/@ggui-ai/mcp-server)](https://npmjs.com/package/@ggui-ai/mcp-server)     |
| [`@ggui-ai/react`](./packages/ggui-react)               | React embedding — `<McpAppIframe>` + shells                        | [![npm](https://img.shields.io/npm/v/@ggui-ai/react)](https://npmjs.com/package/@ggui-ai/react)               |
| [`@ggui-ai/react-native`](./packages/ggui-react-native) | React Native embedding — WebView-backed renderer                   | [![npm](https://img.shields.io/npm/v/@ggui-ai/react-native)](https://npmjs.com/package/@ggui-ai/react-native) |
| [`@ggui-ai/protocol`](./packages/protocol)              | Wire types (events, sessions, WebSocket, MCP envelopes)            | [![npm](https://img.shields.io/npm/v/@ggui-ai/protocol)](https://npmjs.com/package/@ggui-ai/protocol)         |
| [`@ggui-ai/gadgets`](./packages/gadgets)                | Author wrappers for 3rd-party libs (Leaflet, Mapbox, …)            | [![npm](https://img.shields.io/npm/v/@ggui-ai/gadgets)](https://npmjs.com/package/@ggui-ai/gadgets)           |

Plus ~30 supporting packages under [`packages/`](./packages) spanning the runtime (`@ggui-ai/mcp-server-core`, `@ggui-ai/mcp-server-handlers`, `@ggui-ai/ui-gen`, `@ggui-ai/negotiator`), authoring (`@ggui-ai/project-config`, `@ggui-ai/ui-registry`, `@ggui-ai/predefined`), registry (`@ggui-ai/registry-core`, `@ggui-ai/registry-server`), and dev tooling (`@ggui-ai/dev-stack`, `@ggui-ai/agent-runtime`, `@ggui-ai/console`). See each subdirectory for details.

## Hosted providers

Self-hosting is the primary path. For managed infrastructure (no server to run, no LLM key to wire, hosted dashboards), the first-party hosted endpoint at **`mcp.ggui.ai`** is deploying — see [path 3](#3-use-the-hosted-gguiai-cloud--mcpgguiai-deploying-soon) above. [Guuey](https://guuey.com) hosts an upgraded experience built on top of the protocol. The protocol is identical on all paths — you can move between self-hosted and hosted without rewriting anything against this SDK.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Issues + PRs welcome.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
