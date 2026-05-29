/**
 * Customer (table-bound) MCP tool catalog — registered on `/customer/mcp`.
 *
 * Pure domain tools the diner's agent calls; each returns structured data
 * the agent renders via ggui (this server never renders UI). The table is
 * taken from `ctx`, so none of these tools accept a table argument.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TableOrderService } from '../service.js';
import type { AuthContext } from '../types.js';
import { guard, registerWhoami } from '../tool-result.js';
import { menuItemView } from '../serialize.js';
import { menuItemOut, orderOut, tableOut } from '../output-schemas.js';

export interface CustomerToolDeps {
  readonly service: TableOrderService;
  readonly ctx: AuthContext;
  /** Base URL used to absolutize relative photo paths so they resolve from the browser. */
  readonly baseUrl: string;
}

const optionSchema = z.object({
  groupId: z.string().describe('Modifier group id, e.g. "size".'),
  optionId: z.string().describe('Chosen option id within that group, e.g. "lg".'),
});

export function registerCustomerTools(server: McpServer, deps: CustomerToolDeps): void {
  const { service, ctx, baseUrl } = deps;

  server.registerTool(
    'browse_menu',
    {
      title: 'Menu · Browse',
      description:
        'List orderable menu items, optionally filtered by free-text query or category. Each item includes price (cents), tags, modifier option groups, and an absolute photoUrl. Use as the data source to render a menu of cards.',
      inputSchema: {
        query: z.string().optional().describe('Free-text search over name + description.'),
        category: z
          .enum(['starters', 'mains', 'drinks', 'desserts'])
          .optional()
          .describe('Restrict to one menu section.'),
      },
      outputSchema: { items: z.array(menuItemOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(() => ({
        items: service
          .browseMenu(ctx, { query: input.query, category: input.category })
          .map((item) => menuItemView(item, baseUrl)),
      })),
  );

  server.registerTool(
    'get_item_details',
    {
      title: 'Menu · Item details',
      description:
        'Fetch one menu item by id, including its modifier option groups (size, spice, extras) so the agent can render a modifier form.',
      inputSchema: { itemId: z.string().describe('The menu item id, e.g. "item-margherita".') },
      outputSchema: { item: menuItemOut },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => guard(() => ({ item: menuItemView(service.getItemDetails(ctx, input.itemId), baseUrl) })),
  );

  server.registerTool(
    'add_to_order',
    {
      title: 'Order · Add item',
      description:
        'Add an item (with optional chosen modifiers) to this table\'s order, creating a draft order if none exists. Returns the updated order with line totals + subtotal (cents). Use after the diner confirms an add-to-order action.',
      inputSchema: {
        itemId: z.string().describe('The menu item id to add.'),
        qty: z.number().int().min(1).describe('Quantity, a positive integer.'),
        options: z.array(optionSchema).optional().describe('Chosen modifiers, if any.'),
      },
      outputSchema: { order: orderOut },
      annotations: { openWorldHint: false },
    },
    async (input) =>
      guard(() => ({
        order: service.addToOrder(ctx, {
          itemId: input.itemId,
          qty: input.qty,
          selectedOptions: input.options,
        }),
      })),
  );

  server.registerTool(
    'update_order_item',
    {
      title: 'Order · Update line',
      description:
        'Change the quantity and/or modifiers of an existing draft order line. Returns the updated order. Only a draft (not-yet-submitted) order can be edited.',
      inputSchema: {
        lineId: z.string().describe('The order line id to update.'),
        qty: z.number().int().min(1).optional().describe('New quantity, if changing.'),
        options: z.array(optionSchema).optional().describe('Replacement modifiers, if changing.'),
      },
      outputSchema: { order: orderOut },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(() => ({
        order: service.updateOrderItem(ctx, {
          lineId: input.lineId,
          qty: input.qty,
          selectedOptions: input.options,
        }),
      })),
  );

  server.registerTool(
    'remove_order_item',
    {
      title: 'Order · Remove line',
      description: 'Remove a line from this table\'s draft order. Returns the updated order.',
      inputSchema: { lineId: z.string().describe('The order line id to remove.') },
      outputSchema: { order: orderOut },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(() => ({ order: service.removeOrderItem(ctx, input.lineId) })),
  );

  server.registerTool(
    'view_order',
    {
      title: 'Order · View',
      description:
        'Return this table\'s current order (draft or in-progress), with lines + subtotal, or null if there is none yet.',
      inputSchema: {},
      outputSchema: { order: orderOut.nullable() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(() => ({ order: service.viewOrder(ctx) })),
  );

  server.registerTool(
    'submit_order',
    {
      title: 'Order · Submit',
      description:
        'Submit this table\'s draft order to the kitchen (draft → submitted, stamps placedAt). Returns the submitted order. Use when the diner confirms they are done ordering.',
      inputSchema: {},
      outputSchema: { order: orderOut },
      annotations: { openWorldHint: false },
    },
    async () => guard(() => ({ order: service.submitOrder(ctx) })),
  );

  server.registerTool(
    'request_assistance',
    {
      title: 'Table · Request help',
      description:
        'Flag this table as needing a server\'s attention (optionally with a reason). Returns the table with its updated status.',
      inputSchema: { reason: z.string().optional().describe('Optional note, e.g. "more water".') },
      outputSchema: { table: tableOut },
      annotations: { openWorldHint: false },
    },
    async (input) => guard(() => ({ table: service.requestAssistance(ctx, input.reason) })),
  );

  registerWhoami(server, ctx);
}
