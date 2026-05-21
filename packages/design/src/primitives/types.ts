import type { CSSProperties, ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, AnchorHTMLAttributes } from 'react';

/**
 * Base props shared across all primitives.
 *
 * Every ggui primitive extends BaseProps, providing escape hatches for
 * inline styles and CSS class overrides. Prefer component-specific props
 * (e.g., `padding`, `shadow`) over raw `style` overrides when possible.
 *
 * Trait composition (`as={Clickable}`) is deliberately NOT here. It is
 * added only to the structural primitives that host it — Box, Stack,
 * Row, Card — via `WithTrait<…>` from `../interact/trait`, a
 * closed-world union (never `React.ElementType`). A bare primitive
 * therefore exposes no `as` at all, so a raw event handler on it stays
 * a type error by design.
 */
export interface BaseProps {
  /** Inline style overrides. Merged last, so these win over all component-computed styles. */
  style?: CSSProperties;
  /** CSS class name for external stylesheet integration or Tailwind-style utilities. */
  className?: string;
}

// ============================================================================
// Layout Primitives
// ============================================================================

/**
 * Container -- Width-constrained wrapper that centers content horizontally.
 *
 * Renders a `<div>` with `width: 100%` and a `maxWidth` constraint.
 * When `center` is true (the default), applies `margin: 0 auto`.
 * No background, border, or shadow -- use Card for visual containment.
 *
 * CSS variables used: none (pure layout primitive).
 *
 * @example
 * <Container maxWidth="xl" padding="var(--ggui-spacing-6)">
 *   <Stack gap="var(--ggui-spacing-4)">
 *     <Heading level={1}>Dashboard</Heading>
 *     <Card shadow="md" padding="var(--ggui-spacing-5)">
 *       <Text>Welcome back!</Text>
 *     </Card>
 *   </Stack>
 * </Container>
 */
export interface ContainerProps extends BaseProps {
  children?: ReactNode;
  /**
   * Maximum width constraint. Accepts a preset token or any CSS width string.
   * - `'xs'` -- 320px
   * - `'sm'` -- 480px
   * - `'md'` -- 640px
   * - `'lg'` -- 768px
   * - `'xl'` -- 1024px
   * - `'2xl'` -- 1280px
   * - `'3xl'` -- 1536px
   * - `'full'` -- 100%
   *
   * Custom strings (e.g., `'900px'`, `'60ch'`) are passed through as-is.
   * @default 'lg'
   */
  maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | 'full' | string;
  /**
   * Whether to center the container horizontally via `margin: 0 auto`.
   * @default true
   */
  center?: boolean;
  /**
   * Padding applied to all sides. Prefer a spacing-scale name
   * (`'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'`) — each resolves to
   * the matching `--ggui-spacing-*` token. A number is treated as
   * pixels; any other string is passed through as a raw CSS value.
   * @default undefined (no padding)
   */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
}

/**
 * Card -- Container with background, shadow, and optional border.
 *
 * Renders a `<div>` with:
 * - Background: `var(--ggui-color-surface)`
 * - Border (when enabled): `1px solid var(--ggui-color-outlineVariant)`
 * - Shadow and radius controlled by design tokens via CSS variables.
 * - No built-in transitions.
 *
 * @example
 * <Card shadow="md" padding="lg" radius="lg">
 *   <Stack gap="md">
 *     <Text variant="label">Settings</Text>
 *     <Input label="Name" value={name} onChange={setName} />
 *     <Button variant="primary">Save</Button>
 *   </Stack>
 * </Card>
 */
export interface CardProps extends BaseProps {
  children?: ReactNode;
  /**
   * Padding applied to all sides. Prefer a spacing-scale name
   * (`'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'`) — each resolves to
   * the matching `--ggui-spacing-*` token. A number is treated as
   * pixels; any other string is passed through as a raw CSS value.
   * @default 'lg'
   */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * Shadow elevation level. Maps to design tokens:
   * - `'none'` -- no shadow
   * - `'sm'` -- var(--ggui-shape-shadow-sm, 0 1px 2px 0 rgba(0,0,0,0.05)) -- subtle, default
   * - `'md'` -- var(--ggui-shape-shadow-md, 0 4px 6px -1px rgba(0,0,0,0.1)) -- dialogs, emphasized sections
   * - `'lg'` -- var(--ggui-shape-shadow-lg, 0 10px 15px -3px rgba(0,0,0,0.1)) -- floating panels
   * - `'xl'` -- var(--ggui-shape-shadow-xl, 0 20px 25px -5px rgba(0,0,0,0.1)) -- popovers, modals
   * @default 'sm'
   */
  shadow?: 'none' | 'sm' | 'md' | 'lg' | 'xl';
  /**
   * Whether to render a 1px border using `var(--ggui-color-outlineVariant)`.
   * @default true
   */
  border?: boolean;
  /**
   * Corner radius. Prefer a radius-scale name (`'none' | 'sm' | 'md' |
   * 'lg' | 'xl'`) — each resolves to the matching `--ggui-shape-radius-*`
   * token. A number is treated as pixels; any other string is passed
   * through as a raw CSS value.
   * @default 'lg'
   */
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | number | string;
  /**
   * Semantic surface slot. Same vocabulary as {@link BoxProps.surface};
   * see that prop's docs for the full slot table. Default Card surface
   * is `'default'` (the active theme's `--ggui-color-surface`); pair
   * with `shadow="md"|"lg"` for elevated cards, or use `'inverted'`
   * for a dark testimonial-style card on a light theme.
   *
   * @default 'default'
   */
  surface?: 'default' | 'elevated' | 'sunken' | 'accent' | 'inverted' | 'transparent';
}

/**
 * Stack -- Flexbox layout primitive for arranging children along a single axis.
 *
 * Renders a `<div>` with `display: flex`. Default layout is vertical (column).
 * All flex shorthand values (`align`, `justify`, `wrap`) are abstracted into
 * semantic prop names.
 *
 * CSS variables used: none (pure layout primitive).
 *
 * @example
 * <Stack gap="lg" align="center">
 *   <Heading level={2}>Profile</Heading>
 *   <Text variant="body">Edit your account details below.</Text>
 *   <Stack direction="horizontal" gap="sm" justify="end">
 *     <Button variant="ghost">Cancel</Button>
 *     <Button variant="primary">Save</Button>
 *   </Stack>
 * </Stack>
 */
export interface StackProps extends BaseProps {
  children?: ReactNode;
  /**
   * Main axis direction.
   * - `'vertical'` -- `flex-direction: column`
   * - `'horizontal'` -- `flex-direction: row`
   * @default 'vertical'
   */
  direction?: 'vertical' | 'horizontal';
  /**
   * Gap between children. Prefer a spacing-scale name
   * (`'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'`) — each resolves to
   * the matching `--ggui-spacing-*` token. A number is treated as
   * pixels; any other string is passed through as a raw CSS value.
   * @default 'sm'
   */
  gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * Cross-axis alignment (maps to `align-items`).
   * - `'start'` -- flex-start
   * - `'center'` -- center
   * - `'end'` -- flex-end
   * - `'stretch'` -- stretch (children fill cross-axis)
   * @default 'stretch'
   */
  align?: 'start' | 'center' | 'end' | 'stretch';
  /**
   * Main-axis content distribution (maps to `justify-content`).
   * - `'start'` -- flex-start
   * - `'center'` -- center
   * - `'end'` -- flex-end
   * - `'between'` -- space-between
   * - `'around'` -- space-around
   * - `'evenly'` -- space-evenly
   * @default 'start'
   */
  justify?: 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';
  /**
   * Whether children wrap to the next line when they overflow.
   * Maps to `flex-wrap: wrap` when true.
   * @default false
   */
  wrap?: boolean;
}

/**
 * Row -- Convenience alias for a horizontal Stack.
 *
 * Identical to StackProps but with the `direction` prop removed.
 * The component always renders with `flex-direction: row`.
 *
 * @example
 * <Row gap="md" align="center" justify="between">
 *   <Text variant="label">Total</Text>
 *   <Text weight="bold">$42.00</Text>
 * </Row>
 */
export type RowProps = Omit<StackProps, 'direction'>;

/**
 * Grid -- 2-D layout primitive. Arranges children into rows AND
 * columns; reach for it when Stack/Row's single-axis flow isn't
 * enough (card galleries, dashboards, stat grids).
 *
 * @example
 * <Grid columns={3} gap="md">
 *   {items.map((it) => <Card key={it.id}>{it.name}</Card>)}
 * </Grid>
 *
 * @example
 * // Responsive: as many >=220px columns as fit the width.
 * <Grid minColumnWidth={220} gap="lg">…</Grid>
 *
 * @example
 * // Explicit per-breakpoint counts: 1 column on mobile, 3 from md up.
 * <Grid columns={{ base: 1, md: 3 }} gap="md">…</Grid>
 */
export interface GridProps extends BaseProps {
  children?: ReactNode;
  /**
   * Column count. Three forms:
   * - a number — that many equal columns at every width (`columns={3}`);
   * - a {@link ResponsiveColumns} map — explicit counts per breakpoint
   *   (`columns={{ base: 1, md: 3 }}` = 1 column on mobile, 3 from `md`).
   *   Use this when the request names exact per-breakpoint counts
   *   ("3 per row on desktop, 1 on mobile").
   * Ignored entirely when `minColumnWidth` is set.
   * @default 2
   */
  columns?: number | ResponsiveColumns;
  /**
   * Gap between cells. Prefer a spacing-scale name
   * (`'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'`); a number is pixels.
   * @default 'md'
   */
  gap?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * When set, the grid becomes responsive — it fits as many equal
   * columns as possible, each at least this wide, and `columns` is
   * ignored. A number is treated as pixels.
   * @default undefined (use `columns`)
   */
  minColumnWidth?: number | string;
}

/**
 * Explicit column count per viewport breakpoint, mobile-first. `base`
 * applies from 0 up; each named key overrides at and above its
 * breakpoint width (`sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px).
 * Omit `base` to default to a single column on the narrowest screens.
 */
export interface ResponsiveColumns {
  /** Columns below the `sm` breakpoint. @default 1 */
  base?: number;
  /** Columns from 640px up. */
  sm?: number;
  /** Columns from 768px up. */
  md?: number;
  /** Columns from 1024px up. */
  lg?: number;
  /** Columns from 1280px up. */
  xl?: number;
}

/**
 * Skeleton -- a pulsing placeholder for content that has not loaded
 * yet. ggui UIs are agent-driven (props arrive late, streams start
 * empty), so a loading frame is the rule — render `Skeleton` instead
 * of a blank screen or a hand-rolled pulsing `<div>`.
 *
 * @example
 * {user === undefined
 *   ? <Skeleton variant="text" width="40%" />
 *   : <Text>{user.name}</Text>}
 */
