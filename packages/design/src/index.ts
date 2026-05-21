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
 * - **Templates**: Full-screen agent interface layouts (Dashboard, ListDetail, ChatInterface)
 *
 * **Import path:** everything ships from the single bare barrel —
 * primitives, components, compositions, blueprints, and tokens all
 * resolve from `@ggui-ai/design`.
 * ```ts
 * import { Button, Input, SearchField, Modal, Dashboard } from '@ggui-ai/design';
 * import { colors, spacing } from '@ggui-ai/design';
 * ```
 *
 * @packageDocumentation
 */

// The bare barrel is the ONE import path — for generated component code
// and for human consumers alike. `import { Card, Grid, Modal, Clickable }
// from '@ggui-ai/design'` — no caller ever has to predict which internal
// folder a name lives in.
export * from './primitives';
export * from './components';
export * from './compositions';
export * from './interact';
export * from './blueprints';
export * from './tokens';
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
