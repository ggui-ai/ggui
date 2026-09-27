/**
 * ggui#1399 step 2 — the consume → amend hint is SENT, over a real MCP SDK
 * client on a linked in-memory transport.
 *
 * Step 1 declared `nextStep` on `ggui_consume`'s closed output one release
 * earlier, so a client that cached that schema at `listTools` accepts the
 * emit here with no validation error (the N−1 receipt). This pins: a
 * non-empty drain carries `nextStep` = `ggui_amend` with the input's
 * sessionId, the model-visible content LEADS with the amend example in
 * plain text (the device that made render → consume stick), and an empty
 * drain carries neither.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore, InMemoryPendingEventConsumer } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiConsumeHandler, type HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { buildMcpServer } from './build-mcp.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};

const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-1' };
const sessionId = 'render-wire-1399';

const card: ComponentGguiSession = {
  type: 'component',
  id: sessionId,
  appId: 'app-1',
  componentCode: '/* card */',
  eventSequence: 0,
  createdAt: 0,
  lastActivityAt: 0,
  expiresAt: 0,
  epoch: 1,
};

async function boot(withEvent: boolean) {
  const consumer = new InMemoryPendingEventConsumer();
  await consumer.markCreated(sessionId);
  if (withEvent) {
    await consumer.append(sessionId, {
      id: 'evt-1',
      envelope: {
        type: 'action',
        sessionId,
        intent: 'confirm',
        actionData: { id: 'bk_1' },
        uiContext: {},
        actionId: 'a1f2e3d4',
        firedAt: '2026-09-27T00:00:00.000Z',
      },
      createdAt: '2026-09-27T00:00:00.000Z',
    });
  }
  const store = new InMemoryGguiSessionStore();
  await store.commit({ appId: 'app-1', render: card });
  const handler = createGguiConsumeHandler({ pendingEventConsumer: consumer, renderStore: store });
  const server = buildMcpServer({ name: 'test', version: '0' }, [handler], () => ctx, silentLogger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'consume-nextstep-wire-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  await client.listTools(); // the client caches the output validator here
  return { client, server };
}

describe('ggui_consume over a real SDK client — the amend hint is sent (#1399 step 2)', () => {
  it('a non-empty drain carries nextStep → ggui_amend with the input sessionId, validated against the cached schema, and the text leads with the example', async () => {
    const { client, server } = await boot(true);
    try {
      const result = await client.callTool({ name: 'ggui_consume', arguments: { sessionId, timeout: 0 } });
      expect(result.isError).toBeFalsy();
      const out = result.structuredContent as { events: unknown[]; nextStep?: { tool: string; example: string; args: { sessionId: string } } };
      expect(out.events).toHaveLength(1);
      expect(out.nextStep).toMatchObject({ tool: 'ggui_amend', args: { sessionId } });
      const first = (result.content as { type: string; text?: string }[])[0];
      expect(first?.type).toBe('text');
      expect(first?.text).toContain(out.nextStep?.example ?? 'ggui_amend(');
      expect(first?.text).not.toMatch(/catch an immediate gesture/); // the poll wording is the consume hint's, not this one
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('an empty drain carries no nextStep and no plain-text lead', async () => {
    const { client, server } = await boot(false);
    try {
      const result = await client.callTool({ name: 'ggui_consume', arguments: { sessionId, timeout: 0 } });
      const out = result.structuredContent as { events: unknown[]; nextStep?: unknown };
      expect(out.events).toHaveLength(0);
      expect(out).not.toHaveProperty('nextStep');
      expect((result.content as { type: string }[]).length).toBe(1); // the JSON block only
    } finally {
      await client.close();
      await server.close();
    }
  });
});
