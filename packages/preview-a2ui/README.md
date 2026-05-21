# @ggui-ai/preview-a2ui

Narrow A2UI boundary for ggui's provisional UI assembly channel.

Everything A2UI-shaped in the ggui workspace lives here and **only** here.
The core protocol (`@ggui-ai/protocol`) stays vendor-neutral; it carries
only the reserved `_ggui:preview` channel rule — no A2UI types.

## What this package is

Types, validators, and a catalog manifest for the V1 subset of A2UI used
on the server-emitted `_ggui:preview` channel. Framework-neutral
(`zod`-only, no React / React Native). Consumed by the server preamble
that emits provisional A2UI messages and by the renderer packages that
paint them as shimmering, non-interactive shells before the final
generated UI arrives.

## V1 scope (deliberately narrow)

**Messages (server → client write path):**

- `createSurface`
- `updateComponents`
- `deleteSurface`

**Catalog (`ggui.preview.v1`, 12 components):**

`Row`, `Column`, `Card`, `List`, `Divider`, `Text`, `Image`, `Icon`,
`Button`, `TextField`, `CheckBox`, `ChoicePicker`.

**Pinned version:** A2UI `v0.9` subset.

## Explicitly out of scope

Do not add these without a deliberate design decision — not in bug
fixes, not in "small follow-ups," not in refactors:

- `updateDataModel` or any data-binding surface. Provisional UI is
  **non-interactive in V1**.
- Client → server messages (`action`, `error`). Same reason.
- Catalog components outside the 12 above (`Tabs`, `Modal`, `Video`,
  `AudioPlayer`, `Slider`, `DateTimeInput`, etc.). These come back when
  the renderer slice needs them, shipped together with their mapping
  code — not speculatively.
- Any dependency on `@ggui-ai/protocol`, `@ggui-ai/design`, React,
  or React Native. The boundary is that this package stands alone.

If you believe you need to expand any of the above, stop and open a
design discussion. Narrow surfaces are the point.

## Public surface

```ts
import {
  // catalog
  GGUI_PREVIEW_CATALOG_V1,
  GGUI_PREVIEW_CATALOG_V1_ID,
  GGUI_PREVIEW_CATALOG_V1_COMPONENTS,
  A2UI_V1_SUBSET_VERSION,
  isGguiPreviewComponentType,
  // components
  parseComponent,
  type Component,
  // messages
  parseServerMessage,
  type ServerMessage,
  isCreateSurfaceMessage,
  isUpdateComponentsMessage,
  isDeleteSurfaceMessage,
} from "@ggui-ai/preview-a2ui";
```

Both parsers return a discriminated result so callers don't have to
choose between throwing and introspecting Zod errors:

```ts
const result = parseServerMessage(input);
if (result.ok) {
  // result.value is typed ServerMessage
} else {
  // result.issues: [{path, message}, ...]
}
```

## License

Apache 2.0
