/**
 * MCP-level test for the table-order server (no agent / ggui).
 *
 * Run with `pnpm --filter @ggui-samples/mcp-table-order mcp-test`. Connects
 * a real MCP SDK `Client` to each route over an in-memory transport to
 * verify: per-persona `tools/list` scoping, tool calls + structured output,
 * `DomainError` → `isError` mapping. Then a thin HTTP smoke covers the
 * `/assets` photo route, `/admin` helpers, and that the MCP routes are
 * reachable. Like `selftest`, this is a dev smoke, not a CI tier.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createService } from './service.js';
import { DEMO_TABLE_ID, RESTAURANT_ID, seedDatabase } from './seed.js';
import { buildMcpServerForRoute, startServer } from './index.js';
import { resolveAuth } from './auth.js';
import type { AuthContext } from './types.js';

let checks = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  checks += 1;
}

async function connectClient(server: McpServer): Promise<Client> {
  const client = new Client({ name: 'table-order-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

/**
 * Call a tool. `callTool`'s static return type is a union (modern result +
 * legacy `{toolResult}`), so we treat it as `unknown` at this boundary and
 * validate the shape with zod below — no casts.
 */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return client.callTool({ name, arguments: args }, CallToolResultSchema);
}

const toolResultSchema = z.object({
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  isError: z.boolean().optional(),
});

/** Read a tool result's payload from structuredContent, falling back to the text block. */
function payload<T>(result: unknown, schema: z.ZodType<T>): T {
  const r = toolResultSchema.parse(result);
  if (r.structuredContent !== undefined) return schema.parse(r.structuredContent);
  const text = r.content?.find((c) => c.type === 'text' && c.text !== undefined)?.text;
  return schema.parse(text !== undefined ? JSON.parse(text) : undefined);
}

function isErrorResult(result: unknown): boolean {
  return toolResultSchema.parse(result).isError === true;
}

/** Extract the typed DomainError code from an isError tool result, if present. */
function errorCode(result: unknown): string | undefined {
  const r = toolResultSchema.parse(result);
  if (r.isError !== true) return undefined;
  const text = r.content?.find((c) => c.type === 'text' && c.text !== undefined)?.text;
  if (text === undefined) return undefined;
  const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(JSON.parse(text));
  return parsed.success ? parsed.data.error.code : undefined;
}

const FIXED_NOW = new Date('2026-05-29T12:00:00.000Z');

