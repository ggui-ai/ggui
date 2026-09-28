/**
 * ggui#1415 — the measuring gate over a REAL MCP SDK client on a linked
 * in-memory transport: what a previous-release view sends (no `_meta`, or
 * `_meta` without the proof's key) is accepted exactly as before and read
 * `missing`; a view that signs with its view key reads `valid`; and the
 * served `tools/list` names the declared code on both closed outputs. The
 * gate never changes an answer.
 */
import { createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { z, type ZodRawShape } from 'zod';
import { mintViewRoot } from '@ggui-ai/mcp-server-core';
import {
  InMemoryGguiSessionStore,
  InMemoryPendingEventConsumer,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  InMemoryToolIdentityCatalogStore,
  createGguiDeclareToolCatalogHandler,
  createGguiRuntimePullHandler,
  createGguiSubmitActionHandler,
  createGguiSyncContextHandler,
  type HandlerContext,
  type SharedHandler,
} from '@ggui-ai/mcp-server-handlers';
import type { ComponentGguiSession, JsonObject } from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_ORIGIN_UNPROVEN,
  formatViewProofV1,
  viewProofArgsBytes,
  viewProofCallBytes,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { buildMcpServer } from './build-mcp.js';
import type { Logger } from './logger.js';
import { createViewProofGate } from './view-proof-gate.js';

const SECRET = 'wire-gate-secret';
const sessionId = 'render_wire_gate_1';
const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-1', authSource: 'apikey' };
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
  contextSpec: { draft: { schema: { type: 'string' } } },
};
const dispatch: JsonObject = {
  kind: 'dispatch',
  payload: { intent: 'confirm', actionData: null, uiContext: {} },
  sessionId,
  appId: 'app-1',
  actionId: 'a3f2b1d4',
  firedAt: '2026-09-29T00:00:00.000Z',
};

