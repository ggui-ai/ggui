/**
 * CSS Tokens
 *
 * Single source of truth for CSS variable injection. Derives all CSS from
 * the theme registry rather than hardcoding values, ensuring consistency
 * between the design system and all rendering contexts.
 *
 * Every public helper accepts an optional {@link ThemeMode} so callers can
 * resolve a theme's dark variant. When the requested theme has not shipped
 * a dark mode yet, the registry falls back to its `light` tokens — see
 * `themes/registry.ts` for the resolution rule.
 *
 * ## `color-mix()` two-tier fallback
 *
 * Several tokens bake `color-mix()` so elevation/glow/surface ramps carry
 * a primary-accent tint that adapts per color mode at runtime:
 *   - the `--ggui-shape-shadow-*` tokens (indigo/claudic themes), and
 *   - the scoped `--ggui-color-ground-gradient` / `--ggui-effect-glow-*`
 *     tokens emitted below.
 *
 * Browsers without `color-mix()` support (Safari <16.2, Firefox <113) drop
 * any declaration whose value they cannot parse, so those tokens would
 * vanish entirely (shadows/glow gone, surface ramp flattened to white).
 * To keep the design intact on modern browsers AND degrade gracefully on
 * old ones, every `color-mix()` token is emitted as two tiers:
 *   1. a STATIC fallback (precomputed `rgba()` / flat gradient) FIRST, then
 *   2. the original `color-mix()` value re-declared inside an
 *      `@supports (color: color-mix(...))` block.
 * Modern browsers apply the second tier and render exactly as before; old
 * browsers stop at the first tier and keep a sane tinted fallback. The
 * emitter resolves the theme per mode, so the static fallback is computed
 * from that mode's own `primary-500` hex — no mode's tint is frozen.
 */

import { getTheme, getDefaultThemeId } from '../themes/index';
import { completeThemeVariables } from '../themes/derive-theme-variables';
import type { FontFaceDeclaration, ThemeMode } from '../themes/types';
import { fontFaceRules, isRenderableFontFace } from '../themes/font-faces';

/**
 * `@supports` query that gates the modern `color-mix()` tier of every
 * tinted token. Browsers that pass it (Chrome 111+, Safari 16.2+,
 * Firefox 113+) re-declare the color-mix values and keep the exact
 * design; browsers that fail it keep the static `rgba()` fallback emitted
 * just before. Probing `red`/`blue` (not theme tokens) keeps the query a
 * pure feature test.
 */
const COLOR_MIX_SUPPORTS = '@supports (color: color-mix(in srgb, red, blue))';

/**
 * Resolve a theme's literal `primary-500` hex from its emitted CSS
 * variable declarations (`--ggui-color-primary-500: #rrggbb;`). The value
 * adapts per mode (light vs dark ladders resolve different hexes), so
 * reading it back from the parsed variables keeps the static fallback in
 * lockstep with whichever mode is being rendered.
 *
 * Returns `null` when the variable is absent or not a 3/6-digit hex —
 * callers then skip fallback emission and rely on the color-mix value
 * alone (no worse than before this fallback existed).
 */
function resolvePrimary500Hex(cssVariables: string): string | null {
  const match = cssVariables.match(
    /--ggui-color-primary-500:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s*;/
  );
  return match ? match[1] : null;
}

