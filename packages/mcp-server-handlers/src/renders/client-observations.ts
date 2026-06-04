/**
 * Shared zod schema for the `client.*` output envelope every handler
 * with an "agent return value" attaches when client-side observations
 * exist on the render. Today carries only `hostContext`; future
 * additions may layer further client signals (e.g. echoed
 * `InterfaceContext`, last-known navigation state) here.
 *
 * Extracted to a shared module so `handshake.ts` and `consume.ts`
 * stay in lockstep. Adding a field here updates both handlers'
 * outputs simultaneously; the alternative (per-handler inlining)
 * has shown drift bugs in past schema additions.
 */
import { z } from 'zod';

export const hostContextProjectionSchema = z
  .object({
    availableDisplayModes: z
      .array(z.enum(['inline', 'fullscreen', 'pip']))
      .optional(),
    currentDisplayMode: z.enum(['inline', 'fullscreen', 'pip']).optional(),
    containerDimensions: z
      .object({
        width: z.number().optional(),
        maxWidth: z.number().optional(),
        height: z.number().optional(),
        maxHeight: z.number().optional(),
      })
      .optional(),
    platform: z.enum(['web', 'desktop', 'mobile']).optional(),
    deviceCapabilities: z
      .object({
        touch: z.boolean().optional(),
        hover: z.boolean().optional(),
      })
      .optional(),
    locale: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .optional();

/**
 * Top-level `client` envelope. Always optional on handler output —
 * absent when no client observations are available (e.g. iframe
 * hasn't completed `ui/initialize` yet).
 */
export const clientObservationsSchema = z
  .object({
    hostContext: hostContextProjectionSchema,
  })
  .optional();
