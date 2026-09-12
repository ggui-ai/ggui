/**
 * Semantic color slots that primitives expose as typed props.
 *
 * The LLM-generation contract: structure + intent come from the
 * component author; visuals come from the theme + primitive variants.
 * Primitives that historically accepted `color?: string` /
 * `background?: string` (Text, Heading, Box, Card, Divider, Icon,
 * Link, Spinner) gave the LLM an arbitrary-string escape that
 * defeated theming — the operator's preset selection had no effect
 * on a component that hardcoded `color: '#B8FF3A'`. Hex literals
 * are a tier-0 self-check `fail`, but the deeper fix is to NEVER
 * let the LLM pass arbitrary color strings through these props.
 * Typed slot unions force the choice to land on a token family the
 * theme controls.
 *
 * **Naming convention.** Slots are named for SEMANTIC ROLE, not for
 * a specific color value. `'muted'` is "secondary text"; the theme
 * decides what muted looks like (Indigo's #4a4954 vs Claudic's quiet
 * grey vs Neon-Noir's dim cyan). Components that use slot props
 * inherit the operator's chosen visual identity automatically.
 *
 * @public
 */

/**
 * Tone slots for text-content primitives (Text, Heading, Link, Icon).
 *
 * Maps to `color: var(--ggui-color-*)`. Each slot picks the canonical
 * onSurface-family token for that semantic role:
 *
 * | slot          | token                              | use case                                    |
 * | ------------- | ---------------------------------- | ------------------------------------------- |
 * | `default`     | `--ggui-color-onContainer`         | primary body text (most common)              |
 * | `muted`       | `--ggui-color-onSunken`            | secondary / metadata / captions             |
 * | `subtle`      | `--ggui-color-neutral-500`         | very-low-emphasis labels, hint text          |
 * | `emphasized`  | `--ggui-color-link` (700 beneath)  | accent text (branded label, tagline, eyebrow) — the theme's READABLE accent ink |
 * | `loud`        | `--ggui-color-link` (500 beneath)  | the strongest accent (call-to-action label) — the theme's READABLE accent ink |
 * | `success`     | `--ggui-color-success`             | success status text (semantic flat token)    |
 * | `warning`     | `--ggui-color-warning`             | warning status text (semantic flat token)    |
 * | `error`       | `--ggui-color-error`               | error status text (semantic flat token)      |
 * | `info`        | `--ggui-color-info`                | info status text (semantic flat token)       |
 * | `inverse`     | `--ggui-color-container`           | text rendered on a dark / inverted surface    |
 * | `inherit`     | `inherit`                          | use the parent's color (nested-render case)  |
 *
 * @public
 */
export type ToneSlot =
  | 'default'
  | 'muted'
  | 'subtle'
  | 'emphasized'
  | 'loud'
  | 'success'
  | 'warning'
  | 'error'
  | 'info'
  | 'inverse'
  | 'inherit';

/**
 * Resolve a {@link ToneSlot} to the canonical CSS color expression.
 * Always emits a `var(--ggui-color-*, #fallback)` reference so
 * un-themed contexts still paint, and so the existing CHECK regex's
 * "var(--ggui-" allowance lights up cleanly.
 *
 * @public
 */
