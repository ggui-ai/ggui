/**
 * Notes MCP — OSS mount integration proof (Slice 6.2).
 *
 * Shape-parallel to `../tasks/mount-integration.test.ts`: boots a real
 * `createGguiServer({ mcpApps, sessionChannel, ..., mcpMounts: [{
 * name: 'notes', handlers: <Notes bundle> }] })` on an ephemeral port,
 * then drives its `/mcp` endpoint via the `@modelcontextprotocol/sdk`
 * Client over HTTP — the same transport a real agent uses.
 *
 * The product claim this test anchors: one OSS session sees BOTH
 * `ggui_render` AND every `notes_*` tool on the same `tools/list`, and
 * `tools/call notes_*` mutations are visible in the shared
 * `NotesStore` that backed the handler bundle.
 *
 * Together with the Tasks mount-integration test it proves the
 * `mcpMounts` seam is reusable across domains — Notes is not
 * "Tasks with different labels".
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
import { createNotesSharedHandlers } from './handlers.js';
import { NOTES_TOOL_NAMES } from './server.js';
import { NotesStore } from './store.js';

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
  store: NotesStore;
}

async function boot(): Promise<BootedFixture> {
  const store = new NotesStore({
    now: () => 1_776_556_800_000,
    generateId: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
  });
  const mount: McpServerMount = {
    name: 'notes',
    handlers: createNotesSharedHandlers({ store }),
  };
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    sessionChannel: true,
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
    { name: 'notes-mount-integration', version: '0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe('Notes MCP mounted on createGguiServer — real /mcp wire', () => {
  let fx: BootedFixture;

  beforeEach(async () => {
    fx = await boot();
  });

  afterEach(async () => {
    await fx.server.close();
  });

  it('exposes ggui_render + every notes_* tool on one MCP surface', async () => {
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Required-surface assertion only. The exhaustive tool-count
      // canary is tarball-smoke's job.
      expect(names).toContain('ggui_render');
      expect(names).toContain('ggui_handshake');
      for (const noteName of NOTES_TOOL_NAMES) {
        expect(names).toContain(noteName);
      }
    } finally {
      await client.close();
    }
  });

  it('tools/call notes_create writes to the mounted store; notes_list reads it back', async () => {
    const client = await connectClient(fx.url);
    try {
      const createResult = await client.callTool({
        name: 'notes_create',
        arguments: {
          input: { title: 'slice 6.2 launch', body: 'inline body' },
        },
      });
      const createOut = createResult.structuredContent as {
        item: { id: string; title: string; body: string };
      };
      expect(createOut.item.id).toBe('new-1');
      expect(createOut.item.title).toBe('slice 6.2 launch');
      expect(createOut.item.body).toBe('inline body');

      // Observable in the store the mount captured.
      expect(fx.store.get('new-1')?.title).toBe('slice 6.2 launch');

      const listResult = await client.callTool({
        name: 'notes_list',
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

  it('tools/call notes_append preserves prior body with a paragraph break through the wire path', async () => {
    const client = await connectClient(fx.url);
    try {
      await client.callTool({
        name: 'notes_create',
        arguments: { input: { title: 'seed', body: 'kickoff note' } },
      });
      const appended = await client.callTool({
        name: 'notes_append',
        arguments: { id: 'new-1', markdown: 'follow-up' },
      });
      const out = appended.structuredContent as {
        item: { body: string } | null;
      };
      expect(out.item?.body).toBe('kickoff note\n\nfollow-up');
    } finally {
      await client.close();
    }
  });

  it('tools/call notes_search finds body-only matches (distinct from Tasks title-only search)', async () => {
    const client = await connectClient(fx.url);
    try {
      await client.callTool({
        name: 'notes_create',
        arguments: {
          input: {
            title: 'meeting 1',
            body: 'discussed the new pricing plan at length',
          },
        },
      });
      const out = await client.callTool({
        name: 'notes_search',
        arguments: { query: 'pricing plan' },
      });
      const structured = out.structuredContent as {
        items: Array<{ id: string; title: string }>;
        totalMatches: number;
      };
      // Title "meeting 1" contains no 'pricing' — only the body matches.
      expect(structured.items.map((i) => i.id)).toEqual(['new-1']);
      expect(structured.totalMatches).toBe(1);
    } finally {
      await client.close();
    }
  });

  it('tools/call ggui_render still works (native tool unaffected by mount)', async () => {
    const client = await connectClient(fx.url);
    try {
      // Post-Phase-B render is handshake-first: handshake(intent,
      // blueprintDraft) → render(handshakeId, decision). The prior
      // `ggui_new_session` mint is gone — every render IS the
      // addressable scope.
      const hs = (await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'smoke test — notes mount parity with ggui_render',
          blueprintDraft: { contract: {} },
        },
      })).structuredContent as { handshakeId: string };
      const result = await client.callTool({
        name: 'ggui_render',
        arguments: {
          handshakeId: hs.handshakeId,
          decision: { kind: 'accept' },
        },
      });
      const structured = result.structuredContent as {
        renderId: string;
        action: string;
      };
      expect(structured.renderId).toBeTruthy();
      // Post-R5 (fix-A 2026-05-26): no dead `url` on structuredContent.
      expect(Object.keys(structured)).not.toContain('url');
    } finally {
      await client.close();
    }
  });

  it('tools/call with a bad notes_create tag returns an MCP isError tool-result', async () => {
    const client = await connectClient(fx.url);
    try {
      // `Pricing` (uppercase) fails the tag regex at the SDK's input
      // parse before reaching the handler. SDK surfaces as
      // isError:true per MCP convention.
      const result = await client.callTool({
        name: 'notes_create',
        arguments: {
          input: {
            title: 'bad-tag',
            body: '',
            tags: ['Pricing'],
            pinned: false,
            linkedTaskIds: [],
          },
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
