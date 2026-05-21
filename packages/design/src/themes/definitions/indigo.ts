/**
 * Indigo Theme — light + dark variants
 *
 * The flagship ggui preset. Refined electric indigo accent on a quiet
 * paper surface in light mode; deep midnight with the same indigo
 * lifted for contrast in dark mode. Designed to read as "this product
 * has taste" — restrained but distinctive, clearly authored.
 *
 * Reference points the palette is calibrated against:
 *   - Linear's electric Indigo accent on cool-paper surfaces.
 *   - Vercel's monochrome restraint with one bold accent.
 *   - Stripe's confident violet without the saturation bloat.
 *
 * Palette anchors:
 *   - **Indigo** — `#5b5bf2`. The accent. Cool, vivid, lifted toward
 *     cobalt rather than royal-purple. Used as `primary-500`.
 *   - **Paper** — `#fafaf7`. Light surface. A whisper of warm tint
 *     keeps it from feeling clinical; never bluish-white.
 *   - **Ink** — `#15131f`. Near-black with a violet undertone.
 *     Anchors text in light mode and the deepest text in dark.
 *   - **Midnight** — `#0c0b14`. Dark-mode surface base — rich rather
 *     than flat-black, a touch warmer than a pure cool-black.
 *
 * Shadow tokens use `color-mix()` against `--ggui-color-primary-500`
 * so elevation carries an indigo halo. Visible in both light and dark
 * — a pure-black shadow on midnight disappears.
 *
 * Canvas mode is `'ambient'`: a very subtle background motion (slow,
 * 8s breathing). On-brand for the "this is the flagship" feel
 * without being attention-stealing the way a wave gradient would be.
 */

