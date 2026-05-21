/**
 * Default design system documentation for the `get_design_system` MCP tool.
 *
 * This large string documents all available CSS variables, design tokens,
 * animation presets, elevation levels, and typography scales. It is served
 * to the LLM when no app-specific design context is configured.
 *
 * Any changes here must stay in sync with the design tokens, CSS
 * variables, and component APIs published by `@ggui-ai/design`
 * (`packages/design/`). A drift between this doc and the real design
 * system causes the LLM to emit styling that the renderer cannot
 * honor.
 */

/** Default light-theme design system documentation served to the LLM. */
export const DEFAULT_DESIGN_SYSTEM_DOCS = `# Design System - Default Light Theme

**IMPORTANT:** Always use CSS variables (var(--ggui-*)) for styling to ensure components respect the app theme.

## Colors

### Primary
- var(--ggui-color-primary-50) - #f0f9ff
- var(--ggui-color-primary-100) - #e0f2fe
- var(--ggui-color-primary-200) - #bae6fd
- var(--ggui-color-primary-300) - #7dd3fc
- var(--ggui-color-primary-400) - #38bdf8
- var(--ggui-color-primary-500) - #0ea5e9
- var(--ggui-color-primary-600) - #0284c7 (main action color)
- var(--ggui-color-primary-700) - #0369a1
- var(--ggui-color-primary-800) - #075985
- var(--ggui-color-primary-900) - #0c4a6e

### Semantic Surface & Text Colors (REQUIRED for theme compatibility)
These tokens adapt automatically to any theme (light, dark, branded). **ALWAYS use these for surfaces and text — never use raw neutral-* scale values.**

| Token | CSS Variable | Default | Role |
|-------|-------------|---------|------|
| surface | var(--ggui-color-surface) | Main content background |
| onSurface | var(--ggui-color-onSurface) | Primary text on surface |
| surfaceVariant | var(--ggui-color-surfaceVariant) | Card/panel background |
| onSurfaceVariant | var(--ggui-color-onSurfaceVariant) | Muted/secondary text |
| container | var(--ggui-color-container) | Primary-branded containers |
| onContainer | var(--ggui-color-onContainer) | Text on branded containers |
| outline | var(--ggui-color-outline) | Borders, dividers |
| outlineVariant | var(--ggui-color-outlineVariant) | Subtle borders |

**Usage pattern:**
- Page/section background → \`var(--ggui-color-surface)\`
- Body text → \`var(--ggui-color-onSurface)\`
- Card/panel background → \`var(--ggui-color-surfaceVariant)\`
- Secondary/muted text → \`var(--ggui-color-onSurfaceVariant)\`
- Branded section/header → \`var(--ggui-color-container)\` bg + \`var(--ggui-color-onContainer)\` text
- Borders/dividers → \`var(--ggui-color-outline)\` or \`var(--ggui-color-outlineVariant)\`

### State Colors
- var(--ggui-color-success) — success states
- var(--ggui-color-warning) — warning states
- var(--ggui-color-error) — error states, destructive actions
- var(--ggui-color-info) — informational

### IMPORTANT: Color Rules
- **NEVER** use hardcoded hex colors. ONLY use var(--ggui-color-*) tokens.
- **NEVER** use rgba(), hsl(), or other CSS color functions with hardcoded values.
- **NEVER** use raw neutral-* or gray-* scale tokens (neutral-50, neutral-900, etc.) — these are internal to the theme and break in dark mode.
- **ALWAYS** use semantic tokens for text and backgrounds:
  - Text: \`var(--ggui-color-onSurface)\` or \`var(--ggui-color-onSurfaceVariant)\`
  - Backgrounds: \`var(--ggui-color-surface)\` or \`var(--ggui-color-surfaceVariant)\`
  - Borders: \`var(--ggui-color-outline)\` or \`var(--ggui-color-outlineVariant)\`
- For branded elements use \`var(--ggui-color-primary-*)\` scale tokens — these ARE safe because primary adapts per theme.
- For card backgrounds use \`var(--ggui-color-surfaceVariant)\` or \`var(--ggui-color-primary-50)\`

## Spacing

Use \`var(--ggui-spacing-N)\` for all padding, gap, and margin values. **Never use raw numbers** like \`padding={16}\` — always use the token: \`padding="var(--ggui-spacing-4)"\`.

| Token | Value | Common use |
|-------|-------|------------|
| var(--ggui-spacing-1) | 4px | Icon gaps, tight spacing |
| var(--ggui-spacing-2) | 8px | Button padding, small gaps |
| var(--ggui-spacing-3) | 12px | List item spacing, form gaps |
| var(--ggui-spacing-4) | 16px | Card padding, section gaps |
| var(--ggui-spacing-5) | 20px | Medium padding |
| var(--ggui-spacing-6) | 24px | Container padding, large gaps |
| var(--ggui-spacing-8) | 32px | Section spacing |
| var(--ggui-spacing-10) | 40px | Page margins |
| var(--ggui-spacing-12) | 48px | Hero/large section spacing |

**Quick lookup (px → token):** 4→1, 8→2, 12→3, 16→4, 20→5, 24→6, 28→7, 32→8, 36→9, 40→10, 48→12

**Usage on primitives:**
\`\`\`tsx
<Container padding="var(--ggui-spacing-6)">
  <Stack gap="var(--ggui-spacing-4)">
    <Card padding="var(--ggui-spacing-4)">
      <Row gap="var(--ggui-spacing-2)">...</Row>
    </Card>
  </Stack>
</Container>
\`\`\`

## Typography

### Font Sizes
- var(--ggui-font-size-xs) - 12px
- var(--ggui-font-size-sm) - 14px
- var(--ggui-font-size-base) - 16px
- var(--ggui-font-size-lg) - 18px
- var(--ggui-font-size-xl) - 20px
- var(--ggui-font-size-2xl) - 24px
- var(--ggui-font-size-3xl) - 30px
- var(--ggui-font-size-4xl) - 36px

### Font Weights
- var(--ggui-font-weight-normal) - 400
- var(--ggui-font-weight-medium) - 500
- var(--ggui-font-weight-semibold) - 600
- var(--ggui-font-weight-bold) - 700

## Border Radius
- var(--ggui-shape-radius-sm) - 4px
- var(--ggui-shape-radius-md) - 8px
- var(--ggui-shape-radius-lg) - 12px
- var(--ggui-shape-radius-xl) - 16px
- var(--ggui-shape-radius-full) - 9999px

## Shadows
- var(--ggui-shape-shadow-sm) - 0 1px 2px rgba(0,0,0,0.05)
- var(--ggui-shape-shadow-md) - 0 4px 6px -1px rgba(0,0,0,0.1)
- var(--ggui-shape-shadow-lg) - 0 10px 15px -3px rgba(0,0,0,0.1)
- var(--ggui-shape-shadow-xl) - 0 20px 25px -5px rgba(0,0,0,0.1)

## Usage Examples (always use ggui primitives — never raw <div>, <button>, <input>)

### Branded section header
\`\`\`tsx
<Box padding="var(--ggui-spacing-4)" surface="accent">
  <Heading level={2} tone="emphasized">Contact Us</Heading>
  <Text tone="emphasized">We'd love to hear from you</Text>
</Box>
\`\`\`

### Form input
\`\`\`tsx
<Input label="Email" placeholder="you@example.com" />
\`\`\`

### Buttons
\`\`\`tsx
<Button variant="primary">Submit</Button>
<Button variant="outline">Cancel</Button>
<Button variant="ghost">Skip</Button>
\`\`\`

### Card with spacing tokens
\`\`\`tsx
<Card padding="var(--ggui-spacing-4)" shadow="md">
  <Stack gap="var(--ggui-spacing-3)">
    <Heading level={3}>Title</Heading>
    <Text tone="muted">Description</Text>
  </Stack>
</Card>
\`\`\`

### Color usage guide
- **Semantic roles** (surface, onSurface, container, outline): Use for all surface/text/border decisions — these adapt to any theme
- **primary-50/100**: Section backgrounds, highlight strips, card headers
- **primary-200/300**: Borders, dividers, focus rings, input outlines
- **primary-500/600**: Icons, links, labels, badges, buttons, CTAs
- **primary-700/800/900**: Headings and text on light primary backgrounds
- **neutral-***: Only when you need a specific shade that semantic tokens don't cover

The primary palette is the app's brand — use it throughout (headers, accents, borders, interactive elements), not just on the submit button.

**Note:** Do NOT add fallback values to var() (e.g., var(--ggui-color-surface, #fafafa)). Just use var(--ggui-color-surface) — the theme provides all values.

## Motion & Animation

### Duration Scale
- \`instant\`: 0ms
- \`fast\`: 100ms
- \`normal\`: 200ms
- \`slow\`: 300ms
- \`slower\`: 500ms

### Easing Curves
- \`linear\`: linear
- \`easeIn\`: cubic-bezier(0.4, 0, 1, 1)
- \`easeOut\`: cubic-bezier(0, 0, 0.2, 1)
- \`easeInOut\`: cubic-bezier(0.4, 0, 0.2, 1)
- \`spring\`: cubic-bezier(0.175, 0.885, 0.32, 1.275)

### Transition Presets (import from '@ggui-ai/design/tokens')
\`\`\`tsx
import { duration, easing, transition } from '@ggui-ai/design/tokens';
// transition.fast    → "100ms cubic-bezier(0.4, 0, 0.2, 1)"
// transition.normal  → "200ms cubic-bezier(0.4, 0, 0.2, 1)"
// transition.slow    → "300ms cubic-bezier(0.4, 0, 0.2, 1)"
// transition.colors  → color + background-color + border-color (200ms each)
// transition.opacity → opacity 200ms
// transition.transform → transform 200ms
\`\`\`

### Animation Keyframes
Use \`<MotionKeyframes />\` once in your component to inject all keyframes, then reference by name.

**Entrance / exit** (GPU-composited, transform + opacity):
- \`ggui-fadeIn\` / \`ggui-fadeOut\`
- \`ggui-slideInUp\` / \`ggui-slideInDown\`
- \`ggui-scaleIn\` / \`ggui-scaleOut\`

**State feedback** (color-based, for data-change highlights):
- \`ggui-flash\` — background-color highlight that fades out. Set \`--ggui-flash-color\` on the element (default: \`var(--ggui-color-primary-100)\`)
- \`ggui-pulse\` — gentle opacity breathing (infinite, for "live" indicators)
- \`ggui-bounce\` — subtle scale overshoot (one-shot, for confirmations)

\`\`\`tsx
import { MotionKeyframes, useMotion, useAnimationKey } from '@ggui-ai/design';
import { animation } from '@ggui-ai/design/tokens';

function MyComponent() {
  const { motionEnabled } = useMotion(); // respects prefers-reduced-motion
  return (
    <>
      <MotionKeyframes />
      {/* Entrance animation */}
      <div style={{ animation: motionEnabled ? animation.slideInUp : 'none' }}>
        Content slides in
      </div>
    </>
  );
}
\`\`\`

### Retriggering Animations on Data Changes
When data updates (e.g., stock price from a stream), CSS animations don't replay automatically.
Use \`useAnimationKey(dep)\` — returns a key that increments when \`dep\` changes, causing React to remount the element and replay the animation.

\`\`\`tsx
import { MotionKeyframes, useAnimationKey } from '@ggui-ai/design';
import { animation } from '@ggui-ai/design/tokens';

// Flash a stock card green/red when the price changes
const priceKey = useAnimationKey(stock.price);
<div
  key={priceKey}
  style={{
    animation: animation.flash,
    '--ggui-flash-color': stock.change > 0
      ? 'var(--ggui-color-success-100)'
      : 'var(--ggui-color-error-100)',
  } as React.CSSProperties}
>
  {stock.price}
</div>
\`\`\`

## Chart / Data Visualization Colors
Semantic chart tokens for data visualizations:
- \`var(--ggui-color-primary-600)\` — primary series
- \`var(--ggui-color-success-500)\` — positive / success
- \`var(--ggui-color-error-500)\` — negative / error
- \`var(--ggui-color-warning-500)\` — warning / caution
- \`var(--ggui-color-info-500)\` — informational
- \`var(--ggui-color-neutral-400)\` — neutral series
- \`var(--ggui-color-neutral-200)\` — light background series
- \`var(--ggui-color-neutral-600)\` — dark series

## Accessibility Tokens

### Focus Ring (for keyboard focus states)
- Color: \`var(--ggui-color-primary-600)\`
- Width: 2px
- Offset: 2px
- Style: solid
\`\`\`tsx
// Apply to focusable elements:
outline: '2px solid var(--ggui-color-primary-600)',
outlineOffset: '2px',
\`\`\`

### Reduced Motion
Use \`useMotion()\` hook to check user preference. If disabled, set animation/transition to \`none\`.

## Elevation System
Semantic depth levels combining shadow + z-index:
| Level | Shadow | Z-Index | Use For |
|-------|--------|---------|---------|
| 0 | none | 0 | Flat content |
| 1 | sm | auto | Cards, slight lift |
| 2 | md | 1000 | Dropdowns, popovers |
| 3 | lg | 1200 | Banners, sticky bars |
| 4 | xl | 1400 | Modals, dialogs |
| 5 | 2xl | 1800 | Tooltips, toasts |

\`\`\`tsx
import { elevation } from '@ggui-ai/design/tokens';
// elevation.level1 → { shadow: 'var(--ggui-shape-shadow-sm)', zIndex: 'auto' }
// elevation.level2 → { shadow: 'var(--ggui-shape-shadow-md)', zIndex: 1000 }
<div style={{ boxShadow: elevation.level1.shadow, zIndex: elevation.level1.zIndex }}>
  Card content
</div>
\`\`\`

## Typography Presets

### Heading Styles (import { headingStyles } from '@ggui-ai/design/tokens')
| Level | Size | Weight | Line Height | Letter Spacing |
|-------|------|--------|-------------|----------------|
| h1 | 36px | bold (700) | 1.25 | -0.025em |
| h2 | 30px | bold (700) | 1.25 | -0.025em |
| h3 | 24px | semibold (600) | 1.375 | 0 |
| h4 | 20px | semibold (600) | 1.375 | 0 |
| h5 | 18px | semibold (600) | 1.5 | 0 |
| h6 | 16px | semibold (600) | 1.5 | 0 |

### Text Styles (import { textStyles } from '@ggui-ai/design/tokens')
- \`body\`: 16px / normal / 1.5
- \`bodySmall\`: 14px / normal / 1.5
- \`bodyLarge\`: 18px / normal / 1.625
- \`caption\`: 12px / normal / 1.5
- \`label\`: 14px / medium (500) / 1.5
- \`overline\`: 12px / semibold / 1.5 / 0.05em / UPPERCASE

### Letter Spacing Scale
- \`tighter\`: -0.05em
- \`tight\`: -0.025em
- \`normal\`: 0
- \`wide\`: 0.025em
- \`wider\`: 0.05em
- \`widest\`: 0.1em

### Line Height Scale
- \`none\`: 1
- \`tight\`: 1.25
- \`snug\`: 1.375
- \`normal\`: 1.5
- \`relaxed\`: 1.625
- \`loose\`: 2`;
