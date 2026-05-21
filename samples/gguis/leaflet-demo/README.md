# Sample ggui — `leaflet-demo`

A ggui server pre-configured with a 3rd-party gadget (`@ggui-samples/gadget-leaflet`) registered on `app.gadgets`. Demonstrates the end-to-end gadget path:

- `ggui.json#app.gadgets` declares the Leaflet gadget package.
- The CLI seeds the app-metadata store with that catalog.
- Agents may declare the package-keyed ref `clientCapabilities.gadgets['@ggui-samples/gadget-leaflet'] = { LeafletMap: {} }` on contracts — `LeafletMap` is a component export.
- Push-time validation accepts those references.
- The boilerplate generator emits `import { LeafletMap } from '@ggui-samples/gadget-leaflet';` and the component renders it as JSX.
- The renderer route attaches a `Content-Security-Policy` header allowlisting the gadget bundle origins (script + style) and `tile.openstreetmap.org` (connect).

## Running standalone

```bash
pnpm --filter @ggui-samples/ggui-leaflet-demo start
# → ggui serve on http://127.0.0.1:6783
# → MCP at /mcp; ggui_list_gadgets returns the Leaflet entry.
```

## What's NOT in here

- A hosted wrapper bundle. Generated code direct-imports the in-tree `@ggui-samples/gadget-leaflet` workspace package instead. The end-to-end gadget-registry suite exercises the component-gadget gate against this server.
