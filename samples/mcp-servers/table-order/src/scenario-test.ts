/* eslint-disable no-console */
/**
 * Agent-free scenario e2e for the table-order server.
 *
 * Run with `pnpm --filter @ggui-samples/mcp-table-order scenario`. Boots the
 * REAL HTTP server and drives BOTH endpoints with MCP SDK clients over
 * Streamable HTTP — no LLM/agent/ggui — to prove the stage-demo narrative
 * works end to end and that the two personas share ONE database:
 *
 *   Act 1  diner @ /customer/mcp  : browse → add → submit
 *   Bridge the SAME order appears on the owner's kitchen board
 *   Act 2  owner @ /owner/mcp     : cooking → ready → served, sales update
 *   Plus   assistance call raised by the diner, cleared by the owner
 *
 * Deterministic; like selftest/mcp-test it is a dev smoke, not a CI tier.
 */
import assert from 'node:assert/strict';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { startServer } from './index.js';

let checks = 0;
function check(label: string, cond: boolean): void {
  assert.ok(cond, label);
  checks += 1;
  console.log(`    ✓ ${label}`);
}

const toolResultSchema = z.object({
  structuredContent: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  isError: z.boolean().optional(),
});

function payload<T>(result: unknown, schema: z.ZodType<T>): T {
  const r = toolResultSchema.parse(result);
  if (r.structuredContent !== undefined) return schema.parse(r.structuredContent);
  const text = r.content?.find((c) => c.type === 'text' && c.text !== undefined)?.text;
  return schema.parse(text !== undefined ? JSON.parse(text) : undefined);
}

async function connect(url: string, headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'scenario', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return client.callTool({ name, arguments: args }, CallToolResultSchema);
}

const orderShape = z.object({ orderId: z.string(), tableId: z.string(), status: z.string(), subtotalCents: z.number() });

async function main(): Promise<void> {
  const http = await startServer({ port: 0, seedNow: new Date('2026-05-29T12:00:00.000Z') });
  const base = `http://localhost:${http.port}`;
  const diner = await connect(`${base}/customer/mcp`, { 'x-ggui-table': 'tbl-7' });
  const owner = await connect(`${base}/owner/mcp`, {});

  try {
    console.log('\n  Act 1 — diner at table 7 orders:');
    const menu = payload(
      await call(diner, 'browse_menu', { category: 'mains' }),
      z.object({ items: z.array(z.object({ id: z.string(), available: z.boolean() })) }),
    );
    check('diner browses available mains', menu.items.length === 6 && menu.items.every((i) => i.available));

    await call(diner, 'add_to_order', { itemId: 'item-margherita', qty: 2, options: [{ groupId: 'size', optionId: 'lg' }] });
    await call(diner, 'add_to_order', { itemId: 'item-cola', qty: 2 });
    const draft = payload(await call(diner, 'view_order'), z.object({ order: orderShape }));
    check('cart totals correctly (margherita lg×2 + cola×2 = 3800c)', draft.order.subtotalCents === 3800);

    const submitted = payload(await call(diner, 'submit_order'), z.object({ order: orderShape }));
    const orderId = submitted.order.orderId;
    check('diner submits the order', submitted.order.status === 'submitted');

    console.log('\n  Bridge — same database, two faces:');
    const queue = payload(
      await call(owner, 'get_order_queue', {}),
      z.object({ orders: z.array(orderShape) }),
    );
    const onBoard = queue.orders.find((o) => o.orderId === orderId);
    check("the diner's exact order appears on the owner's kitchen board", onBoard !== undefined);
    check('...for the right table, freshly submitted', onBoard?.tableId === 'tbl-7' && onBoard?.status === 'submitted');

    console.log('\n  Act 2 — owner runs the pass:');
    await call(owner, 'update_order_status', { orderId, status: 'cooking' });
    await call(owner, 'update_order_status', { orderId, status: 'ready' });
    const served = payload(
      await call(owner, 'update_order_status', { orderId, status: 'served' }),
      z.object({ order: orderShape }),
    );
    check('owner drives the order to served', served.order.status === 'served');

    const sales = payload(
      await call(owner, 'get_sales_summary', { period: 'all' }),
      z.object({ summary: z.object({ revenueCents: z.number(), orderCount: z.number() }) }),
    );
    check('the served order is reflected in sales revenue', sales.summary.revenueCents >= 3800);

    const afterServed = payload(await call(diner, 'view_order'), z.object({ order: orderShape.nullable() }));
    check("the diner's active order clears once served", afterServed.order === null);

    console.log('\n  Assistance — raised by diner, cleared by owner:');
    await call(diner, 'request_assistance', { reason: 'check please' });
    const calling = payload(
      await call(owner, 'list_tables', { status: 'needs_assistance' }),
      z.object({ tables: z.array(z.object({ tableId: z.string() })) }),
    );
    check('owner sees table 7 calling for help', calling.tables.some((t) => t.tableId === 'tbl-7'));

    await call(owner, 'respond_to_call', { tableId: 'tbl-7' });
    const cleared = payload(
      await call(owner, 'list_tables', { status: 'needs_assistance' }),
      z.object({ tables: z.array(z.object({ tableId: z.string() })) }),
    );
    check('table 7 is cleared after the owner responds', !cleared.tables.some((t) => t.tableId === 'tbl-7'));
  } finally {
    await diner.close();
    await owner.close();
    await http.close();
  }

  console.log(`\n[table-order scenario] ${checks} checks passed ✓`);
}

main().catch((err) => {
  console.error('[table-order scenario] FAILED:', err);
  process.exit(1);
});
