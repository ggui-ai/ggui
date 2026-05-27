/**
 * Contacts MCP — OSS mount integration proof (Slice 6.3).
 *
 * Shape-parallel to `../notes/mount-integration.test.ts` +
 * `../tasks/mount-integration.test.ts`: boots a real
 * `createGguiServer({ mcpApps, sessionChannel, ..., mcpMounts: [{
 * name: 'contacts', handlers: <Contacts bundle> }] })` on an
 * ephemeral port, then drives its `/mcp` endpoint via the
 * `@modelcontextprotocol/sdk` Client over HTTP — the same transport a
 * real agent uses.
 *
 * The product claim this test anchors: one OSS server surface sees
 * BOTH `ggui_render` AND every `contacts_*` tool on the same
 * `tools/list`, and `tools/call contacts_*` mutations — including
 * the Contacts-specific `contacts_link` cross-ref op — are visible
 * in the shared `ContactsStore` that backed the handler bundle.
 *
 * Together with the Tasks + Notes mount-integration tests, this
 * completes the trio proof that the `mcpMounts` seam is reusable
 * across three distinct domains.
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
import { createContactsSharedHandlers } from './handlers.js';
import { CONTACTS_TOOL_NAMES } from './server.js';
import { ContactsStore } from './store.js';

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
  store: ContactsStore;
}

async function boot(): Promise<BootedFixture> {
  const store = new ContactsStore({
    now: () => 1_776_556_800_000,
    generateId: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
  });
  const mount: McpServerMount = {
    name: 'contacts',
    handlers: createContactsSharedHandlers({ store }),
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
    { name: 'contacts-mount-integration', version: '0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

describe('Contacts MCP mounted on createGguiServer — real /mcp wire', () => {
  let fx: BootedFixture;

  beforeEach(async () => {
    fx = await boot();
  });

  afterEach(async () => {
    await fx.server.close();
  });

  it('exposes ggui_render + every contacts_* tool on one MCP surface', async () => {
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Required-surface assertion only. The exhaustive tool-count
      // canary is tarball-smoke's job; `expect.arrayContaining` here
      // lets new native tools land without flapping this spec.
      expect(names).toContain('ggui_render');
      expect(names).toContain('ggui_handshake');
      for (const contactName of CONTACTS_TOOL_NAMES) {
        expect(names).toContain(contactName);
      }
    } finally {
      await client.close();
    }
  });

  it('tools/call contacts_create writes to the mounted store; contacts_list reads it back', async () => {
    const client = await connectClient(fx.url);
    try {
      const createResult = await client.callTool({
        name: 'contacts_create',
        arguments: {
          input: {
            displayName: 'slice 6.3 test',
            email: 'slice63@example.com',
          },
        },
      });
      const createOut = createResult.structuredContent as {
        item: { id: string; displayName: string; email: string | null };
      };
      expect(createOut.item.id).toBe('new-1');
      expect(createOut.item.displayName).toBe('slice 6.3 test');
      expect(createOut.item.email).toBe('slice63@example.com');

      // Observable in the store the mount captured.
      expect(fx.store.get('new-1')?.displayName).toBe('slice 6.3 test');

      const listResult = await client.callTool({
        name: 'contacts_list',
        arguments: {},
      });
      const listOut = listResult.structuredContent as {
        items: Array<{ id: string; displayName: string }>;
      };
      expect(listOut.items.map((i) => i.id)).toEqual(['new-1']);
    } finally {
      await client.close();
    }
  });

  it('tools/call contacts_link add→remove round-trips through the wire path', async () => {
    const client = await connectClient(fx.url);
    try {
      await client.callTool({
        name: 'contacts_create',
        arguments: {
          input: {
            displayName: 'link-target',
          },
        },
      });

      const added = await client.callTool({
        name: 'contacts_link',
        arguments: {
          id: 'new-1',
          link: { kind: 'task', targetId: 'task-42', op: 'add' },
        },
      });
      const addedOut = added.structuredContent as {
        item: { linkedTaskIds: string[] } | null;
      };
      expect(addedOut.item?.linkedTaskIds).toEqual(['task-42']);

      const removed = await client.callTool({
        name: 'contacts_link',
        arguments: {
          id: 'new-1',
          link: { kind: 'task', targetId: 'task-42', op: 'remove' },
        },
      });
      const removedOut = removed.structuredContent as {
        item: { linkedTaskIds: string[] } | null;
      };
      expect(removedOut.item?.linkedTaskIds).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it('tools/call contacts_search finds email-only matches (distinct from Notes title-OR-body and Tasks title-only)', async () => {
    const client = await connectClient(fx.url);
    try {
      await client.callTool({
        name: 'contacts_create',
        arguments: {
          input: {
            displayName: 'Display-Only Record',
          },
        },
      });
      await client.callTool({
        name: 'contacts_create',
        arguments: {
          input: {
            displayName: 'Email-Bearing Record',
            email: 'finance-alpha@example.com',
          },
        },
      });
      const out = await client.callTool({
        name: 'contacts_search',
        arguments: { query: 'finance-alpha' },
      });
      const structured = out.structuredContent as {
        items: Array<{ id: string; displayName: string }>;
        totalMatches: number;
      };
      // Only the email-bearing record matches on an email-only query.
      expect(structured.items.map((i) => i.id)).toEqual(['new-2']);
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
      // addressable scope. Direct render without a handshakeId fails
      // with handshake_not_found.
      const hs = (await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'smoke test — contacts mount parity with ggui_render',
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
      // Post-Phase-B render response: structuredContent carries
      // `{renderId, action}`.
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

  it('tools/call with a bad contacts_create email returns an MCP isError tool-result', async () => {
    const client = await connectClient(fx.url);
    try {
      // "not-an-email" fails the schema `.email()` at the SDK's
      // permissive input parse before reaching the handler. SDK
      // surfaces as isError:true per MCP convention.
      const result = await client.callTool({
        name: 'contacts_create',
        arguments: {
          input: {
            displayName: 'bad-email',
            email: 'not-an-email',
            tags: [],
            favorite: false,
            linkedTaskIds: [],
            linkedNoteIds: [],
          },
        },
      });
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
