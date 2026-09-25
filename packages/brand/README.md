# @ggui-ai/brand

The ggui brand kit as code: the wordmark's canonical geometry, the brand's
colour tokens, the vendored faces, and one renderer for the social cards
(`og:image`) every ggui surface serves.

> **Private for now.** This package is not published to npm. A published
> package may use it only by **bundling** it into its build output; it must
> never import it at runtime from an unbundled build, because an install of
> the published package would then fail to resolve it.

## The social card

```ts
import { renderSocialCard, socialCardFonts, SOCIAL_CARD_SIZE } from "@ggui-ai/brand";
import satori from "satori";

const svg = await satori(
  renderSocialCard({
    surface: "DOCS", // the badge beside the mark; omit it for no badge
    title: "Agents describe. Interfaces appear.",
    footer: { url: "docs.ggui.ai", fact: "OPEN PROTOCOL" },
  }),
  { ...SOCIAL_CARD_SIZE, fonts: socialCardFonts() }
);
```

In a Next app, pass the same tree and faces to `ImageResponse`. The tree is
plain `{ type, props, key }` objects, so it needs no framework.

- **1200 × 630**, paper ground, a hairline frame, the mark top-left, an
  optional badge, one eyebrow line, a headline of at most two lines, an
  optional description, and a footer (the surface's URL, and one fact).
- **A static card claims nothing live.** Unfurlers cache a card for days, so
  the footer's fact must be one that only a deploy can change.
- `socialCardFonts()` reads the faces from disk, so it runs in Node, not in
  an edge runtime.

## The wordmark

`WORDMARK_SHAPES` is the canonical four-glyph construction on its 224 × 50
grid (chrome-g · ink-g · ink-u · chrome-i). Every other copy of the mark must
match it byte for byte. `wordmarkSvg({ width })` renders the letters as an
SVG document.

## Tokens

`BRAND_COLORS` holds the kit's colours. `brandTokensCss()` emits them as
CSS custom properties under the `--ggb-` prefix. They are separate from
`@ggui-ai/design`'s `--ggui-*` tokens, which style generated interfaces.

## Faces

Inter (Regular, Bold) and Geist Mono (Regular), both under the
[SIL Open Font License 1.1](https://openfontlicense.org); the licence texts
are in `fonts/`. The files are the Latin subsets as published on npm, as
WOFF, since satori reads TTF, OTF and WOFF but not WOFF2:

| File                           | Source                                                                  | SHA-256                                                            |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `fonts/Inter-Regular.woff`     | `@fontsource/inter@5.3.0` `files/inter-latin-400-normal.woff`           | `e20fa0b4fd2dd26e4d14b3ac3cc922509c3a63fa5e910e90c614544aa042dd45` |
| `fonts/Inter-Bold.woff`        | `@fontsource/inter@5.3.0` `files/inter-latin-700-normal.woff`           | `7c5ed5655730de337704d3fc94628515cd7e3d8d32368871709bf56ac0397e7a` |
| `fonts/GeistMono-Regular.woff` | `@fontsource/geist-mono@5.3.0` `files/geist-mono-latin-400-normal.woff` | `ec7ecd39327c39a2b2792c8b402d094619b6c1e517a74420cde8fd67a71ed083` |

## Licence and trademarks

The code is Apache-2.0 (see `LICENSE`); the faces are OFL-1.1. The Apache
licence grants no rights to the ggui name or wordmark (§6): they are the
ggui project's marks, included here so ggui's own surfaces render them
consistently.
