/**
 * A2UI component shapes for ggui's V1 provisional subset.
 *
 * Each component has:
 *   - `id`: stable string identifier. Replace-by-id is the state model;
 *     re-emitting a component with the same id replaces it.
 *   - `component`: discriminator naming the catalog type.
 *   - Type-specific fields per the A2UI Basic Catalog.
 *
 * Schema discipline:
 *   - Unknown component names reject (discriminated union).
 *   - Unknown fields on a known component are stripped silently
 *     (Zod default). Tolerant because A2UI Basic Catalog evolves
 *     upstream and Haiku may emit extra hints we simply don't need.
 *   - Children references are plain strings — A2UI's "flat adjacency
 *     list" model. We don't enforce reference integrity at parse time;
 *     that's a renderer concern.
 */
import { z } from 'zod';

/** Shared base: every component carries a stable string id. */
const ComponentBase = z.object({
  id: z.string().min(1),
});

/**
 * Stable-id string reference to another component.
 * Narrow alias so consumers can spot refs in the schema.
 */
const ComponentRef = z.string().min(1);

/** Shared layout hints accepted by container components. */
const Align = z.enum(['start', 'center', 'end', 'stretch']);
const Justify = z.enum([
  'start',
  'center',
  'end',
  'between',
  'around',
  'evenly',
]);

/**
 * Horizontal container. Children are referenced by id, in order.
 * Non-interactive in V1 — a provisional Row visually mirrors the real
 * final layout without wiring interaction.
 */
const RowComponent = ComponentBase.extend({
  component: z.literal('Row'),
  children: z.array(ComponentRef).optional(),
  gap: z.string().optional(),
  align: Align.optional(),
  justify: Justify.optional(),
});

/** Vertical container. Same shape as Row, different axis. */
const ColumnComponent = ComponentBase.extend({
  component: z.literal('Column'),
  children: z.array(ComponentRef).optional(),
  gap: z.string().optional(),
  align: Align.optional(),
  justify: Justify.optional(),
});

/**
 * Card — single-child container with surface treatment. A2UI's
 * canonical example uses a singular `child` key (not `children`)
 * for Card; we honor that shape.
 */
const CardComponent = ComponentBase.extend({
  component: z.literal('Card'),
  child: ComponentRef.optional(),
});

/** Generic ordered list of components referenced by id. */
const ListComponent = ComponentBase.extend({
  component: z.literal('List'),
  children: z.array(ComponentRef).optional(),
});

/** Visual separator. No children, no payload. */
const DividerComponent = ComponentBase.extend({
  component: z.literal('Divider'),
  orientation: z.enum(['horizontal', 'vertical']).optional(),
});

/**
 * Text block. A2UI supports Markdown inside `text` and uses `variant`
 * to carry semantic level (`h1`..`h6`, `body`, `caption`, `label`).
 * We accept any variant string since Haiku may produce variants we
 * hadn't anticipated — unknown variants degrade to default body text
 * in the renderer, not a parse failure.
 */
const TextComponent = ComponentBase.extend({
  component: z.literal('Text'),
  text: z.string(),
  variant: z.string().optional(),
});

/** Image. `alt` is recommended; not required for non-interactive preview. */
const ImageComponent = ComponentBase.extend({
  component: z.literal('Image'),
  src: z.string().min(1),
  alt: z.string().optional(),
});

/**
 * Icon. `name` targets the upstream icon set (Material / Lucide
 * family); the renderer maps it to its own icon registry.
 */
const IconComponent = ComponentBase.extend({
  component: z.literal('Icon'),
  name: z.string().min(1),
});

/**
 * Button shell — always disabled/non-interactive in V1. The `label`
 * is rendered; `action` (if any A2UI emits) is intentionally dropped
 * at the renderer since we don't process interactions on the
 * provisional surface.
 */
const ButtonComponent = ComponentBase.extend({
  component: z.literal('Button'),
  label: z.string(),
});

/** Text input shell. Non-interactive in V1. */
const TextFieldComponent = ComponentBase.extend({
  component: z.literal('TextField'),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  value: z.string().optional(),
});

/** Checkbox shell. Non-interactive in V1. */
const CheckBoxComponent = ComponentBase.extend({
  component: z.literal('CheckBox'),
  label: z.string().optional(),
  checked: z.boolean().optional(),
});

/**
 * Single-choice picker shell. Options are tuples of label + value.
 * Non-interactive in V1 — rendered as a disabled select affordance.
 */
const ChoicePickerOption = z.object({
  label: z.string(),
  value: z.string(),
});
const ChoicePickerComponent = ComponentBase.extend({
  component: z.literal('ChoicePicker'),
  label: z.string().optional(),
  options: z.array(ChoicePickerOption).optional(),
  value: z.string().optional(),
});

/**
 * Component schema — discriminated union over `component`. Unknown
 * discriminator values reject at parse time. This is the catalog
 * gate.
 */
export const ComponentSchema = z.discriminatedUnion('component', [
  RowComponent,
  ColumnComponent,
  CardComponent,
  ListComponent,
  DividerComponent,
  TextComponent,
  ImageComponent,
  IconComponent,
  ButtonComponent,
  TextFieldComponent,
  CheckBoxComponent,
  ChoicePickerComponent,
]);

export type Component = z.infer<typeof ComponentSchema>;

/**
 * Narrow type helper — pulls the variant matching a given component
 * discriminator. `PickComponent<'Row'>` → the RowComponent type.
 */
export type PickComponent<K extends Component['component']> = Extract<
  Component,
  { component: K }
>;

/** Parse result for the component gate. */
export type ComponentParseResult =
  | { readonly ok: true; readonly value: Component }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
    };

/**
 * Safe-parse a single component. Returns a discriminated result so
 * callers don't have to choose between throwing and inspecting
 * `ZodError`. Kept narrow on purpose — we don't re-export Zod's
 * internals.
 */
export function parseComponent(input: unknown): ComponentParseResult {
  const result = ComponentSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}
