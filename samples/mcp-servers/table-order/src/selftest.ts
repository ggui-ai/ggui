/**
 * Deterministic self-test for the data core (no MCP / agent / ggui).
 *
 * Run with `pnpm --filter @ggui-samples/mcp-table-order selftest`. This is a
 * developer smoke that asserts the deterministic parts — money math, the
 * draft→submit lifecycle, the cross-table ownership guard, and the
 * customer/owner authorization boundary. It is intentionally NOT wired into
 * any CI tier (the sample's CI exercise is the agent-loop journey e2e); it
 * exists so a contributor can prove the backend in isolation.
 */
import assert from 'node:assert/strict';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createService } from './service.js';
import { DEMO_TABLE_ID, RESTAURANT_ID, seedDatabase } from './seed.js';
import type { AuthContext, OrderLine } from './types.js';

function customer(tableId = DEMO_TABLE_ID): AuthContext {
  return { role: 'customer', restaurantId: RESTAURANT_ID, tableId, principalId: `diner:${tableId}` };
}
function owner(): AuthContext {
  return { role: 'owner', restaurantId: RESTAURANT_ID, principalId: 'owner:demo' };
}

let checks = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  checks += 1;
}
function expectThrows(label: string, errName: string, fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error && err.name === errName, `${label}: expected ${errName}, got ${String(err)}`);
    checks += 1;
    return;
  }
  assert.fail(`${label}: expected ${errName} to be thrown`);
}
function lineOf(lines: readonly OrderLine[], itemId: string): OrderLine {
  const line = lines.find((l) => l.itemId === itemId);
  assert.ok(line, `expected a line for ${itemId}`);
  return line;
}

function main(): void {
  const db = openDb(':memory:');
  // Fixed midday "now" so the time-windowed bits never straddle midnight.
  const now = new Date('2026-05-29T12:00:00.000Z');
  seedDatabase(db, now);
  const store = createStore(db);
  const svc = createService(store);

  // --- seed integrity ------------------------------------------------------
  check('menu seeded with 15 items', store.listMenu().length === 15);
  check('13 items available (2 are 86\'d)', store.listMenu({ availableOnly: true }).length === 13);
  check('9 tables seeded', store.listTables().length === 9);
  check('one table needs assistance', store.listTables('needs_assistance').length === 1);

  const sales0 = svc.getSalesSummary(owner(), 'all');
  check('sales counts 5 placed seed orders', sales0.orderCount === 5);
  check('sales revenue sums to 16560c', sales0.revenueCents === 16560);
  check('sales has top items', sales0.topItems.length > 0 && sales0.topItems[0]!.qty > 0);

  // --- customer ordering flow (tbl-7 starts with no order) -----------------
  const cust = customer();
  check('diner sees only available items', svc.browseMenu(cust, {}).every((m) => m.available));
  check('diner sees 13 available items', svc.browseMenu(cust, {}).length === 13);
  check('mains filter returns 6', svc.browseMenu(cust, { category: 'mains' }).length === 6);

  const afterPizza = svc.addToOrder(cust, {
    itemId: 'item-margherita',
    qty: 2,
    selectedOptions: [{ groupId: 'size', optionId: 'lg' }],
  });
  check('one line after first add', afterPizza.lines.length === 1);
  check('margherita lg x2 = 3200c', afterPizza.subtotalCents === 3200);

  const afterCola = svc.addToOrder(cust, { itemId: 'item-cola', qty: 1 });
  check('two lines after cola', afterCola.lines.length === 2);
  check('subtotal now 3500c', afterCola.subtotalCents === 3500);

  const viewed = svc.viewOrder(cust);
  assert.ok(viewed, 'active order should exist');
  check('viewed order is a draft', viewed.status === 'draft');

  const pizzaLine = lineOf(viewed.lines, 'item-margherita');
  const afterQty = svc.updateOrderItem(cust, { lineId: pizzaLine.lineId, qty: 1 });
  check('margherita down to x1 → subtotal 1900c', afterQty.subtotalCents === 1900);

  const colaLine = lineOf(afterQty.lines, 'item-cola');
  const afterRemove = svc.removeOrderItem(cust, colaLine.lineId);
  check('one line after removing cola', afterRemove.lines.length === 1);
  check('subtotal back to 1600c', afterRemove.subtotalCents === 1600);

  const submitted = svc.submitOrder(cust);
  check('order is submitted', submitted.status === 'submitted');
  check('submit stamped placedAt', submitted.placedAt !== null);

  // editing a submitted order is rejected; a fresh add opens a NEW draft
  expectThrows('edit submitted order', 'ValidationError', () =>
    svc.updateOrderItem(cust, { lineId: submitted.lines[0]!.lineId, qty: 5 }),
  );
  const secondRound = svc.addToOrder(cust, { itemId: 'item-tiramisu', qty: 1 });
  check('second round opens a new draft', secondRound.orderId !== submitted.orderId);
  check('new draft is draft', secondRound.status === 'draft');

  // --- authorization boundary ---------------------------------------------
  expectThrows('owner cannot use a customer tool', 'PermissionDeniedError', () =>
    svc.addToOrder(owner(), { itemId: 'item-cola', qty: 1 }),
  );
  expectThrows('customer cannot void an order', 'PermissionDeniedError', () =>
    svc.voidOrder(cust, 'ord-seed-1', 'nope'),
  );
  const otherTableLine = store.getOrder('ord-seed-1')!.lines[0]!;
  expectThrows('customer cannot edit another table\'s line', 'PermissionDeniedError', () =>
    svc.updateOrderItem(cust, { lineId: otherTableLine.lineId, qty: 9 }),
  );

  // --- owner operations ----------------------------------------------------
  const own = owner();
  const queue = svc.getOrderQueue(own, {});
  check('kitchen queue includes the cooking seed order', queue.some((o) => o.orderId === 'ord-seed-1'));
  check('kitchen queue excludes served orders', queue.every((o) => o.status !== 'served'));

  const advanced = svc.updateOrderStatus(own, 'ord-seed-2', 'cooking');
  check('owner advanced order to cooking', advanced.status === 'cooking');
  expectThrows('owner cannot set draft via update', 'ValidationError', () =>
    svc.updateOrderStatus(own, 'ord-seed-2', 'draft'),
  );

  const reopened = svc.setMenuAvailability(own, 'item-iced-tea', true);
  check('owner re-enabled iced tea', reopened.available === true);
  check('14 items available after re-enable', store.listMenu({ availableOnly: true }).length === 14);

  check('floor map flags table 4', svc.listTables(own, 'needs_assistance').some((t) => t.tableId === 'tbl-4'));
  const cleared = svc.respondToCall(own, 'tbl-4');
  check('responding clears assistance', cleared.status === 'seated');
  check('no tables need help now', svc.listTables(own, 'needs_assistance').length === 0);

  expectThrows('void requires a reason', 'ValidationError', () =>
    svc.voidOrder(own, 'ord-seed-3', '  '),
  );
  const voided = svc.voidOrder(own, 'ord-seed-3', 'guest left');
  check('owner voided the order', voided.status === 'voided');
  expectThrows('cannot change a voided order', 'ValidationError', () =>
    svc.updateOrderStatus(own, 'ord-seed-3', 'served'),
  );

  // whoami
  check('whoami echoes the table', svc.whoami(cust).tableId === DEMO_TABLE_ID);

  db.close();
  // eslint-disable-next-line no-console
  console.log(`\n[table-order selftest] ${checks} checks passed ✓`);
}

main();
