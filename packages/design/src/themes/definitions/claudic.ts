/**
 * Claudic Theme — light + dark variants
 *
 * The "fits inside claude.ai" preset. The intent is that a UI rendered
 * with Claudic looks native when displayed inside claude.ai's chat —
 * same warm-neutral surface tone, same Crail/terracotta accent, same
 * deep-warm text contrast. Picking Claudic in the console /theme route
 * is the fast path for builders whose primary surface is the Claude
 * connector.
 *
 * Palette anchors (informed by Anthropic's published brand work):
 *
 * - **Crail** — `#cc785c`. The terracotta accent. Used as `primary-500`.
 *   600 darkens for hover/active. Intentionally desaturated relative to
 *   a pure orange so it reads warm-earthy, not safety-cone.
 * - **Ivory** — `#faf9f5`. Light surface base. Slight yellow undertone
 *   (≈ HSL 50/30/97) — never bluish-white. This is the load-bearing
 *   tell for "feels like claude.ai".
 * - **Slate** — `#141413`. Near-black with a warm undertone. Light-mode
 *   text + dark-mode contrast anchor. NOT pure `#000`; pure black on
 *   ivory reads metallic and breaks the warm gestalt.
 * - **Charcoal** — `#262624`. Dark-mode surface base. Warm dark
 *   counterpart to Ivory.
 *
 * Shadow tokens use `color-mix()` against `--ggui-color-primary-500` so
 * elevation carries a faint terracotta halo — matches the rest of the
 * registry and keeps dark-mode shadows readable (a pure-black shadow on
 * Charcoal disappears).
 *
 * Canvas mode is `'none'`: Claudic is meant to be quiet. The
 * GenerativeCanvas wave animation is on-brand for Indigo; here it
 * fights claude.ai's restraint.
 */

import type { DtcgTheme } from '../types';
import {
  standardAccessibility,
  standardTransitions,
  standardZIndex,
} from './_shared';

