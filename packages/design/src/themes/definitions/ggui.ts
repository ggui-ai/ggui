/**
 * GGUI Theme — light + dark variants
 *
 * The default ggui theme. Embodies the brand kit philosophy: monochrome
 * paper + ink, primitive-built, strictly architectural — no decorative
 * flourish.
 *
 * Brand-alignment notes (kept in sync with the ggui brand kit):
 *
 * - Palette is paper (#F4F3ED) + ink (#292929) at the extremes, with a
 *   four-step ink ramp for muted text/borders and a chrome pair for
 *   surfaces. The "primary" ramp is monochrome ink — there is no brand
 *   accent hue. Brand voice: the interface is the artifact, not the
 *   chrome around it.
 * - Status hues are the brand-kit triad: signal (#D93822 — error),
 *   live (#1B7A37 — success), draft (#A87B0E — warning). Info inherits
 *   ink rather than introducing a fourth hue.
 * - Typography is Inter (sans) + Geist Mono (mono). Both are the
 *   brand-kit choice and align with the published landing-ggui-ai +
 *   console-ggui-ai surfaces.
 * - Radii are architectural (2px–6px) — the brand kit consistently
 *   uses `border-radius: 2px` across components. Cards land at 4px so
 *   primitives don't read razor-edged at hero scale, but the family
 *   stays sharp relative to Indigo/Glow's 16px norm.
 * - Canvas mode is `'none'`. Per brand kit: "no decorative flourish."
 * - Shadows are flat — the brand kit relies on hairline borders, not
 *   elevation.
 *
 * Dark variant inverts paper ↔ ink so the canvas reads as ink-base
 * with paper-tinted text. Status hues lift slightly for AA contrast
 * against the dark surface.
 */

import type { DtcgTheme } from '../types';
import {
  standardAccessibility,
  standardTransitions,
  standardZIndex,
} from './_shared';

// ── shared (mode-agnostic) tokens ──────────────────────────────────
//
// font / spacing / shape / motion don't change between modes; lifting
// them keeps the two variants in sync without copy-paste drift.
const shared = {
  font: {
    family: {
      sans: {
        $value: '"Inter", system-ui, -apple-system, sans-serif',
        $type: 'fontFamily',
      },
      mono: {
        $value: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
        $type: 'fontFamily',
      },
    },
    size: {
      sm: { $value: '0.8125rem', $type: 'dimension' }, // 13px
      base: { $value: '0.875rem', $type: 'dimension' }, // 14px — brand-kit body
      lg: { $value: '1rem', $type: 'dimension' }, // 16px
      xl: { $value: '1.125rem', $type: 'dimension' }, // 18px
      '2xl': { $value: '1.375rem', $type: 'dimension' }, // 22px — brand-kit hero tag
    },
    weight: {
      normal: { $value: '400', $type: 'fontWeight' },
      medium: { $value: '500', $type: 'fontWeight' },
      semibold: { $value: '600', $type: 'fontWeight' },
      bold: { $value: '700', $type: 'fontWeight' },
    },
    lineHeight: {
      tight: { $value: '1.2', $type: 'number' },
      normal: { $value: '1.5', $type: 'number' },
      relaxed: { $value: '1.6', $type: 'number' },
    },
  },

  spacing: {
    '1': { $value: '0.25rem', $type: 'dimension' }, // 4px
    '2': { $value: '0.5rem', $type: 'dimension' }, // 8px
    '3': { $value: '0.75rem', $type: 'dimension' }, // 12px
    '4': { $value: '1rem', $type: 'dimension' }, // 16px
    '5': { $value: '1.25rem', $type: 'dimension' }, // 20px
    '6': { $value: '1.5rem', $type: 'dimension' }, // 24px
    '8': { $value: '2rem', $type: 'dimension' }, // 32px
    '10': { $value: '2.5rem', $type: 'dimension' }, // 40px
    '12': { $value: '3rem', $type: 'dimension' }, // 48px
    xs: { $value: '0.25rem', $type: 'dimension' },
    sm: { $value: '0.5rem', $type: 'dimension' },
    md: { $value: '1rem', $type: 'dimension' },
    lg: { $value: '1.5rem', $type: 'dimension' },
    xl: { $value: '2rem', $type: 'dimension' },
    '2xl': { $value: '3rem', $type: 'dimension' },
  },

  shape: {
    // Brand kit radii — architectural (2–6px). Cards land at 4px so
    // primitives don't read razor-edged, but the family stays sharp
    // relative to Indigo/Glow's 12–16px norm. `border-radius: 2px`
    // is the brand-kit default across nearly every component.
    radius: {
      sm: { $value: '2px', $type: 'dimension' },
      md: { $value: '2px', $type: 'dimension' },
      lg: { $value: '4px', $type: 'dimension' },
      xl: { $value: '6px', $type: 'dimension' },
      full: { $value: '9999px', $type: 'dimension' },
    },
    // Flat shadows — the brand kit relies on hairline borders, not
    // elevation. Keep the token names so primitives compile, but
    // values are intentionally minimal (or `none` for sm).
    shadow: {
      sm: { $value: 'none', $type: 'shadow' },
      md: {
        $value: '0 1px 2px rgba(41, 41, 41, 0.06)',
        $type: 'shadow',
      },
      lg: {
        $value: '0 2px 6px rgba(41, 41, 41, 0.08)',
        $type: 'shadow',
      },
      xl: {
        $value: '0 4px 12px rgba(41, 41, 41, 0.10)',
        $type: 'shadow',
      },
    },
  },

  motion: {
    duration: {
      fast: { $value: '120ms', $type: 'duration' },
      normal: { $value: '200ms', $type: 'duration' },
      slow: { $value: '400ms', $type: 'duration' },
      ambient: { $value: '2000ms', $type: 'duration' },
    },
    easing: {
      default: {
        $value: 'cubic-bezier(0.4, 0, 0.2, 1)',
        $type: 'cubicBezier',
      },
      bounce: {
        $value: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
        $type: 'cubicBezier',
      },
      spring: {
        $value: 'cubic-bezier(0.22, 1, 0.36, 1)',
        $type: 'cubicBezier',
      },
    },
    transition: standardTransitions,
    keyframes: {
      'accent-pulse': {
        $value: '0%{opacity:1}50%{opacity:0.7}100%{opacity:1}',
        $type: 'keyframes',
      },
      entrance: {
        $value:
          '0%{opacity:0;transform:translateY(4px)}100%{opacity:1;transform:none}',
        $type: 'keyframes',
      },
      shimmer: {
        $value: '0%{background-position:-200% 0}100%{background-position:200% 0}',
        $type: 'keyframes',
      },
    },
  },
} as const;

