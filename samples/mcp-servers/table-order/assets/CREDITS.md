# Menu photo assets

This folder holds the menu photos served at `GET /assets/<file>`. The seed
(`src/seed.ts`) references them by relative path (e.g. `/assets/margherita.svg`).

## Placeholder behavior

Until a real image file exists here, the server **generates a labeled
placeholder SVG** on the fly for any requested `*.svg` name (see
`placeholderSvg` in `src/index.ts`). So the sample renders a complete-looking
menu out of the box with **zero bundled binaries**.

## Adding real photos

Drop a license-clean image into this folder using the same base name as the
seed's `photoPath`, and it will be served instead of the placeholder. For
example, to give the Margherita a real photo, add `margherita.jpg` and change
that item's `photoPath` to `/assets/margherita.jpg` in `src/seed.ts`.

**Licensing:** this sample ships in the public OSS mirror, so any committed
image MUST be CC0 / public-domain or self-authored. Record each file's source
and license below.

| File                                             | Source | License |
| ------------------------------------------------ | ------ | ------- |
| _(none yet — placeholders generated at runtime)_ |        |         |
