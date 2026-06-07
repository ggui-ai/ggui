# Sample ggui — `canvas-demo`

`ggui serve` configured with `defaultDisplayMode: 'fullscreen'`.

Every `ggui_render` from this app carries `_meta.ui.displayMode: 'fullscreen'`
as a host hint, in addition to its per-render `_meta.ui.resourceUri`. The
hint tells hosts to render the iframe as a main view (replacing the
previous one in the primary slot) rather than stacking it inline in
the chat log. The wire mechanism is identical to inline mode — every
GguiSession stamps its own resource URI and every iframe goes through the
same runtime mount path; the only difference is how the host arranges
the iframes it mounts.

## What's in here

```
ggui.json          { app.defaultDisplayMode: 'fullscreen' }
package.json       declares `start` script that runs `ggui serve --port 6786`
```

## Running standalone

```bash
pnpm --filter @ggui-samples/ggui-canvas-demo start
```

Then call `ggui_handshake` against `http://localhost:6786/mcp` and
follow up with `ggui_render` — each render response carries
`_meta.ui.resourceUri` plus `_meta.ui.displayMode: 'fullscreen'`.

## Used by

The end-to-end suite uses this sample to verify that the fullscreen
hint propagates through the render pipeline unchanged regardless of how
many GguiSessions a conversation emits.
