/**
 * Data-access layer over SQLite for the table-order sample.
 *
 * Pure persistence: row↔domain mapping + CRUD + computed totals. It does
 * NOT enforce authorization — that is `service.ts`'s job. Rows are read
 * back through zod parsers (not casts) so the untyped `better-sqlite3`
 * boundary returns fully-typed domain objects.
 *
 * Money is integer cents throughout. Booleans are stored as 0/1; the
 * parsers normalize them back to `boolean`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SqliteDatabase } from './db.js';
import type {
  MenuCategory,
  MenuItem,
  ModifierGroup,
  Order,
  OrderLine,
  OrderStatus,
  RestaurantTable,
  SalesPeriod,
  SalesSummary,
  SelectedOption,
  TableStatus,
} from './types.js';

const MENU_CATEGORIES = ['starters', 'mains', 'drinks', 'desserts'] as const;
const MENU_TAGS = ['spicy', 'vegetarian', 'vegan', 'gluten_free', 'popular'] as const;
const ORDER_STATUSES = [
  'draft',
  'submitted',
  'cooking',
  'ready',
  'served',
  'voided',
] as const;
const TABLE_STATUSES = ['empty', 'seated', 'needs_assistance'] as const;

// --- zod parsers for the JSON columns + rows (the trust boundary) ----------

const modifierOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  priceDeltaCents: z.number().int(),
});
const modifierGroupSchema = z.object({
  id: z.string(),
  label: z.string(),
  required: z.boolean(),
  multi: z.boolean(),
  options: z.array(modifierOptionSchema),
});
const selectedOptionSchema = z.object({ groupId: z.string(), optionId: z.string() });
const tagsArraySchema = z.array(z.enum(MENU_TAGS));
const groupsArraySchema = z.array(modifierGroupSchema);
const selectedArraySchema = z.array(selectedOptionSchema);

const menuRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  price_cents: z.number().int(),
  category: z.enum(MENU_CATEGORIES),
  tags_json: z.string(),
  options_json: z.string(),
  available: z.number().int(),
  photo_path: z.string(),
});
const tableRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(TABLE_STATUSES),
  current_order_id: z.string().nullable(),
});
const orderRowSchema = z.object({
  id: z.string(),
  table_id: z.string(),
  status: z.enum(ORDER_STATUSES),
  placed_at: z.string().nullable(),
  updated_at: z.string(),
});
const lineRowSchema = z.object({
  id: z.string(),
  order_id: z.string(),
  item_id: z.string(),
  name: z.string(),
  qty: z.number().int(),
  selected_options_json: z.string(),
  line_total_cents: z.number().int(),
});
const orderIdRowSchema = z.object({ order_id: z.string() });
const nextSeqRowSchema = z.object({ next: z.number().int() });
const totalsRowSchema = z.object({ orders: z.number().int(), revenue: z.number().int() });
const topRowSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  qty: z.number().int(),
  revenue: z.number().int(),
});

function toMenuItem(raw: unknown): MenuItem {
  const r = menuRowSchema.parse(raw);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    priceCents: r.price_cents,
    category: r.category,
    tags: tagsArraySchema.parse(JSON.parse(r.tags_json)),
    options: groupsArraySchema.parse(JSON.parse(r.options_json)),
    available: r.available === 1,
    photoPath: r.photo_path,
  };
}
function toTable(raw: unknown): RestaurantTable {
  const r = tableRowSchema.parse(raw);
  return {
    tableId: r.id,
    label: r.label,
    status: r.status,
    currentOrderId: r.current_order_id,
  };
}
function toLine(raw: unknown): OrderLine {
  const r = lineRowSchema.parse(raw);
  return {
    lineId: r.id,
    itemId: r.item_id,
    name: r.name,
    qty: r.qty,
    selectedOptions: selectedArraySchema.parse(JSON.parse(r.selected_options_json)),
    lineTotalCents: r.line_total_cents,
  };
}

// --- seed-insert payloads (used by seed.ts) --------------------------------

export interface MenuItemSeed {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly priceCents: number;
  readonly category: MenuCategory;
  readonly tags: readonly string[];
  readonly options: readonly ModifierGroup[];
  readonly available: boolean;
  readonly photoPath: string;
}
export interface TableSeed {
  readonly id: string;
  readonly label: string;
  readonly status: TableStatus;
}
export interface OrderSeed {
  readonly id: string;
  readonly tableId: string;
  readonly status: OrderStatus;
  readonly placedAt: string | null;
  readonly updatedAt: string;
  readonly lines: readonly {
    readonly itemId: string;
    readonly name: string;
    readonly qty: number;
    readonly selectedOptions: readonly SelectedOption[];
    readonly lineTotalCents: number;
  }[];
}

// --- store -----------------------------------------------------------------

export interface AddLineInput {
  readonly itemId: string;
  readonly name: string;
  readonly qty: number;
  readonly selectedOptions: readonly SelectedOption[];
  readonly lineTotalCents: number;
}
export interface UpdateLinePatch {
  readonly qty?: number;
  readonly selectedOptions?: readonly SelectedOption[];
  readonly lineTotalCents?: number;
}

export interface TableOrderStore {
  // menu
  listMenu(filter?: { category?: MenuCategory; query?: string; availableOnly?: boolean }): MenuItem[];
  getMenuItem(id: string): MenuItem | null;
  setMenuAvailability(id: string, available: boolean): MenuItem | null;
  // tables
  listTables(status?: TableStatus): RestaurantTable[];
  getTable(tableId: string): RestaurantTable | null;
  setTableStatus(
    tableId: string,
    status: TableStatus,
    currentOrderId?: string | null,
  ): RestaurantTable | null;
  // orders
  getOrder(orderId: string): Order | null;
  getDraftForTable(tableId: string): Order | null;
  getActiveOrderForTable(tableId: string): Order | null;
  createDraft(tableId: string): Order;
  listOrders(filter?: { statuses?: readonly OrderStatus[] }): Order[];
  setOrderStatus(orderId: string, status: OrderStatus, placedAt?: string | null): Order | null;
  // lines
  getLineOrderId(lineId: string): string | null;
  addLine(orderId: string, input: AddLineInput): OrderLine;
  updateLine(lineId: string, patch: UpdateLinePatch): boolean;
  removeLine(lineId: string): boolean;
  // analytics
  salesSummary(period: SalesPeriod, now: Date): SalesSummary;
  // seed
  insertMenuItem(item: MenuItemSeed, sortOrder: number): void;
  insertTable(table: TableSeed, sortOrder: number): void;
  insertSeedOrder(order: OrderSeed): void;
}

export function createStore(db: SqliteDatabase): TableOrderStore {
  const nowIso = (): string => new Date().toISOString();

  function touchOrder(orderId: string): void {
    db.prepare('UPDATE orders SET updated_at = @ts WHERE id = @id').run({ id: orderId, ts: nowIso() });
  }
  function loadLines(orderId: string): OrderLine[] {
    return db
      .prepare('SELECT * FROM order_line WHERE order_id = @orderId ORDER BY seq ASC')
      .all({ orderId })
      .map(toLine);
  }
  function assembleOrder(raw: unknown): Order {
    const r = orderRowSchema.parse(raw);
    const lines = loadLines(r.id);
    return {
      orderId: r.id,
      tableId: r.table_id,
      status: r.status,
      lines,
      subtotalCents: lines.reduce((sum, l) => sum + l.lineTotalCents, 0),
      placedAt: r.placed_at,
      updatedAt: r.updated_at,
    };
  }

  function getMenuItem(id: string): MenuItem | null {
    const row = db.prepare('SELECT * FROM menu_item WHERE id = @id').get({ id });
    return row ? toMenuItem(row) : null;
  }
  function getTable(tableId: string): RestaurantTable | null {
    const row = db.prepare('SELECT * FROM restaurant_table WHERE id = @id').get({ id: tableId });
    return row ? toTable(row) : null;
  }
  function getOrder(orderId: string): Order | null {
    const row = db.prepare('SELECT * FROM orders WHERE id = @id').get({ id: orderId });
    return row ? assembleOrder(row) : null;
  }
  function getLineOrderId(lineId: string): string | null {
    const row = db.prepare('SELECT order_id FROM order_line WHERE id = @id').get({ id: lineId });
    return row ? orderIdRowSchema.parse(row).order_id : null;
  }

  return {
    listMenu(filter) {
      const where: string[] = [];
      const params: Record<string, string | number> = {};
      if (filter?.category) {
        where.push('category = @category');
        params.category = filter.category;
      }
      if (filter?.availableOnly) where.push('available = 1');
      if (filter?.query) {
        where.push('(LOWER(name) LIKE @q OR LOWER(description) LIKE @q)');
        params.q = `%${filter.query.toLowerCase()}%`;
      }
      const sql =
        'SELECT * FROM menu_item' +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ' ORDER BY sort_order ASC';
      return db.prepare(sql).all(params).map(toMenuItem);
    },
    getMenuItem,
    setMenuAvailability(id, available) {
      const info = db
        .prepare('UPDATE menu_item SET available = @available WHERE id = @id')
        .run({ id, available: available ? 1 : 0 });
      return info.changes === 0 ? null : getMenuItem(id);
    },

    listTables(status) {
      const sql = status
        ? 'SELECT * FROM restaurant_table WHERE status = @status ORDER BY sort_order ASC'
        : 'SELECT * FROM restaurant_table ORDER BY sort_order ASC';
      return db.prepare(sql).all(status ? { status } : {}).map(toTable);
    },
    getTable,
    setTableStatus(tableId, status, currentOrderId) {
      const sets = ['status = @status'];
      const params: Record<string, string | null> = { id: tableId, status };
      if (currentOrderId !== undefined) {
        sets.push('current_order_id = @cur');
        params.cur = currentOrderId;
      }
      const info = db
        .prepare(`UPDATE restaurant_table SET ${sets.join(', ')} WHERE id = @id`)
        .run(params);
      return info.changes === 0 ? null : getTable(tableId);
    },

    getOrder,
    getDraftForTable(tableId) {
      const row = db
        .prepare(
          "SELECT * FROM orders WHERE table_id = @t AND status = 'draft' ORDER BY updated_at DESC LIMIT 1",
        )
        .get({ t: tableId });
      return row ? assembleOrder(row) : null;
    },
    getActiveOrderForTable(tableId) {
      const row = db
        .prepare(
          "SELECT * FROM orders WHERE table_id = @t AND status IN ('draft','submitted','cooking','ready') ORDER BY updated_at DESC LIMIT 1",
        )
        .get({ t: tableId });
      return row ? assembleOrder(row) : null;
    },
    createDraft(tableId) {
      const id = `ord_${randomUUID()}`;
      db.prepare(
        "INSERT INTO orders (id, table_id, status, placed_at, updated_at) VALUES (@id, @t, 'draft', NULL, @ts)",
      ).run({ id, t: tableId, ts: nowIso() });
      const order = getOrder(id);
      if (!order) throw new Error('createDraft: inserted order not found');
      return order;
    },
    listOrders(filter) {
      let sql = 'SELECT * FROM orders';
      const params: Record<string, string> = {};
      if (filter?.statuses && filter.statuses.length > 0) {
        const names = filter.statuses.map((s, i) => {
          params[`s${i}`] = s;
          return `@s${i}`;
        });
        sql += ` WHERE status IN (${names.join(', ')})`;
      }
      sql += ' ORDER BY COALESCE(placed_at, updated_at) ASC';
      return db.prepare(sql).all(params).map(assembleOrder);
    },
    setOrderStatus(orderId, status, placedAt) {
      const sets = ['status = @status', 'updated_at = @ts'];
      const params: Record<string, string | null> = { id: orderId, status, ts: nowIso() };
      if (placedAt !== undefined) {
        sets.push('placed_at = @placed');
        params.placed = placedAt;
      }
      const info = db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = @id`).run(params);
      return info.changes === 0 ? null : getOrder(orderId);
    },

    getLineOrderId,
    addLine(orderId, input) {
      const id = `line_${randomUUID()}`;
      const seqRow = db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM order_line WHERE order_id = @o')
        .get({ o: orderId });
      const seq = nextSeqRowSchema.parse(seqRow).next;
      db.prepare(
        `INSERT INTO order_line (id, order_id, item_id, name, qty, selected_options_json, line_total_cents, seq)
         VALUES (@id, @o, @item, @name, @qty, @opts, @total, @seq)`,
      ).run({
        id,
        o: orderId,
        item: input.itemId,
        name: input.name,
        qty: input.qty,
        opts: JSON.stringify(input.selectedOptions),
        total: input.lineTotalCents,
        seq,
      });
      touchOrder(orderId);
      const line = db.prepare('SELECT * FROM order_line WHERE id = @id').get({ id });
      return toLine(line);
    },
    updateLine(lineId, patch) {
      const sets: string[] = [];
      const params: Record<string, string | number> = { id: lineId };
      if (patch.qty !== undefined) {
        sets.push('qty = @qty');
        params.qty = patch.qty;
      }
      if (patch.selectedOptions !== undefined) {
        sets.push('selected_options_json = @opts');
        params.opts = JSON.stringify(patch.selectedOptions);
      }
      if (patch.lineTotalCents !== undefined) {
        sets.push('line_total_cents = @total');
        params.total = patch.lineTotalCents;
      }
      if (sets.length === 0) return true;
      const orderId = getLineOrderId(lineId);
      const info = db.prepare(`UPDATE order_line SET ${sets.join(', ')} WHERE id = @id`).run(params);
      if (info.changes === 0) return false;
      if (orderId) touchOrder(orderId);
      return true;
    },
    removeLine(lineId) {
      const orderId = getLineOrderId(lineId);
      const info = db.prepare('DELETE FROM order_line WHERE id = @id').run({ id: lineId });
      if (info.changes === 0) return false;
      if (orderId) touchOrder(orderId);
      return true;
    },

    salesSummary(period, now) {
      const params: Record<string, string> = {};
      let timeWhere = '';
      if (period !== 'all') {
        const since = new Date(now);
        if (period === 'today') since.setHours(0, 0, 0, 0);
        else since.setDate(since.getDate() - 7);
        params.since = since.toISOString();
        timeWhere = ' AND o.placed_at >= @since';
      }
      const baseWhere = `o.status NOT IN ('draft','voided') AND o.placed_at IS NOT NULL${timeWhere}`;

      const totalsRow = db
        .prepare(
          `SELECT COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(ol.line_total_cents), 0) AS revenue
           FROM orders o JOIN order_line ol ON ol.order_id = o.id
           WHERE ${baseWhere}`,
        )
        .get(params);
      const totals = totalsRowSchema.parse(totalsRow);

      const topRows = db
        .prepare(
          `SELECT ol.item_id AS itemId, ol.name AS name, SUM(ol.qty) AS qty, SUM(ol.line_total_cents) AS revenue
           FROM orders o JOIN order_line ol ON ol.order_id = o.id
           WHERE ${baseWhere}
           GROUP BY ol.item_id, ol.name
           ORDER BY qty DESC, revenue DESC
           LIMIT 5`,
        )
        .all(params);
      const topItems = z
        .array(topRowSchema)
        .parse(topRows)
        .map((r) => ({ itemId: r.itemId, name: r.name, qty: r.qty, revenueCents: r.revenue }));

      return { period, orderCount: totals.orders, revenueCents: totals.revenue, topItems };
    },

    insertMenuItem(item, sortOrder) {
      db.prepare(
        `INSERT INTO menu_item (id, name, description, price_cents, category, tags_json, options_json, available, photo_path, sort_order)
         VALUES (@id, @name, @desc, @price, @cat, @tags, @opts, @avail, @photo, @sort)`,
      ).run({
        id: item.id,
        name: item.name,
        desc: item.description,
        price: item.priceCents,
        cat: item.category,
        tags: JSON.stringify(item.tags),
        opts: JSON.stringify(item.options),
        avail: item.available ? 1 : 0,
        photo: item.photoPath,
        sort: sortOrder,
      });
    },
    insertTable(table, sortOrder) {
      db.prepare(
        `INSERT INTO restaurant_table (id, label, status, current_order_id, sort_order)
         VALUES (@id, @label, @status, NULL, @sort)`,
      ).run({ id: table.id, label: table.label, status: table.status, sort: sortOrder });
    },
    insertSeedOrder(order) {
      db.prepare(
        'INSERT INTO orders (id, table_id, status, placed_at, updated_at) VALUES (@id, @t, @status, @placed, @updated)',
      ).run({
        id: order.id,
        t: order.tableId,
        status: order.status,
        placed: order.placedAt,
        updated: order.updatedAt,
      });
      order.lines.forEach((line, i) => {
        db.prepare(
          `INSERT INTO order_line (id, order_id, item_id, name, qty, selected_options_json, line_total_cents, seq)
           VALUES (@id, @o, @item, @name, @qty, @opts, @total, @seq)`,
        ).run({
          id: `line_${randomUUID()}`,
          o: order.id,
          item: line.itemId,
          name: line.name,
          qty: line.qty,
          opts: JSON.stringify(line.selectedOptions),
          total: line.lineTotalCents,
          seq: i + 1,
        });
      });
      if (order.status !== 'served' && order.status !== 'voided') {
        db.prepare('UPDATE restaurant_table SET current_order_id = @o WHERE id = @t').run({
          o: order.id,
          t: order.tableId,
        });
      }
    },
  };
}
