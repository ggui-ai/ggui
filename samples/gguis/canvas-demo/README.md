# Sample ggui — `canvas-demo`

`ggui serve` configured with `defaultMcpAppsMode: 'canvas'`.

When a host calls `ggui_new_session` against this sample, the MCP host receives `_meta.ui.resourceUri = "ui://ggui/session/<sessionId>"` and mints **one** session-scoped iframe. Subsequent `ggui_push` calls route state through the session WebSocket channel — they do NOT mint a new per-push iframe (`canvasOwnsRender`).

Contrast with `@ggui-samples/ggui-default`, where every `ggui_push` returns its own `ui://ggui/render/<shortCode>` and the host mounts a fresh iframe per push.

## What's in here

```
ggui.json          { app.defaultMcpAppsMode: 'canvas' }
package.json       declares `start` script that runs `ggui serve --port 6786`
```

## Running standalone

```bash
pnpm --filter @ggui-samples/ggui-canvas-demo start
```

Then call `ggui_new_session` against `http://localhost:6786/mcp` — the response carries `_meta.ui.resourceUri` pointing at the canvas iframe.

## Used by

The end-to-end suite uses this sample to verify canvas-mode behavior:
`_meta.ui.resourceUri` minting on `ggui_new_session`, and that subsequent
pushes route through the session channel rather than minting a new
per-push `ui://` resource.
