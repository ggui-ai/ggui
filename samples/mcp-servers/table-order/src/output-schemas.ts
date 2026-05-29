/**
 * Zod output schemas advertised via each tool's `outputSchema` (spec §8).
 *
 * The MCP SDK validates a tool's `structuredContent` against these and
 * surfaces the shape in `tools/list`, so clients/agents know what comes
 * back. Kept deliberately loose on enum-ish string fields (status,
 * category, tags) to describe the wire shape without re-encoding every
 * domain enum — the authoritative types live in `types.ts`.
 */
import { z } from 'zod';

const modifierOptionOut = z.object({
  id: z.string(),
  label: z.string(),
  priceDeltaCents: z.number().int(),
});
const modifierGroupOut = z.object({
  id: z.string(),
  label: z.string(),
  required: z.boolean(),
  multi: z.boolean(),
  options: z.array(modifierOptionOut),
});

export const menuItemOut = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  priceCents: z.number().int(),
  category: z.string(),
  tags: z.array(z.string()),
  options: z.array(modifierGroupOut),
  available: z.boolean(),
  photoPath: z.string(),
  photoUrl: z.string(),
});

const orderLineOut = z.object({
  lineId: z.string(),
  itemId: z.string(),
  name: z.string(),
  qty: z.number().int(),
  selectedOptions: z.array(z.object({ groupId: z.string(), optionId: z.string() })),
  lineTotalCents: z.number().int(),
});

export const orderOut = z.object({
  orderId: z.string(),
  tableId: z.string(),
  status: z.string(),
  lines: z.array(orderLineOut),
  subtotalCents: z.number().int(),
  placedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const tableOut = z.object({
  tableId: z.string(),
  label: z.string(),
  status: z.string(),
  currentOrderId: z.string().nullable(),
});

export const salesSummaryOut = z.object({
  period: z.string(),
  orderCount: z.number().int(),
  revenueCents: z.number().int(),
  topItems: z.array(
    z.object({
      itemId: z.string(),
      name: z.string(),
      qty: z.number().int(),
      revenueCents: z.number().int(),
    }),
  ),
});

export const identityOut = z.object({
  role: z.string(),
  restaurantId: z.string(),
  tableId: z.string().optional(),
  principalId: z.string(),
});
