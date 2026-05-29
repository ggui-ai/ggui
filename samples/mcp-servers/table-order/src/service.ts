/**
 * Business rules + authorization for the table-order sample.
 *
 * This is the REAL security boundary. The MCP route (`/customer/mcp` vs
 * `/owner/mcp`) decides which tools are *advertised*, but that is UX/
 * structure only — every method here re-asserts the caller's `AuthContext`
 * before reading or mutating. A customer session is rejected from owner
 * actions (and vice-versa) with a typed `PermissionDeniedError`, and
 * customer line edits are scoped to the caller's own table's draft.
 *
 * Methods return plain domain objects; the MCP handlers (`tools/*`) wrap
 * them into tool results and map `DomainError` → tool errors.
 */
import type { TableOrderStore } from './store.js';
import { priceLine } from './pricing.js';
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
  type AuthContext,
  type MenuCategory,
  type MenuItem,
  type Order,
  type OrderStatus,
  type RestaurantTable,
  type SalesPeriod,
  type SalesSummary,
  type SelectedOption,
  type TableStatus,
} from './types.js';

const KITCHEN_QUEUE_STATUSES: readonly OrderStatus[] = ['submitted', 'cooking', 'ready'];
const OWNER_SETTABLE_STATUSES: readonly OrderStatus[] = ['submitted', 'cooking', 'ready', 'served'];

export interface BrowseMenuInput {
  readonly query?: string;
  readonly category?: MenuCategory;
  readonly availableOnly?: boolean;
}
export interface AddToOrderInput {
  readonly itemId: string;
  readonly qty: number;
  readonly selectedOptions?: readonly SelectedOption[];
}
export interface UpdateOrderItemInput {
  readonly lineId: string;
  readonly qty?: number;
  readonly selectedOptions?: readonly SelectedOption[];
}
export interface GetOrderQueueInput {
  readonly status?: OrderStatus;
  /** Accepted for forward-compat; this sample has no per-station routing. */
  readonly station?: string;
}

export interface TableOrderService {
  // customer (table-bound)
  browseMenu(ctx: AuthContext, input: BrowseMenuInput): MenuItem[];
  getItemDetails(ctx: AuthContext, itemId: string): MenuItem;
  addToOrder(ctx: AuthContext, input: AddToOrderInput): Order;
  updateOrderItem(ctx: AuthContext, input: UpdateOrderItemInput): Order;
  removeOrderItem(ctx: AuthContext, lineId: string): Order;
  viewOrder(ctx: AuthContext): Order | null;
  submitOrder(ctx: AuthContext): Order;
  requestAssistance(ctx: AuthContext, reason?: string): RestaurantTable;
  // owner (restaurant-wide)
  getOrderQueue(ctx: AuthContext, input: GetOrderQueueInput): Order[];
  updateOrderStatus(ctx: AuthContext, orderId: string, status: OrderStatus): Order;
  setMenuAvailability(ctx: AuthContext, itemId: string, available: boolean): MenuItem;
  getSalesSummary(ctx: AuthContext, period: SalesPeriod): SalesSummary;
  listTables(ctx: AuthContext, status?: TableStatus): RestaurantTable[];
  respondToCall(ctx: AuthContext, tableId: string): RestaurantTable;
  voidOrder(ctx: AuthContext, orderId: string, reason: string): Order;
  // both
  whoami(ctx: AuthContext): AuthContext;
}

function requireCustomerTable(ctx: AuthContext): string {
  if (ctx.role !== 'customer' || !ctx.tableId) {
    throw new PermissionDeniedError('this action requires a customer (table) session');
  }
  return ctx.tableId;
}
function requireOwner(ctx: AuthContext): void {
  if (ctx.role !== 'owner') {
    throw new PermissionDeniedError('this action requires an owner session');
  }
}