async function main(): Promise<void> {
  // --- resolveAuth ---------------------------------------------------------
  check('customer route defaults to demo table', resolveAuth({ headers: {} }, 'customer').tableId === DEMO_TABLE_ID);
  check('owner route resolves owner', resolveAuth({ headers: {} }, 'owner').role === 'owner');
  check(
    'x-ggui-table header binds the table',
    resolveAuth({ headers: { 'x-ggui-table': 'tbl-2' } }, 'customer').tableId === 'tbl-2',
  );
  check(
    'bearer token resolves a table',
    resolveAuth({ headers: { authorization: 'Bearer demo-customer-table-7' } }, 'customer').tableId === 'tbl-7',
  );
  check(
    'owner token on customer route falls back to customer',
    resolveAuth({ headers: { authorization: 'Bearer demo-owner' } }, 'customer').role === 'customer',
  );

  // --- in-memory MCP -------------------------------------------------------
  const db = openDb(':memory:');
  seedDatabase(db, FIXED_NOW);
  const service = createService(createStore(db));
  const baseUrl = 'http://localhost:6783';
  const custCtx: AuthContext = { role: 'customer', restaurantId: RESTAURANT_ID, tableId: 'tbl-7', principalId: 'diner:tbl-7' };
  const ownerCtx: AuthContext = { role: 'owner', restaurantId: RESTAURANT_ID, principalId: 'owner:demo' };

  const customer = await connectClient(buildMcpServerForRoute('customer', custCtx, service, baseUrl));
  const owner = await connectClient(buildMcpServerForRoute('owner', ownerCtx, service, baseUrl));

  const custTools = (await customer.listTools()).tools.map((t) => t.name);
  const ownerTools = (await owner.listTools()).tools.map((t) => t.name);
  check('customer exposes 8 tools + whoami', custTools.length === 9);
  check('customer exposes browse_menu + submit_order', custTools.includes('browse_menu') && custTools.includes('submit_order'));
  check('customer does NOT expose owner tools', !custTools.includes('void_order') && !custTools.includes('get_order_queue'));
  check('owner exposes 7 tools + whoami', ownerTools.length === 8);
  check('owner exposes get_order_queue + void_order', ownerTools.includes('get_order_queue') && ownerTools.includes('void_order'));
  check('owner does NOT expose customer tools', !ownerTools.includes('add_to_order') && !ownerTools.includes('browse_menu'));

  const menu = payload(
    await call(customer, 'browse_menu'),
    z.object({ items: z.array(z.object({ available: z.boolean(), photoUrl: z.string() })) }),
  );
  check('browse_menu returns 13 available items', menu.items.length === 13);
  check('items are available + photoUrl absolutized', menu.items.every((i) => i.available && i.photoUrl.startsWith('http')));

  const added = payload(
    await call(customer, 'add_to_order', { itemId: 'item-margherita', qty: 2, options: [{ groupId: 'size', optionId: 'lg' }] }),
    z.object({ order: z.object({ subtotalCents: z.number(), lines: z.array(z.unknown()) }) }),
  );
  check('add_to_order subtotal is 3200c', added.order.subtotalCents === 3200);

  const submitted = payload(
    await call(customer, 'submit_order'),
    z.object({ order: z.object({ status: z.string(), placedAt: z.string().nullable() }) }),
  );
  check('submit_order → submitted + placedAt', submitted.order.status === 'submitted' && submitted.order.placedAt !== null);

  const bad = await call(customer, 'add_to_order', { itemId: 'nope', qty: 1 });
  check('unknown item → isError tool result', isErrorResult(bad));

  const queue = payload(
    await call(owner, 'get_order_queue'),
    z.object({ orders: z.array(z.object({ orderId: z.string(), status: z.string() })) }),
  );
  check('owner queue lists active seed order', queue.orders.some((o) => o.orderId === 'ord-seed-1'));
  check('owner queue excludes served orders', queue.orders.every((o) => o.status !== 'served'));

  const who = payload(
    await call(customer, 'whoami'),
    z.object({ identity: z.object({ role: z.string(), tableId: z.string().optional() }) }),
  );
  check('whoami reports customer + table', who.identity.role === 'customer' && who.identity.tableId === 'tbl-7');

  // --- exercise EVERY remaining tool through the MCP client (also validates each outputSchema) ---
  const details = payload(
    await call(customer, 'get_item_details', { itemId: 'item-curry' }),
    z.object({ item: z.object({ id: z.string(), options: z.array(z.unknown()), photoUrl: z.string() }) }),
  );
  check('get_item_details returns the item + modifier groups', details.item.id === 'item-curry' && details.item.options.length > 0);

  const view = payload(
    await call(customer, 'view_order'),
    z.object({ order: z.object({ status: z.string() }).nullable() }),
  );
  check('view_order returns the submitted order', view.order?.status === 'submitted');

  const round2 = payload(
    await call(customer, 'add_to_order', { itemId: 'item-cola', qty: 1 }),
    z.object({ order: z.object({ lines: z.array(z.object({ lineId: z.string() })) }) }),
  );
  const colaLineId = round2.order.lines[round2.order.lines.length - 1]!.lineId;
  const reqty = payload(
    await call(customer, 'update_order_item', { lineId: colaLineId, qty: 3 }),
    z.object({ order: z.object({ subtotalCents: z.number() }) }),
  );
  check('update_order_item reprices (cola x3 = 900c)', reqty.order.subtotalCents === 900);
  const removed = payload(
    await call(customer, 'remove_order_item', { lineId: colaLineId }),
    z.object({ order: z.object({ lines: z.array(z.unknown()) }) }),
  );
  check('remove_order_item empties the new draft', removed.order.lines.length === 0);

  const helped = payload(
    await call(customer, 'request_assistance', { reason: 'more water' }),
    z.object({ table: z.object({ status: z.string() }) }),
  );
  check('request_assistance flags the table', helped.table.status === 'needs_assistance');

  const avail = payload(
    await call(owner, 'set_menu_availability', { itemId: 'item-iced-tea', available: true }),
    z.object({ item: z.object({ available: z.boolean(), photoUrl: z.string() }) }),
  );
  check('set_menu_availability re-enables + carries photoUrl', avail.item.available && avail.item.photoUrl.startsWith('http'));

  const sales = payload(
    await call(owner, 'get_sales_summary', { period: 'all' }),
    z.object({ summary: z.object({ revenueCents: z.number(), topItems: z.array(z.unknown()) }) }),
  );
  check('get_sales_summary returns revenue + top items', sales.summary.revenueCents > 0 && sales.summary.topItems.length > 0);

  const tables = payload(
    await call(owner, 'list_tables', {}),
    z.object({ tables: z.array(z.object({ tableId: z.string() })) }),
  );
  check('list_tables returns the 9-table floor', tables.tables.length === 9);

  const advanced = payload(
    await call(owner, 'update_order_status', { orderId: 'ord-seed-2', status: 'cooking' }),
    z.object({ order: z.object({ status: z.string() }) }),
  );
  check('update_order_status advances the order', advanced.order.status === 'cooking');

  const responded = payload(
    await call(owner, 'respond_to_call', { tableId: 'tbl-4' }),
    z.object({ table: z.object({ status: z.string() }) }),
  );
  check('respond_to_call clears the assistance flag', responded.table.status === 'seated');

  const voided = payload(
    await call(owner, 'void_order', { orderId: 'ord-seed-3', reason: 'guest left' }),
    z.object({ order: z.object({ status: z.string() }) }),
  );
  check('void_order voids the order', voided.order.status === 'voided');

  // --- call-time authz THROUGH the MCP boundary: owner ctx on a customer-route tool → isError ---
  const crossClient = await connectClient(buildMcpServerForRoute('customer', ownerCtx, service, baseUrl));
  const denied = await call(crossClient, 'add_to_order', { itemId: 'item-cola', qty: 1 });
  check('owner ctx on a customer tool → isError', isErrorResult(denied));
  check('and the error code is PERMISSION_DENIED', errorCode(denied) === 'PERMISSION_DENIED');
  await crossClient.close();

  await customer.close();
  await owner.close();
  db.close();

  // --- HTTP smoke ----------------------------------------------------------
  const http = await startServer({ port: 0, seedNow: FIXED_NOW });
  const base = `http://localhost:${http.port}`;
  try {
    const svg = await fetch(`${base}/assets/margherita.svg`);
    const svgBody = await svg.text();
    check('asset route serves an SVG', svg.status === 200 && (svg.headers.get('content-type') ?? '').includes('image/svg+xml'));
    check('placeholder SVG has content', svgBody.includes('<svg'));

    const state = z
      .object({ menu: z.array(z.unknown()), tables: z.array(z.unknown()), orders: z.array(z.unknown()) })
      .parse(await (await fetch(`${base}/admin/state`)).json());
    check('admin/state returns the 15-item menu', state.menu.length === 15);

    const reset = await fetch(`${base}/admin/reset`, { method: 'POST' });
    check('admin/reset responds 200', reset.status === 200);

    const seed = await fetch(`${base}/admin/seed`, { method: 'POST' });
    check('admin/seed responds 200', seed.status === 200);

    const init = await fetch(`${base}/customer/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
      }),
    });
    check('customer mcp route reachable (initialize 200)', init.status === 200);
    await init.body?.cancel().catch(() => undefined);
  } finally {
    await http.close();
  }

  // eslint-disable-next-line no-console
  console.log(`\n[table-order mcp-test] ${checks} checks passed ✓`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[table-order mcp-test] FAILED:', err);
  process.exit(1);
});
