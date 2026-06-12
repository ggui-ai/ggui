# Custom themes

Three paths, picked by who you are and how permanent the customisation is.

| You are…                               | Use this path                           | Persistence      |
| -------------------------------------- | --------------------------------------- | ---------------- |
| Tweaking one or two tokens of a preset | `/theme` picker → DTCG override editor  | `ggui.json` JSON |
| End-user shipping a brand theme        | `theme.json` file alongside `ggui.json` | flat file        |
| Contributor baking a preset into ggui  | Register a preset in `@ggui-ai/design`  | source code      |

The override editor is fine for "Claudic with a different primary." For
anything bigger, you want a `theme.json` file or a registered preset.

---

## Path 1 — Drop a `theme.json` next to `ggui.json`

The OSS server's manifest schema accepts a file pointer:

```jsonc
// ggui.json
{
  "schema": "1",
  "protocol": "1.1",
  "app": { "slug": "demo", "name": "Demo" },
  "theme": { "file": "./theme.json", "mode": "light" },
}
```

Drop `theme.json` next to `ggui.json` with the full DTCG token tree —
shape matches the `DtcgTheme` interface exported from
`@ggui-ai/design`. Restart `ggui serve` and the picker shows it
as the active selection.

The fastest way to author one: copy `src/themes/definitions/claudic.ts`
(dual-mode preset, ~250 lines), strip the TypeScript wrapping, save the
inner objects as JSON. Or export from Figma Tokens / Tokens Studio /
Style Dictionary if your design system already lives there — the
`DtcgTheme` shape is a strict subset of W3C DTCG, so most exports
parse with minor tweaks (motion + name/description fields).

The picker will surface a "current selection is a file-form theme"
warning when you switch presets, since selecting a preset overwrites
the file pointer in `ggui.json`.

---

## Path 2 — Register a preset (contributors)

If you're working in the ggui monorepo and want your theme baked into
the bundle, add it to the registry. Three steps.

**1. Create the definition.** Copy an existing one as a template —
`claudic.ts` is the cleanest dual-mode example.

```ts
// packages/design/src/themes/definitions/aurora.ts
import type { DtcgTheme } from "../types";

const shared = {
  /* font / spacing / shape / motion */
} as const;

const auroraLight: DtcgTheme = {
  $name: "Aurora",
  $description: "Cool blue-green daytime palette.",
  $metadata: { font: "Inter" },
  color: {
    primary: {
      /* 50..900 ladder */
    },
    neutral: {
      /* 50..900 ladder */
    },
    success: { $value: "#…", $type: "color" },
    // …warning, error, info, surface, onSurface, container, outline, …
  },
  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,
};

const auroraDark: DtcgTheme = {
  /* mirror with dark palette */
};

export const theme = { light: auroraLight, dark: auroraDark } as const;
```

**2. Register it.**

```ts
// packages/design/src/themes/registry.ts
import { theme as auroraTheme } from "./definitions/aurora";

const themes = new Map<string, ThemeRegistration>([
  ["ggui", gguiTheme],
  ["claudic", claudicTheme],
  ["aurora", auroraTheme], // ← add this line
  // …
]);
```

Insertion order is the picker's display order. The first entry is the
default theme — keep `ggui` first unless you mean to replace it.

**3. Rebuild.**

```bash
pnpm --filter @ggui-ai/design build
# restart `ggui serve`
```

The new preset shows up in the `/theme` sidebar immediately.

### Required tokens

The `DtcgTheme` TypeScript interface in `src/themes/types.ts` is the
authoritative contract — `tsc` will refuse to compile a definition
that's missing required fields. The high-level shape:

```
color
  primary: { 50, 100, 200, 300, 400, 500, 600, 700, 800, 900 }
  neutral: { 50, 100, 200, 300, 400, 500, 600, 700, 800, 900 }
  success, warning, error, info        — single tokens
  surface, onSurface, surfaceVariant, onSurfaceVariant
  container, onContainer
  outline, outlineVariant
font
  family.sans         (mono optional)
  size:        sm, base, lg, xl, 2xl   (extend freely)
  weight:      normal, medium, semibold, bold
  lineHeight:  tight, normal, relaxed
spacing
  numeric 1..12 + named xs/sm/md/lg/xl/2xl   — primitives reference both
shape.radius
  sm, md, lg, xl, full
shape.shadow
  sm, md, lg, xl
motion.duration, motion.easing, motion.keyframes
```

Spacing in particular ships **both** numeric (`1..12`) and named
(`xs..2xl`) keys on purpose — primitives reference the named keys,
LLM-generated UIs and existing consumers mix both. Drop either set and
something downstream breaks.

### Status hues

`success` / `warning` / `error` / `info` are semantic-only. They render
through `--ggui-color-success` etc., not through the primary/neutral
ramps. Pick hues that read against your `surface` regardless of the
ladder you chose for `primary`.

---

## Tokens used in the brand kit shell

If you're matching against an existing brand kit (e.g. ggui's monochrome
paper + ink, or any brand-specific palette like punchy primary + neutral
surface), the `definitions/ggui.ts` and `definitions/claudic.ts` files
document their brand alignments inline — read those first to see the
conventions. Notable patterns:

- **Primary 500** is the brand's default foreground accent (or in
  GGUI's case, plain ink) — the shade everything else maps around.
- **Primary 600** is the hover/pressed tone; consumers of
  `--ggui-color-primary-600` rely on this being darker, not a totally
  different hue.
- **Neutral 50** = lightest surface; **neutral 900** = darkest text in
  light mode (inverted in dark).
- **Container / onContainer** is the recessed-panel pair — it's where
  brand-tinted regions sit without dominating the surface.

When in doubt, copy Claudic and drift.
