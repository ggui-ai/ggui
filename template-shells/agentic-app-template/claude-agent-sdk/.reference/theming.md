# Reference — theming a ggui app

> ggui generates the UI; you control how it **looks** via design tokens —
> without touching UI code. Two-layer theming: static **DTCG design tokens** →
> per-app **CSS variables** every generated surface renders against. Change the
> theme and every screen restyles.

Declared at **`servers/ggui/ggui.json#theme`**, which is a *pointer* — two forms.

## 1. A built-in preset (fastest)

```json
"theme": { "preset": "indigo", "mode": "dark" }
```

- **`preset`** — `ggui` · `indigo` · `claudic` · `premium-cyberpunk` ·
  `premium-zen` · `premium-neon-noir` · `premium-botanical`.
- **`mode`** — `light` | `dark`. String shorthand: `"theme": "claudic"`.

## 2. A custom theme (your brand)

```json
"theme": { "file": "./theme.json" }
```

Point `ggui.json` at a **DTCG theme document** (path relative to `servers/ggui/`,
or absolute). A ready-to-edit starter ships at **`.reference/theme.example.json`**:

```bash
cp .reference/theme.example.json servers/ggui/theme.json   # then edit color.primary
pnpm --filter ./servers/ggui exec ggui theme validate ./theme.json   # check it
# set servers/ggui/ggui.json#theme to { "file": "./theme.json" }
```

### Token leaves
Every leaf is `{ "$type": "…", "$value": …, "$description"?: "…" }`. Valid
`$type`: `color` · `dimension` · `fontFamily` · `fontWeight` · `duration` ·
`cubicBezier` · `shadow` · `transition` · `number`. **Root and every group are
strict** — an unknown key fails validation (so it's a typo guard).

### Groups — `color`, `spacing`, `font`, `shape` are REQUIRED

| Group | Required? | Shape |
| ----- | --------- | ----- |
| **`color`** | ✅ | Open record. Each entry is either a **palette** (`{ "50": …, "500": …, "900": … }` of `color` tokens) or a **single** `color` token. `primary` (palette) is your brand; `success`/`warning`/`error`/`info` are semantic palettes; `background`/`surface`/`onSurface`/`outline`/… are single-token roles. Add your own keys freely. |
| **`spacing`** | ✅ | Record of `dimension` tokens (`"4": "16px"`). |
| **`font`** | ✅ | Strict `{ family, size, weight, lineHeight }`. `family.sans` (a `fontFamily` token) is **mandatory**; `mono`/others optional. `size` → `dimension`; `weight` → `fontWeight` (number 1–1000 or keyword); `lineHeight` → `number` or `dimension`. |
| **`shape`** | ✅ | Strict `{ radius, shadow }`. `radius` → `dimension`; `shadow` → `shadow` tokens (a CSS string **or** `{ offsetX, offsetY, blur, spread, color }`). |
| **`motion`** | optional | Strict `{ duration, transition, easing?, keyframes? }`. `duration` → `duration`; `transition` → `transition` (string or `{ duration, timingFunction, property? }`); `easing` → `cubicBezier`. |
| **`accessibility`** | optional | `{ focusRing?: {color,width,offset}, reducedMotion?: {duration}, highContrast?: {borderWidth,textColor,backgroundColor,linkColor} }`. |
| **`zIndex`** | optional | Record of `number` tokens. |
| **`canvas`** | optional | GenerativeCanvas background config (`mode`/`speed`/`colors`/`background`). |
| `$name` `$description` `$metadata` | optional | DTCG metadata. |

> Note: this is the **canonical** (DTCG-nested) shape — `radius`/`shadow` live
> under `shape`, font tokens under `font.*`, durations/transitions under
> `motion.*`. (Older Tailwind-flat `theme.json` files with root `radius`/`typography`
> are no longer valid.)

### Easiest path
Copy `.reference/theme.example.json`, change **`color.primary`** to your brand
scale (and `mode` colors if you like), `ggui theme validate` it, and point
`ggui.json#theme` at it. Or just stick with a preset.

## Why this is zero-UI-code
The agent never sees your tokens — it describes UI in natural language and ggui
renders it against whatever theme is active. So editing `theme` here restyles the
**entire** app — every agent-generated surface — with no component edits. That's
the `/bootstrap` Beat-4 ownership moment.

(Preset token sources live in `@ggui-ai/design`; deeper docs via the `ggui-docs`
MCP — see `.mcp.json` — or https://docs.ggui.ai.)