export function resolveToneCss(tone: ToneSlot): string {
  switch (tone) {
    case 'default':
      return 'var(--ggui-color-onContainer, #18181b)';
    case 'muted':
      return 'var(--ggui-color-onSunken, #52525b)';
    case 'subtle':
      // `subtle` resolves to `neutral-500` rather than `outline`
      // (intended for borders, ~2:1 contrast on dark surfaces —
      // failed WCAG for text). Both light and dark themes ship
      // `neutral-500` as the canonical tertiary-text grey: light =
      // #6e6d74 (~5:1 on paper), dark = #5e5c70 (~4:1 on midnight).
      // Stays "barely visible" for hint-text usage but readable.
      return 'var(--ggui-color-neutral-500, #71717a)';
    case 'emphasized':
      // Accent TEXT reads through the theme's readable accent ink (ggui#1039 —
      // the #1035 rule for every accent-text slot): the registry audit cleared
      // the 700 stop on the registry's themes only; an app theme derived from a
      // low-saturation brand puts its 700 mid-grey on a dark ground. The 700
      // stop sits beneath it only for un-themed contexts.
      return 'var(--ggui-color-link, var(--ggui-color-primary-700, #0369a1))';
    case 'loud':
      // Accent TEXT reads through the theme's readable accent ink (ggui#1035):
      // the bare 500 stop read 1.60:1 on the brand theme's light container.
      // `link` is derived per mode to clear 4.5:1; the 500 stop sits beneath
      // it only for un-themed contexts.
      return 'var(--ggui-color-link, var(--ggui-color-primary-500, #0ea5e9))';
    case 'error':
      // The flat `--ggui-color-error` is the one semantic slot a host
      // palette or a theme override addresses directly (ggui#983); it
      // reads first, with the ladder's live `error-500` stop beneath it
      // so an unset flat token changes nothing. Static on purpose: the
      // consumed-token manifest derives the dynamic site below from
      // `SEMANTIC_TONE_FALLBACK`'s range, and this slot must be visible
      // to it as two plain tokens.
      return `var(--ggui-color-error, var(--ggui-color-error-500, ${SEMANTIC_TONE_FALLBACK.error}))`;
    case 'success':
    case 'warning':
    case 'info':
      // Semantic tones resolve to the ladder's `500` stop — the "live"
      // stop every theme annotates as the semantic role color and ships
      // per palette mode (ggui light success-500 #1b7a37, ggui dark
      // #3da85b "brighter live"), the same stop Alert reads for its
      // icon. NOT the flat `--ggui-color-<tone>`: `DtcgTheme.color`
      // types the four semantic families as SCALES ONLY and the parser
      // walks scales, so no theme has ever emitted a flat token — the
      // prior flat lookup fell through to SEMANTIC_TONE_FALLBACK's
      // light-mode hexes on every theme, invisible on dark surfaces
      // (found by the beauty/002 understand pass, 2026-08-19).
      return `var(--ggui-color-${tone}-500, ${SEMANTIC_TONE_FALLBACK[tone]})`;
    case 'inverse':
      // Text on an inverted / hero surface reads that surface's INK (ggui#1047): inside a
      // scope, `container` is swapped to the surface's own ground (#1024), so a bare
      // `var(--ggui-color-container)` here put ink on ink — the served Mosaic hello's hero
      // text computed equal to its ground (1:1). `onInverted` is derived = the page's
      // container and re-declared on every scope root as that surface's ink.
      return 'var(--ggui-color-onInverted, var(--ggui-color-container, #ffffff))';
    case 'inherit':
      return 'inherit';
  }
}

/**
 * Per-tone hardcoded fallback for the semantic slots. Used only when
 * no theme is bound (every registry theme emits `<tone>-500` in both
 * modes). Each picks a value with adequate contrast on a light surface
 * (the historical default); dark-mode users without a theme bound see
 * a less-readable but still-distinguishable shade. Prefer binding a
 * real theme.
 */
const SEMANTIC_TONE_FALLBACK: Readonly<Record<'success' | 'warning' | 'error' | 'info', string>> = {
  success: '#15803d',
  warning: '#b45309',
  error: '#b91c1c',
  info: '#0e7490',
};

/**
 * Surface slots for container primitives (Box, Card, Stack-when-bg).
 *
 * Maps to `backgroundColor: var(--ggui-color-*)`. Each slot picks the
 * canonical surface-family token for that semantic role:
 *
 * | slot         | token                          | use case                                 |
 * | ------------ | ------------------------------ | ---------------------------------------- |
 * | `default`    | `--ggui-color-container`       | a card, a bubble, a panel (most common)   |
 * | `elevated`   | `--ggui-color-elevated`        | floats above the container (menu, modal)  |
 * | `sunken`     | `--ggui-color-sunken`          | inset / quoted region, slightly recessed  |
 * | `accent`     | `--ggui-color-primary-50`      | branded fill — "highlighted" region        |
 * | `inverted`   | `--ggui-color-onContainer`     | dark surface in light mode (testimonial,    |
 * |              |                                | code-snippet card)                          |
 * | `transparent`| `transparent`                  | no fill (defer to parent)                  |
 *
 * @public
 */
export type SurfaceSlot =
  | 'default'
  | 'elevated'
  | 'sunken'
  | 'accent'
  | 'inverted'
  | 'hero'
  | 'transparent';

/**
 * Resolve a {@link SurfaceSlot} to the canonical CSS background-color
 * expression.
 *
 * @public
 */
/**
 * The on-colour a surface OWNS. Theme v2 pairs `inverted` with its ink
 * explicitly: the inverted surface paints `--ggui-color-onContainer` (the
 * ink role) as its background, so text that inherits the page ink is
 * invisible on it — the surface root must set `color` to the `inverse`
 * text slot (`--ggui-color-container`). Every other surface keeps the
 * page ink (returns undefined) — a `tone` on the text still wins by
 * cascade. Bought on ggui#1019: under a theme whose page ink equals that
 * role, inherited text rendered rgb(26,26,26) on rgb(26,26,26) — invisible —
 * while the same code under the default tokens read fine.
 */
