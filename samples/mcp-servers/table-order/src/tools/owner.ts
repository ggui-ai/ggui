/**
 * Owner (restaurant-wide) MCP tool catalog — registered on `/owner/mcp`.
 *
 * Pure domain tools the owner/staff agent calls; each returns structured
 * data the agent renders via ggui (kitchen board, sales chart, floor map).
 * This server never renders UI.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TableOrderService } from '../service.js';
import type { AuthContext } from '../types.js';
import { guard, registerWhoami } from '../tool-result.js';
import { menuItemView } from '../serialize.js';
import { menuItemOut, orderOut, salesSummaryOut, tableOut } from '../output-schemas.js';

export interface OwnerToolDeps {
  readonly service: TableOrderService;
  readonly ctx: AuthContext;
  /** Used to absolutize the photo on the item returned by set_menu_availability. */
  readonly baseUrl: string;
}

export function registerOwnerTools(server: McpServer, deps: OwnerToolDeps): void {
  const { service, ctx, baseUrl } = deps;

  server.registerTool(
    'get_order_queue',
    {
      title: 'Kitchen · Order queue',
      description:
        'List orders for the kitchen board. Defaults to active tickets (submitted, cooking, ready); pass a status to filter. Returns orders with lines + subtotal. Use as the data source to render a status-column board.',
      inputSchema: {
        status: z
          .enum(['draft', 'submitted', 'cooking', 'ready', 'served', 'voided'])
          .optional()
          .describe('Filter to a single order status.'),
        station: z.string().optional().describe('Accepted for forward-compat; not used in this sample.'),
      },
      outputSchema: { orders: z.array(orderOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(() => ({ orders: service.getOrderQueue(ctx, { status: input.status, station: input.station }) })),
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Kitchen · Advance order',
      description:
        'Move an order along its lifecycle (submitted → cooking → ready → served). Returns the updated order. Use void_order to cancel — this tool cannot set draft or voided.',
      inputSchema: {
        orderId: z.string().describe('The order id to update.'),
        status: z.enum(['submitted', 'cooking', 'ready', 'served']).describe('The new status.'),
      },
      outputSchema: { order: orderOut },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(() => ({ order: service.updateOrderStatus(ctx, input.orderId, input.status) })),
  );

  server.registerTool(
    'set_menu_availability',
    {
      title: 'Menu · Set availability',
      description:
        'Mark a menu item available or "86\'d" (unavailable). Returns the updated item. Use to take an item off the menu when it runs out.',
      inputSchema: {
        itemId: z.string().describe('The menu item id.'),
        available: z.boolean().describe('true = orderable, false = 86\'d.'),
      },
      outputSchema: { item: menuItemOut },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      guard(() => ({ item: menuItemView(service.setMenuAvailability(ctx, input.itemId, input.available), baseUrl) })),
  );

  server.registerTool(
    'get_sales_summary',
    {
      title: 'Analytics · Sales summary',
      description:
        'Return revenue (cents), order count, and top-selling items for a period (today, week, or all). Use as the data source to render a sales dashboard chart.',
      inputSchema: {
        period: z
          .enum(['today', 'week', 'all'])
          .optional()
          .describe('Reporting window; defaults to today.'),
      },
      outputSchema: { summary: salesSummaryOut },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => guard(() => ({ summary: service.getSalesSummary(ctx, input.period ?? 'today') })),
  );

  server.registerTool(
    'list_tables',
    {
      title: 'Floor · List tables',
      description:
        'List dining tables with status (empty, seated, needs_assistance) and current order id. Use as the data source to render a floor map. Pass a status to filter (e.g. needs_assistance).',
      inputSchema: {
        status: z
          .enum(['empty', 'seated', 'needs_assistance'])
          .optional()
          .describe('Filter to one table status.'),
      },
      outputSchema: { tables: z.array(tableOut) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => guard(() => ({ tables: service.listTables(ctx, input.status) })),
  );

  server.registerTool(
    'respond_to_call',
    {
      title: 'Floor · Respond to call',
      description:
        'Clear a table\'s assistance flag (needs_assistance → seated). Returns the updated table. Use after staff has attended to a table that called for help.',
      inputSchema: { tableId: z.string().describe('The table id that called for help.') },
      outputSchema: { table: tableOut },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    async (input) => guard(() => ({ table: service.respondToCall(ctx, input.tableId) })),
  );

  server.registerTool(
    'void_order',
    {
      title: 'Order · Void',
      description:
        'Void (cancel) an order with a required reason. This is irreversible — the order is frozen. Returns the voided order.',
      inputSchema: {
        orderId: z.string().describe('The order id to void.'),
        reason: z.string().min(1).describe('Why the order is being voided (required, for audit).'),
      },
      outputSchema: { order: orderOut },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async (input) => guard(() => ({ order: service.voidOrder(ctx, input.orderId, input.reason) })),
  );

  registerWhoami(server, ctx);
}
