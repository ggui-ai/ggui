/**
 * @ggui-ai/design - GGUI Design System
 *
 * A complete design system following atomic design principles, built for
 * AI-generated UI components. All primitives use CSS custom variables with
 * fallbacks, enabling runtime theming via DTCG token injection.
 *
 * **Component hierarchy (atomic design):**
 * - **Primitives** (Atoms): Single-purpose building blocks (Button, Input, Card)
 * - **Components** (Molecules): Functional units combining 2-3 primitives (SearchField, FormField)
 * - **Compositions** (Organisms): Self-contained sections with logic/state (Header, Modal, DataTable)
 *
 * **Import paths:** generated component code and app code use the bare
 * barrel — primitives, components, compositions, and tokens all
 * resolve from `@ggui-ai/design`.
 * ```ts
 * import { Button, Input, SearchField, Modal } from '@ggui-ai/design';
 * import { colors, spacing } from '@ggui-ai/design';
 * ```
 * Renderer integrators use the subpaths kept out of the barrel:
 * `@ggui-ai/design/preview`, `/rendering`, `/module-loader`, `/inline`.
 *
 * @packageDocumentation
 */

// The bare barrel is the one import path for generated component code
// and human consumers alike. `import { Card, Grid, Modal, Clickable }
// from '@ggui-ai/design'` — no caller ever has to predict which internal
// folder a name lives in. Renderer-facing modules (preview / rendering /
// module-loader / inline) deliberately stay OUT of the barrel and ship
// as subpaths only.
export * from './primitives';
export * from './components';
export * from './compositions';
export * from './interact';
export * from './tokens';
// The Icon primitive's curated Lucide subset, kebab-case (ggui#1015) — read
// by the generator's icon tool and its check leg. Exported from the root
// only: it is data, not a primitive, so it stays out of the `primitives`
// subpath (the renderer shim's allowlist and the VALID_PRIMITIVES list).
export { LUCIDE_ICON_NAMES } from './primitives/icon-data';
export * from './themes';

// Re-export types, excluding conflicts with tokens
export type {
  BaseProps,
  ContainerBaseProps,
  Size,
  ColorVariant,
  Alignment,
  JustifyContent,
  Direction,
  TextAlign,
  FontWeight as FontWeightType,
  Shadow as ShadowType,
  Radius as RadiusType,
} from './types';
