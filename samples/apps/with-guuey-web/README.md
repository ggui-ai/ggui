# with-guuey-web — web half of the composed golden path

**platform-composed (guuey-sdk)** — this sample composes the ggui protocol
through guuey's published SDKs (`@guuey/agent-client` against `@guuey/cli`'s
dev router). It is one way to drive a ggui agent from the browser, not the
way: the framework-native app under `../ggui-basic-web` (paired with the
`claude-agent-sdk` / `openai-agents-sdk` / `google-adk` backends) remains
first-class, and the ggui protocol does not require guuey.

A Vite SPA that:

- talks to `guuey dev --serve` (`POST /agent/invoke` SSE) via
  `useAgentInvoke` from `@guuey/agent-client/react` — the hook owns the SSE
  fold, the per-turn status lifecycle
  (`ready | connecting | thinking | using-tool | responding`), abort/reset,
  and the error surface;
- recognises generative-UI cards with `@guuey/mcp-apps-host`'s view-mount
  dispatcher (`toolResultViewMount` → inline mcp-ui resources first, ggui
  renders second, bare `ui://` locators last) and mounts them through the
  MCP-Apps **second-origin sandbox** path with `@mcp-ui/client`'s
  `<AppRenderer>` — the ggui card arrives as the package's self-contained
  shell (`gguiShellHtml` inlining the `_meta["ai.ggui/render"]` bootstrap)
  and boots ggui's iframe runtime with no host-side ggui code;
- rehydrates a persisted card after a page reload: the host keeps the
  render's durable `ui://` locator (plus its sandbox-CSP origins) in
  `localStorage` and resolves it with the package's generic reader
  (`createMcpUiResourceReader` over the same MCP client the guest
  `tools/call` relay holds) — one fresh `resources/read`, fresh mount
  material, never a replay of stored HTML.

## Before / after

This app replaces the 702-line hand-rolled chat loop in
`../ggui-basic-web/src/Chat.tsx` with `useAgentInvoke` + the view-mount
dispatcher: the SSE parsing, per-turn status machine, and transcript fold
live in `@guuey/agent-client`; resource narrowing, generative-UI
recognition, and locator rehydration live in `@guuey/mcp-apps-host`; and
what remains here is rendering — an `App.tsx` that is mostly JSX and
comments.

## Quickstart

Boot the agent half first (`../../agents/with-guuey` — `guuey dev --serve`
on **6790**, plus a ggui runtime MCP on **6781** via `ggui serve
--mcp-only`; see that README), then:

```bash
cd oss/samples/apps/with-guuey-web
npm install
npm run dev        # http://127.0.0.1:6890
```

This directory is standalone — deliberately **excluded from the repo's pnpm
workspaces** so its exact-pinned `@guuey/*` dependencies never share a hoist
with workspace HEAD. Install inside the directory with npm.

Ports and environment:

| Variable              | Default                              | Meaning                                        |
| --------------------- | ------------------------------------ | ---------------------------------------------- |
| `VITE_GUUEY_ENDPOINT` | `http://localhost:6790`              | guuey dev router base URL                      |
| `VITE_GUUEY_APP_ID`   | `ggui-golden-path`                   | app id (matches the agent half's `guuey.json`) |
| `VITE_SERVER_PORT`    | `6890` (then `PORT`)                 | this SPA's dev/preview port                    |
| `SANDBOX_PROXY_PORT`  | `7890`                               | self-booted second-origin sandbox page port    |
| `VITE_SANDBOX_URL`    | `http://127.0.0.1:7890/sandbox.html` | set to use an externally-hosted sandbox page   |

The sandbox host page is a hard requirement of the MCP Apps double-iframe
rule (`<AppRenderer>` mounts untrusted card HTML only via a page on a
DIFFERENT origin). The framework-native backends boot one for their web
app; guuey's dev router doesn't, so `vite.config.ts` boots the same
spec-canonical proxy itself (`@ggui-ai/agent-server`'s
`startSandboxProxyServer`, loopback-only). For ggui cards the sandbox
page's CSP is derived per-card from the render bootstrap — the runtime
bundle origin and the live-channel (WebSocket) origin the wire announced,
nothing hardcoded.

## Known limitation: fresh transcripts, rehydrated cards

`guuey dev --serve` (0.3.0) keeps sessions in memory and now serves a
`GET /threads/:id/messages` history read (text rows only), but its
`session` frame still carries no `threadId` — and the agent-client hook
speaks the `threadId` dialect — so this app never learns which dev session
is "its" thread and every page load starts a fresh conversation. (The dev
router keys its in-memory context by a `sessionId` field the agent-client
wire does not send, so under the dev router each turn reaches the agent
without prior chat context; durable state belongs in your MCP servers —
the todo list lives in the todo MCP and survives both turns and reloads.)

The **card** is the exception: a ggui render's `ui://` locator is its
durable identity, and this host persists that locator itself (see the
`CardMemento` note in `src/App.tsx`). After a reload the panel re-fetches
fresh mount material via `resources/read` and the card comes back live
with the render's current server-side state — while the text transcript,
honestly, starts empty.

## Dev-server trust

> guuey dev runs your agent unjailed with your environment — standard
> dev-server trust; run it in a container if that posture doesn't fit.

See the agent half's README for the full note; the composed e2e cell treats
its throwaway container as the isolation boundary.