// Claudic uses bespoke durations (120/240/480ms) that diverge from the
// standard (100/200/300ms). Spread + override `fast`/`normal`/`slow`
// so transition shorthands match the theme's actual motion tempo.
// `colors`/`opacity`/`transform` keep the 200ms canonical default
// (they were intentionally pinned in standardTransitions).
const claudicTransitions = {
  ...standardTransitions,
  fast: {
    $type: 'transition',
    $value: '120ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  normal: {
    $type: 'transition',
    $value: '240ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  slow: {
    $type: 'transition',
    $value: '480ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
} as const;

// ── shared (mode-agnostic) tokens ──────────────────────────────────
//
// Anything that doesn't change between light and dark — type stack,
// spacing scale, radii, motion, canvas — lives here so the two
// variants stay in sync without copy-paste drift.
const shared = {
  font: {
    family: {
      sans: {
        $value:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
        $type: 'fontFamily',
      },
      mono: {
        $value:
          'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.875rem', $type: 'dimension' },
      base: { $value: '1rem', $type: 'dimension' },
      lg: { $value: '1.125rem', $type: 'dimension' },
      xl: { $value: '1.25rem', $type: 'dimension' },
      '2xl': { $value: '1.5rem', $type: 'dimension' },
    },
    weight: {
      normal: { $value: '400', $type: 'fontWeight' },
      medium: { $value: '500', $type: 'fontWeight' },
      semibold: { $value: '600', $type: 'fontWeight' },
      bold: { $value: '700', $type: 'fontWeight' },
    },
    lineHeight: {
      tight: { $value: '1.25', $type: 'number' },
      normal: { $value: '1.55', $type: 'number' }, // claude.ai-ish — slightly looser than Indigo
      relaxed: { $value: '1.75', $type: 'number' },
    },
  },

  // Same dual-key spacing scale as Indigo so primitives that
  // reference named keys (Card.padding=lg, Stack.gap=sm) keep working.
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
    // Claude.ai uses softer, generous radii — bubbles + cards feel
    // pillowy rather than crisp. Match the shipped Indigo ladder
    // so primitives that pin to `--ggui-shape-radius-lg` stay consistent.
    radius: {
      sm: { $value: '0.5rem', $type: 'dimension' },
      md: { $value: '0.75rem', $type: 'dimension' },
      lg: { $value: '1rem', $type: 'dimension' },
      xl: { $value: '1.5rem', $type: 'dimension' },
      full: { $value: '9999px', $type: 'dimension' },
    },
    // Atmospheric shadows tinted with the active primary (Crail) so
    // elevation reads on both ivory and charcoal. See signature.ts for
    // the layering rationale.
    shadow: {
      sm: {
        $value:
          '0 1px 3px color-mix(in srgb, var(--ggui-color-primary-500) 8%, transparent)',
        $type: 'shadow',
      },
      md: {
        $value:
          '0 1px 2px rgba(20, 20, 19, 0.04), 0 8px 16px -4px color-mix(in srgb, var(--ggui-color-primary-500) 14%, transparent)',
        $type: 'shadow',
      },
      lg: {
        $value:
          '0 2px 4px rgba(20, 20, 19, 0.04), 0 16px 32px -8px color-mix(in srgb, var(--ggui-color-primary-500) 20%, transparent)',
        $type: 'shadow',
      },
      xl: {
        $value:
          '0 4px 8px rgba(20, 20, 19, 0.04), 0 24px 48px -12px color-mix(in srgb, var(--ggui-color-primary-500) 26%, transparent)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    // Claudic is calmer than Indigo — no `ambient` 3s breathing
    // duration is exposed. Animations stay snappy + functional only.
    duration: {
      fast: { $value: '120ms', $type: 'duration' },
      normal: { $value: '240ms', $type: 'duration' },
      slow: { $value: '480ms', $type: 'duration' },
    },
    easing: {
      default: {
        $value: 'cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'cubicBezier',
      },
      spring: {
        $value: 'cubic-bezier(0.22, 1, 0.36, 1)',
        $type: 'cubicBezier',
      },
    },
    keyframes: {
      entrance: {
        $value:
          '0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:none}',
        $type: 'keyframes',
      },
    },
    transition: claudicTransitions,
  },
} as const;

// Crail-centered primary ladder (terracotta, claude.ai's accent).
// Step 500 is Crail itself; 600 is one notch darker for CTA hover.
const primaryLadder = {
  '50': { $value: '#fbf2ee', $type: 'color' },
  '100': { $value: '#f5dfd4', $type: 'color' },
  '200': { $value: '#ecbfa9', $type: 'color' },
  '300': { $value: '#df9d80', $type: 'color' },
  '400': { $value: '#d6896c', $type: 'color' },
  '500': { $value: '#cc785c', $type: 'color' }, // Crail
  '600': { $value: '#b8694f', $type: 'color' }, // hover/active
  '700': { $value: '#965240', $type: 'color' },
  '800': { $value: '#723e30', $type: 'color' },
  '900': { $value: '#4d2920', $type: 'color' },
} as const;

// ── Claudic — Light ────────────────────────────────────────────────
//
// Ivory surfaces, deep slate text. Mirrors claude.ai's daytime canvas.
const claudicLight: DtcgTheme = {
  $name: 'Claudic',
  $description:
    'Fits inside claude.ai — warm ivory surfaces, terracotta accent, calm by design.',
  $metadata: {
    font: 'system',
    philosophy:
      'Quiet, papery, conversational. Built to feel native when rendered inside claude.ai.',
  },

  color: {
    primary: { ...primaryLadder },
    // Warm-gray neutrals — yellow-tinted, never blue. Ivory at the top,
    // deep warm slate at the bottom.
    neutral: {
      '50': { $value: '#faf9f5', $type: 'color' }, // Ivory (surface)
      '100': { $value: '#f5f4ee', $type: 'color' }, // surface variant / sidebar
      '200': { $value: '#ebe9df', $type: 'color' }, // outline variant
      '300': { $value: '#dad8cc', $type: 'color' }, // outline
      '400': { $value: '#a8a59f', $type: 'color' }, // muted text
      '500': { $value: '#7c7a76', $type: 'color' }, // body muted
      '600': { $value: '#56544f', $type: 'color' },
      '700': { $value: '#3d3b39', $type: 'color' },
      '800': { $value: '#262624', $type: 'color' }, // Charcoal
      '900': { $value: '#141413', $type: 'color' }, // Slate (text)
    },
    // Semantic colors — kept in the warm family. Success skews olive
    // rather than emerald; warning is amber-orange; error is brick.
    // Each scale anchors the Claudic brand hex at `500` and ladders
    // lighter/darker around it so consumers can reference 50/100/200/
    // 600/700/800 stops with the same idiom as Tailwind-canonical scales.
    success: {
      '50': { $value: '#f4f7ec', $type: 'color' },
      '100': { $value: '#e3ecd0', $type: 'color' },
      '200': { $value: '#c8d8a5', $type: 'color' },
      '500': { $value: '#6b8e3d', $type: 'color' }, // brand: olive
      '600': { $value: '#587634', $type: 'color' },
      '700': { $value: '#465c29', $type: 'color' },
      '800': { $value: '#33431e', $type: 'color' },
    },
    warning: {
      '50': { $value: '#fbf3e3', $type: 'color' },
      '100': { $value: '#f6e2bb', $type: 'color' },
      '200': { $value: '#eac786', $type: 'color' },
      '500': { $value: '#c98e2e', $type: 'color' }, // brand: amber-orange
      '600': { $value: '#a87725', $type: 'color' },
      '700': { $value: '#825c1d', $type: 'color' },
      '800': { $value: '#5d4214', $type: 'color' },
    },
    error: {
      '50': { $value: '#f9ebe7', $type: 'color' },
      '100': { $value: '#f1cec5', $type: 'color' },
      '200': { $value: '#e3a294', $type: 'color' },
      '500': { $value: '#bc4a3a', $type: 'color' }, // brand: brick
      '600': { $value: '#9d3d30', $type: 'color' },
      '700': { $value: '#7a2f25', $type: 'color' },
      '800': { $value: '#57211a', $type: 'color' },
    },
    info: {
      '50': { $value: '#f1f0ee', $type: 'color' },
      '100': { $value: '#dedcd8', $type: 'color' },
      '200': { $value: '#bdbab4', $type: 'color' },
      '500': { $value: '#7c7a76', $type: 'color' }, // brand: neutral muted
      '600': { $value: '#65635f', $type: 'color' },
      '700': { $value: '#4d4b48', $type: 'color' },
      '800': { $value: '#363432', $type: 'color' },
    },
    // Two-tier semantic roles
    surface: { $value: '#faf9f5', $type: 'color' }, // Ivory
    onSurface: { $value: '#141413', $type: 'color' }, // Slate
    surfaceVariant: { $value: '#f5f4ee', $type: 'color' },
    onSurfaceVariant: { $value: '#56544f', $type: 'color' },
    container: { $value: '#fbf2ee', $type: 'color' }, // primary-50
    onContainer: { $value: '#4d2920', $type: 'color' }, // primary-900
    outline: { $value: '#dad8cc', $type: 'color' },
    outlineVariant: { $value: '#ebe9df', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    // No animated background — Claudic is quiet by design.
    mode: { $value: 'none', $type: 'string' },
    speed: { $value: 0, $type: 'number' },
    colors: { $value: [], $type: 'array' },
    background: { $value: '#faf9f5', $type: 'color' }, // Ivory
  },

  // Focus ring uses Crail (primary-500) so keyboard focus reads as
  // brand-aligned rather than the sky-blue WCAG default. Reduced-motion
  // + high-contrast stay on standard defaults.
  accessibility: {
    ...standardAccessibility.light,
    focusRing: {
      ...standardAccessibility.light.focusRing,
      color: { $type: 'color', $value: '#cc785c' },
    },
  },

  zIndex: standardZIndex,
};

// ── Claudic — Dark ─────────────────────────────────────────────────
//
// Charcoal surfaces, ivory text. Mirrors claude.ai's nighttime canvas.
// The primary ladder shifts down a step (500 reads softer on dark) and
// neutrals invert.
const claudicDark: DtcgTheme = {
  $name: 'Claudic',
  $description:
    'Fits inside claude.ai (dark) — warm charcoal surfaces, terracotta accent, calm by design.',
  $metadata: {
    font: 'system',
    philosophy:
      'Quiet, papery, conversational. Built to feel native when rendered inside claude.ai.',
  },

  color: {
    // Same Crail anchor; on dark we pull `primary-500` slightly lighter
    // so contrast against `#262624` clears WCAG AA for body text usage.
    // The hex shift is small — keeps the brand reading.
    primary: {
      '50': { $value: '#4d2920', $type: 'color' }, // ladder INVERTS for dark — 50 is darkest
      '100': { $value: '#723e30', $type: 'color' },
      '200': { $value: '#965240', $type: 'color' },
      '300': { $value: '#b8694f', $type: 'color' },
      '400': { $value: '#cc785c', $type: 'color' },
      '500': { $value: '#d6896c', $type: 'color' }, // shifted lighter for dark contrast
      '600': { $value: '#df9d80', $type: 'color' },
      '700': { $value: '#ecbfa9', $type: 'color' },
      '800': { $value: '#f5dfd4', $type: 'color' },
      '900': { $value: '#fbf2ee', $type: 'color' },
    },
    // Inverted neutral ladder — top step is the darkest surface, bottom
    // is the lightest text. Keeps the warm tint throughout.
    neutral: {
      '50': { $value: '#1a1917', $type: 'color' }, // background base
      '100': { $value: '#262624', $type: 'color' }, // Charcoal (surface)
      '200': { $value: '#2d2c2a', $type: 'color' }, // surface variant
      '300': { $value: '#3d3b39', $type: 'color' }, // outline
      '400': { $value: '#56544f', $type: 'color' },
      '500': { $value: '#7c7a76', $type: 'color' }, // muted text
      '600': { $value: '#a8a59f', $type: 'color' }, // body muted
      '700': { $value: '#dad8cc', $type: 'color' },
      '800': { $value: '#ebe9df', $type: 'color' },
      '900': { $value: '#faf9f5', $type: 'color' }, // Ivory (text)
    },
    // Dark-mode semantic scales — ladder INVERTS like the neutral
    // ladder (50 = darkest, 800 = lightest). Brand hex stays anchored
    // at `500`; 600+ pull progressively lighter so they sit readable
    // against Charcoal surfaces, while 50-200 darken into deep warm
    // backgrounds usable for tinted callout/banner surfaces.
    success: {
      '50': { $value: '#1c2412', $type: 'color' },
      '100': { $value: '#34461e', $type: 'color' },
      '200': { $value: '#4a6029', $type: 'color' },
      '500': { $value: '#9bb56b', $type: 'color' }, // brand: olive (lifted for dark)
      '600': { $value: '#b1c688', $type: 'color' },
      '700': { $value: '#c8d8a5', $type: 'color' },
      '800': { $value: '#e3ecd0', $type: 'color' },
    },
    warning: {
      '50': { $value: '#2a1e0c', $type: 'color' },
      '100': { $value: '#523915', $type: 'color' },
      '200': { $value: '#7a541f', $type: 'color' },
      '500': { $value: '#dba14a', $type: 'color' }, // brand: amber-orange (lifted for dark)
      '600': { $value: '#e4b46e', $type: 'color' },
      '700': { $value: '#eac786', $type: 'color' },
      '800': { $value: '#f6e2bb', $type: 'color' },
    },
    error: {
      '50': { $value: '#2a1410', $type: 'color' },
      '100': { $value: '#52271f', $type: 'color' },
      '200': { $value: '#7a3a2e', $type: 'color' },
      '500': { $value: '#d56b59', $type: 'color' }, // brand: brick (lifted for dark)
      '600': { $value: '#df8576', $type: 'color' },
      '700': { $value: '#e3a294', $type: 'color' },
      '800': { $value: '#f1cec5', $type: 'color' },
    },
    info: {
      '50': { $value: '#222220', $type: 'color' },
      '100': { $value: '#3a3936', $type: 'color' },
      '200': { $value: '#56544f', $type: 'color' },
      '500': { $value: '#a8a59f', $type: 'color' }, // brand: neutral muted (lifted for dark)
      '600': { $value: '#bcbab5', $type: 'color' },
      '700': { $value: '#d1cfca', $type: 'color' },
      '800': { $value: '#e6e4e0', $type: 'color' },
    },
    surface: { $value: '#262624', $type: 'color' }, // Charcoal
    onSurface: { $value: '#faf9f5', $type: 'color' }, // Ivory
    surfaceVariant: { $value: '#2d2c2a', $type: 'color' },
    onSurfaceVariant: { $value: '#a8a59f', $type: 'color' },
    container: { $value: '#3d3b39', $type: 'color' },
    onContainer: { $value: '#fbf2ee', $type: 'color' },
    outline: { $value: '#3d3b39', $type: 'color' },
    outlineVariant: { $value: '#2d2c2a', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'none', $type: 'string' },
    speed: { $value: 0, $type: 'number' },
    colors: { $value: [], $type: 'array' },
    background: { $value: '#1a1917', $type: 'color' },
  },

  // Dark-mode focus ring uses the lifted Crail (primary-500 in the
  // dark ladder) so the keyboard-focus halo still reads as Claudic
  // brand against the warm-charcoal surface, rather than the sky-blue
  // WCAG default.
  accessibility: {
    ...standardAccessibility.dark,
    focusRing: {
      ...standardAccessibility.dark.focusRing,
      color: { $type: 'color', $value: '#d6896c' },
    },
  },

  zIndex: standardZIndex,
};

/**
 * Claudic registration — both modes ship from day one.
 *
 * Re-exported from `themes/registry.ts` keyed `'claudic'`. The registry
 * resolves `getTheme('claudic', mode)` to the matching variant; with
 * both modes registered there's no fallback needed.
 */
export const theme = {
  light: claudicLight,
  dark: claudicDark,
} as const;
