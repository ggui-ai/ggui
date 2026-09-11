import { z } from 'zod';

/**
 * The rendering-context vocabulary — how and where a generated component
 * will be displayed (ggui#1000, `items[].rendering?` on the bootstrap door).
 *
 * ONE vocabulary. It used to exist twice as hand-declared unions
 * (`@ggui-ai/mcp-server-core` `UiGenerateInput.rendering`, `@ggui-ai/ui-gen`
 * `RenderingContext`) and nowhere as a schema; a wire that carries it needs
 * a validator, so it lives here and every consumer derives its type from
 * this schema — never a second spelling, never a narrower one at a door.
 *
 * Parties and obligations: a SENDER (a host announcing where the
 * component renders; a provisioning caller pre-minting for a chip) sends
 * `{ shell, device, viewport? }` from this vocabulary and nothing else; a
 * RECEIVER validates with this schema and answers an invalid value with its
 * surface's typed refusal (the bootstrap door: `400 invalid_rendering`);
 * what a lane can JUDGE for a given shell/device (its canvas pair) is that
 * lane's policy, reported on its receipt — never a trimmed vocabulary.
 * Absent ⇒ the receiver's default behaviour, unchanged.
 */
export const RENDERING_SHELLS = ['chat', 'fullscreen', 'partial'] as const;
export const RENDERING_DEVICES = ['mobile', 'tablet', 'desktop', 'spatial'] as const;

export type RenderingShell = (typeof RENDERING_SHELLS)[number];
export type RenderingDevice = (typeof RENDERING_DEVICES)[number];

/** Viewport in CSS pixels — both dimensions, finite and positive. */
export const renderingViewportSchema = z
  .object({
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

export const renderingContextSchema = z
  .object({
    /** Device category — affects touch targets, column count, density. */
    device: z.enum(RENDERING_DEVICES),
    /** Shell type — the container the component renders in. */
    shell: z.enum(RENDERING_SHELLS),
    /** Viewport dimensions in CSS pixels (optional). */
    viewport: renderingViewportSchema.optional(),
  })
  .strict();

export type RenderingContext = z.infer<typeof renderingContextSchema>;