export function createService(store: TableOrderStore): TableOrderService {
  function getOrderOrThrow(orderId: string): Order {
    const order = store.getOrder(orderId);
    if (!order) throw new NotFoundError(`order "${orderId}" not found`);
    return order;
  }
  function getItemOrThrow(itemId: string): MenuItem {
    const item = store.getMenuItem(itemId);
    if (!item) throw new NotFoundError(`menu item "${itemId}" not found`);
    return item;
  }

  /** Resolve the caller's editable draft order, asserting line ownership + draft state. */
  function editableOrderForLine(ctx: AuthContext, lineId: string): { order: Order; tableId: string } {
    const tableId = requireCustomerTable(ctx);
    const orderId = store.getLineOrderId(lineId);
    if (!orderId) throw new NotFoundError(`order line "${lineId}" not found`);
    const order = getOrderOrThrow(orderId);
    if (order.tableId !== tableId) {
      throw new PermissionDeniedError('that order line belongs to a different table');
    }
    if (order.status !== 'draft') {
      throw new ValidationError('only a draft order can be edited; submit creates a new one');
    }
    return { order, tableId };
  }

  return {
    browseMenu(ctx, input) {
      requireCustomerTable(ctx);
      return store.listMenu({
        query: input.query,
        category: input.category,
        // diners only ever see what they can actually order
        availableOnly: input.availableOnly ?? true,
      });
    },
    getItemDetails(ctx, itemId) {
      requireCustomerTable(ctx);
      return getItemOrThrow(itemId);
    },
    addToOrder(ctx, input) {
      const tableId = requireCustomerTable(ctx);
      const item = getItemOrThrow(input.itemId);
      if (!item.available) throw new ValidationError(`"${item.name}" is currently unavailable`);
      const selectedOptions = input.selectedOptions ?? [];
      const lineTotalCents = priceLine(item, selectedOptions, input.qty);
      const draft = store.getDraftForTable(tableId) ?? store.createDraft(tableId);
      store.setTableStatus(tableId, 'seated', draft.orderId);
      store.addLine(draft.orderId, {
        itemId: item.id,
        name: item.name,
        qty: input.qty,
        selectedOptions,
        lineTotalCents,
      });
      return getOrderOrThrow(draft.orderId);
    },
    updateOrderItem(ctx, input) {
      const { order } = editableOrderForLine(ctx, input.lineId);
      const line = order.lines.find((l) => l.lineId === input.lineId);
      if (!line) throw new NotFoundError(`order line "${input.lineId}" not found`);
      const item = getItemOrThrow(line.itemId);
      const qty = input.qty ?? line.qty;
      const selectedOptions = input.selectedOptions ?? line.selectedOptions;
      const lineTotalCents = priceLine(item, selectedOptions, qty);
      store.updateLine(input.lineId, { qty, selectedOptions, lineTotalCents });
      return getOrderOrThrow(order.orderId);
    },
    removeOrderItem(ctx, lineId) {
      const { order } = editableOrderForLine(ctx, lineId);
      store.removeLine(lineId);
      return getOrderOrThrow(order.orderId);
    },
    viewOrder(ctx) {
      const tableId = requireCustomerTable(ctx);
      return store.getActiveOrderForTable(tableId);
    },
    submitOrder(ctx) {
      const tableId = requireCustomerTable(ctx);
      const draft = store.getDraftForTable(tableId);
      if (!draft) throw new ValidationError('no draft order to submit');
      if (draft.lines.length === 0) throw new ValidationError('cannot submit an empty order');
      const placedAt = new Date().toISOString();
      const submitted = store.setOrderStatus(draft.orderId, 'submitted', placedAt);
      store.setTableStatus(tableId, 'seated', draft.orderId);
      if (!submitted) throw new NotFoundError(`order "${draft.orderId}" not found`);
      return submitted;
    },
    requestAssistance(ctx, _reason) {
      const tableId = requireCustomerTable(ctx);
      const table = store.setTableStatus(tableId, 'needs_assistance');
      if (!table) throw new NotFoundError(`table "${tableId}" not found`);
      return table;
    },

    getOrderQueue(ctx, input) {
      requireOwner(ctx);
      const statuses = input.status ? [input.status] : KITCHEN_QUEUE_STATUSES;
      return store.listOrders({ statuses });
    },
    updateOrderStatus(ctx, orderId, status) {
      requireOwner(ctx);
      const order = getOrderOrThrow(orderId);
      if (order.status === 'voided') {
        throw new ValidationError('a voided order cannot change status');
      }
      if (!OWNER_SETTABLE_STATUSES.includes(status)) {
        throw new ValidationError(
          `status must be one of ${OWNER_SETTABLE_STATUSES.join(', ')} (use void_order to cancel)`,
        );
      }
      const updated = store.setOrderStatus(orderId, status);
      if (!updated) throw new NotFoundError(`order "${orderId}" not found`);
      if (status === 'served') {
        const table = store.getTable(order.tableId);
        if (table && table.currentOrderId === orderId) {
          store.setTableStatus(order.tableId, table.status, null);
        }
      }
      return updated;
    },
    setMenuAvailability(ctx, itemId, available) {
      requireOwner(ctx);
      const item = store.setMenuAvailability(itemId, available);
      if (!item) throw new NotFoundError(`menu item "${itemId}" not found`);
      return item;
    },
    getSalesSummary(ctx, period) {
      requireOwner(ctx);
      return store.salesSummary(period, new Date());
    },
    listTables(ctx, status) {
      requireOwner(ctx);
      return store.listTables(status);
    },
    respondToCall(ctx, tableId) {
      requireOwner(ctx);
      const existing = store.getTable(tableId);
      if (!existing) throw new NotFoundError(`table "${tableId}" not found`);
      const table = store.setTableStatus(tableId, 'seated');
      if (!table) throw new NotFoundError(`table "${tableId}" not found`);
      return table;
    },
    voidOrder(ctx, orderId, reason) {
      requireOwner(ctx);
      if (!reason || reason.trim().length === 0) {
        throw new ValidationError('a void reason is required');
      }
      const order = getOrderOrThrow(orderId);
      const updated = store.setOrderStatus(orderId, 'voided');
      if (!updated) throw new NotFoundError(`order "${orderId}" not found`);
      const table = store.getTable(order.tableId);
      if (table && table.currentOrderId === orderId) {
        store.setTableStatus(order.tableId, table.status, null);
      }
      return updated;
    },

    whoami(ctx) {
      return ctx;
    },
  };
}