import type { DtcgTheme } from '../types';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
const shared = {
  font: {
    family: {
      // Modern sans, guaranteed-native on every platform without
      // webfont loading. Order chosen to maximise visual quality:
      //   1. `Inter Variable` / `Inter` — if loaded by the host
      //      (claude.ai already loads Inter for its own UI)
      //   2. `system-ui` — SF Pro on macOS/iOS, Segoe UI Variable on
      //      Windows 11, Roboto on Android. All modern + beautiful.
      //   3. Explicit Apple/Windows fallbacks for older browsers.
      //   4. Generic `sans-serif` as the floor (never serif).
      sans: {
        $value:
          '"Inter Variable", "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI Variable", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        $type: 'fontFamily',
      },
      mono: {
        $value:
          '"JetBrains Mono", "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.8125rem', $type: 'dimension' }, // 13px
      base: { $value: '0.9375rem', $type: 'dimension' }, // 15px
      lg: { $value: '1.0625rem', $type: 'dimension' }, // 17px
      xl: { $value: '1.3125rem', $type: 'dimension' }, // 21px — bumped for display headings
      '2xl': { $value: '1.75rem', $type: 'dimension' }, // 28px — generous display
    },
    weight: {
      normal: { $value: '400', $type: 'fontWeight' },
      medium: { $value: '500', $type: 'fontWeight' },
      semibold: { $value: '600', $type: 'fontWeight' },
      bold: { $value: '680', $type: 'fontWeight' }, // variable-axis weight; reads bold without going harsh on Inter
    },
    lineHeight: {
      tight: { $value: '1.1', $type: 'number' }, // headings
      normal: { $value: '1.55', $type: 'number' }, // body — generous, editorial
      relaxed: { $value: '1.7', $type: 'number' },
    },
  },

  spacing: {
    '1': { $value: '0.25rem', $type: 'dimension' },
    '2': { $value: '0.5rem', $type: 'dimension' },
    '3': { $value: '0.75rem', $type: 'dimension' },
    '4': { $value: '1rem', $type: 'dimension' },
    '5': { $value: '1.25rem', $type: 'dimension' },
    '6': { $value: '1.5rem', $type: 'dimension' },
    '8': { $value: '2rem', $type: 'dimension' },
    '10': { $value: '2.5rem', $type: 'dimension' },
    '12': { $value: '3rem', $type: 'dimension' },
    xs: { $value: '0.25rem', $type: 'dimension' },
    sm: { $value: '0.5rem', $type: 'dimension' },
    md: { $value: '1rem', $type: 'dimension' },
    lg: { $value: '1.5rem', $type: 'dimension' },
    xl: { $value: '2rem', $type: 'dimension' },
    '2xl': { $value: '3rem', $type: 'dimension' },
  },

  shape: {
    // Generous radii — Linear/Arc-grade pillowy surfaces.
    // `md` is the load-bearing button + card radius.
    radius: {
      sm: { $value: '0.5rem', $type: 'dimension' }, // 8px — small chips
      md: { $value: '0.875rem', $type: 'dimension' }, // 14px — buttons, inputs
      lg: { $value: '1.125rem', $type: 'dimension' }, // 18px — cards
      xl: { $value: '1.5rem', $type: 'dimension' }, // 24px — modals, hero cards
      full: { $value: '9999px', $type: 'dimension' },
    },
    // Atmospheric shadows tinted with the indigo accent. `md` is the
    // canonical card elevation; `lg`/`xl` step up for floating surfaces
    // (modals, popovers, hero panels).
    shadow: {
      sm: {
        $value:
          '0 1px 2px color-mix(in srgb, var(--ggui-color-primary-500) 6%, transparent)',
        $type: 'shadow',
      },
      md: {
        $value:
          '0 1px 3px rgba(21, 19, 31, 0.06), 0 8px 24px -6px color-mix(in srgb, var(--ggui-color-primary-500) 16%, transparent)',
        $type: 'shadow',
      },
      lg: {
        $value:
          '0 2px 6px rgba(21, 19, 31, 0.05), 0 20px 40px -10px color-mix(in srgb, var(--ggui-color-primary-500) 22%, transparent)',
        $type: 'shadow',
      },
      xl: {
        $value:
          '0 4px 10px rgba(21, 19, 31, 0.04), 0 32px 64px -16px color-mix(in srgb, var(--ggui-color-primary-500) 28%, transparent)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    duration: {
      fast: { $value: '150ms', $type: 'duration' },
      normal: { $value: '250ms', $type: 'duration' },
      slow: { $value: '420ms', $type: 'duration' },
      ambient: { $value: '8000ms', $type: 'duration' }, // background breathing
    },
    easing: {
      // Linear's signature easing — confident, slightly overshoots arrival.
      default: {
        $value: 'cubic-bezier(0.32, 0.72, 0, 1)',
        $type: 'cubicBezier',
      },
      spring: {
        $value: 'cubic-bezier(0.16, 1, 0.3, 1)',
        $type: 'cubicBezier',
      },
    },
    keyframes: {
      entrance: {
        $value:
          '0%{opacity:0;transform:translateY(6px)}100%{opacity:1;transform:none}',
        $type: 'keyframes',
      },
    },
  },
} as const;

// Indigo-centered primary ladder — the brand accent.
// Step 500 is the brand Indigo `#4f46e5` — deep, confident, not too
// "bright". 600 darkens for hover/active. 50-100 are pale violet
// whispers for hover surfaces + container roles. Tuned against
// Linear/Vercel/Stripe accents with a touch more saturation in the
// 200-400 band so secondary chips read alive on paper.
const primaryLadder = {
  '50': { $value: '#eef2ff', $type: 'color' },
  '100': { $value: '#e0e7ff', $type: 'color' },
  '200': { $value: '#c7d2fe', $type: 'color' },
  '300': { $value: '#a5b4fc', $type: 'color' },
  '400': { $value: '#818cf8', $type: 'color' },
  '500': { $value: '#4f46e5', $type: 'color' }, // Indigo (brand) — deeper, confident
  '600': { $value: '#4338ca', $type: 'color' }, // hover/active
  '700': { $value: '#3730a3', $type: 'color' },
  '800': { $value: '#312e81', $type: 'color' },
  '900': { $value: '#1e1b4b', $type: 'color' },
} as const;

// ── Indigo — Light ─────────────────────────────────────────────────
//
// Paper surface, deep ink text, indigo accent. Quiet but premium.
const indigoLight: DtcgTheme = {
  $name: 'Indigo',
  $description:
    'Flagship ggui preset — refined electric indigo on a quiet paper surface. Premium, restrained, distinctive.',
  $metadata: {
    font: 'inter',
    philosophy:
      'Looks like a deliberate aesthetic choice. Linear/Arc/Vercel-grade restraint with one confident accent.',
  },

  color: {
    primary: { ...primaryLadder },
    // Cool-warm neutral ladder — slightly violet-tinted at the deep end
    // (so dark text doesn't fight the indigo accent), neutral at the
    // light end. Reads "paper" not "screen".
    neutral: {
      '50': { $value: '#fafaf7', $type: 'color' }, // Paper (surface)
      '100': { $value: '#f4f4f0', $type: 'color' }, // surface variant
      '200': { $value: '#e8e7e3', $type: 'color' }, // outline variant
      '300': { $value: '#d4d3cf', $type: 'color' }, // outline
      '400': { $value: '#9c9ba0', $type: 'color' }, // muted text
      '500': { $value: '#6e6d74', $type: 'color' }, // body muted
      '600': { $value: '#4a4954', $type: 'color' },
      '700': { $value: '#322f3e', $type: 'color' },
      '800': { $value: '#211f2c', $type: 'color' },
      '900': { $value: '#15131f', $type: 'color' }, // Ink (text)
    },
    // Vivid semantic ladder. Tuned to harmonize with the indigo accent.
    success: { $value: '#0e9d6e', $type: 'color' }, // emerald
    warning: { $value: '#e08515', $type: 'color' }, // amber
    error: { $value: '#dc2845', $type: 'color' }, // rose
    info: { $value: '#0891b2', $type: 'color' }, // cyan

    surface: { $value: '#fafaf7', $type: 'color' }, // Paper
    onSurface: { $value: '#15131f', $type: 'color' }, // Ink
    surfaceVariant: { $value: '#f4f4f0', $type: 'color' },
    onSurfaceVariant: { $value: '#4a4954', $type: 'color' },
    container: { $value: '#eef2ff', $type: 'color' }, // primary-50 — pale indigo whisper
    onContainer: { $value: '#1e1b4b', $type: 'color' }, // primary-900
    outline: { $value: '#d4d3cf', $type: 'color' },
    outlineVariant: { $value: '#e8e7e3', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    // Very subtle ambient breathing — primary-tinted halo gradient
    // with low opacity, slow oscillation. Premium, never flashy.
    mode: { $value: 'mesh', $type: 'string' },
    speed: { $value: 0.5, $type: 'number' },
    colors: {
      $value: ['#eef2ff', '#fafaf7', '#e0e7ff'],
      $type: 'array',
    },
    background: { $value: '#fafaf7', $type: 'color' }, // Paper
  },
};

// ── Indigo — Dark ──────────────────────────────────────────────────
//
// Midnight surface, paper text, indigo accent lifted for contrast.
const indigoDark: DtcgTheme = {
  $name: 'Indigo',
  $description:
    'Flagship ggui preset (dark) — refined electric indigo on rich midnight. Premium, restrained, distinctive.',
  $metadata: {
    font: 'inter',
    philosophy:
      'Looks like a deliberate aesthetic choice. Linear/Arc/Vercel-grade restraint with one confident accent.',
  },

  color: {
    // Indigo lifted ~two steps lighter for AA contrast on midnight.
    primary: {
      '50': { $value: '#1e1b4b', $type: 'color' },
      '100': { $value: '#312e81', $type: 'color' },
      '200': { $value: '#3730a3', $type: 'color' },
      '300': { $value: '#4338ca', $type: 'color' },
      '400': { $value: '#4f46e5', $type: 'color' },
      '500': { $value: '#818cf8', $type: 'color' }, // shifted lighter for dark — Indigo-400
      '600': { $value: '#a5b4fc', $type: 'color' },
      '700': { $value: '#c7d2fe', $type: 'color' },
      '800': { $value: '#e0e7ff', $type: 'color' },
      '900': { $value: '#eef2ff', $type: 'color' },
    },
    // Inverted neutral ladder — keeps the cool-violet undertone.
    neutral: {
      '50': { $value: '#0c0b14', $type: 'color' }, // Midnight (background)
      '100': { $value: '#15131f', $type: 'color' }, // surface
      '200': { $value: '#1d1b29', $type: 'color' }, // surface variant
      '300': { $value: '#2a2839', $type: 'color' }, // outline
      '400': { $value: '#3e3c50', $type: 'color' },
      '500': { $value: '#5e5c70', $type: 'color' }, // muted
      '600': { $value: '#8b8898', $type: 'color' },
      '700': { $value: '#b8b6c2', $type: 'color' },
      '800': { $value: '#dcdbe2', $type: 'color' },
      '900': { $value: '#f5f4f9', $type: 'color' }, // Paper-on-dark (text)
    },
    success: { $value: '#34d399', $type: 'color' },
    warning: { $value: '#f59e0b', $type: 'color' },
    error: { $value: '#fb7185', $type: 'color' },
    info: { $value: '#22d3ee', $type: 'color' },

    // Surface tiers tuned for clearer visual hierarchy in dark mode.
    // Earlier values had surface (#15131f) and surfaceVariant
    // (#1d1b29) at ~3% RGB delta — elevated/sunken cards were
    // indistinguishable from default. Variant is now #221e35 (visible
    // 1-tier step) and outline #3e3c50 (matches neutral-400, gives
    // borders a hairline visibility on dark).
    surface: { $value: '#15131f', $type: 'color' },
    onSurface: { $value: '#f5f4f9', $type: 'color' },
    surfaceVariant: { $value: '#221e35', $type: 'color' },
    onSurfaceVariant: { $value: '#c8c6d2', $type: 'color' },
    container: { $value: '#312e81', $type: 'color' }, // primary-100 dark
    onContainer: { $value: '#eef2ff', $type: 'color' },
    outline: { $value: '#3e3c50', $type: 'color' },
    outlineVariant: { $value: '#2a2839', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'mesh', $type: 'string' },
    speed: { $value: 0.5, $type: 'number' },
    colors: {
      $value: ['#1e1b4b', '#0c0b14', '#312e81'],
      $type: 'array',
    },
    background: { $value: '#0c0b14', $type: 'color' },
  },
};

/**
 * Public registration — the registry consumes this `theme` export and
 * keys it as `'indigo'`. The (light, dark) pair is the load-bearing
 * shape; future single-mode presets register only `light`.
 */
export const theme = {
  light: indigoLight,
  dark: indigoDark,
} as const;
