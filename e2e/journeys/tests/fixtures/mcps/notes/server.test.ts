/**
 * MCP wire-level contract tests for the Notes MCP fixture.
 *
 * Boots `createNotesMcpServer` over `InMemoryTransport`, connects a
 * real `Client`, and exercises every tool via `client.callTool()`.
 * Shape-parallel to `../tasks/server.test.ts`. Anything structurally
 * identical across the two MCPs stays in Tasks' coverage; this file
 * focuses on Notes-specific invariants:
 *
 *   - body-or-title search (the Notes-vs-Tasks differentiator)
 *   - `notes_append` paragraph semantics
 *   - tag-array canonicalisation
 *   - pinned sort + pinned filter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectMcpInMemory } from '../_shared/mcp-test-client.js';
import { createNotesMcpServer, NOTES_TOOL_NAMES } from './server.js';
import { NotesStore } from './store.js';
import { NOTES_SEED, SEED_NOW } from './seed.js';

interface Ctx {
  store: NotesStore;
  client: Client;
  close: () => Promise<void>;
}

async function boot(opts: { seeded?: boolean } = {}): Promise<Ctx> {
  let counter = 0;
  const store = new NotesStore({
    filename: ':memory:',
    now: () => SEED_NOW + 1_000,
    generateId: () => `new-note-${++counter}`,
  });
  if (opts.seeded ?? true) {
    store.seed(NOTES_SEED);
  }
  const server = createNotesMcpServer({ store });
  const { client, close } = await connectMcpInMemory(server);
  return { store, client, close };
}

function structured<T extends Record<string, unknown>>(
  result: Awaited<ReturnType<Client['callTool']>>,
): T {
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeTruthy();
  return result.structuredContent as T;
}

describe('notes MCP — tools/list', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('surfaces every canonical notes_* tool', async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...NOTES_TOOL_NAMES].sort());
  });

  it('every tool carries a non-empty description', async () => {
    const { tools } = await ctx.client.listTools();
    for (const t of tools) {
      expect(
        t.description && t.description.length > 0,
        `${t.name} description`,
      ).toBe(true);
    }
  });
});

describe('notes MCP — create + get + delete round-trip', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('notes_create returns a fully populated item with defaults', async () => {
    const out = structured<{ item: Record<string, unknown> }>(
      await ctx.client.callTool({
        name: 'notes_create',
        arguments: { input: { title: 'Slice 6.2 plan' } },
      }),
    );
    expect(out.item).toMatchObject({
      id: 'new-note-1',
      title: 'Slice 6.2 plan',
      body: '',
      tags: [],
      pinned: false,
      aboutContactId: null,
      linkedTaskIds: [],
    });
  });

  it('notes_get returns the created note', async () => {
    await ctx.client.callTool({
      name: 'notes_create',
      arguments: {
        input: {
          title: 'get-me-back',
          body: 'hello',
          tags: ['x'],
          pinned: true,
          linkedTaskIds: [],
        },
      },
    });
    const out = structured<{ item: { title: string; pinned: boolean } | null }>(
      await ctx.client.callTool({
        name: 'notes_get',
        arguments: { id: 'new-note-1' },
      }),
    );
    expect(out.item?.title).toBe('get-me-back');
    expect(out.item?.pinned).toBe(true);
  });

  it('notes_get returns { item: null } for unknown id', async () => {
    const out = structured<{ item: unknown }>(
      await ctx.client.callTool({
        name: 'notes_get',
        arguments: { id: 'nope' },
      }),
    );
    expect(out.item).toBeNull();
  });

  it('notes_delete is idempotent', async () => {
    await ctx.client.callTool({
      name: 'notes_create',
      arguments: { input: { title: 'doomed' } },
    });
    const first = structured<{ deleted: boolean }>(
      await ctx.client.callTool({
        name: 'notes_delete',
        arguments: { id: 'new-note-1' },
      }),
    );
    expect(first.deleted).toBe(true);
    const second = structured<{ deleted: boolean }>(
      await ctx.client.callTool({
        name: 'notes_delete',
        arguments: { id: 'new-note-1' },
      }),
    );
    expect(second.deleted).toBe(false);
  });
});

describe('notes MCP — append + update distinction', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: true });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('notes_append preserves prior body with a paragraph break', async () => {
    const out = structured<{ item: { body: string } | null }>(
      await ctx.client.callTool({
        name: 'notes_append',
        arguments: { id: 'seed-note-2', markdown: 'Follow-up sent 2026-04-22.' },
      }),
    );
    expect(out.item?.body).toMatch(/Discussed Phase 5 scope/);
    expect(out.item?.body).toMatch(/\n\nFollow-up sent 2026-04-22\./);
  });

  it('notes_update with body replaces the full body (contrast with append)', async () => {
    const out = structured<{ item: { body: string } | null }>(
      await ctx.client.callTool({
        name: 'notes_update',
        arguments: { id: 'seed-note-2', patch: { body: 'replaced' } },
      }),
    );
    expect(out.item?.body).toBe('replaced');
  });

  it('notes_append returns { item: null } for unknown id', async () => {
    const out = structured<{ item: unknown }>(
      await ctx.client.callTool({
        name: 'notes_append',
        arguments: { id: 'nope', markdown: 'stray' },
      }),
    );
    expect(out.item).toBeNull();
  });
});

describe('notes MCP — search over title OR body', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: true });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('finds a body-only match — Notes differentiator from Tasks', async () => {
    const out = structured<{
      items: Array<{ id: string }>;
      totalMatches: number;
    }>(
      await ctx.client.callTool({
        name: 'notes_search',
        arguments: { query: 'reference check' },
      }),
    );
    // Only seed-note-5's body mentions "reference check".
    expect(out.items.map((n) => n.id)).toEqual(['seed-note-5']);
    expect(out.totalMatches).toBe(1);
  });

  it('matches titles', async () => {
    const out = structured<{
      items: Array<{ id: string }>;
      totalMatches: number;
    }>(
      await ctx.client.callTool({
        name: 'notes_search',
        arguments: { query: 'Pricing' },
      }),
    );
    expect(out.items.map((n) => n.id)).toContain('seed-note-4');
  });

  it('composes with tag filter', async () => {
    const out = structured<{ items: Array<{ id: string }> }>(
      await ctx.client.callTool({
        name: 'notes_search',
        arguments: { query: 'blog', filter: { tags: ['launch'] } },
      }),
    );
    expect(out.items.map((n) => n.id)).toEqual(['seed-note-1']);
  });
});

describe('notes MCP — list filter + sort', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: true });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('filters by pinned=true', async () => {
    const out = structured<{ items: Array<{ id: string; pinned: boolean }> }>(
      await ctx.client.callTool({
        name: 'notes_list',
        arguments: { filter: { pinned: true } },
      }),
    );
    for (const i of out.items) expect(i.pinned).toBe(true);
    expect(out.items.map((n) => n.id).sort()).toEqual([
      'seed-note-1',
      'seed-note-4',
    ]);
  });

  it('sort=pinned desc puts pinned-first', async () => {
    const out = structured<{ items: Array<{ id: string; pinned: boolean }> }>(
      await ctx.client.callTool({
        name: 'notes_list',
        arguments: { sort: { field: 'pinned', direction: 'desc' } },
      }),
    );
    // First two should be pinned.
    expect(out.items[0]?.pinned).toBe(true);
    expect(out.items[1]?.pinned).toBe(true);
  });
});

describe('notes MCP — validation', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('rejects an unknown tag pattern via the declared schema', async () => {
    // Tag "Pricing" — uppercase — fails the schema regex at the SDK
    // permissive zod parse BEFORE reaching the handler body. SDK
    // surfaces as isError:true rather than a JSON-RPC throw.
    const result = await ctx.client.callTool({
      name: 'notes_create',
      arguments: {
        input: {
          title: 'bad tag',
          body: '',
          tags: ['Pricing'],
          pinned: false,
          linkedTaskIds: [],
        },
      },
    });
    expect(result.isError).toBe(true);
  });
});
