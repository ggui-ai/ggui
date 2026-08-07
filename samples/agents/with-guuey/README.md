# with-guuey — agent half of the composed golden path

**platform-composed (guuey-sdk)** — this sample composes the ggui protocol
through guuey's published dev tooling (`@guuey/cli` + `@guuey/worker`). It is
one way to run a ggui agent, not the way: the framework-native samples under
`../` (claude-agent-sdk, openai-agents-sdk, google-adk) remain first-class and
the ggui protocol does not require guuey.

A `guuey.json`-configured Claude agent with two MCP servers:

- `todo` — the colocated todo MCP (`../../mcp-servers/todo`), spawned by
  `guuey dev` with `PORT=6740`.
- `ggui` — **not declared**: `guuey dev` injects the ggui runtime MCP default
  (`http://localhost:6781/mcp`) whenever no `ggui` entry is declared.
  Declaring it manually is unnecessary; `ggui: false` is the only opt-out.

`guuey.worker.js` is the full-worker entry (`@guuey/worker`'s `serveNative`
running one Claude Agent SDK `query()` per invoke). Worker mode is required:
guuey's graceful `agent.entry` mode is google-adk-only under `guuey dev
--serve`, so a claude-agent-sdk project ships a worker file.

## Quickstart

This directory is standalone — it is deliberately **excluded from the repo's
pnpm workspaces** so its exact-pinned `@guuey/*` dependencies never share a
hoist with workspace HEAD. Install inside the directory:

```bash
cd oss/samples/agents/with-guuey
npm install
export ANTHROPIC_API_KEY=sk-ant-…
npm run dev        # guuey dev --serve → http://localhost:6790
```

The dev router serves `POST /agent/invoke` (SSE) and `GET /healthz` on port 6790. For the rendered-UI half, pair it with the web sample
(`../../apps/with-guuey-web`) and a ggui runtime MCP on port 6781
(`ggui serve --mcp-only`) — the composed samples-render lane boots all three.

Conformance check for the worker file (no key needed to launch the probe):

```bash
npm run verify     # guuey worker verify → fd-3 protocol probe
```

## Dev-server trust

> guuey dev runs your agent unjailed with your environment — standard
> dev-server trust; run it in a container if that posture doesn't fit.

The CLI forwards `process.env` wholesale to the agent worker. The composed
e2e cell therefore passes only `ANTHROPIC_API_KEY` (+ `PATH`/`HOME`) and
treats the throwaway container as the isolation boundary.

## Known limitation: fresh-thread sessions only

`guuey dev --serve` keeps sessions in memory and serves no
`GET /threads/:id/messages` history endpoint — every page load starts a fresh
thread. Reload-repaint/history hydration is a hosted-platform feature, not a
dev-server one.
