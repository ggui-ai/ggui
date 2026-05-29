---
description: Scaffold and author a ggui gadget — a client-side library wrapper
---

Help the developer author a **ggui gadget**.

## What a gadget is

A gadget wraps a **client-side browser library or capability** — a map
(Leaflet, Mapbox), a chart, the camera, the clipboard — as a stable React hook
or component that the LLM-generated UI can use. Without a gadget, the generator
only knows plain React; a gadget hands it a tested, bounded building block.

Reach for one when your UI needs a specific client-side library, or a browser
API the ggui stdlib doesn't already cover.

## Steps

### 1. Gather inputs

Ask the developer:
- **Scope** and **name** — e.g. `@acme` / `venue-map`.
- **What it wraps** — which library or browser capability.
- **Hook or component** — a hook (`useVenueMap`) for imperative APIs; a
  component (`<VenueMap>`) when the gadget owns its own container and lifecycle.

### 2. Scaffold

Create a `gadgets/` directory if absent, then scaffold inside it:

```
ggui gadget create @<scope>/<name>
```

(`ggui` is the `@ggui-ai/cli` binary; if not on `PATH`, use
`pnpm --filter ./servers/ggui exec ggui …`.)

### 3. Read what was generated

Open the scaffolded `ggui.gadget.json`, `src/index.ts(x)`, and `package.json`.

### 4. Implement the wrapper

Wrap the third-party library and register it with `createGguiGadget({ … })`.
A hook returns `{ status, value?, error?, start?, stop? }` where `status` is
`idle | prompting | active | completed | denied | error`. A component owns its
container, sizing, and the library's lifecycle.

### 5. Fill the manifest — write `exports[]` for the LLM

The `exports[]` entries in `ggui.gadget.json` are read by the **code
generator**, not by humans. Each export needs:
- `description` — one line on what it renders or does.
- `usage` — prose telling the LLM *exactly* when and how to use it.
- `example` — a concrete component snippet plus sample props.
- `gotchas` — anti-patterns and traps (e.g. "do NOT import the library
  directly; render the component").

Also set, as needed:
- `connect` — URL allowlist for any fetches / CSP (e.g. a tile server).
- `requires` — `GGUI_PUBLIC_APP_*` env vars the gadget needs (e.g. an API token).
- `peerDeps` — e.g. `{ "react": "^19" }`.

### 6. Validate, then publish

```
ggui gadget publish --dry-run                  # conformance gate, no upload
ggui gadget publish                            # build, sign, push to a registry
ggui gadget install @<scope>/<name>            # registers it in ggui.json
```

The Leaflet and Mapbox gadgets under `samples/gadgets/` in `ggui-ai/ggui` are
good references for the hook/component shape and a well-written manifest.