// ── GGUI — Light ──────────────────────────────────────────────────
//
// Paper canvas, ink text. Primary ramp is the brand-kit ink ladder —
// monochrome on purpose; there is no accent hue. Container reads as
// paper-2 (the muted paper variant) so primary-tagged regions feel
// recessed rather than colored.
const gguiLight: DtcgTheme = {
  $name: 'GGUI',
  $description:
    'The default ggui theme — monochrome paper + ink, architectural, no decorative flourish.',
  $metadata: {
    font: 'Inter',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;700&display=swap',
    philosophy:
      'The interface is the artifact, not the chrome around it.',
  },

  color: {
    // Monochrome ink ladder. Step 500 = ink (the brand-kit primary
    // foreground); step 600 = ink-2 (a nudge darker for hover/pressed).
    // Lower steps lift toward chrome/paper for hairline backgrounds
    // and recessed surfaces.
    primary: {
      '50': { $value: '#f4f3ed', $type: 'color' }, // paper
      '100': { $value: '#ebe9e1', $type: 'color' }, // paper-2
      '200': { $value: '#e4e4e2', $type: 'color' }, // chrome-2
      '300': { $value: '#d9d9d9', $type: 'color' }, // chrome
      '400': { $value: '#8c8c93', $type: 'color' }, // ink-4
      '500': { $value: '#292929', $type: 'color' }, // ink (brand base)
      '600': { $value: '#1f1f1f', $type: 'color' }, // ink darker — hover/pressed
      '700': { $value: '#171717', $type: 'color' },
      '800': { $value: '#0e0e0e', $type: 'color' },
      '900': { $value: '#000000', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#f4f3ed', $type: 'color' }, // paper
      '100': { $value: '#ebe9e1', $type: 'color' }, // paper-2
      '200': { $value: '#e4e4e2', $type: 'color' }, // chrome-2
      '300': { $value: '#d9d9d9', $type: 'color' }, // chrome
      '400': { $value: '#8c8c93', $type: 'color' }, // ink-4
      '500': { $value: '#5a5a5a', $type: 'color' }, // ink-3
      '600': { $value: '#3d3d3d', $type: 'color' }, // ink-2
      '700': { $value: '#292929', $type: 'color' }, // ink
      '800': { $value: '#24242c', $type: 'color' }, // line
      '900': { $value: '#0e0e0e', $type: 'color' },
    },
    // Brand-kit status triad: signal / live / draft. Info inherits ink
    // rather than introducing a fourth hue. Each ships a 7-stop scale
    // (50/100/200/500/600/700/800) with the brand hex pinned at 500;
    // lower stops lighten, higher stops darken.
    success: {
      '50': { $value: '#e8f5ec', $type: 'color' },
      '100': { $value: '#c5e6cd', $type: 'color' },
      '200': { $value: '#8fcca0', $type: 'color' },
      '500': { $value: '#1b7a37', $type: 'color' }, // live
      '600': { $value: '#15622c', $type: 'color' },
      '700': { $value: '#0f4a21', $type: 'color' },
      '800': { $value: '#093116', $type: 'color' },
    },
    warning: {
      '50': { $value: '#fbf3e0', $type: 'color' },
      '100': { $value: '#f3e1b0', $type: 'color' },
      '200': { $value: '#e6c46e', $type: 'color' },
      '500': { $value: '#a87b0e', $type: 'color' }, // draft
      '600': { $value: '#86620b', $type: 'color' },
      '700': { $value: '#654a08', $type: 'color' },
      '800': { $value: '#433105', $type: 'color' },
    },
    error: {
      '50': { $value: '#fbe7e3', $type: 'color' },
      '100': { $value: '#f4bbb1', $type: 'color' },
      '200': { $value: '#ea8a7a', $type: 'color' },
      '500': { $value: '#d93822', $type: 'color' }, // signal
      '600': { $value: '#ae2d1b', $type: 'color' },
      '700': { $value: '#822214', $type: 'color' },
      '800': { $value: '#57160d', $type: 'color' },
    },
    info: {
      '50': { $value: '#e1e1e1', $type: 'color' },
      '100': { $value: '#bababa', $type: 'color' },
      '200': { $value: '#8e8e8e', $type: 'color' },
      '500': { $value: '#3d3d3d', $type: 'color' }, // ink-2 (no info hue)
      '600': { $value: '#313131', $type: 'color' },
      '700': { $value: '#252525', $type: 'color' },
      '800': { $value: '#181818', $type: 'color' },
    },
    // Semantic surface roles
    surface: { $value: '#f4f3ed', $type: 'color' }, // paper
    onSurface: { $value: '#292929', $type: 'color' }, // ink
    surfaceVariant: { $value: '#ebe9e1', $type: 'color' }, // paper-2
    onSurfaceVariant: { $value: '#5a5a5a', $type: 'color' }, // ink-3
    container: { $value: '#ebe9e1', $type: 'color' }, // paper-2
    onContainer: { $value: '#292929', $type: 'color' }, // ink
    outline: { $value: '#d6d4cb', $type: 'color' }, // line-2
    outlineVariant: { $value: '#e4e4e2', $type: 'color' }, // chrome-2
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'none', $type: 'string' },
    speed: { $value: 1.0, $type: 'number' },
    colors: { $value: [], $type: 'array' },
    background: { $value: '#f4f3ed', $type: 'color' }, // paper
  },

  // Brand-aligned focus ring: ink (#292929) instead of the standard
  // sky-blue accent — ggui has no accent hue, so the focus ring stays
  // monochrome.
  accessibility: {
    ...standardAccessibility.light,
    focusRing: {
      ...standardAccessibility.light.focusRing,
      color: { $type: 'color', $value: '#292929' },
    },
  },

  zIndex: standardZIndex,
};