interface Line {
  readonly level: 'info' | 'warn';
  readonly msg: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function capturingLogger(lines: Line[]): Logger {
  const logger: Logger = {
    info: (msg, data) => void lines.push({ level: 'info', msg, data: data ?? {} }),
    warn: (msg, data) => void lines.push({ level: 'warn', msg, data: data ?? {} }),
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger;
}

function signDispatch(): string {
  const root = mintViewRoot({ sessionId, appId: 'app-1', src: 'result' }, SECRET);
  const P = root.token.split('.')[0] ?? '';
  const K = Buffer.from(root.viewKey ?? '', 'base64url');
  const toolName = 'ggui_runtime_submit_action';
  const nonce = 'AAECAwQFBgcICQoLDA0ODw';
  const vtime = String(Date.now());
  const flags = '1';
  const argmac = createHmac('sha256', K).update(viewProofArgsBytes(toolName, dispatch)).digest('base64url');
  const callmac = createHmac('sha256', K)
    .update(viewProofCallBytes({ toolName, nonce, vtime, flags, argmac }))
    .digest('base64url');
  return formatViewProofV1({ root: P, nonce, vtime, flags, argmac, callmac });
}

async function withServer(
  run: (client: Client, lines: Line[], store: InMemoryGguiSessionStore) => Promise<void>,
  extra: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>> = [],
): Promise<void> {
  const lines: Line[] = [];
  const store = new InMemoryGguiSessionStore();
  await store.commit({ appId: 'app-1', render: card });
  const consumer = new InMemoryPendingEventConsumer();
  await consumer.markCreated(sessionId);
  const handlers = [
    createGguiSubmitActionHandler({ pendingEventConsumer: consumer, renderStore: store, consumerGraceMs: 0 }),
    createGguiSyncContextHandler({ renderStore: store }),
    createGguiRuntimePullHandler({ renderStore: store }),
    createGguiDeclareToolCatalogHandler({ catalogStore: new InMemoryToolIdentityCatalogStore() }),
    ...extra,
  ];
  const server = buildMcpServer({ name: 'test', version: '0' }, handlers, () => ctx, capturingLogger(lines), {
    viewProofGate: createViewProofGate({ secret: SECRET, sessionStore: store }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'view-proof-gate-wire-test', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client, lines, store);
  } finally {
    await client.close();
    await server.close();
  }
}

/** A server with only the given handlers and the gate. */
async function withServerOnly(
  handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const server = buildMcpServer({ name: 'test', version: '0' }, handlers, () => ctx, capturingLogger([]), {
    viewProofGate: createViewProofGate({ secret: SECRET, sessionStore: undefined }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'view-proof-gate-wire-only', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const invoked = (lines: readonly Line[], tool: string): Readonly<Record<string, unknown>> | undefined =>
  lines.filter((l) => l.msg === 'tool_invoked' && l.data['tool'] === tool).at(-1)?.data;

describe('the view-proof measuring gate over a real SDK client (ggui#1415)', () => {
  it('a previous-release view (no _meta) is accepted exactly as before, and its line reads missing, legacy', async () => {
    await withServer(async (client, lines) => {
      const result = await client.callTool({ name: 'ggui_runtime_submit_action', arguments: dispatch });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect(invoked(lines, 'ggui_runtime_submit_action')).toMatchObject({
        outcome: 'success',
        sessionId,
        viewProof: 'missing',
        viewProofReason: 'meta_absent',
        claimedSessionId: sessionId,
        viewProofEra: 'legacy',
        authSource: 'apikey',
      });
    });
  });

  it('_meta without the proof’s key reads key_absent, and is accepted', async () => {
    await withServer(async (client, lines) => {
      const result = await client.callTool({
        name: 'ggui_runtime_submit_action',
        arguments: dispatch,
        _meta: { 'ai.ggui/host-session': { hostName: 'h', hostSessionId: 's' } },
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
      expect(invoked(lines, 'ggui_runtime_submit_action')).toMatchObject({ viewProof: 'missing', viewProofReason: 'key_absent' });
    });
  });

  it('a view that signs with its view key reads valid, and the line never carries the proof', async () => {
    await withServer(async (client, lines) => {
      const proof = signDispatch();
      const result = await client.callTool({
        name: 'ggui_runtime_submit_action',
        arguments: dispatch,
        _meta: { [MCP_APP_AI_GGUI_VIEW_META_KEY]: proof },
      });
      expect(result.structuredContent).toMatchObject({ ok: true });
      const line = invoked(lines, 'ggui_runtime_submit_action');
      expect(line).toMatchObject({
        viewProof: 'valid',
        viewProofSessionId: sessionId,
        viewProofRootSrc: 'result',
        viewProofActivation: true,
      });
      expect(line).not.toHaveProperty('viewProofReason');
      // No segment of the proof (root, nonce, clock, flags, tags) reaches the line.
      const text = JSON.stringify(line);
      for (const segment of proof.split('.').slice(1).filter((part) => part.length >= 8)) {
        expect(text).not.toContain(segment);
      }
    });
  });

  it('the handler runs with the gated context: the verdict reaches it, and a required call reads its row once', async () => {
    const seen: Array<string | undefined> = [];
    const echo: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'ggui_runtime_pull',
      description: 'echoes the verdict it was handed',
      inputSchema: { sessionId: z.string() },
      outputSchema: { verdict: z.string() },
      viewProof: 'measured',
      async handler(_input, ctx) {
        seen.push(ctx.viewProof?.verdict);
        return { verdict: ctx.viewProof?.verdict ?? 'none' };
      },
    };
    await withServerOnly([echo], async (client) => {
      await client.callTool({ name: 'ggui_runtime_pull', arguments: { sessionId } });
    });
    expect(seen).toEqual(['missing']);
    await withServer(async (client, _lines, store) => {
      const get = vi.spyOn(store, 'get');
      const result = await client.callTool({ name: 'ggui_runtime_submit_action', arguments: dispatch });
      expect(result.structuredContent).toMatchObject({ ok: true });
      // The gate's era read and the dispatch gate's own read share one store read.
      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  it('a call that throws carries the proof fields on its error line, with authSource', async () => {
    await withServer(async (client, lines) => {
      const result = await client.callTool({ name: 'ggui_runtime_pull', arguments: { sessionId: 'render_absent' } });
      expect(result.isError).toBe(true);
      expect(invoked(lines, 'ggui_runtime_pull')).toMatchObject({
        outcome: 'error',
        viewProof: 'missing',
        viewProofReason: 'meta_absent',
        claimedSessionId: 'render_absent',
        authSource: 'apikey',
      });
    });
  });

  it('declare_tool_catalog declares no proof, and its line carries authSource', async () => {
    await withServer(async (client, lines) => {
      await client.callTool({ name: 'ggui_runtime_declare_tool_catalog', arguments: { toolCatalog: {} } });
      const line = invoked(lines, 'ggui_runtime_declare_tool_catalog');
      expect(line).toMatchObject({ authSource: 'apikey' });
      expect(line).not.toHaveProperty('viewProof');
      expect(line).not.toHaveProperty('viewProofUnverifiable');
    });
  });

  it('a sync names its refusal on the line, with the claimed session and the era', async () => {
    await withServer(async (client, lines) => {
      const result = await client.callTool({
        name: 'ggui_runtime_sync_context',
        arguments: { sessionId: 'render_absent', appId: 'app-1', snapshot: { draft: 'x' } },
      });
      expect(result.structuredContent).toMatchObject({ ok: false, code: 'SESSION_NOT_FOUND' });
      expect(invoked(lines, 'ggui_runtime_sync_context')).toMatchObject({
        outcome: 'success',
        ok: false,
        code: 'SESSION_NOT_FOUND',
        viewProof: 'missing',
        claimedSessionId: 'render_absent',
        viewProofEra: 'row_absent',
      });
    });
  });

  it('the served tools/list names VIEW_ORIGIN_UNPROVEN on both closed outputs', async () => {
    await withServer(async (client) => {
      const { tools } = await client.listTools();
      const codeEnum = z.object({
        outputSchema: z.object({
          additionalProperties: z.literal(false),
          properties: z.object({ code: z.object({ enum: z.array(z.string()) }) }),
        }),
      });
      for (const name of ['ggui_runtime_submit_action', 'ggui_runtime_sync_context']) {
        const tool = tools.find((t) => t.name === name);
        expect(codeEnum.parse(tool).outputSchema.properties.code.enum, name).toContain(VIEW_ORIGIN_UNPROVEN);
      }
    });
  });
});