export interface SkeletonProps extends BaseProps {
  /**
   * Shape preset.
   * - `'rect'` -- a block (default); pair with `width` / `height`.
   * - `'text'` -- a single text line (height ~1em).
   * - `'circle'` -- equal width/height, fully rounded (avatar slot).
   * @default 'rect'
   */
  variant?: 'rect' | 'text' | 'circle';
  /**
   * Width. A number is pixels. Defaults to `100%` (`2.5rem` for circle).
   */
  width?: number | string;
  /**
   * Height. A number is pixels. Defaults by variant when unset.
   */
  height?: number | string;
  /**
   * Corner radius. Prefer a radius-scale name. Ignored for
   * `variant="circle"` (always fully round).
   * @default 'sm'
   */
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | number | string;
}

/**
 * Box -- Generic container with padding, margin, background, and border-radius.
 *
 * Renders a plain `<div>`. Unlike Card, Box has no default background, shadow,
 * or border -- it is a blank canvas for custom styling. Use it for layout
 * spacing, colored sections, or wrapping arbitrary content.
 *
 * When both `paddingX`/`paddingY` and `padding` are provided, the axis-specific
 * props take precedence and `padding` is ignored.
 *
 * CSS variables used: none (all values are passed through directly).
 *
 * @example
 * <Box paddingX="xl" paddingY="lg" surface="accent" radius="lg">
 *   <Text variant="bodySmall" tone="emphasized">
 *     Tip: You can customize your theme in Settings.
 *   </Text>
 * </Box>
 */
export interface BoxProps extends BaseProps {
  children?: ReactNode;
  /**
   * Padding applied to all four sides. Prefer a spacing-scale name
   * (`'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'`) — each resolves to
   * the matching `--ggui-spacing-*` token. A number is treated as
   * pixels; any other string is passed through as a raw CSS value.
   * Ignored when `paddingX` or `paddingY` is set.
   * @default undefined (no padding)
   */
  padding?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * Horizontal (left + right) padding. Accepts a spacing-scale name,
   * a pixel number, or a raw CSS string — see {@link BoxProps.padding}.
   * When set alongside `paddingY`, they combine into a shorthand `padding: {Y} {X}`.
   * When set without `paddingY`, vertical padding defaults to 0.
   * @default undefined
   */
  paddingX?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * Vertical (top + bottom) padding. Accepts a spacing-scale name,
   * a pixel number, or a raw CSS string — see {@link BoxProps.padding}.
   * When set alongside `paddingX`, they combine into a shorthand `padding: {Y} {X}`.
   * When set without `paddingX`, horizontal padding defaults to 0.
   * @default undefined
   */
  paddingY?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * Margin applied to all four sides. Accepts a spacing-scale name,
   * a pixel number, or a raw CSS string — see {@link BoxProps.padding}.
   * @default undefined (no margin)
   */
  margin?: 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | number | string;
  /**
   * Semantic surface slot. Picks the right `var(--ggui-color-*)`
   * background token from the active theme. The ONLY way to set a
   * theme-tracking background fill on Box.
   *
   * Available slots:
   * - `'default'` — base container surface (most common)
   * - `'elevated'` — same fill, intended to be paired with shadow
   *   (use Card.shadow for actual elevation)
   * - `'sunken'` — recessed / inset region (`surfaceVariant` token)
   * - `'accent'` — highlighted / branded fill (`primary-50` token)
   * - `'inverted'` — dark surface in light mode, light in dark
   *   (testimonials, code-snippet cards). Pair with
   *   {@link TextProps.tone} `'inverse'` for legible text.
   * - `'transparent'` — explicit "no fill"
   *
   * For non-theme-mapped brand colors (e.g. a partner's exact brand
   * hex like Stripe purple) use the {@link BoxProps.assetColor}
   * escape — every other hex / rgba on Box is rejected by tier-0
   * self-check.
   *
   * @default undefined (transparent)
   */
  surface?: 'default' | 'elevated' | 'sunken' | 'accent' | 'inverted' | 'transparent';
  /**
   * Asset color escape — the typed valve for legitimate non-theme
   * color values (a partner's exact brand hex, a fixed product
   * surface, etc.). Renders as the Box background.
   *
   * **MUST be paired with {@link BoxProps.assetSemantic}.** The
   * semantic name is human-readable documentation of why this color
   * bypasses the theme — e.g. `"stripe-brand-purple"`,
   * `"slack-aubergine"`. Tier-0 self-check allows hex / rgba inside
   * `assetColor` ONLY when `assetSemantic` is a non-empty string;
   * one without the other fails the check.
   *
   * Reach for `surface` first. This escape exists for the small set
   * of cases where the operator's theme MUST NOT override the value
   * (brand identity rendering).
   *
   * @example
   * <Box assetColor="#635BFF" assetSemantic="stripe-brand-purple">…</Box>
   *
   * @default undefined
   */
  assetColor?: string;
  /**
   * Human-readable semantic label that documents why
   * {@link BoxProps.assetColor} bypasses the theme. Required when
   * `assetColor` is set; tier-0 self-check rejects empty strings or
   * a missing `assetSemantic` next to a hex `assetColor`.
   *
   * Examples: `"stripe-brand-purple"`, `"slack-aubergine"`,
   * `"partner-logo-orange"`. Pure documentation — no rendering effect.
   *
   * @default undefined
   */
  assetSemantic?: string;
  /**
   * Corner radius. Prefer a radius-scale name (`'none' | 'sm' | 'md' |
   * 'lg' | 'xl'`) — each resolves to the matching `--ggui-shape-radius-*`
   * token. A number is treated as pixels; any other string is passed
   * through as a raw CSS value.
   * @default undefined (no rounding)
   */
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | number | string;
}

/**
 * Divider -- A 1px line to visually separate content sections.
 *
 * Renders an `<hr>` (horizontal) or `<div>` (vertical) with `role="separator"`.
 * - Horizontal: 1px tall, full width, with vertical margin.
 * - Vertical: 1px wide, stretches to parent height via `align-self: stretch`,
 *   with horizontal margin. Works best inside a horizontal Stack or Row.
 *
 * Default color: `var(--ggui-color-outlineVariant)`.
 *
 * @example
 * <Stack gap={0}>
 *   <Text>Section A</Text>
 *   <Divider margin="var(--ggui-spacing-3)" />
 *   <Text>Section B</Text>
 * </Stack>
 */
export interface DividerProps extends BaseProps {
  /**
   * Line direction.
   * - `'horizontal'` -- renders `<hr>`, full width, 1px height, margin top/bottom
   * - `'vertical'` -- renders `<div>`, 1px width, `align-self: stretch`, margin left/right
   * @default 'horizontal'
   */
  orientation?: 'horizontal' | 'vertical';
  /**
   * Spacing around the divider. Numbers are treated as pixels.
   * Applied as vertical margin for horizontal dividers, horizontal margin for vertical.
   * @default 16
   */
  margin?: number | string;
  /**
   * Semantic color slot. Same vocabulary as {@link TextProps.tone}; the
   * theme decides what each tone LOOKS like. Defaults to a quiet
   * outline-variant tint when unset (independent of the tone slots).
   *
   * @default undefined (uses `var(--ggui-color-outlineVariant)`)
   */
  tone?:
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
}

/**
 * Spacer -- Invisible spacing element, either fixed-size or flexible.
 *
 * Renders an empty `<div>`.
 * - Fixed mode (number): sets both `width` and `height` to the given pixel
 *   value with `flex-shrink: 0`, creating rigid spacing in any direction.
 * - Flex mode (`'flex'`): sets `flex: 1`, expanding to fill remaining space
 *   in a flex container. Useful for pushing siblings apart.
 *
 * CSS variables used: none.
 *
 * @example
 * <Stack direction="horizontal" align="center">
 *   <Heading level={3}>Logo</Heading>
 *   <Spacer size="flex" />
 *   <Button variant="ghost">Login</Button>
 * </Stack>
 */
export interface SpacerProps extends BaseProps {
  /**
   * Spacing amount.
   * - Number: fixed square spacer (width and height in pixels, `flex-shrink: 0`).
   * - `'flex'`: expands to fill available space (`flex: 1`).
   * @default 16
   */
  size?: number | 'flex';
}

// ============================================================================
// Typography Primitives
// ============================================================================

/**
 * Text -- Versatile typography primitive for body copy, captions, and labels.
 *
 * Renders as `<p>` by default (configurable via `is`). The `variant` prop
 * selects a preset typography style (font size, weight, line height). The
 * `size` and `weight` props override the variant values when specified.
 *
 * Default text color: `var(--ggui-color-onSurface)`.
 * All text renders with `margin: 0` (no default paragraph spacing).
 *
 * @example
 * <Stack gap="var(--ggui-spacing-1)">
 *   <Text variant="overline">ACCOUNT</Text>
 *   <Text variant="bodyLarge">Welcome back, Jane.</Text>
 *   <Text variant="caption" tone="muted">
 *     Last login: 2 hours ago
 *   </Text>
 * </Stack>
 */