// ── GGUI — Dark ───────────────────────────────────────────────────
//
// Ink canvas, paper text. Primary ramp inverts: step 500 lifts to
// paper so monochrome CTAs read on the dark surface. Status hues nudge
// brighter to clear AA on ink.
const gguiDark: DtcgTheme = {
  $name: 'GGUI',
  $description:
    'The default ggui theme (dark) — ink canvas, paper text, architectural and flat.',
  $metadata: {
    font: 'Inter',
    fontUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Geist+Mono:wght@400;500;700&display=swap',
    philosophy:
      'The interface is the artifact, not the chrome around it.',
  },

  color: {
    // Inverted ladder — 50 darkest, 900 lightest. Step 500 lifts to
    // paper (#f4f3ed) so CTAs read on the ink-base surface.
    primary: {
      '50': { $value: '#0e0e0e', $type: 'color' },
      '100': { $value: '#1f1f1f', $type: 'color' },
      '200': { $value: '#292929', $type: 'color' }, // ink
      '300': { $value: '#3d3d3d', $type: 'color' }, // ink-2
      '400': { $value: '#5a5a5a', $type: 'color' }, // ink-3
      '500': { $value: '#f4f3ed', $type: 'color' }, // paper (inverted CTA)
      '600': { $value: '#ebe9e1', $type: 'color' }, // paper-2 (hover/pressed)
      '700': { $value: '#e4e4e2', $type: 'color' }, // chrome-2
      '800': { $value: '#d9d9d9', $type: 'color' }, // chrome
      '900': { $value: '#ffffff', $type: 'color' },
    },
    neutral: {
      '50': { $value: '#0e0e0e', $type: 'color' },
      '100': { $value: '#1f1f1f', $type: 'color' },
      '200': { $value: '#292929', $type: 'color' }, // ink (canvas base)
      '300': { $value: '#3d3d3d', $type: 'color' }, // ink-2
      '400': { $value: '#5a5a5a', $type: 'color' }, // ink-3
      '500': { $value: '#8c8c93', $type: 'color' }, // ink-4
      '600': { $value: '#d9d9d9', $type: 'color' }, // chrome
      '700': { $value: '#e4e4e2', $type: 'color' }, // chrome-2
      '800': { $value: '#ebe9e1', $type: 'color' }, // paper-2
      '900': { $value: '#f4f3ed', $type: 'color' }, // paper (text)
    },
    // Status hues lifted slightly for AA on the ink surface. Each ships
    // a 7-stop scale (50/100/200/500/600/700/800) with the brand hex
    // pinned at 500; dark-mode convention inverts the ramp so 50 is the
    // darkest and 800 the lightest, matching the standardSemanticScales
    // dark variant.
    success: {
      '50': { $value: '#0d2918', $type: 'color' },
      '100': { $value: '#174f2a', $type: 'color' },
      '200': { $value: '#286b3d', $type: 'color' },
      '500': { $value: '#3da85b', $type: 'color' }, // brighter live
      '600': { $value: '#6dbf83', $type: 'color' },
      '700': { $value: '#9dd5ab', $type: 'color' },
      '800': { $value: '#cdead3', $type: 'color' },
    },
    warning: {
      '50': { $value: '#332608', $type: 'color' },
      '100': { $value: '#5e4612', $type: 'color' },
      '200': { $value: '#896720', $type: 'color' },
      '500': { $value: '#d4a02e', $type: 'color' }, // brighter draft
      '600': { $value: '#dfb55c', $type: 'color' },
      '700': { $value: '#eaca8a', $type: 'color' },
      '800': { $value: '#f5deb8', $type: 'color' },
    },
    error: {
      '50': { $value: '#3d130d', $type: 'color' },
      '100': { $value: '#702419', $type: 'color' },
      '200': { $value: '#a33828', $type: 'color' },
      '500': { $value: '#ff5b46', $type: 'color' }, // brighter signal
      '600': { $value: '#ff7d6c', $type: 'color' },
      '700': { $value: '#ff9f93', $type: 'color' },
      '800': { $value: '#ffc2ba', $type: 'color' },
    },
    info: {
      '50': { $value: '#363636', $type: 'color' },
      '100': { $value: '#5a5a5a', $type: 'color' },
      '200': { $value: '#8c8c8c', $type: 'color' },
      '500': { $value: '#d9d9d9', $type: 'color' }, // chrome (inverted ink-2)
      '600': { $value: '#e0e0e0', $type: 'color' },
      '700': { $value: '#e8e8e8', $type: 'color' },
      '800': { $value: '#f0f0f0', $type: 'color' },
    },
    surface: { $value: '#1f1f1f', $type: 'color' }, // surface above ink base
    onSurface: { $value: '#f4f3ed', $type: 'color' }, // paper
    surfaceVariant: { $value: '#292929', $type: 'color' }, // ink
    onSurfaceVariant: { $value: '#d9d9d9', $type: 'color' }, // chrome
    container: { $value: '#292929', $type: 'color' }, // ink
    onContainer: { $value: '#f4f3ed', $type: 'color' }, // paper
    outline: { $value: '#3d3d3d', $type: 'color' }, // ink-2
    outlineVariant: { $value: '#292929', $type: 'color' },
  },

  font: shared.font,
  spacing: shared.spacing,
  shape: shared.shape,
  motion: shared.motion,

  canvas: {
    mode: { $value: 'none', $type: 'string' },
    speed: { $value: 1.0, $type: 'number' },
    colors: { $value: [], $type: 'array' },
    background: { $value: '#1a1a1a', $type: 'color' }, // ink-base canvas
  },

  // Brand-aligned focus ring: paper (#f4f3ed) instead of the standard
  // sky-blue accent — ggui dark inverts the ink/paper relationship and
  // stays monochrome.
  accessibility: {
    ...standardAccessibility.dark,
    focusRing: {
      ...standardAccessibility.dark.focusRing,
      color: { $type: 'color', $value: '#f4f3ed' },
    },
  },

  zIndex: standardZIndex,
};

/**
 * GGUI registration — both modes ship from day one.
 */
export const theme = {
  light: gguiLight,
  dark: gguiDark,
} as const;
