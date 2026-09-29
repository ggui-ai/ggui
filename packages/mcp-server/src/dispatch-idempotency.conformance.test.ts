/**
 * ggui#1519 — the OSS server's handler stack is bound to the kit's
 * `dispatch-idempotency` catalog (SPEC §11.1, "A retried dispatch is one
 * gesture"), and passes it: every case, with nothing warned.
 *
 * The binding drives the handlers `defaultHandlers` registers, sharing one
 * render store and one pending-event pipe, which is where the promise lives:
 * `ggui_runtime_submit_action` appends, `ggui_consume` drains, and
 * `ggui_runtime_pull` serves the ledger. It does not go through the MCP
 * transport (`createGguiServer` owns its pipe privately, so a session could
 * not be opened on it from outside); the `domain-error` catalog's binding
 * covers the transport's result shape.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryGguiSessionStore, InMemoryPendingEventConsumer, InMemoryVectorStore, MockEmbeddingProvider } from '@ggui-ai/mcp-server-core/in-memory';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import type { HandlerContext } from '@ggui-ai/mcp-server-handlers';
import {
  DISPATCH_IDEMPOTENCY_ACTION_SPEC,
  runDispatchIdempotencyConformance,
  type DispatchIdempotencyHost,
} from '@ggui-ai/protocol-conformance/dispatch-idempotency-conformance';
import { defaultHandlers } from './server.js';

const APP = 'app-dispatch-idempotency';

function host(): DispatchIdempotencyHost {
  const renderStore = new InMemoryGguiSessionStore();
  const pendingEventConsumer = new InMemoryPendingEventConsumer();
  const handlers = defaultHandlers({
    embedding: new MockEmbeddingProvider(),
    vectors: new InMemoryVectorStore(),
    render: { renderStore },
    update: { renderStore },
    consume: { pendingEventConsumer },
  });
  const ctx: HandlerContext = { appId: APP, requestId: 'req-dispatch-idempotency' };
  let n = 0;
  return {
    callTool: async (scenario) => {
      const handler = handlers.find((h) => h.name === scenario.tool);
      if (!handler) return null;
      const structuredContent: unknown = await handler.handler(scenario.args, ctx);
      return { content: [], structuredContent };
    },
    openSession: async () => {
      const now = Date.now();
      const created = await renderStore.create({ appId: APP });
      const card: ComponentGguiSession = {
        type: 'component',
        id: created.id,
        appId: APP,
        componentCode: 'export default function Card(){return null}',
        actionSpec: DISPATCH_IDEMPOTENCY_ACTION_SPEC,
        eventSequence: 0,
        createdAt: now,
        lastActivityAt: now,
        expiresAt: now + 3_600_000,
        epoch: ++n,
      };
      await renderStore.commit({ appId: APP, render: card });
      pendingEventConsumer.markCreated(created.id);
      return { sessionId: created.id, appId: APP, close: async () => renderStore.delete(created.id) };
    },
  };
}

// Each dispatch the handler accepts waits out its doorbell grace before it
// answers: up to 2 s on a card younger than a minute with no consumer parked,
// which is every card here. A run is eight such waits in series (the
// concurrent pair overlaps), about 16 s.
const RUN_TIMEOUT_MS = 60_000;

describe("the OSS server passes the kit's dispatch-idempotency catalog (ggui#1519)", () => {
  it('every case holds: a sequential retry, a concurrent retry, and a reused id keeping the first gesture', async () => {
    const result = await runDispatchIdempotencyConformance(host());
    expect(result.warned).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.passed.map((c) => c.name)).toEqual([
      'sequential-retry-is-one-gesture',
      'concurrent-retry-is-one-gesture',
      'reused-id-keeps-the-first-gesture',
    ]);
  }, RUN_TIMEOUT_MS);
});