export interface TextProps extends BaseProps {
  children?: ReactNode;
  /**
   * Preset typography style. Each variant maps to a fixed combination of
   * font size, weight, and line height from the typography tokens:
   * - `'body'` -- 16px / 400 / 1.5 line-height
   * - `'bodySmall'` -- 14px / 400 / 1.5 line-height
   * - `'bodyLarge'` -- 18px / 400 / 1.625 line-height (relaxed)
   * - `'caption'` -- 12px / 400 / 1.5 line-height
   * - `'label'` -- 14px / 500 (medium) / 1.5 line-height
   * - `'overline'` -- 12px / 600 (semibold) / 1.5 line-height, uppercase, wider letter-spacing (0.05em)
   * @default 'body'
   */
  variant?: 'body' | 'bodySmall' | 'bodyLarge' | 'caption' | 'label' | 'overline';
  /**
   * Font size override. When set, replaces the variant's font size.
   * Maps to CSS variables with pixel fallbacks:
   * - `'xs'` -- var(--ggui-font-size-xs)
   * - `'sm'` -- var(--ggui-font-size-sm)
   * - `'base'` -- var(--ggui-font-size-base)
   * - `'lg'` -- var(--ggui-font-size-lg)
   * - `'xl'` -- var(--ggui-font-size-xl)
   * - `'2xl'` -- var(--ggui-font-size-2xl)
   * - `'3xl'` -- var(--ggui-font-size-3xl)
   * - `'4xl'` -- var(--ggui-font-size-4xl)
   * @default undefined (uses variant's font size)
   */
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl';
  /**
   * Font weight override. When set, replaces the variant's weight.
   * Maps to CSS variables with numeric fallbacks:
   * - `'normal'` -- var(--ggui-font-weight-normal)
   * - `'medium'` -- var(--ggui-font-weight-medium)
   * - `'semibold'` -- var(--ggui-font-weight-semibold)
   * - `'bold'` -- var(--ggui-font-weight-bold)
   * @default undefined (uses variant's weight)
   */
  weight?: 'normal' | 'medium' | 'semibold' | 'bold';
  /**
   * Semantic color slot. Picks the right `var(--ggui-color-*)` token
   * from the active theme. The theme decides what each tone LOOKS
   * like — `'muted'` is a quiet warm grey on Claudic, a cool slate on
   * Indigo, dim cyan on Neon-Noir. Components that use `tone` track
   * the operator's theme switch automatically.
   *
   * Available slots: `'default'` (primary body text), `'muted'`
   * (secondary / metadata), `'subtle'` (very-low-emphasis hint),
   * `'emphasized'` (branded accent), `'loud'` (strongest accent),
   * `'success'` / `'warning'` / `'error'` / `'info'` (status text),
   * `'inverse'` (text on dark surface), `'inherit'` (parent's color).
   *
   * `tone` is the ONLY way to set a Text color. The legacy
   * `color?: string` escape was retired — raw color strings bypass
   * theming and silently override the operator's preset.
   *
   * @default 'default' (var(--ggui-color-onSurface))
   */
  tone?:
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
   * Horizontal text alignment. Maps directly to `text-align`.
   * @default undefined (inherits from parent)
   */
  align?: 'left' | 'center' | 'right';
  /**
   * When true, clips overflowing text with an ellipsis. Applies
   * `overflow: hidden`, `text-overflow: ellipsis`, and `white-space: nowrap`.
   * @default false
   */
  truncate?: boolean;
  /**
   * HTML element to render. Choose based on semantic context:
   * - `'p'` -- paragraph (default, block-level)
   * - `'span'` -- inline text within a sentence
   * - `'div'` -- generic block container
   * - `'label'` -- form label (pair with `htmlFor`)
   *
   * @default 'p'
   */
  is?: 'p' | 'span' | 'div' | 'label';
  /**
   * `id` for the rendered element — anchor an in-page link, or pair
   * with a form control's `aria-labelledby`.
   */
  id?: string;
  /**
   * Associates an `is="label"` element with a form control by the
   * control's `id`. Only meaningful when `is="label"`.
   */
  htmlFor?: string;
}

/**
 * Heading -- Semantic heading element (h1-h6) with preset typography styles.
 *
 * Renders the corresponding `<h1>`-`<h6>` HTML element based on `level`.
 * Each level has a preset font size, weight, line height, and letter spacing
 * from the heading typography tokens:
 * - Level 1: 36px / bold / 1.25 line-height / -0.025em tracking
 * - Level 2: 30px / bold / 1.25 line-height / -0.025em tracking
 * - Level 3: 24px / semibold / 1.375 line-height / 0em tracking
 * - Level 4: 20px / semibold / 1.375 line-height / 0em tracking
 * - Level 5: 18px / semibold / 1.5 line-height / 0em tracking
 * - Level 6: 16px / semibold / 1.5 line-height / 0em tracking
 *
 * Default text color: `var(--ggui-color-onSurface)`.
 * All headings render with `margin: 0` (no default heading spacing).
 *
 * @example
 * <Stack gap="var(--ggui-spacing-2)">
 *   <Heading level={1}>Page Title</Heading>
 *   <Heading level={3} tone="emphasized">
 *     Subsection
 *   </Heading>
 *   <Text variant="body">Body content goes here.</Text>
 * </Stack>
 */
export interface HeadingProps extends BaseProps {
  children?: ReactNode;
  /**
   * Semantic heading level. Determines both the HTML element (`<h1>`-`<h6>`)
   * and the preset typography style.
   * @default 2
   */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Semantic color slot. Same vocabulary as {@link TextProps.tone};
   * see that prop's docs for the full slot table. `tone` is the ONLY
   * way to set a Heading color — the legacy `color?: string` escape
   * was retired so the operator's theme always wins.
   *
   * @default 'default' (var(--ggui-color-onSurface))
   */
  tone?:
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
   * Horizontal text alignment. Maps directly to `text-align`.
   * @default undefined (inherits from parent)
   */
  align?: 'left' | 'center' | 'right';
}

// ============================================================================
// Form Primitives
// ============================================================================

/**
 * Button -- A clickable button primitive with multiple visual variants and sizes.
 *
 * Renders a native `<button>` element styled with inline CSS derived from design-token
 * CSS variables. Supports a loading spinner, left/right icon slots, and a cross-platform
 * `onPress` alias for `onClick`.
 *
 * Base styles applied to every variant:
 * - `border-radius: var(--ggui-shape-radius-md)`
 * - `font-weight: var(--ggui-font-weight-medium)`
 * - `box-shadow: var(--ggui-shape-shadow-sm, 0 1px 2px rgba(0,0,0,0.05))`
 * - `gap: var(--ggui-spacing-2)` between icon and text
 * - Transitions: background-color, box-shadow, opacity at 200ms ease-in-out
 *
 * Disabled or loading: `opacity: 0.5`, `cursor: not-allowed`, click handler suppressed.
 *
 * Also extends native `ButtonHTMLAttributes` (except `style`/`className`), so props
 * like `type`, `form`, `aria-*`, and `data-*` are forwarded to the `<button>` element.
 * The `type` prop defaults to `'button'` (not `'submit'`), preventing accidental form
 * submissions.
 *
 * @example
 * <Button variant="primary" size="md" leftIcon={<Icon name="save" />} onClick={handleSave}>
 *   Save Changes
 * </Button>
 */
export interface ButtonProps extends BaseProps, Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style' | 'className'> {
  children?: ReactNode;
  /**
   * Visual style. Maps to CSS variables:
   * - `'primary'` -- `var(--ggui-color-primary-600)` background, white text, no border
   * - `'secondary'` -- `var(--ggui-color-surfaceVariant)` background, `var(--ggui-color-onSurfaceVariant)` text, no border
   * - `'outline'` -- transparent background, `1px solid var(--ggui-color-primary-600)` border, primary-600 text
   * - `'ghost'` -- transparent background, `var(--ggui-color-onSurfaceVariant)` text, no border
   * - `'danger'` -- `var(--ggui-color-error-600)` background, white text, no border
   * @default 'primary'
   */
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
  /**
   * Controls padding, font size, and minimum height:
   * - `'xs'` -- padding `4px 8px`, font `var(--ggui-font-size-xs)`, min-height 24px
   * - `'sm'` -- padding `6px 12px`, font `var(--ggui-font-size-sm)`, min-height 32px
   * - `'md'` -- padding `10px 16px`, font `var(--ggui-font-size-sm)`, min-height 40px
   * - `'lg'` -- padding `12px 24px`, font `var(--ggui-font-size-base)`, min-height 48px
   * @default 'md'
   */
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /**
   * When true, sets `width: 100%` so the button fills its container.
   * @default false
   */
  fullWidth?: boolean;
  /**
   * When true, replaces children with a 16px `Spinner` (color: `currentColor`)
   * and disables interaction (same effect as `disabled`).
   * @default false
   */
  loading?: boolean;
  /** ReactNode rendered before children, inside the flex layout with `var(--ggui-spacing-2)` gap. */
  leftIcon?: ReactNode;
  /** ReactNode rendered after children, inside the flex layout with `var(--ggui-spacing-2)` gap. */
  rightIcon?: ReactNode;
  /**
   * Alias for `onClick` for cross-platform compatibility (React Native convention).
   * If both `onClick` and `onPress` are provided, `onClick` takes precedence.
   */
  onPress?: () => void;
}

/**
 * Input -- A single-line text input with label, validation, and helper text.
 *
 * Renders a `<div>` wrapper containing an optional `<label>`, a native `<input>`,
 * and an optional message `<span>` for error or helper text.
 *
 * Styling:
 * - Border: `1px solid var(--ggui-color-outline)` (normal),
 *   `var(--ggui-color-error-500)` (error)
 * - Background: `var(--ggui-color-surface)` (normal),
 *   `var(--ggui-color-surface)` (disabled)
 * - Text: `var(--ggui-color-onSurface)`
 * - Border radius: `var(--ggui-shape-radius-md)`
 * - Label: `var(--ggui-font-size-sm)`, `var(--ggui-font-weight-medium)`,
 *   `var(--ggui-color-onSurfaceVariant)`
 * - Transitions: border-color, box-shadow at 200ms ease-in-out
 *
 * Accessibility: auto-generated `id` links `<label>` to `<input>` via `htmlFor`.
 * When `error` is set, `aria-invalid` is true and the message has `role="alert"`.
 * When `required` is true, a red asterisk is appended to the label.
 *
 * Also extends native `InputHTMLAttributes` (except `style`, `className`, `onChange`,
 * `size`), so props like `autoFocus`, `name`, `pattern`, `aria-*` are forwarded.
 *
 * **IMPORTANT:** `onChange` receives the string value directly, NOT a React
 * `ChangeEvent`. This differs from native `<input>` behavior.
 *
 * @example
 * <Input label="Email" type="email" value={email} onChange={setEmail} error={emailError} />
 */
