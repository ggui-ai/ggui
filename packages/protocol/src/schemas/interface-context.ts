/**
 * Interface-context schema — the client's viewport/platform snapshot every
 * handshake and every `InvokeEvent` carries. Its own module (ggui#819) so
 * the browser entry (`@ggui-ai/protocol/wire`) reaches it without the
 * tool schemas that used to share its file.
 */
import { z } from 'zod';

export const viewportSchema = z.object({
  width: z.number(),
  height: z.number(),
});

export const interfaceContextSchema = z.object({
  viewport: viewportSchema,
  platform: z.enum(['web', 'mobile', 'desktop']),
  deviceType: z.enum(['phone', 'tablet', 'desktop']),
  orientation: z.enum(['portrait', 'landscape']),
  devicePixelRatio: z.number().optional(),
  touchPrimary: z.boolean().optional(),
  shellType: z.enum(['chat', 'fullscreen', 'spatial']).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  reducedMotion: z.boolean().optional(),
}).passthrough();