export function resolveSurfaceOnColorCss(surface: SurfaceSlot): string | undefined {
  if (surface === 'inverted') return resolveToneCss('inverse');
  if (surface === 'hero') return 'var(--ggui-color-onHeroGround, #0c4a6e)';
  return undefined;
}

/**
 * The class an `inverted` root carries so {@link INVERTED_SCOPE_CSS} can
 * re-map the surface-layering pair for its subtree (ggui#1024).
 *
 * @public
 */
export const INVERTED_SCOPE_CLASS = 'ggui-surface-inverted';

/**
 * A surface owns ALL its on-colours (ggui#1024, the ggui#1019 family one
 * step further). ggui#1019 gave the inverted root its PRIMARY ink; every
 * `tone="muted"` label, `neutral-500` hint, chip and outline inside it
 * still resolved the light-surface tokens by cascade — grey-on-black at
 * 2.4–3.5:1 on served greeting cards.
 *
 * The root records the pair it inverts as two scoped aliases (its own
 * background = the page ink role, its own ink = the page container) and
 * this rule re-maps the surface-layering vocabulary for the root's
 * DIRECT children — custom properties then inherit to every descendant:
 *
 *   container ↔ onContainer swap; elevated / sunken are the inverted
 *   ground tinted a step toward the ink; onSunken / neutral-500 (the
 *   `muted` / `subtle` inks) are the inverted ink stepped toward the
 *   ground; outline / outlineVariant are ink at low mix.
 *
 * Two tiers per the package's `color-mix()` convention: a static tier
 * every browser applies (pair swap; secondary inks = the primary ink;
 * outlines untouched — the light outline stays visible on a dark ground),
 * then the mixed values inside `@supports`. Derived, never authored — no
 * theme role is added, and the aliases live under the package's own
 * `--ggui-surface-*` namespace, which is not a theme family.
 *
 * Nested inversion flips back: an inverted root inside an inverted scope
 * reads the already-swapped pair, so its aliases invert it again.
 *
 * The rule is co-rendered as a `<style>` child by Card / Box (the Grid
 * precedent: `display:none` by UA default, never a layout child), so it
 * holds in every rendering context — preview, iframe, SSR — without a
 * theme stylesheet.
 *
 * @public
 */
/**
 * The scoped remap for a surface that owns its whole ink vocabulary: the root
 * records its ground / ink as two aliases under the package's own
 * `--ggui-surface-<name>-*` namespace (not a theme family), and the rule
 * re-maps the surface-layering roles for the root's direct children (which
 * then inherit). Two tiers per the package's `color-mix()` convention.
 */
function surfaceScopeCss(cls: string, name: string, bg: string, ink: string, accent: string, outlineOpen: string): string {
  // The aliases live under the package's own `--ggui-surface-*` namespace (not a
  // theme family); composed outside any `var(--ggui-` literal so the consumed-
  // token scan sees no dynamic token construction here.
  const bgAlias = '--ggui-surface-' + name + '-bg';
  const inkAlias = '--ggui-surface-' + name + '-ink';
  const B = 'var(' + bgAlias + ')';
  const I = 'var(' + inkAlias + ')';
  return (
    `.${cls}{` +
    `${bgAlias}:${bg};` +
    `${inkAlias}:${ink};` +
    // The ink every `tone="inverse"` beneath this root reads (ggui#1047).
    `--ggui-color-onInverted:${ink}}` +
    `.${cls}>*{` +
    `--ggui-color-container:${B};` +
    `--ggui-color-onContainer:${I};` +
    `--ggui-color-elevated:${B};` +
    `--ggui-color-onElevated:${I};` +
    `--ggui-color-sunken:${B};` +
    `--ggui-color-onSunken:${I};` +
    `--ggui-color-neutral-500:${I};` +
    // A scoped surface IS its subtree's ground (ggui#1047): text painted with the page's
    // `onGround` inside an inverted card read ink-on-ink on a theme whose ground is its container.
    `--ggui-color-ground:${B};` +
    `--ggui-color-onGround:${I};` +
    // Accent text walks against THIS ground (ggui#1043), never the container's.
    `--ggui-color-link:${accent}}` +
    '@supports (color: color-mix(in srgb, red, blue)){' +
    `.${cls}>*{` +
    // A nested `default` container inside the scope reads a whisper of ink over the scope ground (ggui#1051):
    // at the bare ground it was invisible — the served card's after-click panel vanished into the card.
    `--ggui-color-container:color-mix(in srgb, ${B} 94%, ${I});` +
    `--ggui-color-elevated:color-mix(in srgb, ${B} 92%, ${I});` +
    `--ggui-color-sunken:color-mix(in srgb, ${B} 88%, ${I});` +
    `--ggui-color-onSunken:color-mix(in srgb, ${I} 76%, ${B});` +
    `--ggui-color-neutral-500:color-mix(in srgb, ${I} 62%, ${B});` +
    // The outline is DERIVED per theme to clear 3:1 on this ground (ggui#1051); the 32 % mix is the un-themed fallback.
    `--ggui-color-outline:${outlineOpen}color-mix(in srgb, ${I} 32%, ${B}));` +
    `--ggui-color-outlineVariant:color-mix(in srgb, ${I} 18%, ${B})}}`
  );
}