/** Parse a 3- or 6-digit hex color into 0-255 channels. */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  let h = hex.replace('#', '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (h.length !== 6) return null;
  const r = Number.parseInt(h.slice(0, 2), 16);
  const g = Number.parseInt(h.slice(2, 4), 16);
  const b = Number.parseInt(h.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
  return { r, g, b };
}

/**
 * Replace every `color-mix(in srgb, var(--ggui-color-primary-500) N%,
 * transparent)` occurrence in a value with the equivalent
 * `rgba(r, g, b, N/100)`. For an opaque source color mixed with
 * `transparent`, the two are pixel-identical, so the static fallback
 * matches the modern look exactly — it just doesn't track runtime
 * `--ggui-color-primary-500` overrides (acceptable for the old-browser
 * floor). Any other `color-mix()` form (e.g. mixed against a surface
 * color) is left untouched.
 */
function precomputePrimaryColorMix(
  value: string,
  primary500Hex: string
): string {
  const rgb = hexToRgb(primary500Hex);
  if (!rgb) return value;
  return value.replace(
    /color-mix\(\s*in srgb\s*,\s*var\(--ggui-color-primary-500\)\s+(\d+(?:\.\d+)?)%\s*,\s*transparent\s*\)/g,
    (_match, pct: string) => {
      const alpha = Number(pct) / 100;
      // Trim trailing zeros so `0.18`/`0.4` read clean in output.
      const a = Number(alpha.toFixed(4)).toString();
      return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
    }
  );
}

/**
 * Split a `:root { ... }` / `.scope { ... }` variable block into the
 * declaration lines that use `color-mix()` and those that don't. Used to
 * lift only the color-mix declarations into the two-tier `@supports`
 * layer while leaving plain declarations in the base block untouched.
 */
function partitionColorMixDeclarations(block: string): {
  base: string;
  colorMix: string[];
} {
  const open = block.indexOf('{');
  const close = block.lastIndexOf('}');
  if (open === -1 || close === -1) return { base: block, colorMix: [] };
  const selector = block.slice(0, open + 1);
  const body = block.slice(open + 1, close);
  const baseLines: string[] = [];
  const colorMixLines: string[] = [];
  for (const rawLine of body.split('\n')) {
    if (rawLine.trim() === '') continue;
    if (rawLine.includes('color-mix(')) colorMixLines.push(rawLine);
    else baseLines.push(rawLine);
  }
  return {
    base: `${selector}\n${baseLines.join('\n')}\n}`,
    colorMix: colorMixLines,
  };
}

/**
 * Wrap a parsed `:root`/`.scope` variable block so `color-mix()`-based
 * tokens (e.g. the indigo/claudic `--ggui-shape-shadow-*` shadows) degrade
 * gracefully on old browsers. Emits, in order:
 *
 *   1. the base block (non-color-mix declarations) unchanged;
 *   2. a STATIC fallback block re-declaring each color-mix token with a
 *      precomputed per-mode `rgba()` so old browsers keep the tinted
 *      shadow instead of dropping it entirely;
 *   3. an `@supports` block re-declaring the original color-mix tokens so
 *      modern browsers render the exact, runtime-adaptive value.
 *
 * `selectorPrefix` is the `:root` or `.scopeClass` selector the block is
 * scoped to. When the theme exposes no resolvable primary-500 hex, or the
 * block has no color-mix tokens, it is returned unchanged.
 */
function withColorMixFallback(
  block: string,
  selectorPrefix: string,
  primary500Hex: string | null
): string {
  if (!primary500Hex || !block.includes('color-mix(')) return block;
  const { base, colorMix } = partitionColorMixDeclarations(block);
  if (colorMix.length === 0) return block;
  const fallbackLines = colorMix.map((line) =>
    precomputePrimaryColorMix(line, primary500Hex)
  );
  const fallbackBlock = `${selectorPrefix} {\n${fallbackLines.join('\n')}\n}`;
  const modernBlock = `${COLOR_MIX_SUPPORTS} {\n  ${selectorPrefix} {\n${colorMix.join('\n')}\n  }\n}`;
  return `${base}\n${fallbackBlock}\n${modernBlock}`;
}

/**
 * Get the full CSS (variables + keyframes) for the default theme.
 *
 * Equivalent to `getThemeCss(getDefaultThemeId(), mode)`.
 *
 * @param mode - Color mode (default `'light'`)
 * @returns CSS string with `:root` block and `@keyframes` declarations
 */
export function getCssTokens(mode: ThemeMode = 'light'): string {
  return getThemeCss(getDefaultThemeId(), mode);
}

/**
 * Get scoped CSS for the default theme, replacing `:root` with a class selector.
 *
 * Equivalent to `getScopedThemeCss(getDefaultThemeId(), scopeClass, mode)`.
 *
 * @param scopeClass - CSS class name to scope variables under (without leading dot)
 * @param mode - Color mode (default `'light'`)
 * @returns Scoped CSS string
 */
export function getScopedCssTokens(
  scopeClass: string,
  mode: ThemeMode = 'light'
): string {
  return getScopedThemeCss(getDefaultThemeId(), scopeClass, mode);
}

/**
 * Get the full CSS for a specific theme by ID and mode.
 *
 * Falls back to the default theme if the requested theme is not found.
 * Returns an empty string as a last resort if the default theme is also missing.
 *
 * @param themeId - Theme identifier (e.g., `'ggui'`, `'premium-cyberpunk'`)
 * @param mode - Color mode (default `'light'`)
 * @returns CSS string with `:root` block and `@keyframes` declarations
 */
export function getThemeCss(
  themeId: string,
  mode: ThemeMode = 'light'
): string {
  const theme = getTheme(themeId, mode);
  if (theme) {
    // Wrap the `:root` variables so any `color-mix()` shadow token degrades
    // gracefully (per-mode rgba fallback + `@supports` modern re-declare).
    const primary500 = resolvePrimary500Hex(theme.cssVariables);
    const variables = withColorMixFallback(
      theme.cssVariables,
      ':root',
      primary500
    );
    return theme.cssKeyframes
      ? `${variables}\n\n${theme.cssKeyframes}`
      : variables;
  }

  // Fallback to default theme (avoid infinite recursion if default is also missing)
  const defaultId = getDefaultThemeId();
  if (themeId === defaultId) return '';
  return getThemeCss(defaultId, mode);
}

/**
 * Get scoped CSS for a specific theme, replacing `:root` with a class selector.
 *
 * Useful for rendering components inside a scoped container (or shadow DOM)
 * where `:root` would not apply. Also includes a universal
 * `box-sizing: border-box` rule scoped to the class.
 *
 * Falls back to the default theme if the requested theme is not found.
 * Returns an empty string as a last resort if the default theme is also missing.
 *
 * @param themeId - Theme identifier
 * @param scopeClass - CSS class name to scope variables under (without leading dot)
 * @param mode - Color mode (default `'light'`)
 * @returns Scoped CSS string
 */
export function getScopedThemeCss(
  themeId: string,
  scopeClass: string,
  mode: ThemeMode = 'light'
): string {
  const theme = getTheme(themeId, mode);
  if (!theme) {
    // Fallback to default theme (avoid infinite recursion if default is also missing)
    const defaultId = getDefaultThemeId();
    if (themeId === defaultId) return '';
    return getScopedThemeCss(defaultId, scopeClass, mode);
  }

  // Resolve the theme's literal primary-500 hex from the emitted CSS
  // variables. Used to compute STATIC rgba()/flat-gradient fallbacks for
  // the `color-mix()`-based effect tokens below (and the color-mix shadow
  // tokens) so browsers without `color-mix()` support (Safari <16.2,
  // Firefox <113) still render a tinted shadow + glow + surface ramp
  // instead of dropping the whole declaration.
  const primary500 = resolvePrimary500Hex(theme.cssVariables);
  // Scope the parsed `:root` variables to the class, then split any
  // `color-mix()`-based custom property (e.g. the indigo/claudic shadow
  // tokens) into a precomputed-rgba fallback + an `@supports`-gated modern
  // re-declaration. Modern browsers keep the EXACT per-mode color-mix
  // value; older Safari/FF get the per-mode rgba so the shadow's tint
  // survives instead of the whole declaration being dropped.
  const scoped = withColorMixFallback(
    theme.cssVariables.replace(/^:root\s*\{/, `.${scopeClass} {`),
    `.${scopeClass}`,
    primary500
  );
  // Apply the theme's `font-family` + base body color to the scope
  // root so unstyled descendants (h1-h6 / button / etc — primitives
  // that don't explicitly set `font-family`) inherit the active
  // theme's sans stack instead of the user-agent default (which is
  // Times New Roman in most browsers' default stylesheets for h1-h6).
  // Same for body color so the `--ggui-color-onGround` token
  // resolves on plain text without a Text/Heading wrapper.
  //
  // Scope root stays TRANSPARENT (no `background`). When this tree is
  // mounted inside an MCP-Apps host iframe (claude.ai, Claude Desktop)
  // the host's chat-bubble / card chrome should show through — the
  // generated UI is meant to layer onto whatever container the host
  // provides, not paint its own opaque page surface. Primitives that
  // need a real surface (Card, Modal, etc.) opt into
  // `var(--ggui-color-ground)` or `var(--ggui-color-ground-gradient)`
  // explicitly. The standalone `/r/<shortCode>` viewer that ships with
  // OSS bakes its OWN page-level background in the shell HTML for the
  // direct-browser case.
  const baseInherits = baseInheritsRule(scopeClass);
  // Gradient + effect tokens primitives can opt-in to for premium accents.
  // `--ggui-color-primary-gradient` is a confident left-to-right
  // primary-500 → primary-600 ramp suitable for hero CTAs (no color-mix —
  // valid everywhere). `--ggui-color-ground-gradient` /
  // `--ggui-effect-glow-primary` / `--ggui-effect-glow-primary-strong`
  // bake `color-mix()`, so they ship a static fallback + an `@supports`
  // modern tier (see `buildGradientTokens`).
  const gradientTokens = buildGradientTokens(scopeClass, primary500);
  // Frameless themes (`$metadata.frameless`): the embedding host draws
  // the card silhouette (rim / rounded clip mask), so a stroke on the
  // document's ROOT layer gets its corners amputated by the mask. The
  // suppression targets only the scope's direct children (the mounted
  // component's outermost element(s)); inner-container strokes are
  // untouched. `:where()` keeps specificity at zero; `!important` is
  // required because generated components carry inline styles.
  const framelessRule =
    theme.metadata?.frameless === true ? framelessSuppressionRule(scopeClass) : '';
  return `${scoped}\n${baseInherits}\n${gradientTokens}\n${theme.cssKeyframes}\n${structuralScaffolding(scopeClass)}${framelessRule}`;
}

/**
 * The frameless silhouette rule (`$metadata.frameless` on a compiled
 * theme; `frameless: true` on a per-app theme overlay — ggui#987 §3.3):
 * the embedding host draws the card silhouette (rim / rounded clip
 * mask), so a stroke on the document's ROOT layer gets its corners
 * amputated by the mask. Targets only the scope's direct children (the
 * mounted component's outermost element(s)); inner-container strokes
 * are untouched. `:where()` keeps specificity at zero; `!important` is
 * required because generated components carry inline styles. ONE
 * string for both transports — the renderer appends this exact rule
 * for an overlay that declares `frameless`.
 */
export function framelessSuppressionRule(scopeClass: string): string {
  return `\n.${scopeClass} > :where(:not(style)) { border: none !important; }`;
}

/**
 * The expanded frame (ggui#1083 cut 2; the expanded-frame direction v1.2):
 * inside a host's canvas panel the panel carries the one chrome, and the card fills it.
 *
 * - Its OUTER radius is the theme's `xl` radius stop, in every bucket. That is the rule the guuey
 *   widget pins its panel table to (guuey `33afd73d0`, `panel-radius-sync.test.ts`: none 0 / soft
 *   16 / round 24 = the forwarded `xl`), so the two sides read one definition.
 * - Its INSET is the host's panel gap. guuey's `panelGap` default (16 px, guuey#1245) is a
 *   cross-fleet constant: a builder's custom gap is invisible inside the frame, and concentricity
 *   is then off by (gap − 16) px, visible only on the `round` bucket (24 − 16 = 8 px inner corner).
 */
export const EXPANDED_FRAME = { outerRadiusVar: '--ggui-shape-radius-xl', insetPx: 16 } as const;

/** A first-level surface inset by the frame: concentric with the panel's corner — max(0, R − inset). */
export const EXPANDED_FRAME_INNER_RADIUS = `max(0px, calc(var(${EXPANDED_FRAME.outerRadiusVar}) - ${EXPANDED_FRAME.insetPx}px))`;

/**
 * What bleeds inside the expanded frame (ggui#1083 cut 2, the founder's pick (B)): an element
 * that declares `bleed`, and a `surface="hero"` band that is the fill surface's FIRST child.
 * The second is inferred from position, not declared by the card, so a card served before
 * `bleed` existed keeps its opening hero band edge to edge.
 */
export const EXPANDED_FRAME_BLEEDS = '[data-ggui-bleed], [data-ggui-surface="hero"]:first-child';

/**
 * The scrim a host stand-in paints under the expanded frame (ggui#1083 cut 1 → cut 3): the theme's
 * `scrim.tone` at its `scrim.opacity` over the mode's `neutral-50` — the ground a frosted host puts
 * under the card (the embedding shell mixes the same tint at the same opacity over the host page,
 * `--guuey-widget-scrim-{tint,opacity}` ← AppTheme `scrim`). Declarations for a page's `body`, so the
 * judge's page and the served-preview harness sit the card on one scrim.
 */
export function expandedFrameScrimDecls(): string {
  return `background: ${expandedFrameScrim('var(--ggui-color-neutral-50, #ffffff)')};`;
}
/**
 * The scrim's colour over a ground of the caller's: the theme's tint at its opacity, mixed over `over` —
 * a stand-in page mixes over its own ground (`expandedFrameScrimDecls`); a replica with a host page
 * behind it mixes over `transparent` and adds the blur only a host page can be behind.
 */
export function expandedFrameScrim(over: string): string {
  return (
    'color-mix(in oklch, var(--ggui-scrim-tint, var(--ggui-color-ground, #ffffff)) ' +
    `calc(var(--ggui-scrim-opacity, 0.45) * 100%), ${over})`
  );
}
/**
 * The panel chrome a host draws around the expanded frame (ggui#1083 cut 3, ggui#1067 §5): what the
 * visitor sees between the scrim and the fill card. The embedding shell's canvas panel is
 * `rounded-panel shadow-sm ring-1 ring-guuey-ink/[0.06]` at the theme's `shape.radius` bucket; this is
 * that chrome read from the AppTheme bucket the card composes with, so a stand-in and the shell agree:
 *  - radius: the frame's own outer radius (`EXPANDED_FRAME.outerRadiusVar`, the `xl` stop the shell's
 *    panel table pins to — none 0 / soft 16 / round 24);
 *  - hairline: the theme's ink on its ground at the shell's 6 %, as a 1 px ring (`onGround` follows the
 *    mode, as the shell's ink does);
 *  - elevation: the `sm` shadow stop (the shell's `shadow-sm`, the "SUBTLE" call);
 *  - ground: the mode's `neutral-50` — the stand-in host's own panel colour, visible only under a card
 *    that paints no ground of its own;
 *  - `overflow: clip`, so the card's square corners take the panel's — clip, never hidden/auto: a
 *    scroll container would swallow the overflow a judge measures on the document.
 *
 * Rule 0 holds: ggui's runtime NEVER composes this (the fill rule strips the card's own silhouette;
 * a second chrome is the frame-in-frame fault). Its one keyed exception is a chat-width card on a
 * fullscreen surface ({@link resolveMountFit} → `framed-card`): no host frame exists round that card,
 * so the runtime composes the card's own frame ({@link cardFitRule}) — one frame, not two. It exists for the surfaces that STAND IN for a host —
 * the judge's page and the served-preview harness — so the frame the founder approves carries the
 * hairline, radius and elevation the visitor sees.
 */
export const EXPANDED_FRAME_CHROME = {
  radius: `var(${EXPANDED_FRAME.outerRadiusVar})`,
  hairline: 'color-mix(in srgb, var(--ggui-color-onGround) 6%, transparent)',
  shadowVar: '--ggui-shape-shadow-sm',
  ground: 'var(--ggui-color-neutral-50)',
} as const;
/** The panel's own declarations — one string for every host stand-in (a judge's div, a harness's iframe panel). */
export function expandedFramePanelDecls(): string {
  const c = EXPANDED_FRAME_CHROME;
  return `border-radius: ${c.radius}; box-shadow: 0 0 0 1px ${c.hairline}, var(${c.shadowVar}); background: ${c.ground}; overflow: clip;`;
}
/**
 * A judge page's panel (ggui#1083 cut 3): the scope mounts INSIDE a panel that sits the frame's gap in
 * from the page's edges and grows with the card, so a full-page capture unrolls what the visitor
 * scrolls inside the panel. Inside it the scope's frame IS the panel, so its anchor moves from `100vh`
 * to the panel's height, `100vh − 2·gap` — still a viewport length, never a percentage (ggui#1073).
 * Specificity does the ordering: `.panel > .scope` (0,2,0) outranks the fill rule's `.scope` anchor,
 * and `body > .panel` (0,1,1) outranks its `:has(> .scope) { margin: 0 }` (which zeroes the runtime's
 * mount list; here the scope's parent is the panel, and the margin is the gap).
 */
export function expandedFramePanelRule(panelClass: string, scopeClass: string): string {
  const gap = EXPANDED_FRAME.insetPx;
  return [
    '',
    `.${panelClass} { ${expandedFramePanelDecls()} }`,
    `body > .${panelClass} { margin: ${gap}px; }`,
    `.${panelClass} > .${scopeClass} { min-height: calc(100vh - ${2 * gap}px); }`,
  ].join('\n');
}

/**
 * The `fit: 'fill'` rule (ggui#1041): inside a host's canvas the mounted root
 * is the whole surface — no border, radius or shadow of its own, and it fills
 * the page. The host's panel carries the one chrome.
 */
export function fillFitRule(scopeClass: string): string {
  const s = scopeClass;
  const strip = 'border: none !important; border-radius: 0 !important; box-shadow: none !important;';
  const inset = `${EXPANDED_FRAME.insetPx}px`;
  return [
    '',
    // The chain above the scope is the host's frame: the runtime's mount list
    // (a bare <ul>: 16 px margins, padding, bullets) and the document margins
    // must not add to the canvas (ggui#1073 — the fill measured 414 px in an
    // 836 px frame because 100 % resolved against a content-sized list).
    `html:has(.${s}), html:has(.${s}) body { margin: 0; }`,
    `:has(> .${s}) { margin: 0; padding: 0; list-style: none; }`,
    // The scope is the viewport — anchored on the frame's own height, never on
    // a parent's, and a flex column so the root grows with it.
    `.${s} { min-height: 100vh; display: flex; flex-direction: column; }`,
    // The root drops its own silhouette and centring; it fills the column.
    `.${s} > :where(:not(style)) { ${strip} margin: 0 !important; max-width: none !important; flex: 1 1 auto; }`,
    // A root that is only a wrapper around ONE surface (a centring <div> round
    // a hero card) hands the fill through: the wrapper becomes a column and
    // the surface inside it is the one stripped and stretched (ggui#1073).
    // The wrapper's own inset goes with its margins, and the surface's own
    // viewport sizing (a cell's inline `min-height: 100vh`) yields to the
    // frame — the flex column fills it (ggui#1096: 884 px in an 836 frame).
    // The frame owns the surface's WIDTH too (ggui#1139): a cap the surface
    // carries (`max-width: 640px`, a centring margin) left it a 640 px strip
    // on a 768 px md frame, left-aligned because the column defeats the
    // wrapper's centring — the same strip the root drops. A reading measure
    // belongs on a column INSIDE the surface, as on the root.
    `.${s} > :where(:not(style)):has(> :only-child) { display: flex; flex-direction: column; padding: 0 !important; }`,
    `.${s} > :where(:not(style)) > :where(:only-child) { ${strip} margin: 0 !important; max-width: none !important; min-height: 0 !important; flex: 1 1 auto; }`,
    // ggui#1083 — the expanded frame's rhythm, inside the fill surface F (the root, or the one
    // surface a wrapper root hands the fill to): F keeps the frame's inset; a first-level surface
    // is concentric with the panel's corner; a bleeding element takes the inset back and meets
    // the panel's edge (square, since the panel's own corner clips it). An element bleeds when it
    // says so (`bleed`), or when it is a hero band that OPENS the card (`EXPANDED_FRAME_BLEEDS`):
    // the founder's pick (B), so the cards already served, which open on a hero band and cannot
    // learn a new prop, keep that band edge to edge.
    // ggui#1556 — a bleed moves the band's GROUND, never its content: the inset the margin takes
    // back along the inline axis is handed to the content as a transparent border of the same
    // width, which the band's own ground paints under (`background-clip` defaults to the border
    // box). So every content x in the frame is the chat card's plus the inset, whatever padding
    // the card set: a heading in an opening band keeps the edge of the body and chips beside it
    // (without it, heading at 16 and chips at 32 on a pane-width canvas). A gradient or image ground
    // is POSITIONED in the padding box by default and repeats, so it would tile a seam into the two
    // strips; `background-origin: border-box` positions it over the whole element, which is exactly
    // the box it painted before the border existed. The block axis is left as it was: no edge is
    // shared there.
    // ggui#1765 — the fill surface's CONTENT sits the card's inset in from its edge (40 from the pane at the default
    // `lg` step: the host's 16 px panel gap, then the card's 24); the block axis keeps the frame's 16.
    ...fillSurfaces(s).map((f) => `${f} { padding: ${inset} ${CARD_INSET} !important; }`),
    ...fillSurfaces(s).map(
      (f) =>
        `${f} > [data-ggui-surface]:not(${EXPANDED_FRAME_BLEEDS}) { border-radius: ${EXPANDED_FRAME_INNER_RADIUS} !important; }`,
    ),
    ...fillSurfaces(s).map(
      (f) =>
        `${f} > :is(${EXPANDED_FRAME_BLEEDS}) { ${bleedInline()} border-radius: 0 !important; }`,
    ),
    ...fillSurfaces(s).map((f) => `${f} > :is(${EXPANDED_FRAME_BLEEDS}):first-child { margin-top: -${inset} !important; }`),
    ...fillSurfaces(s).map((f) => `${f} > :is(${EXPANDED_FRAME_BLEEDS}):last-child { margin-bottom: -${inset} !important; }`),
  ].join('\n');
}

/**
 * The fit's CSS for a scoped mount — the ONE selection (ggui#1765): the runtime's `composeThemeCss` and the visual
 * judge's page both call it, so neither can pick a different set of rules for a fit. `fill` takes the fill rule;
 * every other fit takes the card's one content edge, and `framed-card` also its frame (`radiusPx`, `null` = the
 * theme's `lg` radius).
 */
export function mountFitCss(scopeClass: string, fit: MountFit | undefined, radiusPx: number | null): string {
  if (fit === 'fill') return fillFitRule(scopeClass);
  return cardInsetRule(scopeClass) + (fit === 'framed-card' ? cardFitRule(scopeClass, radiusPx) : '');
}

/** The card's content inset (ggui#1765): the `lg` step by default, per app through the spacing scale. */
const CARD_INSET = 'var(--ggui-card-inset, var(--ggui-spacing-lg))';

/**
 * A bleeding element's inline declarations (ggui#1556, ggui#1765): it takes the card's inset back so its GROUND meets
 * the card's edge, hands the same width to its content as a transparent border its ground paints under, and drops its
 * own inline padding — so its content lands on the body's edge, measured from the card's edge, never inset twice.
 */
function bleedInline(): string {
  return `margin-left: calc(-1 * ${CARD_INSET}) !important; margin-right: calc(-1 * ${CARD_INSET}) !important; border-left: ${CARD_INSET} solid transparent !important; border-right: ${CARD_INSET} solid transparent !important; padding-left: 0 !important; padding-right: 0 !important; background-origin: border-box !important;`;
}

/**
 * The card's one content edge in the inline and framed fits (ggui#1765): the root insets its content by the card's
 * inset, whatever padding the generated root set, so every block's content shares one left edge (a surface's own
 * content steps in by exactly one inset); an opening hero band or a `bleed` element keeps its ground edge to edge.
 * The host draws the frame OUTSIDE the iframe; this is the card's inside, which ggui's runtime paints for every host.
 */
export function cardInsetRule(scopeClass: string): string {
  const s = scopeClass;
  return [
    '',
    `.${s} > :where(:not(style)) { padding-left: ${CARD_INSET} !important; padding-right: ${CARD_INSET} !important; }`,
    `.${s} > :where(:not(style)) > :is(${EXPANDED_FRAME_BLEEDS}) { ${bleedInline()} }`,
  ].join('\n');
}

/** The fill surface's two shapes: a root with several children, or the one child a wrapper root hands the fill to. */
function fillSurfaces(s: string): readonly string[] {
  return [`.${s} > :where(:not(style)):not(:has(> :only-child))`, `.${s} > :where(:not(style)) > :where(:only-child)`];
}

/**
 * The structural scaffolding EVERY scoped ladder needs regardless of
 * where its variables came from: border-box sizing and the
 * font-family inherit for elements user-agent stylesheets would
 * otherwise style (h1-h6, form controls).
 */
function structuralScaffolding(scopeClass: string): string {
  return `.${scopeClass} *, .${scopeClass} *::before, .${scopeClass} *::after { box-sizing: border-box; }\n.${scopeClass} h1, .${scopeClass} h2, .${scopeClass} h3, .${scopeClass} h4, .${scopeClass} h5, .${scopeClass} h6, .${scopeClass} button, .${scopeClass} input, .${scopeClass} textarea, .${scopeClass} select { font-family: inherit; }`;
}

/**
 * The size body copy is set at: the theme's `base` stop, which a host's
 * `typeScale.body.size` (or its ramp's `base`) moves. `<Text>` already reads
 * it; this is what text OUTSIDE a Text primitive inherits, instead of the
 * browser's 16px (ggui#1274). The default ladder states `16px`, so an
 * unthemed card paints what it painted before. It lands on the scope root
 * (the tree) and on a scope-less page's `body` (the judge), never on `html`:
 * a `rem` base on the root element would scale every `rem` in the card by
 * itself a second time.
 */
const BODY_COPY_SIZE = 'font-size: var(--ggui-font-size-base);';

/**
 * Apply the theme's `font-family`, body size and base body color to the
 * scope root so unstyled descendants (h1-h6 / button / etc — primitives
 * that don't explicitly set `font-family`) inherit the active theme's sans
 * stack instead of the user-agent default, plain text is set at the
 * theme's body size ({@link BODY_COPY_SIZE}), and it resolves
 * `--ggui-color-onGround` without a Text/Heading wrapper. The scope
 * root stays TRANSPARENT (no `background`): inside an MCP-Apps host
 * iframe the host's card chrome shows through; primitives that need a
 * real surface opt into `var(--ggui-color-ground)` explicitly.
 */
function baseInheritsRule(scopeClass: string): string {
  return `.${scopeClass} {
  font-family: var(--ggui-font-family-sans);
  ${BODY_COPY_SIZE}
  color: var(--ggui-color-onGround);
  background-color: transparent;
}`;
}


/**
 * Build the scoped gradient + glow effect tokens with a two-tier
 * `@supports` fallback. These tokens are emitted by the scoped helper
 * (not the theme parser), so the fallback is constructed here rather than
 * routed through {@link withColorMixFallback}: the surface-gradient mixes
 * against a SURFACE color (not `transparent`), so its old-browser fallback
 * is a FLAT surface ramp — never white/none — while the two glow tokens
 * mix against `transparent` and precompute to an exact `rgba()`.
 *
 * Modern browsers (Chrome 111+, Safari 16.2+, Firefox 113+) re-declare and
 * render the exact color-mix values; older browsers keep the static layer.
 * When no primary-500 hex resolves, only the color-mix layer is emitted
 * (no regression vs. before this fallback existed).
 */
function buildGradientTokens(
  scopeClass: string,
  primary500Hex: string | null
): string {
  const selector = `.${scopeClass}`;
  // `--ggui-color-primary-gradient` has no color-mix — always valid.
  const primaryGradient = `  --ggui-color-primary-gradient: linear-gradient(135deg, var(--ggui-color-primary-500) 0%, var(--ggui-color-primary-600) 100%);`;
  // Modern color-mix declarations (the current, exact look).
  const surfaceGradientModern = `  --ggui-color-ground-gradient: linear-gradient(180deg, var(--ggui-color-ground) 0%, color-mix(in srgb, var(--ggui-color-primary-500) 4%, var(--ggui-color-ground)) 100%);`;
  const glowModern = `  --ggui-effect-glow-primary: 0 0 0 4px color-mix(in srgb, var(--ggui-color-primary-500) 18%, transparent);`;
  const glowStrongModern = `  --ggui-effect-glow-primary-strong: 0 8px 24px -4px color-mix(in srgb, var(--ggui-color-primary-500) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--ggui-color-primary-500) 30%, transparent) inset;`;

  // Without a resolvable primary hex we can't compute the rgba fallback,
  // so emit color-mix-only (same as the pre-fix behavior).
  if (!primary500Hex) {
    return `${selector} {\n${primaryGradient}\n${surfaceGradientModern}\n${glowModern}\n${glowStrongModern}\n}`;
  }

  // STATIC fallbacks (no color-mix). Flat surface gradient never collapses
  // to white/none; glow tints precompute to exact rgba (mix-vs-transparent
  // == rgba, so identical to the modern value on modern browsers).
  const surfaceGradientFallback = `  --ggui-color-ground-gradient: linear-gradient(180deg, var(--ggui-color-ground) 0%, var(--ggui-color-ground) 100%);`;
  const glowFallback = `  --ggui-effect-glow-primary: ${precomputePrimaryColorMix(
    '0 0 0 4px color-mix(in srgb, var(--ggui-color-primary-500) 18%, transparent)',
    primary500Hex
  )};`;
  const glowStrongFallback = `  --ggui-effect-glow-primary-strong: ${precomputePrimaryColorMix(
    '0 8px 24px -4px color-mix(in srgb, var(--ggui-color-primary-500) 40%, transparent), 0 0 0 1px color-mix(in srgb, var(--ggui-color-primary-500) 30%, transparent) inset',
    primary500Hex
  )};`;

  const baseBlock = `${selector} {\n${primaryGradient}\n${surfaceGradientFallback}\n${glowFallback}\n${glowStrongFallback}\n}`;
  const modernBlock = `${COLOR_MIX_SUPPORTS} {\n  ${selector} {\n${surfaceGradientModern}\n${glowModern}\n${glowStrongModern}\n  }\n}`;
  return `${baseBlock}\n${modernBlock}`;
}

/**
 * The per-app theme's variable layers as the wire carries them (the
 * protocol's `AppTheme` is assignable): the derived `--ggui-*` projection per
 * mode, the mode-agnostic `cssVariables` above it, per-mode `@keyframes`, and
 * the frameless silhouette flag.
 */
export interface ThemeOverlayLayers {
  readonly overlays: {
    readonly light?: Readonly<Record<string, string>>;
    readonly dark?: Readonly<Record<string, string>>;
  };
  readonly cssVariables?: Readonly<Record<string, string>>;
  readonly keyframes?: { readonly light?: string; readonly dark?: string };
  readonly frameless?: boolean;
  /**
   * The faces the theme DECLARES (ggui#1093 / #990 — protocol's
   * `AppTheme.fonts`): rendered as `@font-face` rules by the two
   * DOCUMENT-level layers (`page`, `chrome`) and never by the scoped
   * `tree` block, because `@font-face` is a top-level at-rule no scope
   * contains. Nothing is fetched here: a face whose `src` the document's
   * CSP refuses falls back down the family's stack.
   */
  readonly fonts?: ReadonlyArray<FontFaceDeclaration>;
}

export interface ComposeThemeCssOptions {
  /** A registered theme id — the compiled ladder; absent ⇒ the default theme. */
  readonly themeId?: string;
  /** The effective mode (the host owns it); absent ⇒ light. */
  readonly mode?: ThemeMode;
  /**
   * Which stylesheet is being composed:
   *  - `tree`  — the scoped block that mounts INSIDE the scope div (needs
   *    `scopeClass`): ladder < hostPalette < overlays[mode] < cssVariables <
   *    cssOverrides, then the mode's keyframes and the frameless rule;
   *  - `chrome` — the `:root` block for the embedding shell's body chrome
   *    (`color-scheme` + the same variable layers; no keyframes, no overrides);
   *  - `page`  — a standalone document with no scope (an evaluator's shell):
   *    `chrome` plus the mode's keyframes, so the page paints what the tree
   *    would.
   */
  readonly layer: 'tree' | 'chrome' | 'page';
  readonly scopeClass?: string;
  /** Host-announced palette, already on `--ggui-*` keys — the fallback layer under the app theme. */
  readonly hostPalette?: Readonly<Record<string, string>>;
  readonly appTheme?: ThemeOverlayLayers;
  /** Verbatim CSS the caller appends between the variable layers and the trailing rules (`tree` only). */
  readonly cssOverrides?: string;
  /**
   * How the mounted root sits on its surface (`tree` only); the value comes from
   * {@link resolveMountFit}. `fill` — the host shows this page as the whole of a canvas
   * (an MCP Apps `displayMode` of `fullscreen`): the root loses its own silhouette (border,
   * radius, shadow) and fills the page, because the host's panel is the chrome. `framed-card` —
   * a chat-width card on a fullscreen surface keeps its natural height inside the card frame
   * composed here. `card` — the inline mount, nothing composed. Absent ≡ `card`.
   */
  readonly fit?: MountFit;
}

/** `{ '--ggui-a': '1', '--ggui-b': '2' }` → `--ggui-a: 1;--ggui-b: 2;` */
export function toCssDecls(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}: ${v};`)
    .join('');
}

/**
 * The ONE composition of a theme into CSS — the iframe runtime's scoped block
 * and its `:root` chrome block, and an evaluator's page, are three calls of
 * this function, never three compositions. A judge that composed its own
 * would drift from the runtime again (that drift painted an ink-on-ink hero
 * that a judge scored readable).
 */
export function composeThemeCss(opts: ComposeThemeCssOptions): string {
  const m: ThemeMode = opts.mode ?? 'light';
  // The mode overlay is COMPLETED from its own colours before it is layered
  // (ggui#1043): a role the overlay does not state — the hero pair, the
  // primary / tone container pairs, an accent for a swapped ground — is
  // derived from what it does state, never left to the ladder beneath, which
  // painted the default theme's hero ground under a rep app's brand.
  const overlay = opts.appTheme?.overlays[m];
  const layers = opts.appTheme
    ? [overlay === undefined ? undefined : completeThemeVariables(overlay, m), opts.appTheme.cssVariables].filter(
        (vars): vars is Readonly<Record<string, string>> => vars !== undefined
      )
    : [];
  if (opts.layer === 'tree') {
    const scope = opts.scopeClass;
    if (scope === undefined || scope === '') {
      throw new Error("composeThemeCss: layer 'tree' needs a scopeClass");
    }
    let css = opts.themeId ? getScopedThemeCss(opts.themeId, scope, m) : getScopedCssTokens(scope, m);
    if (opts.hostPalette) css += `.${scope}{${toCssDecls(opts.hostPalette)}}`;
    css += layers.map((vars) => `.${scope}{${toCssDecls(vars)}}`).join('');
    css += opts.cssOverrides ?? '';
    if (opts.appTheme) {
      css += `${opts.appTheme.keyframes?.[m] ?? ''}${opts.appTheme.frameless === true ? framelessSuppressionRule(scope) : ''}`;
    }
    css += mountFitCss(scope, opts.fit, opts.fit === 'framed-card' ? inlineCardRadius({ ...(overlay ?? {}), ...(opts.appTheme?.cssVariables ?? {}) }).radiusPx : null);
    return css;
  }
  let css = opts.themeId ? getThemeCss(opts.themeId, m) : getCssTokens(m);
  if (opts.hostPalette) css += `:root{${toCssDecls(opts.hostPalette)}}`;
  css += `:root{color-scheme:${m};${layers.map(toCssDecls).join('')}}`;
  // A page has no scope root, so its body takes the size the tree's scope root
  // sets: the judge reads body copy at the size a visitor reads it (ggui#1274).
  if (opts.layer === 'page') css += `body{${BODY_COPY_SIZE}}`;
  if (opts.layer === 'page' && opts.appTheme) css += opts.appTheme.keyframes?.[m] ?? '';
  // The declared faces ride the DOCUMENT-level layers (ggui#1093): the family
  // the theme names loads wherever the theme is composed — the runtime's
  // `:root` chrome block when a theme arrives or changes after the shell was
  // served, and an evaluator's page, which until now painted a fallback family
  // and scored typography the visitor never saw. Absent ⇒ byte-identical.
  //
  // A face the grammar cannot render is SKIPPED here, never thrown over
  // (ggui#1110): the write door refuses a malformed face, so one in a stored
  // theme arrived through an older door — and it must cost that face alone,
  // not the composition, and not the evaluation round doing the composing.
  const faces = opts.appTheme?.fonts?.filter(isRenderableFontFace);
  if (faces !== undefined && faces.length > 0) css += fontFaceRules(faces);
  return css;
}


// ─── Mount fit: how a mounted card sits on its host surface ─────────────────

/**
 * The rendering canvases a card is generated for and judged at. A class is derived from the host's
 * display mode plus width, never from width alone: an inline chat-width card is `xs-chat-card`
 * whatever the window measures; a fullscreen surface follows its width through the breakpoints.
 * Defined once here so the runtime, the generator and the evaluator read one vocabulary.
 */
export const CANVAS_CLASSES = ['xs-chat-card', 'mobile-fullscreen-small', 'md', 'lg', 'xl'] as const;
export type CanvasClass = (typeof CANVAS_CLASSES)[number];

/** Whether an untrusted value (a compiled bundle's export) is a canvas class. */
export function isCanvasClass(value: unknown): value is CanvasClass {
  return CANVAS_CLASSES.some((c) => c === value);
}

/**
 * The display mode a host announces for a view (MCP Apps `hostContext.displayMode`, the values of
 * `ui/request-display-mode`).
 */
export type HostDisplayMode = 'inline' | 'fullscreen' | 'pip';

/**
 * How the mounted root sits on its surface:
 * - `card` — the inline mount: the root keeps its natural height and the host draws the card's
 *   frame round it, outside the iframe. Inside it, the runtime composes only the card's one content
 *   edge ({@link cardInsetRule}, ggui#1765): the root's content sits `--ggui-card-inset` in from the
 *   card's edge, for every host, and an opening hero band keeps its ground edge to edge.
 * - `framed-card` — a chat-width card on a fullscreen surface: the root keeps its natural height
 *   and the runtime composes the card's frame round it ({@link cardFitRule}) and the same content
 *   edge inside it ({@link cardInsetRule}).
 * - `fill` — the host shows the page as the whole of a canvas: the root drops its own silhouette
 *   and fills the page, because the host's panel is the chrome ({@link fillFitRule}).
 */
export type MountFit = 'card' | 'framed-card' | 'fill';

/**
 * The named export a compiled card bundle carries its canvas class in. The generator emits it
 * (`export const gguiMountCanvas = '<class>'`) and the runtime reads it beside the default export.
 */
export const GGUI_MOUNT_CANVAS_EXPORT = 'gguiMountCanvas' as const;

/**
 * The ONE fit rule, read by the runtime's composition, the evaluator's capture and the evaluator's
 * frame statement, so none can disagree with the others.
 *
 * - Not fullscreen → `card` (the inline mount; the host draws the frame).
 * - Fullscreen + a chat-width card (`xs-chat-card`) → `framed-card`: the card stays the size of its
 *   content, at the top of the surface, in its own frame. This is the one keyed exception to the
 *   rule that the runtime never composes a card's chrome ({@link EXPANDED_FRAME_CHROME}): on that
 *   surface no host frame exists round the card, so there is one frame, not two.
 * - Fullscreen + any other canvas, OR an unknown or absent canvas → `fill`. This fails closed: a
 *   bundle compiled before it carried {@link GGUI_MOUNT_CANVAS_EXPORT}, or carrying a value that is
 *   not a {@link CanvasClass}, is composed exactly as before.
 *
 * Two absents, kept apart: an absent `canvas` (no export in the bundle) means `fill` under
 * fullscreen; an absent `displayMode` (the host announced none) means the inline mount.
 */
export function resolveMountFit(input: { readonly canvas: unknown; readonly displayMode: HostDisplayMode | undefined }): MountFit {
  if (input.displayMode !== 'fullscreen') return 'card';
  return isCanvasClass(input.canvas) && input.canvas === 'xs-chat-card' ? 'framed-card' : 'fill';
}

/** A radius bucket: the shape family an app theme's radius ladder belongs to. */
export const RADIUS_BUCKETS = ['none', 'soft', 'round'] as const;
export type RadiusBucket = (typeof RADIUS_BUCKETS)[number];

/**
 * The radius ladders (sm / md / lg / xl, in px) a host forwards into an app theme, one per bucket.
 * Distinct, so a ladder names its bucket. Their `xl` stops are the expanded frame's outer radius.
 */
export const RADIUS_LADDERS: Readonly<Record<RadiusBucket, readonly [number, number, number, number]>> = {
  none: [0, 0, 0, 0],
  soft: [4, 8, 12, 16],
  round: [8, 12, 18, 24],
};

/**
 * The inline card frame by bucket: its corner radius (a table, not a ladder stop — soft's 10 px is
 * on no ladder) and its ring, a hairline of the card's ink.
 */
export const INLINE_CARD_RADIUS_PX: Readonly<Record<RadiusBucket, number>> = { none: 0, soft: 10, round: 18 };
export const INLINE_CARD_RING = { widthPx: 1, alpha: 0.08 } as const;

/** The token names the inline card frame reads from an app theme. */
export const INLINE_CARD_FRAME_VARS = {
  ground: '--ggui-color-ground',
  surface: '--ggui-color-container',
  ink: '--ggui-color-onContainer',
  radius: ['--ggui-shape-radius-sm', '--ggui-shape-radius-md', '--ggui-shape-radius-lg', '--ggui-shape-radius-xl'],
} as const;

/** The bucket whose ladder equals the theme's sm / md / lg / xl radii exactly; `null` for any other ladder (never the nearest). */
export function recoverRadiusBucket(ladderPx: readonly (number | null)[]): RadiusBucket | null {
  for (const bucket of RADIUS_BUCKETS) {
    if (RADIUS_LADDERS[bucket].every((stop, i) => ladderPx[i] === stop)) return bucket;
  }
  return null;
}

/** `'12px'` → 12; anything else (a var, a `rem`, absent) → null. */
export function pxValue(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(value.trim());
  return m === null ? null : Number(m[1]);
}

/**
 * The inline card's frame radius for an app theme's variables: the bucket's inline radius when the
 * theme's ladder is one of {@link RADIUS_LADDERS}; otherwise the theme's own `lg` radius, the stop
 * the design system's card wears (`source: 'theme-lg'`). Absent or unreadable both → `null`
 * radius px, and the frame keeps the `lg` token as a CSS value.
 */
export function inlineCardRadius(vars: Readonly<Record<string, string>>): {
  readonly bucket: RadiusBucket | null;
  readonly radiusPx: number | null;
  readonly source: 'bucket' | 'theme-lg';
} {
  const bucket = recoverRadiusBucket(INLINE_CARD_FRAME_VARS.radius.map((name) => pxValue(vars[name])));
  if (bucket !== null) return { bucket, radiusPx: INLINE_CARD_RADIUS_PX[bucket], source: 'bucket' };
  return { bucket: null, radiusPx: pxValue(vars['--ggui-shape-radius-lg']), source: 'theme-lg' };
}

/**
 * The ground under a framed card: the host's sunken pane ground, painted round the card so its edge
 * reads against the room it sits in. The runtime paints it as the document's backdrop (through the
 * render shell's `--ggui-shell-background` override point); a judge's page paints the same token
 * under the card. One constant, so the two cannot drift.
 */
export const FRAMED_CARD_GROUND = 'var(--ggui-color-sunken)';

/**
 * The `fit: 'framed-card'` rule: the root keeps its natural height at the top of
 * the page, inset by the frame's gap, and wears the inline card's frame — the theme's container
 * surface, a 1 px ring of its ink, the bucket's corner radius, its content clipped to that radius,
 * no shadow. `radiusPx` comes from {@link inlineCardRadius}; `null` falls back to the theme's `lg`
 * radius token. The page round it is the host's ground.
 */
export function cardFitRule(scopeClass: string, radiusPx: number | null): string {
  const s = scopeClass;
  const v = INLINE_CARD_FRAME_VARS;
  const radius = radiusPx === null ? 'var(--ggui-shape-radius-lg)' : `${radiusPx}px`;
  const ringPct = Math.round(INLINE_CARD_RING.alpha * 100);
  return [
    '',
    `html:has(.${s}), html:has(.${s}) body { margin: 0; }`,
    // The document's backdrop is the room's ground. The render shell stamps its backdrop inline as a
    // `var(--ggui-shell-background, …)`, so setting the property repaints it in place.
    `html:has(.${s}) { --ggui-shell-background: ${FRAMED_CARD_GROUND}; }`,
    `:has(> .${s}) { margin: 0; padding: 0; list-style: none; }`,
    `.${s} { margin: ${EXPANDED_FRAME.insetPx}px; background: var(${v.surface}); border: ${INLINE_CARD_RING.widthPx}px solid color-mix(in srgb, var(${v.ink}) ${ringPct}%, transparent); border-radius: ${radius}; overflow: clip; box-shadow: none; }`,
  ].join('\n');
}