export interface InputProps extends BaseProps, Omit<InputHTMLAttributes<HTMLInputElement>, 'style' | 'className' | 'onChange' | 'size'> {
  /**
   * Label rendered above the input. Linked to the input via auto-generated `htmlFor`/`id`.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /** Placeholder text shown when the input is empty. */
  placeholder?: string;
  /** Controlled value of the input. */
  value?: string;
  /**
   * Change handler. Receives the new string value directly, NOT a React event.
   * @example onChange={(value) => setValue(value)}
   * @example onChange={setValue}
   */
  onChange?: (value: string) => void;
  /**
   * HTML input type. Determines browser behavior (keyboard on mobile, validation, masking).
   * @default 'text'
   */
  type?: 'text' | 'email' | 'password' | 'number' | 'tel' | 'url' | 'search';
  /**
   * Error message displayed below the input in `var(--ggui-color-error-500)`.
   * When set, the border turns red and the message element gets `role="alert"`.
   * Takes precedence over `helperText`.
   */
  error?: string;
  /**
   * Helper text displayed below the input in `var(--ggui-color-onSurfaceVariant)`.
   * Only shown when `error` is not set.
   */
  helperText?: string;
  /**
   * When true, appends a red asterisk (`*`) to the label and sets the native
   * `required` attribute on the `<input>`.
   * @default false
   */
  required?: boolean;
  /**
   * When true, sets the native `disabled` attribute. Background changes to
   * `var(--ggui-color-surface)`.
   * @default false
   */
  disabled?: boolean;
  /**
   * Controls padding and font size:
   * - `'sm'` -- padding `6px 10px`, font `var(--ggui-font-size-sm)`
   * - `'md'` -- padding `10px 12px`, font `var(--ggui-font-size-sm)`
   * - `'lg'` -- padding `12px 14px`, font `var(--ggui-font-size-base)`
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * TextArea -- A multiline text input with label, validation, character count, and auto-resize.
 *
 * Renders a `<div>` wrapper containing an optional `<label>`, a native `<textarea>`,
 * and a footer row with error/helper text on the left and character count on the right.
 *
 * Styling:
 * - Padding: `10px 12px`, font: `var(--ggui-font-size-sm)`, `font-family: inherit`
 * - Border: `1px solid var(--ggui-color-outline)` (normal),
 *   `var(--ggui-color-error-500)` (error)
 * - Background: `var(--ggui-color-surface)` (normal),
 *   `var(--ggui-color-surface)` (disabled)
 * - Border radius: `var(--ggui-shape-radius-md)`
 * - Resize: `vertical` by default, `none` when `autoResize` is true
 * - Transitions: border-color, box-shadow at 200ms ease-in-out
 *
 * Accessibility: same label/error linking pattern as Input (auto-generated ids,
 * `aria-invalid`, `role="alert"` on error message).
 *
 * Also extends native `TextareaHTMLAttributes` (except `style`, `className`, `onChange`).
 *
 * **IMPORTANT:** `onChange` receives the string value directly, NOT a React
 * `ChangeEvent`. This differs from native `<textarea>` behavior.
 *
 * @example
 * <TextArea label="Bio" value={bio} onChange={setBio} rows={6} maxLength={500} showCount />
 */
export interface TextAreaProps extends BaseProps, Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'style' | 'className' | 'onChange'> {
  /**
   * Label rendered above the textarea. Linked via auto-generated `htmlFor`/`id`.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /** Placeholder text shown when the textarea is empty. */
  placeholder?: string;
  /** Controlled value of the textarea. */
  value?: string;
  /**
   * Change handler. Receives the new string value directly, NOT a React event.
   * @example onChange={(value) => setValue(value)}
   * @example onChange={setValue}
   */
  onChange?: (value: string) => void;
  /**
   * Number of visible text rows (native `rows` attribute on `<textarea>`).
   * @default 4
   */
  rows?: number;
  /**
   * Error message displayed below the textarea in `var(--ggui-color-error-500)`.
   * When set, the border turns red and the message element gets `role="alert"`.
   * Takes precedence over `helperText`.
   */
  error?: string;
  /**
   * Helper text displayed below the textarea in `var(--ggui-color-onSurfaceVariant)`.
   * Only shown when `error` is not set.
   */
  helperText?: string;
  /**
   * When true, appends a red asterisk (`*`) to the label and sets the native
   * `required` attribute on the `<textarea>`.
   * @default false
   */
  required?: boolean;
  /**
   * When true, sets the native `disabled` attribute. Background changes to
   * `var(--ggui-color-surface)`.
   * @default false
   */
  disabled?: boolean;
  /**
   * Maximum character length (native `maxLength` attribute). Also used as the
   * denominator in the character count display when `showCount` is true.
   */
  maxLength?: number;
  /**
   * When true AND `maxLength` is set, displays a `{current}/{max}` character
   * counter in the footer row (right-aligned, `var(--ggui-font-size-xs)`).
   * Has no effect without `maxLength`.
   * @default false
   */
  showCount?: boolean;
  /**
   * When true, sets CSS `resize: none` on the textarea. The flag disables manual
   * resizing to signal that external logic handles sizing. The component does NOT
   * auto-adjust height based on content in the current implementation.
   * @default false
   */
  autoResize?: boolean;
}

/**
 * An individual option within a `Select` dropdown.
 *
 * Rendered as a native `<option>` element. When `disabled` is true, the option
 * is visible but not selectable.
 */
export interface SelectOption {
  /** The value submitted when this option is selected. Must be unique within the options array. */
  value: string;
  /** The display text shown in the dropdown. */
  label: string;
  /**
   * When true, the option is visible but cannot be selected (grayed out by the browser).
   * @default false
   */
  disabled?: boolean;
}

/**
 * Select -- A native dropdown selection primitive with label and validation.
 *
 * Renders a `<div>` wrapper containing an optional `<label>`, a native `<select>`
 * with custom styling, and an optional message `<span>`.
 *
 * The native `<select>` has `appearance: none` with a custom chevron SVG rendered
 * as a `background-image` (right-aligned, 12px, onSurfaceVariant color). Extra right
 * padding (36px) accommodates the chevron.
 *
 * Styling:
 * - Border: `1px solid var(--ggui-color-outline)` (normal),
 *   `var(--ggui-color-error-500)` (error)
 * - Background: `var(--ggui-color-surface)` (normal),
 *   `var(--ggui-color-surface)` (disabled)
 * - Text: `var(--ggui-color-onSurface)` when a value is selected,
 *   `var(--ggui-color-onSurfaceVariant)` when showing placeholder
 * - Border radius: `var(--ggui-shape-radius-md)`
 * - Cursor: `pointer` (normal), `not-allowed` (disabled)
 * - Transitions: border-color, box-shadow at 200ms ease-in-out
 *
 * Accessibility: auto-generated `id` links `<label>` to `<select>`.
 * When `error` is set, `aria-invalid` is true and the message has `role="alert"`.
 *
 * Also extends native `SelectHTMLAttributes` (except `style`, `className`,
 * `onChange`, `size`).
 *
 * **IMPORTANT:** `onChange` receives the selected value string directly, NOT a
 * React `ChangeEvent`. This differs from native `<select>` behavior.
 *
 * @example
 * <Select
 *   label="Country"
 *   value={country}
 *   onChange={setCountry}
 *   options={[
 *     { value: 'us', label: 'United States' },
 *     { value: 'uk', label: 'United Kingdom' },
 *   ]}
 *   placeholder="Select a country"
 * />
 */
export interface SelectProps extends BaseProps, Omit<SelectHTMLAttributes<HTMLSelectElement>, 'style' | 'className' | 'onChange' | 'size'> {
  /**
   * Label rendered above the select. Linked via auto-generated `htmlFor`/`id`.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /** Controlled value. Should match one of the `options[].value` strings. */
  value?: string;
  /**
   * Change handler. Receives the selected option's value string directly, NOT a React event.
   * @example onChange={(value) => setCountry(value)}
   * @example onChange={setCountry}
   */
  onChange?: (value: string) => void;
  /**
   * Array of selectable options. Rendered as native `<option>` elements.
   * Must contain at least one option (or use `placeholder` for an empty-state prompt).
   */
  options: SelectOption[];
  /**
   * Placeholder text rendered as a disabled `<option value="">` at the top of the
   * list. Shown when no value is selected.
   */
  placeholder?: string;
  /**
   * Error message displayed below the select in `var(--ggui-color-error-500)`.
   * When set, the border turns red and the message has `role="alert"`.
   * Takes precedence over `helperText`.
   */
  error?: string;
  /**
   * Helper text displayed below the select in `var(--ggui-color-onSurfaceVariant)`.
   * Only shown when `error` is not set.
   */
  helperText?: string;
  /**
   * When true, appends a red asterisk (`*`) to the label and sets the native
   * `required` attribute.
   * @default false
   */
  required?: boolean;
  /**
   * When true, sets the native `disabled` attribute. Background changes to
   * `var(--ggui-color-surface)` and cursor becomes `not-allowed`.
   * @default false
   */
  disabled?: boolean;
  /**
   * Controls padding and font size:
   * - `'sm'` -- padding `6px 10px`, font `var(--ggui-font-size-sm)`
   * - `'md'` -- padding `10px 12px`, font `var(--ggui-font-size-sm)`
   * - `'lg'` -- padding `12px 14px`, font `var(--ggui-font-size-base)`
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Checkbox -- A custom-styled checkbox with label and description.
 *
 * Renders a `<label>` wrapper containing a visually-hidden native `<input type="checkbox">`
 * overlaid by a custom 18x18px visual box. Supports checked, unchecked, and indeterminate
 * states, each with a distinct SVG icon (checkmark or horizontal dash).
 *
 * Styling:
 * - Box border: `2px solid var(--ggui-color-primary-600)` (checked/indeterminate),
 *   `var(--ggui-color-outline)` (unchecked)
 * - Box fill: `var(--ggui-color-primary-600)` (checked/indeterminate),
 *   `var(--ggui-color-surface)` (unchecked)
 * - Check/dash icon: white SVG, 12x12px
 * - Box radius: `var(--ggui-shape-radius-sm)`
 * - Transition: all 0.2s
 * - Label: `var(--ggui-font-size-sm)`, `var(--ggui-font-weight-medium)`
 * - Description: `var(--ggui-font-size-xs)`, `var(--ggui-color-onSurfaceVariant)`
 * - Disabled: `opacity: 0.5`, `cursor: not-allowed`
 * - Gap between box and text: `var(--ggui-spacing-2)`
 *
 * **IMPORTANT:** `onChange` receives the boolean checked state directly, NOT a
 * React `ChangeEvent`.
 *
 * @example
 * <Checkbox
 *   label="Accept terms"
 *   description="You agree to the Terms of Service and Privacy Policy"
 *   checked={accepted}
 *   onChange={setAccepted}
 * />
 */
export interface CheckboxProps extends BaseProps {
  /**
   * Primary label text rendered beside the checkbox box.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /** Controlled checked state. */
  checked?: boolean;
  /**
   * Change handler. Receives the new boolean checked state directly, NOT a React event.
   * @example onChange={(checked) => setAccepted(checked)}
   * @example onChange={setAccepted}
   */
  onChange?: (checked: boolean) => void;
  /**
   * When true, sets `opacity: 0.5` and `cursor: not-allowed`. The native input
   * is also disabled, preventing keyboard and click interaction.
   * @default false
   */
  disabled?: boolean;
  /**
   * Secondary description text rendered below the label in smaller, muted type
   * (`var(--ggui-font-size-xs)`, `var(--ggui-color-onSurfaceVariant)`).
   */
  description?: string;
  /**
   * When true, displays a horizontal dash instead of a checkmark. Used for
   * "select all" states where some (but not all) children are checked.
   * The `indeterminate` property is set via a ref on the native `<input>`.
   * Visually identical to `checked` in terms of border and fill color.
   * @default false
   */
  indeterminate?: boolean;
}

/**
 * Toggle -- A switch/toggle input rendered as a pill-shaped track with a sliding knob.
 *
 * Renders a `<label>` wrapper with a `<div role="switch">` track and an animated
 * circular knob. Does NOT use a native `<input>` -- keyboard interaction is handled
 * manually (Space and Enter keys toggle the state). The element is focusable via
 * `tabIndex={0}` and shows a focus ring on focus.
 *
 * Styling:
 * - Track (on): `var(--ggui-color-primary-600)`
 * - Track (off): `var(--ggui-color-outline)`
 * - Knob: white circle with `var(--ggui-shape-shadow-sm)`
 * - Focus ring: `0 0 0 3px var(--ggui-color-primary-200)`
 * - Transitions: background-color, box-shadow, knob position at 200ms ease-in-out
 * - Disabled: `opacity: 0.5`, `cursor: not-allowed`, `tabIndex: -1`
 * - Gap between toggle and label: `var(--ggui-spacing-2)`
 *
 * **IMPORTANT:** `onChange` receives the new boolean state directly (inverted from
 * current), NOT a React event.
 *
 * @example
 * <Toggle label="Enable notifications" checked={enabled} onChange={setEnabled} size="md" />
 */
export interface ToggleProps extends BaseProps {
  /**
   * Label text rendered to the right of the toggle track.
   * Also used as `aria-label` on the switch element.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /** Controlled checked (on/off) state. */
  checked?: boolean;
  /**
   * Change handler. Receives the new boolean state directly (i.e., `!checked`), NOT a React event.
   * @example onChange={(checked) => setEnabled(checked)}
   * @example onChange={setEnabled}
   */
  onChange?: (checked: boolean) => void;
  /**
   * When true, sets `opacity: 0.5`, `cursor: not-allowed`, and removes the element
   * from tab order (`tabIndex: -1`). Click and keyboard handlers are suppressed.
   * @default false
   */
  disabled?: boolean;
  /**
   * Controls track and knob dimensions:
   * - `'sm'` -- track 36x20px, knob 16px diameter
   * - `'md'` -- track 44x24px, knob 20px diameter
   * - `'lg'` -- track 52x28px, knob 24px diameter
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * An individual option within a `RadioGroup`.
 *
 * Rendered as a `<label>` containing a visually-hidden `<input type="radio">`
 * and a custom 18px circle indicator. Supports an optional description line
 * below the label text.
 */
export interface RadioOption {
  /** The value emitted via `RadioGroupProps.onChange` when this option is selected. Must be unique. */
  value: string;
  /**
   * Display text for this option.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label: string;
  /**
   * Optional secondary description rendered below the label in smaller, muted type
   * (`var(--ggui-font-size-xs)`, `var(--ggui-color-onSurfaceVariant)`).
   */
  description?: string;
  /**
   * When true, this individual option is grayed out (`opacity: 0.5`) and cannot
   * be selected, regardless of the group-level `disabled` prop.
   * @default false
   */
  disabled?: boolean;
}

/**
 * RadioGroup -- A group of mutually exclusive radio options with optional label and error.
 *
 * Renders a `<div role="radiogroup">` containing a label span, a flex container of
 * radio options, and an optional error message. Each option is a `<label>` with a
 * visually-hidden native `<input type="radio">` and a custom 18px circle indicator.
 *
 * Styling:
 * - Selected circle: `2px solid var(--ggui-color-primary-600)` border with
 *   an 8px `var(--ggui-color-primary-600)` filled inner dot
 * - Unselected circle: `2px solid var(--ggui-color-outline)` border,
 *   `var(--ggui-color-surface)` fill
 * - Circle radius: `var(--ggui-shape-radius-full)`
 * - Transition: all 0.2s
 * - Vertical gap: `var(--ggui-spacing-2)`, horizontal gap: `var(--ggui-spacing-4)`
 * - Error: `var(--ggui-font-size-xs)`, `var(--ggui-color-error-500)`,
 *   `role="alert"`
 * - Disabled options: `opacity: 0.5`, `cursor: not-allowed`
 *
 * Accessibility: the group has `role="radiogroup"` with `aria-labelledby` pointing
 * to the label and `aria-describedby` pointing to the error message (when present).
 * All radio inputs share a common auto-generated `name` attribute.
 *
 * **IMPORTANT:** `onChange` receives the selected option's value string directly,
 * NOT a React `ChangeEvent`.
 *
 * @example
 * <RadioGroup
 *   label="Plan"
 *   value={plan}
 *   onChange={setPlan}
 *   options={[
 *     { value: 'free', label: 'Free', description: 'Up to 5 projects' },
 *     { value: 'pro', label: 'Pro', description: 'Unlimited projects' },
 *   ]}
 * />
 */
export interface RadioGroupProps extends BaseProps {
  /**
   * Group label rendered above the options.
   * Used as `aria-labelledby` target on the `role="radiogroup"` container.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /** Controlled value. Should match one of `options[].value`. */
  value?: string;
  /**
   * Change handler. Receives the newly selected option's value string directly, NOT a React event.
   * @example onChange={(value) => setPlan(value)}
   * @example onChange={setPlan}
   */
  onChange?: (value: string) => void;
  /** Array of radio options. Must contain at least two options for meaningful selection. */
  options: RadioOption[];
  /**
   * Layout direction for the options container:
   * - `'vertical'` -- column layout, `var(--ggui-spacing-2)` gap
   * - `'horizontal'` -- row layout with `flex-wrap: wrap`, `var(--ggui-spacing-4)` gap
   * @default 'vertical'
   */
  direction?: 'vertical' | 'horizontal';
  /**
   * When true, disables ALL options (individual `RadioOption.disabled` is additive).
   * Each option gets `opacity: 0.5` and `cursor: not-allowed`.
   * @default false
   */
  disabled?: boolean;
  /**
   * Error message displayed below all options in `var(--ggui-color-error-500)`
   * with `role="alert"`. Linked to the radiogroup via `aria-describedby`.
   */
  error?: string;
}

/**
 * Slider -- A range input with a custom-styled track, fill, and thumb.
 *
 * Renders a `<div>` wrapper containing an optional label/value header, and a
 * track area with three layers: background track, colored fill, and a circular
 * thumb. A native `<input type="range">` is overlaid with `opacity: 0` to
 * provide accessible keyboard and pointer interaction.
 *
 * Styling:
 * - Track: 6px tall, `var(--ggui-color-outlineVariant)` background, `border-radius: 3px`
 * - Fill: `var(--ggui-color-primary-600)` (normal),
 *   `var(--ggui-color-outline)` (disabled)
 * - Thumb: 20px white circle with `2px solid var(--ggui-color-primary-600)`,
 *   `var(--ggui-shape-shadow-sm)`; disabled border uses outline
 * - Value display (when `showValue`): `var(--ggui-color-primary-600)`,
 *   `var(--ggui-font-size-sm)`, right-aligned in the header row
 * - Fill and thumb transitions: 0.1s for smooth dragging
 *
 * Accessibility: the native `<input type="range">` carries `aria-valuenow`,
 * `aria-valuemin`, `aria-valuemax`, and is linked to the label via `aria-labelledby`.
 * Falls back to `aria-label="Slider"` when no label is provided.
 *
 * **IMPORTANT:** `onChange` receives the numeric value directly, NOT a React
 * `ChangeEvent`. The value is coerced via `Number(e.target.value)`.
 *
 * @example
 * <Slider label="Volume" value={volume} onChange={setVolume} min={0} max={100} step={5} showValue />
 */
export interface SliderProps extends BaseProps {
  /**
   * Label rendered above the slider track (left-aligned).
   * Used as `aria-labelledby` target on the native range input.
   * Styled with `var(--ggui-font-size-sm)` and `var(--ggui-color-onSurfaceVariant)`.
   */
  label?: string;
  /**
   * Controlled numeric value. Must be between `min` and `max`.
   * @default 0
   */
  value?: number;
  /**
   * Change handler. Receives the new numeric value directly, NOT a React event.
   * @example onChange={(value) => setVolume(value)}
   * @example onChange={setVolume}
   */
  onChange?: (value: number) => void;
  /**
   * Minimum allowed value.
   * @default 0
   */
  min?: number;
  /**
   * Maximum allowed value.
   * @default 100
   */
  max?: number;
  /**
   * Step increment for the slider. Determines the granularity of selectable values.
   * @default 1
   */
  step?: number;
  /**
   * When true, sets `cursor: not-allowed` on the native input. The fill color
   * changes to `var(--ggui-color-outline)` and the thumb border
   * also uses outline.
   * @default false
   */
  disabled?: boolean;
  /**
   * When true, displays the current numeric value right-aligned in the header row
   * (beside the label) in `var(--ggui-color-primary-600)`.
   * @default false
   */
  showValue?: boolean;
}

// ============================================================================
// Feedback Primitives
// ============================================================================

/**
 * Badge -- Inline label for status indicators, counts, or categories.
 *
 * Renders a `<span>` with `display: inline-flex`, centered content, and
 * `white-space: nowrap`. Semantic variant colors use background/text pairings
 * from the 100/700 color scale. Pill shape uses `border-radius: 9999px`;
 * non-pill uses `var(--ggui-shape-radius-sm)`.
 *
 * Font weight: `var(--ggui-font-weight-medium)` across all variants.
 *
 * @example
 * <Badge variant="success" size="sm">Active</Badge>
 */
export interface BadgeProps extends BaseProps {
  children?: ReactNode;
  /**
   * Visual style. Maps to background/text color pairings:
   * - `'default'` -- bg `var(--ggui-color-surfaceVariant)`, text `var(--ggui-color-onSurfaceVariant)`
   * - `'primary'` -- bg `var(--ggui-color-primary-100)`, text `var(--ggui-color-primary-700)`
   * - `'secondary'` -- bg `var(--ggui-color-outlineVariant)`, text `var(--ggui-color-onSurface)`
   * - `'success'` -- bg `var(--ggui-color-success-100)`, text `var(--ggui-color-success-700)`
   * - `'warning'` -- bg `var(--ggui-color-warning-100)`, text `var(--ggui-color-warning-700)`
   * - `'error'` -- bg `var(--ggui-color-error-100)`, text `var(--ggui-color-error-700)`
   * - `'info'` -- bg `var(--ggui-color-info-100)`, text `var(--ggui-color-info-700)`
   * @default 'default'
   */
  variant?: 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info';
  /**
   * Controls padding and font size:
   * - `'sm'` -- padding `2px 6px`, font `var(--ggui-font-size-xs)`
   * - `'md'` -- padding `2px 8px`, font `var(--ggui-font-size-xs)`
   * - `'lg'` -- padding `4px 10px`, font `var(--ggui-font-size-sm)`
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * When true, uses fully rounded corners (`border-radius: 9999px`).
   * When false, uses `var(--ggui-shape-radius-sm)`.
   * @default true
   */
  pill?: boolean;
}

/**
 * Spinner -- Animated SVG loading indicator.
 *
 * Renders an `<svg>` with `role="status"` and `aria-label="Loading"`.
 * The SVG contains a full outlineVariant background circle and a quarter-arc
 * foreground stroke in the spinner color.
 *
 * Animation: `ggui-spin 1s linear infinite` (360-degree rotation).
 * The `@keyframes ggui-spin` definition is injected inline via a `<style>` tag.
 *
 * @example
 * <Spinner size={32} tone="success" />
 */
export interface SpinnerProps extends BaseProps {
  /**
   * Width and height of the SVG element in pixels. The internal viewBox is
   * always `0 0 24 24`, so this controls rendered size only.
   * @default 24
   */
  size?: number;
  /**
   * Semantic color slot for the animated foreground arc. Same
   * vocabulary as {@link TextProps.tone}; the theme decides the
   * resolved value. The background circle always uses
   * `var(--ggui-color-outlineVariant)`.
   *
   * Use `'inherit'` when the spinner sits inside a colored container
   * (e.g. inside a Button) — the stroke picks up `currentColor` from
   * the parent so it tracks the container's foreground.
   *
   * @default undefined (uses `var(--ggui-color-primary-600)`)
   */
  tone?:
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
}

/**
 * Avatar -- User or entity representation with image or auto-generated initials.
 *
 * Renders a `<div role="img">` with `overflow: hidden` and `flex-shrink: 0`.
 * When `src` is provided and loads successfully, renders an `<img>` with
 * `object-fit: cover`. On image error (or when no `src`), falls back to
 * initials derived from `name` (up to 2 characters, uppercase).
 *
 * Initials background: deterministic color from a 5-color palette based on
 * name hash (primary-500, success-500, warning-500, error-500, info-500).
 * Falls back to `var(--ggui-color-outline)` when no name is given.
 * Initials text: white, `font-weight: var(--ggui-font-weight-semibold)`,
 * `font-size: resolvedSize * 0.4`.
 *
 * @example
 * <Avatar src="/photos/jane.jpg" name="Jane Doe" size="lg" shape="circle" />
 */
export interface AvatarProps extends BaseProps {
  /**
   * Image URL. When provided and the image loads, it is rendered with
   * `object-fit: cover`. On load error, falls back to initials.
   */
  src?: string;
  /**
   * Name used for two purposes:
   * 1. Generating initials (splits on spaces, takes first letter of each word, max 2).
   * 2. Deterministic background color selection via character code hash.
   * Also used as `aria-label` on the container. Falls back to `'Avatar'` if omitted.
   */
  name?: string;
  /**
   * Avatar dimensions. Named sizes map to pixel values:
   * - `'xs'` -- 24px
   * - `'sm'` -- 32px
   * - `'md'` -- 40px
   * - `'lg'` -- 48px
   * - `'xl'` -- 64px
   *
   * Numeric values are used directly as pixel dimensions.
   * @default 'md'
   */
  size?: number | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /**
   * Container shape.
   * - `'circle'` -- `border-radius: 50%`
   * - `'square'` -- `border-radius: var(--ggui-shape-radius-md)`
   * @default 'circle'
   */
  shape?: 'circle' | 'square';
}

/**
 * Alert -- Contextual message box for important information with icon and optional dismiss.
 *
 * Renders a `<div role="alert">` with flex layout (12px gap), variant-specific
 * background, border, text color, and a leading icon. Each variant provides a
 * default SVG icon (info circle, checkmark, warning triangle, or X circle) that
 * can be overridden via the `icon` prop.
 *
 * Layout: icon (flex-shrink: 0) | content column (title + body) | close button.
 * Border radius: `var(--ggui-shape-radius-lg)`.
 * Padding: `12px 16px`.
 *
 * @example
 * <Alert variant="warning" title="Rate limit" closable onClose={() => setShow(false)}>
 *   You have 3 requests remaining this minute.
 * </Alert>
 */
export interface AlertProps extends BaseProps {
  children?: ReactNode;
  /**
   * Visual style. Maps to background/border/text/icon color sets:
   * - `'info'` -- bg `var(--ggui-color-info-50)`, border `var(--ggui-color-info-200)`, text `var(--ggui-color-info-800)`, icon `var(--ggui-color-info-500)`
   * - `'success'` -- bg `var(--ggui-color-success-50)`, border `var(--ggui-color-success-200)`, text `var(--ggui-color-success-800)`, icon `var(--ggui-color-success-500)`
   * - `'warning'` -- bg `var(--ggui-color-warning-50)`, border `var(--ggui-color-warning-200)`, text `var(--ggui-color-warning-800)`, icon `var(--ggui-color-warning-500)`
   * - `'error'` -- bg `var(--ggui-color-error-50)`, border `var(--ggui-color-error-200)`, text `var(--ggui-color-error-800)`, icon `var(--ggui-color-error-500)`
   * @default 'info'
   */
  variant?: 'info' | 'success' | 'warning' | 'error';
  /**
   * Optional title rendered above the body in semibold (`var(--ggui-font-weight-semibold)`),
   * `var(--ggui-font-size-sm)`. Title and body are separated by `var(--ggui-spacing-1)` gap.
   */
  title?: string;
  /**
   * When true, renders a close button (X icon) in the top-right area. The button
   * has `min-width: 28px`, `min-height: 28px`, and `opacity: 0.7`.
   * Requires `onClose` to be functional.
   * @default false
   */
  closable?: boolean;
  /** Callback fired when the close button is clicked. Only relevant when `closable` is true. */
  onClose?: () => void;
  /**
   * Custom icon ReactNode to replace the default variant icon. Rendered at the
   * leading position with the variant's icon color applied via `color` CSS property.
   */
  icon?: ReactNode;
}

/**
 * Progress -- Horizontal progress bar with determinate and indeterminate modes.
 *
 * Renders a track `<div role="progressbar">` with a colored fill child.
 * The track background is `var(--ggui-color-outlineVariant)` with
 * pill-shaped corners (border-radius = height / 2).
 *
 * Determinate mode: fill width transitions smoothly (`width 0.3s ease`).
 * Indeterminate mode: fill is 30% width, animated with
 * `ggui-progress-indeterminate 1.5s ease-in-out infinite`
 * (translateX from -100% to 400%). The `@keyframes` are injected inline.
 *
 * Accessibility: `aria-valuenow` is set in determinate mode, omitted in
 * indeterminate. `aria-valuemin` is always 0, `aria-valuemax` matches `max`.
 *
 * @example
 * <Progress value={65} variant="success" size="md" showLabel />
 */
export interface ProgressProps extends BaseProps {
  /**
   * Current progress value. Clamped to `[0, max]` and converted to a percentage
   * for the fill width: `Math.min(100, Math.max(0, (value / max) * 100))`.
   */
  value: number;
  /**
   * Maximum value representing 100% progress.
   * @default 100
   */
  max?: number;
  /**
   * Fill bar color. Maps to CSS variables:
   * - `'default'` -- `var(--ggui-color-primary-600)`
   * - `'success'` -- `var(--ggui-color-success-500)`
   * - `'warning'` -- `var(--ggui-color-warning-500)`
   * - `'error'` -- `var(--ggui-color-error-500)`
   * @default 'default'
   */
  variant?: 'default' | 'success' | 'warning' | 'error';
  /**
   * Controls track height in pixels:
   * - `'sm'` -- 4px
   * - `'md'` -- 8px
   * - `'lg'` -- 12px
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Accessible name describing what this bar measures, e.g. `"Survey progress"`
   * or `"Upload"`. Becomes the progressbar's `aria-label` and — when `showLabel`
   * is set — the visible header text in place of the generic word "Progress".
   * Always pass this when the surrounding context does not already make the
   * meaning obvious.
   */
  label?: string;
  /**
   * When true, displays a header row above the track with the `label` text
   * (or "Progress" if `label` is unset) on the left, and the rounded
   * percentage value on the right.
   * @default false
   */
  showLabel?: boolean;
  /**
   * When true, ignores `value` for visual width and plays a looping animation
   * instead. The fill bar is 30% width and slides across the track.
   * Animation: `ggui-progress-indeterminate 1.5s ease-in-out infinite`.
   * `aria-valuenow` is omitted from the progressbar element.
   * @default false
   */
  indeterminate?: boolean;
}

// ============================================================================
// Media Primitives
// ============================================================================

/**
 * Image -- An `<img>` element with built-in error handling and fallback support.
 *
 * Renders a native `<img>` with `display: block`. On load error, either renders
 * the `fallback` ReactNode (if provided) or a default placeholder `<div>` with a
 * surfaceVariant background and a centered image SVG icon in outline.
 *
 * Size values: numbers are treated as pixels, strings are passed through as-is.
 * When no `width` is set, defaults to `100%`. When no `height` is set, defaults
 * to `auto`.
 *
 * @example
 * <Image src="/hero.jpg" alt="Hero banner" width="100%" height={400} objectFit="cover" radius="md" />
 */
export interface ImageProps extends BaseProps {
  /** Image source URL. Load failure triggers the fallback state. */
  src: string;
  /** Alt text for the image. Used as `aria-label` in the error placeholder too. */
  alt: string;
  /**
   * Image width. Numbers are pixels, strings are CSS values (e.g., `'100%'`, `'50vw'`).
   * @default '100%' (applied at render time, not on the type)
   */
  width?: number | string;
  /**
   * Image height. Numbers are pixels, strings are CSS values.
   * @default 'auto' (applied at render time, not on the type)
   */
  height?: number | string;
  /**
   * CSS `object-fit` value controlling how the image fills its box.
   * @default 'cover'
   */
  objectFit?: 'cover' | 'contain' | 'fill' | 'none' | 'scale-down';
  /**
   * Corner radius applied to both the image and the error placeholder.
   * Prefer a radius-scale name (`'none' | 'sm' | 'md' | 'lg' | 'xl'`) —
   * each resolves to the matching `--ggui-shape-radius-*` token. A
   * number is treated as pixels; any other string is passed through.
   */
  radius?: 'none' | 'sm' | 'md' | 'lg' | 'xl' | number | string;
  /**
   * Custom ReactNode rendered when the image fails to load. When provided,
   * completely replaces the default error placeholder (no wrapper div).
   * When omitted, a surfaceVariant background div with an image icon is shown.
   */
  fallback?: ReactNode;
}

/**
 * Icon -- 185 Lucide icons + emoji passthrough.
 *
 * Three resolution layers:
 * 1. **Lucide icon:** pass any common Lucide icon name (e.g. `sun`, `cloud-rain`, `heart`, `shopping-cart`).
 *    Accepts kebab-case, camelCase, or PascalCase. Renders as stroke SVG.
 * 2. **Emoji:** pass emoji/unicode directly (e.g. `☀️`, `🌧️`). Rendered as text.
 * 3. **Custom SVG:** pass children (`<svg>` element) for full control.
 *
 * Container: `<span>` with `display: inline-flex`, centered content.
 *
 * @example
 * <Icon name="search" size={20} tone="muted" />
 * <Icon name="cloud-rain" size={32} />
 * <Icon name="☀️" size={24} />
 */
export interface IconProps extends BaseProps {
  /**
   * Lucide icon name (kebab-case, camelCase, or PascalCase all work).
   * Also accepts emoji/unicode characters directly.
   */
  name?: string;
  /**
   * Icon dimensions in pixels (applied to both width and height of the wrapper
   * and the inner SVG element).
   * @default 24
   */
  size?: number;
  /**
   * Semantic color slot. Same vocabulary as {@link TextProps.tone};
   * the theme decides what each tone LOOKS like. Resolves to a CSS
   * `color` on the wrapper which the inner SVG inherits via
   * `currentColor`. Use `'inherit'` (the default behavior when unset)
   * for icons that should pick up the parent's foreground color.
   *
   * @default undefined (icon uses `currentColor`)
   */
  tone?:
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
   * Custom SVG children. When provided, `name` is ignored and children are
   * rendered inside a sized `<span>` wrapper.
   */
  children?: ReactNode;
  /**
   * Accessible name for a standalone, meaning-bearing icon. When set, the
   * icon exposes `role="img"` + this label. When omitted (the default) the
   * icon is decorative and hidden from screen readers (`aria-hidden`) — the
   * right choice for an icon next to a text label.
   */
  'aria-label'?: string;
}

// ============================================================================
// Interactive Primitives
// ============================================================================

/**
 * Link -- Styled anchor element with external link support.
 *
 * Renders a native `<a>` element. When `external` is true, sets
 * `target="_blank"` and `rel="noopener noreferrer"`, and appends a small
 * (12px) external-link SVG icon after the children.
 *
 * Transition: `color 0.2s`.
 * Underline behavior is controlled via mouseEnter/mouseLeave event handlers
 * (for the `'hover'` mode).
 *
 * Also extends native `AnchorHTMLAttributes` (except `style`/`className`),
 * so props like `aria-*`, `data-*`, `title`, etc. are forwarded to the `<a>`.
 *
 * @example
 * <Link href="https://docs.ggui.ai" external>Documentation</Link>
 */
export interface LinkProps extends BaseProps, Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'style' | 'className'> {
  children?: ReactNode;
  /** Destination URL. Passed directly to the `<a href>` attribute. */
  href: string;
  /**
   * When true, opens link in a new tab (`target="_blank"`, `rel="noopener noreferrer"`)
   * and appends a 12px external-link icon after children.
   * @default false
   */
  external?: boolean;
  /**
   * Semantic color slot for the link text. Same vocabulary as
   * {@link TextProps.tone}; the theme decides what each tone LOOKS
   * like. Defaults to a primary-tinted accent (`'loud'`-ish) when
   * unset.
   *
   * @default undefined (uses `var(--ggui-color-primary-600)`)
   */
  tone?:
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
   * Underline behavior:
   * - `'always'` -- `text-decoration: underline` at all times
   * - `'hover'` -- underline appears on mouse enter, removed on mouse leave
   * - `'none'` -- no underline ever
   * @default 'hover'
   */
  underline?: 'always' | 'hover' | 'none';
}

/**
 * Tooltip -- Hoverable information popup positioned relative to a trigger element.
 *
 * Wraps `children` in a `<div>` trigger (display: inline-block) and renders
 * a fixed-position tooltip `<div role="tooltip">` when visible.
 *
 * Tooltip appearance:
 * - Background: `var(--ggui-color-onSurface)`
 * - Text: white, `var(--ggui-font-size-xs)`
 * - Padding: `6px 10px`, border-radius: `var(--ggui-shape-radius-md)`
 * - Max width: 200px, `white-space: nowrap`, `pointer-events: none`
 * - Z-index: `zIndex.tooltip` (1800)
 *
 * Show/hide: triggered by mouseEnter/mouseLeave AND focus/blur on the
 * trigger element. Uses `position: fixed` with coordinates calculated from
 * `getBoundingClientRect()` and an 8px offset from the trigger edge.
 *
 * @example
 * <Tooltip content="Copy to clipboard" position="top">
 *   <Button variant="ghost"><Icon name="copy" /></Button>
 * </Tooltip>
 */
export interface TooltipProps extends BaseProps {
  /** Trigger element. Wrapped in a `<div>` with mouseEnter/mouseLeave and focus/blur handlers. */
  children: ReactNode;
  /** Tooltip content. Can be text or any ReactNode. */
  content: ReactNode;
  /**
   * Tooltip placement relative to the trigger element:
   * - `'top'` -- above, centered horizontally, transformed `translateX(-50%) translateY(-100%)`
   * - `'bottom'` -- below, centered horizontally, transformed `translateX(-50%)`
   * - `'left'` -- to the left, centered vertically, transformed `translateX(-100%) translateY(-50%)`
   * - `'right'` -- to the right, centered vertically, transformed `translateY(-50%)`
   * @default 'top'
   */
  position?: 'top' | 'bottom' | 'left' | 'right';
  /**
   * Delay in milliseconds before the tooltip becomes visible after hover/focus.
   * Hiding is immediate (no delay).
   * @default 200
   */
  delay?: number;
}

// ============================================================================
// Data Display Primitives
// ============================================================================

/**
 * Column definition for the Table component.
 *
 * Each column maps a `key` in the row data object to a table column with
 * a header label, optional sorting, alignment, width, and custom rendering.
 *
 * @typeParam T - Row data shape. Defaults to `Record<string, unknown>`.
 */
export interface TableColumn<T = Record<string, unknown>> {
  /**
   * Property key in the row data object. Used to extract cell values via
   * `row[key]`. Must be unique across all columns in a Table.
   */
  key: string;
  /**
   * Column header text. Rendered in uppercase, `var(--ggui-font-size-xs)`,
   * `var(--ggui-font-weight-semibold)`, `var(--ggui-color-onSurfaceVariant)`,
   * with `letter-spacing: 0.05em`.
   */
  header: string;
  /**
   * Fixed column width. Numbers are pixels, strings are CSS values (e.g., `'200px'`, `'30%'`).
   * When omitted, the column auto-sizes based on content.
   */
  width?: number | string;
  /**
   * Horizontal text alignment for both the header and data cells.
   * @default 'left'
   */
  align?: 'left' | 'center' | 'right';
  /**
   * When true, the header cell becomes clickable and shows sort direction
   * indicators (ascending/descending triangles). Clicking toggles between
   * `'asc'` and `'desc'`. The header gets `cursor: pointer`, `tabIndex: 0`,
   * and keyboard support (Enter/Space to toggle).
   * @default false
   */
  sortable?: boolean;
  /**
   * Custom cell renderer. When provided, called instead of rendering `row[key]`
   * directly. Receives the cell value, the full row object, and the row index.
   *
   * @param value - The value at `row[key]`
   * @param row - The complete row data object
   * @param index - Zero-based row index
   * @returns ReactNode to render in the cell
   */
  render?: (value: unknown, row: T, index: number) => ReactNode;
}

/**
 * Sort direction for Table columns. Used by `TableProps.sortDirection` and
 * the `onSort` callback.
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Table -- Data table with sortable columns, striped rows, and hover highlights.
 *
 * Renders a scrollable wrapper `<div>` containing a native `<table>` with
 * `border-collapse: collapse` and `width: 100%`. The wrapper has
 * `overflow-x: auto` for horizontal scrolling on narrow viewports.
 *
 * Header row: 2px bottom border (`var(--ggui-color-outlineVariant)`).
 * Data rows: 1px bottom border (`var(--ggui-color-surfaceVariant)`).
 * Hover: `var(--ggui-color-surface)` background with 150ms ease transition.
 * Striped: alternating rows (odd index) get `var(--ggui-color-surface)`.
 *
 * Sort behavior: clicking a sortable column header calls `onSort(key, direction)`.
 * If the same column is clicked again while ascending, it toggles to descending.
 * The component does NOT sort data internally -- the parent must sort `data` and
 * pass updated `sortKey`/`sortDirection`.
 *
 * @typeParam T - Row data shape. Defaults to `Record<string, unknown>`.
 *
 * @example
 * <Table
 *   columns={[
 *     { key: 'name', header: 'Name', sortable: true },
 *     { key: 'role', header: 'Role' },
 *     { key: 'status', header: 'Status', render: (v) => <Badge variant={v as string}>{v as string}</Badge> },
 *   ]}
 *   data={users}
 *   sortKey={sortKey}
 *   sortDirection={sortDir}
 *   onSort={(key, dir) => { setSortKey(key); setSortDir(dir); }}
 *   striped
 * />
 */
export interface TableProps<T = Record<string, unknown>> extends BaseProps {
  /** Array of column definitions controlling header labels, data keys, and rendering. */
  columns: TableColumn<T>[];
  /** Array of row data objects. Each object's keys should match the column `key` values. */
  data: T[];
  /**
   * The `key` of the currently sorted column. Used to highlight the active sort
   * indicator and determine toggle direction on next click.
   */
  sortKey?: string;
  /**
   * Current sort direction for the column identified by `sortKey`.
   * Controls which triangle indicator is highlighted in the header.
   * @default 'asc'
   */
  sortDirection?: SortDirection;
  /**
   * Sort change handler. Called when a sortable column header is clicked.
   * Receives the column `key` and the new `SortDirection`. The component does
   * NOT sort data internally -- you must sort `data` in your state and pass
   * updated `sortKey`/`sortDirection`.
   *
   * @param key - Column key that was clicked
   * @param direction - New sort direction (`'asc'` or `'desc'`)
   */
  onSort?: (key: string, direction: SortDirection) => void;
  /**
   * When true, alternating rows (odd index) get a
   * `var(--ggui-color-surface)` background.
   * @default false
   */
  striped?: boolean;
  /**
   * When true, rows highlight with `var(--ggui-color-surface)`
   * on mouse enter, with a 150ms ease background-color transition.
   * @default true
   */
  hoverable?: boolean;
  /**
   * When true, reduces cell padding:
   * - Compact: `var(--ggui-spacing-1) var(--ggui-spacing-2)`
   * - Normal: `var(--ggui-spacing-2) var(--ggui-spacing-4)`
   * @default false
   */
  compact?: boolean;
  /**
   * When true, adds a 1px border around the table wrapper and between cells.
   * Wrapper border: `1px solid var(--ggui-color-outlineVariant)`.
   * Cell borders: `1px solid var(--ggui-color-surfaceVariant)`.
   * Wrapper border-radius: `var(--ggui-shape-radius-lg)`.
   * @default false
   */
  bordered?: boolean;
  /**
   * Accessible table caption. Rendered as a `<caption>` element with
   * `caption-side: top`, `var(--ggui-font-size-sm)`,
   * `var(--ggui-color-onSurfaceVariant)`.
   */
  caption?: string;
}

// ============================================================================
// Navigation Primitives
// ============================================================================

/**
 * Definition of a single tab within a Tabs component.
 *
 * Each item provides a unique `key` for identification, a `label` for the
 * tab button, and `content` for the associated panel.
 */
export interface TabItem {
  /** Unique identifier for this tab. Used to match `activeKey` and as the value passed to `onChange`. */
  key: string;
  /** Tab button label. Can be text or any ReactNode. */
  label: ReactNode;
  /** Panel content rendered below the tab bar when this tab is active. */
  content: ReactNode;
  /**
   * When true, the tab button shows `opacity: 0.5`, `cursor: not-allowed`,
   * and cannot be selected via click or keyboard navigation.
   * @default false
   */
  disabled?: boolean;
  /**
   * Optional icon rendered before the label inside the tab button, with
   * `var(--ggui-spacing-1)` gap between icon and label.
   */
  icon?: ReactNode;
}

/**
 * Tabs -- Accessible tab navigation with panels and keyboard support.
 *
 * Renders a `<div role="tablist">` with `<button role="tab">` elements and a
 * `<div role="tabpanel">` for the active tab's content. Supports controlled
 * (`activeKey` + `onChange`) and uncontrolled (internal state) modes.
 *
 * Keyboard navigation: ArrowLeft/ArrowRight (and ArrowUp/ArrowDown) cycle
 * through enabled tabs. Home/End jump to first/last. Focus follows selection.
 * Disabled tabs are skipped during keyboard navigation.
 *
 * **IMPORTANT:** `onChange` receives the tab's `key` string directly, NOT a
 * React event.
 *
 * Tab panel padding: `var(--ggui-spacing-4) 0` (top/bottom only).
 * Transitions: color, background-color, border-color at 200ms ease-in-out.
 *
 * @example
 * <Tabs
 *   variant="pills"
 *   items={[
 *     { key: 'overview', label: 'Overview', content: <Overview /> },
 *     { key: 'settings', label: 'Settings', content: <Settings /> },
 *   ]}
 *   activeKey={tab}
 *   onChange={setTab}
 * />
 */
export interface TabsProps extends BaseProps {
  /** Array of tab definitions. Must contain at least one item. */
  items: TabItem[];
  /**
   * Controlled active tab key. When provided, the component is controlled and
   * will not manage its own state. Must match one of `items[].key`.
   * When omitted, defaults to the first item's key (uncontrolled mode).
   */
  activeKey?: string;
  /**
   * Tab change handler. Receives the selected tab's `key` string directly,
   * NOT a React event. In controlled mode, you must update `activeKey` in
   * response to this callback.
   * @example onChange={(key) => setTab(key)}
   * @example onChange={setTab}
   */
  onChange?: (key: string) => void;
  /**
   * Visual style of the tab bar:
   * - `'line'` -- underline indicator (2px solid primary-600 on active), border-bottom on tab list
   * - `'pills'` -- filled pill buttons (primary-600 bg, white text on active), surfaceVariant container with radius-lg
   * - `'enclosed'` -- bordered tab buttons with open bottom (card-style), border-bottom on tab list
   * @default 'line'
   */
  variant?: 'line' | 'pills' | 'enclosed';
  /**
   * Controls tab button padding and font size:
   * - `'sm'` -- padding `var(--ggui-spacing-1) var(--ggui-spacing-2)`, font `var(--ggui-font-size-xs)`
   * - `'md'` -- padding `var(--ggui-spacing-2) var(--ggui-spacing-4)`, font `var(--ggui-font-size-sm)`
   * - `'lg'` -- padding `var(--ggui-spacing-4) var(--ggui-spacing-6)`, font `var(--ggui-font-size-base)`
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * When true, tab buttons expand equally to fill the container width
   * (`flex: 1`, `justify-content: center` on each button).
   * @default false
   */
  fullWidth?: boolean;
}

// ============================================================================
// Notification Primitives
// ============================================================================

/**
 * Toast -- Notification banner with auto-dismiss and slide-in animation.
 *
 * Renders a `<div role="alert" aria-live="assertive">` with a variant-specific
 * icon, optional title, message body, and optional close button.
 *
 * Animation: `ggui-slideInUp 200ms ease-out both` on mount (from the motion
 * token system). The keyframes are provided by the MotionKeyframes provider.
 *
 * Auto-dismiss: when `onClose` is provided and `duration > 0`, a timer calls
 * `onClose` after `duration` ms. Setting `duration` to `0` disables auto-dismiss.
 * The timer resets if `visible`, `duration`, or `onClose` changes.
 *
 * Dimensions: `min-width: 280px`, `max-width: 420px`.
 * Shadow: `var(--ggui-shape-shadow-lg, 0 10px 15px -3px rgba(0,0,0,0.1))`.
 * Border radius: `var(--ggui-shape-radius-lg)`.
 *
 * When `visible` is false, renders nothing (returns `null`).
 *
 * @example
 * <Toast variant="success" title="Saved" message="Your changes have been saved." onClose={() => setShow(false)} />
 */
export interface ToastProps extends BaseProps {
  /** Message body content. Can be text or any ReactNode. */
  message: ReactNode;
  /**
   * Visual style. Maps to background/border/text/icon color sets (same palette as Alert):
   * - `'info'` -- bg `var(--ggui-color-info-50)`, border `var(--ggui-color-info-200)`, text `var(--ggui-color-info-800)`
   * - `'success'` -- bg `var(--ggui-color-success-50)`, border `var(--ggui-color-success-200)`, text `var(--ggui-color-success-800)`
   * - `'warning'` -- bg `var(--ggui-color-warning-50)`, border `var(--ggui-color-warning-200)`, text `var(--ggui-color-warning-800)`
   * - `'error'` -- bg `var(--ggui-color-error-50)`, border `var(--ggui-color-error-200)`, text `var(--ggui-color-error-800)`
   * @default 'info'
   */
  variant?: 'info' | 'success' | 'warning' | 'error';
  /**
   * Optional title rendered above the message in semibold
   * (`var(--ggui-font-weight-semibold)`, `var(--ggui-font-size-sm)`).
   */
  title?: string;
  /**
   * Auto-dismiss delay in milliseconds. After this duration, `onClose` is called
   * automatically. Set to `0` to disable auto-dismiss (toast stays until manually closed).
   * The timer is only active when both `visible` is true and `onClose` is provided.
   * @default 5000
   */
  duration?: number;
  /**
   * Callback fired on auto-dismiss timeout or when the close button is clicked.
   * When provided, a close button (X icon, 16px) is rendered in the top-right area.
   * When omitted, no close button is shown and auto-dismiss is disabled.
   */
  onClose?: () => void;
  /**
   * Controls rendering. When false, the component returns `null`.
   * Toggling from false to true triggers the slide-in animation.
   * @default true
   */
  visible?: boolean;
  /**
   * Intended screen position. This prop is defined on the interface but is NOT
   * implemented by the Toast component itself -- positioning must be handled by
   * a parent container or toast manager.
   */
  position?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'top-center' | 'bottom-center';
}

// ============================================================================
// Disclosure Primitives
// ============================================================================

/**
 * Definition of a single collapsible section within an Accordion.
 *
 * Each item provides a unique `key`, a clickable `title` for the header button,
 * and `content` revealed when expanded.
 */
export interface AccordionItem {
  /** Unique identifier for this item. Used in `expandedKeys` and passed to `onChange`. */
  key: string;
  /** Header label rendered inside the toggle button. Can be text or any ReactNode. */
  title: ReactNode;
  /**
   * Panel content rendered below the header when expanded. Styled with
   * `var(--ggui-font-size-sm)`, `var(--ggui-color-onSurfaceVariant)`,
   * `line-height: var(--ggui-font-lineHeight-normal, 1.5)`.
   * Padding: `0 var(--ggui-spacing-4) var(--ggui-spacing-4)`.
   */
  content: ReactNode;
  /**
   * When true, the header button shows `opacity: 0.5`, `cursor: not-allowed`,
   * and cannot be toggled.
   * @default false
   */
  disabled?: boolean;
}

/**
 * Accordion -- Collapsible content sections with chevron rotation animation.
 *
 * Renders a vertical list of items, each with a `<button>` header (inside `<h3>`)
 * and a `<div role="region">` panel. Supports controlled (`expandedKeys` + `onChange`)
 * and uncontrolled (internal state) modes.
 *
 * Chevron animation: the trailing chevron icon rotates from 0deg (collapsed) to
 * 180deg (expanded) with `transition: transform 200ms ease-in-out`.
 *
 * Header button: full-width flex layout (`justify-content: space-between`),
 * `var(--ggui-font-size-sm)`, `var(--ggui-font-weight-medium)`,
 * `var(--ggui-color-onSurface)`.
 * Header padding: `var(--ggui-spacing-2) var(--ggui-spacing-4)`.
 * Background transition: `background-color 100ms ease-in-out`.
 *
 * **IMPORTANT:** `onChange` receives the full array of currently expanded keys,
 * NOT a single key or a React event. In single mode (`multiple: false`), this
 * array will have at most one element.
 *
 * @example
 * <Accordion
 *   variant="separated"
 *   items={[
 *     { key: 'faq1', title: 'How do I get started?', content: 'Sign up and...' },
 *     { key: 'faq2', title: 'What is the pricing?', content: 'We offer...' },
 *   ]}
 *   expandedKeys={expanded}
 *   onChange={setExpanded}
 *   multiple
 * />
 */
export interface AccordionProps extends BaseProps {
  /** Array of collapsible section definitions. */
  items: AccordionItem[];
  /**
   * Controlled expanded state. Array of item `key` values that should be
   * open. When provided, the component is controlled and will not manage
   * its own expansion state.
   * When omitted, defaults to `[]` (all collapsed, uncontrolled mode).
   */
  expandedKeys?: string[];
  /**
   * Expand/collapse handler. Receives the complete array of expanded keys
   * after a toggle. In controlled mode, you must update `expandedKeys` in
   * response to this callback.
   *
   * @param expandedKeys - Array of currently expanded item keys
   * @example onChange={(keys) => setExpanded(keys)}
   * @example onChange={setExpanded}
   */
  onChange?: (expandedKeys: string[]) => void;
  /**
   * When true, multiple items can be open simultaneously. When false,
   * opening one item closes any other open item (single-expand mode).
   * @default false
   */
  multiple?: boolean;
  /**
   * Visual style controlling borders and spacing:
   * - `'default'` -- top border on first item, bottom border on all items (`var(--ggui-color-outlineVariant)`), no gap between items
   * - `'bordered'` -- connected card style with left/right/bottom borders on all items, top border on first, shared rounded corners (radius-lg on first/last)
   * - `'separated'` -- each item is an independent card with full border (`1px solid var(--ggui-color-outlineVariant)`), `var(--ggui-shape-radius-lg)` radius, `var(--ggui-spacing-2)` gap between items
   * @default 'default'
   */
  variant?: 'default' | 'bordered' | 'separated';
}
