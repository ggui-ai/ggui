/**
 * Tasks MCP — OSS mount integration proof (Slice 6).
 *
 * Boots a real `createGguiServer({ mcpApps, renderChannel, ...,
 * mcpMounts: [{ name: 'tasks', handlers: <Tasks bundle> }] })` on an
 * ephemeral port, then drives its `/mcp` endpoint via the
 * `@modelcontextprotocol/sdk` Client over HTTP — the same transport
 * a real agent uses.
 *
 * The product claim Slice 6 ships: one OSS session sees **both**
 * `ggui_render` AND every `tasks_*` tool on the same `tools/list`, and
 * `tools/call tasks_*` mutations are visible in the shared
 * `TasksStore` that backed the handler bundle.
 *
 * This test is the end-to-end proof that `createGguiServer`'s
 * `mcpMounts` seam actually aggregates mount handlers onto the real
 * wire — not just conceptually via `composeHandlersWithMounts` (that's
 * covered by `packages/mcp-server/src/mcp-mounts.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';
import {
  createGguiServer,
  InMemoryAuthAdapter,
  InMemoryShortCodeIndex,
  type GguiServer,
  type McpServerMount,
} from '@ggui-ai/mcp-server';
import { createTasksSharedHandlers } from './handlers.js';
import { TASKS_TOOL_NAMES } from './server.js';
import { TasksStore } from './store.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface BootedFixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  store: TasksStore;
}

async function boot(): Promise<BootedFixture> {
  const store = new TasksStore({
    now: () => 1_776_556_800_000,
    generateId: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
  });
  const mount: McpServerMount = {
    name: 'tasks',
    handlers: createTasksSharedHandlers({ store }),
  };
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    renderChannel: true,
    mcpApps: {
      wsUrl: 'ws://127.0.0.1/ws',
    },
    shortCodeIndex: new InMemoryShortCodeIndex(),
    mcpMounts: [mount],
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const url = `http://127.0.0.1:${addr.port}`;
  return { server, httpServer, url, store };
}

async function connectClient(url: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: 'Bearer dev' } },
  });
  const client = new Client(
    { name: 'tasks-mount-integration', version: '0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe('Tasks MCP mounted on createGguiServer — real /mcp wire', () => {
  let fx: BootedFixture;

  beforeEach(async () => {
    fx = await boot();
  });

  afterEach(async () => {
    await fx.server.close();
  });

  it('exposes ggui_render + every tasks_* tool on one MCP surface', async () => {
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Required-surface assertion only. The exhaustive tool-count
      // canary is tarball-smoke's job; this spec proves the mount
      // didn't displace the native surface.
      expect(names).toContain('ggui_render');
      expect(names).toContain('ggui_handshake');
      for (const taskName of TASKS_TOOL_NAMES) {
        expect(names).toContain(taskName);
      }
    } finally {
      await client.close();
    }
  });

  it('tools/call tasks_create writes to the mounted store; tasks_list reads it back', async () => {
    const client = await connectClient(fx.url);
    try {
      const createResult = await client.callTool({
        name: 'tasks_create',
        arguments: { input: { title: 'ship slice 6 runtime wiring' } },
      });
      const createOut = createResult.structuredContent as {
        item: { id: string; title: string; status: string };
      };
      expect(createOut.item.id).toBe('new-1');
      expect(createOut.item.title).toBe('ship slice 6 runtime wiring');
      expect(createOut.item.status).toBe('todo');

      // Observable in the store the mount captured.
      expect(fx.store.get('new-1')?.title).toBe(
        'ship slice 6 runtime wiring',
      );

      const listResult = await client.callTool({
        name: 'tasks_list',
        arguments: {},
      });
      const listOut = listResult.structuredContent as {
        items: Array<{ id: string; title: string }>;
      };
      expect(listOut.items.map((i) => i.id)).toEqual(['new-1']);
    } finally {
      await client.close();
    }
  });

  it('tools/call tasks_complete transitions status through the wire path', async () => {
    const client = await connectClient(fx.url);
    try {
      await client.callTool({
        name: 'tasks_create',
        arguments: { input: { title: 'task to complete' } },
      });
      const done = await client.callTool({
        name: 'tasks_complete',
        arguments: { id: 'new-1' },
      });
      const out = done.structuredContent as {
        item: { status: string } | null;
      };
      expect(out.item?.status).toBe('done');
    } finally {
      await client.close();
    }
  });

  it('tools/call ggui_render still works (native tool unaffected by mount)', async () => {
    const client = await connectClient(fx.url);
    try {
      // Post-Phase-B render is handshake-first: handshake(intent,
      // blueprintDraft) → render(handshakeId, props, override?). Accept
      // (reuse the handshake proposal as-is) omits `override` entirely.
      // The prior `ggui_new_session` mint is gone — every render IS the
      // addressable scope.
      const hs = (await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'smoke test — tasks mount parity with ggui_render',
          blueprintDraft: { contract: {} },
        },
      })).structuredContent as { handshakeId: string };
      const result = await client.callTool({
        name: 'ggui_render',
        arguments: {
          handshakeId: hs.handshakeId,
          props: {},
        },
      });
      const structured = result.structuredContent as {
        sessionId: string;
        action: string;
      };
      expect(structured.sessionId).toBeTruthy();
      // Post-R5 (fix-A 2026-05-26): no dead `url` on structuredContent.
      expect(Object.keys(structured)).not.toContain('url');
    } finally {
      await client.close();
    }
  });

  it('tools/call with a bad tasks_create input returns an MCP isError tool-result, not a JSON-RPC throw', async () => {
    const client = await connectClient(fx.url);
    try {
      // Missing `input.title` — strict-object re-parse should fail in
      // the handler and surface as `isError: true` per MCP convention.
      const result = await client.callTool({
        name: 'tasks_create',
        arguments: { input: {} },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
