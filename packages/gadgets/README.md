# @ggui-ai/gadgets

> Browser-capability gadget hooks for ggui. Declared on a `DataContract` via `clientCapabilities.gadgets[*]`, mounted by the UI generator's component code, surfaced to agents through the protocol's gadget-discovery tool.

## Why

LLM-generated component code needs a stable, narrow API for the small set of browser capabilities that interactive UIs reach for: geolocation, clipboard read/write, notifications, file pickers, microphone, camera. Each capability has the same lifecycle shape — idle → prompting → active → completed (or denied / error) — and the same permission-prompt UX. Encoding that shape once, in a typed React hook, keeps the generator's output:

- predictable across providers and prompts,
- testable by code-property assertions on the generated source (not just the rendered DOM),
- bounded by the v1 stdlib catalog the protocol's contract linter recognizes.

The contract declares WHICH hooks the component will mount; the hooks own how they behave at runtime.

## Installation

```bash
pnpm add @ggui-ai/gadgets
```

Peer-dep: `react` ^18 || ^19.

## v1 stdlib catalog

Seven hooks ship in v1, all with a shared `{ value, status, error?, start, stop? }` shape:

| Hook                | Permission        | Description                                                  |
| ------------------- | ----------------- | ------------------------------------------------------------ |
| `useGeolocation`    | `geolocation`     | Current position + watch updates.                            |
| `useClipboardWrite` | `clipboard-write` | Write text or rich payload to the user's clipboard.          |
| `useClipboardPaste` | `clipboard-read`  | Read the user's clipboard on explicit user gesture.          |
| `useNotifications`  | `notifications`   | Request permission + post a system notification.             |
| `useFilePicker`     | _none_            | Open the OS file picker (gated by user activation, no perm). |
| `useMicrophone`     | `microphone`      | Stream access to the user's microphone via `getUserMedia`.   |
| `useCamera`         | `camera`          | Stream access to the user's camera via `getUserMedia`.       |

The same list is exported from `@ggui-ai/protocol` as `STDLIB_GADGETS` and forms the structural floor of every app's `ggui_list_gadgets` catalog — operator-declared packages (`ggui.json#app.gadgets`) layer on top, winning on a package-name collision.

## How a contract uses these hooks

The agent declares the gadgets the component will mount on the contract's `clientCapabilities.gadgets` — a package-keyed map: the npm package name keys the outer map, the export name keys the inner map. The agent names which package + which exports; it does NOT pin a `version` (the operator's `App.gadgets` catalog owns the version). The permission a capability prompts for is NOT a contract field; it is declared by the operator on the registered descriptor's export (`GadgetExport.permission`), and the renderer reads it from there to derive a `Permissions-Policy` header:

```ts
import { defineContract } from "@ggui-ai/protocol";

export const photoCaptureContract = defineContract({
  propsSpec: {
    properties: {
      title: { schema: { type: "string" }, default: "Take a photo" },
    },
  },
  actionSpec: {
    capture: {
      label: "Capture",
      schema: { type: "object", properties: { dataUrl: { type: "string" } } },
    },
  },
  clientCapabilities: {
    // `gadgets` is package-keyed: `Record<package, Record<exportName,
    // { description?, usage? }>>`. The wire carries identity only —
    // `version`, transport fields, and per-export registry metadata
    // (`permission`, `example`, `gotchas`) are NOT on the wire; the
    // server resolves them from `App.gadgets` at render time.
    gadgets: {
      "@ggui-ai/gadgets": {
        useCamera: {
          usage: "Live camera preview + capture-to-data-URL on the capture action.",
        },
      },
    },
  },
} as const);
```

The generator reads `clientCapabilities.gadgets` and emits matching `import { useCamera } from '@ggui-ai/gadgets'` lines at the top of the generated component. Permission strings — read from the registered descriptor's per-export `permission` field — union-deduplicate into a `Permissions-Policy` header on the public-render route and an `allow=""` attribute on the MCP-Apps iframe host.

## Hook surface

Every hook returns a `{ status, ... }` object whose status is `'idle' | 'prompting' | 'active' | 'completed' | 'denied' | 'error'`. Specific value fields live alongside it. Example:

```tsx
import { useGeolocation } from "@ggui-ai/gadgets";

function NearbyStores() {
  const geo = useGeolocation();
  if (geo.status === "completed" || geo.status === "active") {
    return <List origin={geo.value} />;
  }
  if (geo.status === "denied") return <Disabled reason="Allow location to see nearby stores" />;
  return <Skeleton />;
}
```

See the per-hook source under `src/use*.ts` for the exact return shape and options surface.

## Authoring your own gadget package

To wrap a third-party browser library (Leaflet, Mapbox, Chart.js, …) as a
gadget package, use `defineGadgetPackage` — it takes the package identity
once plus a list of export declarations (hooks and/or components) and
returns a validated `GadgetDescriptor`:

```ts
import { defineGadgetPackage } from "@ggui-ai/gadgets";

export const chartDescriptor = defineGadgetPackage({
  package: "@my-org/gadget-chart",
  version: "0.1.0",
  exports: [
    { component: "Chart", impl: Chart, description: "…", usage: "…", example: {} },
    { hook: "useChartTheme", impl: useChartTheme, description: "…", usage: "…", example: {} },
  ],
});
```

For a single-hook package, `createGguiGadget` is the convenience builder.
Emit `descriptor.json` for registry consumption via `@ggui-ai/gadgets/codegen`.

## See also

- [`@ggui-ai/protocol`](https://github.com/ggui-ai/ggui/tree/main/packages/protocol) — `GadgetDescriptor`, `GadgetExport`, `ClientCapabilitiesSpec`, `STDLIB_GADGETS`, and the contract linter that validates contracts using these hooks.