export const INVERTED_SCOPE_CSS = surfaceScopeCss(
  INVERTED_SCOPE_CLASS,
  'inverted',
  'var(--ggui-color-onContainer, #18181b)',
  'var(--ggui-color-container, #ffffff)',
  'var(--ggui-color-inverseLink, var(--ggui-color-container, #ffffff))',
  // The derived outline for this ground (ggui#1051), the 32 % mix beneath it; a literal so the manifest sees it.
  'var(--ggui-color-inverseOutline, ',
);

/** The class a `hero` root carries (ggui#1031 L2) — the same remap over the hero ground pair. */
export const HERO_SCOPE_CLASS = 'ggui-surface-hero';
export const HERO_SCOPE_CSS = surfaceScopeCss(
  HERO_SCOPE_CLASS,
  'hero',
  'var(--ggui-color-heroGround, #e0f2fe)',
  'var(--ggui-color-onHeroGround, #0c4a6e)',
  'var(--ggui-color-heroLink, var(--ggui-color-onHeroGround, #0c4a6e))',
  'var(--ggui-color-heroOutline, ',
);

/** The scope a surface root carries, when the surface owns its subtree's inks. */
/**
 * An author's `style` with its background declarations removed — a SCOPED surface
 * (`inverted`, `hero`) owns its ground (ggui#1047): a generated
 * `style={{ background: 'var(--ggui-color-ground)' }}` on an inverted card painted the
 * page's ground under the scope's swapped inks and read 1:1. Non-scoped surfaces keep
 * the author's background as before.
 *
 * @public
 */
export function withoutBackground<T extends { background?: unknown; backgroundColor?: unknown; backgroundImage?: unknown }>(style: T | undefined): Omit<T, 'background' | 'backgroundColor' | 'backgroundImage'> | undefined {
  if (style === undefined) return undefined;
  const { background: _background, backgroundColor: _backgroundColor, backgroundImage: _backgroundImage, ...rest } = style;
  return rest;
}

export function resolveSurfaceScope(surface: SurfaceSlot): { readonly className: string; readonly css: string } | undefined {
  if (surface === 'inverted') return { className: INVERTED_SCOPE_CLASS, css: INVERTED_SCOPE_CSS };
  if (surface === 'hero') return { className: HERO_SCOPE_CLASS, css: HERO_SCOPE_CSS };
  return undefined;
}

/** The mix percentages above, exported so the contrast pin reads the same numbers. */
export const INVERTED_SCOPE_MIX = {
  elevatedBg: 92,
  sunkenBg: 88,
  onSunkenInk: 76,
  neutral500Ink: 62,
  outlineInk: 32,
  outlineVariantInk: 18,
} as const;

export function resolveSurfaceCss(surface: SurfaceSlot): string {
  switch (surface) {
    case 'default':
      return 'var(--ggui-color-container, #ffffff)';
    case 'elevated':
      // A float above the container (popover, menu, modal, toast) — its own
      // role (ggui#987 §2.1); derived, never authored (§2.4).
      return 'var(--ggui-color-elevated, #ffffff)';
    case 'sunken':
      return 'var(--ggui-color-sunken, #f4f4f5)';
    case 'accent':
      return 'var(--ggui-color-primary-50, #f0f9ff)';
    case 'inverted':
      return 'var(--ggui-color-onContainer, #18181b)';
    case 'hero':
      // The hero ground pair (ggui#1031 L2): brand-tinted on a light host, the
      // ink pair on a dark one — derived per mode, never authored; a hello
      // reaches for it instead of guessing the host's darkness with `inverted`.
      return 'var(--ggui-color-heroGround, #e0f2fe)';
    case 'transparent':
      return 'transparent';
  }
}
