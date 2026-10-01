# @ggui-ai/brand

The GGUI brand kit as code: the wordmark's canonical geometry, the brand's
colour tokens, the vendored faces, and one renderer for the social cards
(`og:image`) every GGUI surface serves.

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
    title: "Agents describe.\nInterfaces appear.", // you place the break, where the sentence breaks
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
- Each face is named by its own literal
  `new URL('../fonts/<face>.woff', import.meta.url)`. A bundler that emits
  those files for a server build needs nothing more; Next with Turbopack
  does. Vite's server build, as Astro 7's prerender runs it, leaves the URLs
  verbatim and emits no font file, so there keep `@ggui-ai/brand` external:
  `vite.environments.prerender.resolve.external` in Astro 7, since the
  top-level `ssr.external` does not reach the prerender environment.

### Keying the image URL

Link-preview services cache a card by its image URL, so a changed card reaches
new shares only when the URL changes. Put a content key in the URL's path that
moves exactly when what the card shows moves. Never key it on a package
version: a consumer inside a workspace never moves it, while the renderer under
it changes.

- **A card rendered on demand:** `socialCardKey(input, { engine })` hashes the
  card's input with the renderer's own digest (`SOCIAL_CARD_RENDERER_DIGEST`,
  over its sources and faces). It moves when any input field, the renderer or
  its faces change. Pass `engine`, the version of whatever turns the card into
  pixels, since that is outside this package.
- **A card rendered to a file at build:** `socialCardKeyFromImage(pngBytes)`
  hashes the rendered bytes. The render is deterministic (the same card gives
  the same bytes), so the key is stable until the card changes.

```ts
// app/og/[key]/route.ts: serve the CURRENT card under any well-formed key.
import { isSocialCardKey } from "@ggui-ai/brand";

export async function GET(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  if (!isSocialCardKey((await params).key)) return new Response(null, { status: 404 });
  return renderTheCard(); // ImageResponse over renderSocialCard(CARD), as above
}

// app/layout.tsx: page metadata points at the current key.
import { socialCardKey } from "@ggui-ai/brand";

const image = `/og/${socialCardKey(CARD, { engine: NEXT_VERSION })}`;
export const metadata = { openGraph: { images: [image] }, twitter: { images: [image] } };
```

Keep every image URL you have published answering with the current card: an
old key still renders, and a fixed URL you served before (such as a bare
`/opengraph-image`) stays as a route that returns the current card with a 200.
A preview service that re-fetches an old link's image then still finds one.

After changing the renderer or a face, run
`pnpm --filter @ggui-ai/brand generate:digest`: the package's tests fail until
the committed digest matches.

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
licence grants no rights to the GGUI name or wordmark (§6): they are the
GGUI project's marks, included here so GGUI's own surfaces render them
consistently.
