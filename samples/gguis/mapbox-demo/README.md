# Sample ggui — `mapbox-demo`

A ggui server pre-configured with a 3rd-party gadget (`@ggui-samples/gadget-mapbox`) AND an operator-stamped public env value. End-to-end demonstration of the public env channel:

- `ggui.json#app.gadgets` declares the Mapbox wrapper, including `requires: ["GGUI_PUBLIC_APP_MAPBOX_TOKEN"]`.
- `ggui.json#app.publicEnv` carries the operator's value for that key.
- The CLI seeds the app-metadata store with both.
- Push-time validation refuses to push a contract using `useMapbox` unless the key is present in `App.publicEnv`.
- The server projects the union of every declared wrapper's `requires` and inlines that subset into the session-meta slice (`_meta["ai.ggui/session"].publicEnv`).
- The iframe runtime installs the subset on `globalThis.__ggui__.publicEnv`.
- Inside the wrapper's hook body, `getPublicEnv('GGUI_PUBLIC_APP_MAPBOX_TOKEN')` reads the value at first render — never at module top (the runtime hasn't booted yet).

## Setting the token

The committed `ggui.json` carries the placeholder `"<set-me-before-running>"`. Before starting the server, replace it with a real Mapbox access token (or pass it through whatever your local config-injection workflow is).

Never commit a real token to this file. The placeholder string is intentionally chosen so the push gate's "missing key" error doesn't fire on misconfig (the key is present, just unusable) — and the Mapbox SDK will surface "Invalid token" on first request, which is the right error to surface.

## Running standalone

```bash
pnpm --filter @ggui-samples/ggui-mapbox-demo start
# → ggui serve on http://127.0.0.1:6784
# → MCP at /mcp; ggui_list_gadgets returns the Mapbox entry.
```

## What's NOT in here

- A hosted wrapper bundle — the end-to-end suite shims it via the workspace package import.
- Per-user env (e.g., per-user OAuth tokens). Only the App-scoped `GGUI_PUBLIC_APP_*` namespace is wired today; the `GGUI_PUBLIC_USER_*` namespace is reserved for a future per-user channel.
