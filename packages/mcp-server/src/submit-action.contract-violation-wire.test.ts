/**
 * ggui#1358 step 2 — the relay's `CONTRACT_VIOLATION` answer, over a REAL MCP
 * SDK client on a linked in-memory transport.
 *
 * The SDK client caches the tool's advertised `outputSchema` at `listTools`
 * and validates every `callTool` result's `structuredContent` against it.
 * Step 1 declared `CONTRACT_VIOLATION` and `violations` on the closed output;
 * step 2 answers with them when a dispatch fails the card's `actionSpec`.
 * This pins that a client holding the declared schema accepts the refusal
 * with no validation error, and that the refusal carries the findings.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractViolationSchema, type ComponentGguiSession } from '@ggui-ai/protocol';
import {
  InMemoryGguiSessionStore,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiSubmitActionHandler, type HandlerContext } from '@ggui-ai/mcp-server-handlers';
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
const sessionId = 'render-wire-gated-1';

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
  actionSpec: {
    confirm: {
      label: 'Confirm',
      schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
};

const refusal = z.object({
  ok: z.literal(false),
  code: z.literal('CONTRACT_VIOLATION'),
  message: z.string(),
  violations: z.array(contractViolationSchema).min(1),
});

describe('ggui_runtime_submit_action over a real SDK client — CONTRACT_VIOLATION (#1358)', () => {
  it('a dispatch that fails the card’s actionSpec is answered CONTRACT_VIOLATION, validated by the client against its cached schema, and never reaches the pipe', async () => {
    const consumer = new InMemoryPendingEventConsumer();
    await consumer.markCreated(sessionId);
    const store = new InMemoryGguiSessionStore();
    await store.commit({ appId: 'app-1', render: card });
    const handler = createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store });
    const server = buildMcpServer({ name: 'test', version: '0' }, [handler], () => ctx, silentLogger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'contract-violation-wire-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.listTools(); // the client caches the output validator here
      const result = await client.callTool({
        name: 'ggui_runtime_submit_action',
        arguments: {
          kind: 'dispatch',
          payload: { intent: 'confirm', actionData: { id: 42 }, uiContext: {} },
          sessionId,
          appId: 'app-1',
          actionId: 'a3f2b1d4',
          firedAt: '2026-09-26T00:00:00.000Z',
        },
      });
      // A typed refusal is a normal result (`ok: false`), not an isError tool
      // result; the client validated it against the schema it cached.
      expect(result.isError).toBeFalsy();
      const out = refusal.parse(result.structuredContent);
      expect(out.violations[0]).toMatchObject({ field: expect.any(String) });
      expect((await consumer.consumeAndClear(sessionId, 50)).events).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
