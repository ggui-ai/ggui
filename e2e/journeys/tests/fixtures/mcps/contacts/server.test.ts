/**
 * MCP wire-level contract tests for the Contacts MCP fixture.
 *
 * Boots `createContactsMcpServer` over `InMemoryTransport`, connects
 * a real `Client`, and exercises every tool via `client.callTool()`.
 * Shape-parallel to `../notes/server.test.ts`. Contacts-specific
 * invariants:
 *
 *   - tri-field search (displayName OR email OR company)
 *   - `contacts_link` add/remove idempotence over the wire
 *   - tag-array canonicalisation
 *   - favorite sort + favorite filter.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectMcpInMemory } from '../_shared/mcp-test-client.js';
import { createContactsMcpServer, CONTACTS_TOOL_NAMES } from './server.js';
import { ContactsStore } from './store.js';
import { CONTACTS_SEED, SEED_NOW } from './seed.js';

interface Ctx {
  store: ContactsStore;
  client: Client;
  close: () => Promise<void>;
}

async function boot(opts: { seeded?: boolean } = {}): Promise<Ctx> {
  let counter = 0;
  const store = new ContactsStore({
    filename: ':memory:',
    now: () => SEED_NOW + 1_000,
    generateId: () => `new-contact-${++counter}`,
  });
  if (opts.seeded ?? true) {
    store.seed(CONTACTS_SEED);
  }
  const server = createContactsMcpServer({ store });
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

describe('contacts MCP — tools/list', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('surfaces every canonical contacts_* tool', async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...CONTACTS_TOOL_NAMES].sort());
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

describe('contacts MCP — create + get + delete round-trip', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('contacts_create returns a fully populated item with defaults', async () => {
    const out = structured<{ item: Record<string, unknown> }>(
      await ctx.client.callTool({
        name: 'contacts_create',
        arguments: { input: { displayName: 'Jane Doe' } },
      }),
    );
    expect(out.item).toMatchObject({
      id: 'new-contact-1',
      displayName: 'Jane Doe',
      givenName: null,
      familyName: null,
      email: null,
      phone: null,
      company: null,
      tags: [],
      favorite: false,
      linkedTaskIds: [],
      linkedNoteIds: [],
    });
  });

  it('contacts_get returns the created contact', async () => {
    await ctx.client.callTool({
      name: 'contacts_create',
      arguments: {
        input: {
          displayName: 'lookup-me',
          email: 'lookup@example.com',
          tags: ['vip'],
          favorite: true,
        },
      },
    });
    const out = structured<{
      item: { displayName: string; email: string | null; favorite: boolean } | null;
    }>(
      await ctx.client.callTool({
        name: 'contacts_get',
        arguments: { id: 'new-contact-1' },
      }),
    );
    expect(out.item?.displayName).toBe('lookup-me');
    expect(out.item?.email).toBe('lookup@example.com');
    expect(out.item?.favorite).toBe(true);
  });

  it('contacts_get returns { item: null } for unknown id', async () => {
    const out = structured<{ item: unknown }>(
      await ctx.client.callTool({
        name: 'contacts_get',
        arguments: { id: 'nope' },
      }),
    );
    expect(out.item).toBeNull();
  });

  it('contacts_delete is idempotent', async () => {
    await ctx.client.callTool({
      name: 'contacts_create',
      arguments: { input: { displayName: 'doomed' } },
    });
    const first = structured<{ deleted: boolean }>(
      await ctx.client.callTool({
        name: 'contacts_delete',
        arguments: { id: 'new-contact-1' },
      }),
    );
    expect(first.deleted).toBe(true);
    const second = structured<{ deleted: boolean }>(
      await ctx.client.callTool({
        name: 'contacts_delete',
        arguments: { id: 'new-contact-1' },
      }),
    );
    expect(second.deleted).toBe(false);
  });
});

describe('contacts MCP — link (cross-ref) vs update distinction', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: true });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('contacts_link op=add appends an id to linkedTaskIds on the wire', async () => {
    const out = structured<{ item: { linkedTaskIds: string[] } | null }>(
      await ctx.client.callTool({
        name: 'contacts_link',
        arguments: {
          id: 'bob',
          link: { kind: 'task', targetId: 'seed-task-4', op: 'add' },
        },
      }),
    );
    // bob started with ['seed-task-3']; now adds 'seed-task-4'.
    expect(out.item?.linkedTaskIds).toEqual(['seed-task-3', 'seed-task-4']);
  });

  it('contacts_link add is idempotent — re-adding leaves the array untouched', async () => {
    await ctx.client.callTool({
      name: 'contacts_link',
      arguments: {
        id: 'alice',
        link: { kind: 'task', targetId: 'seed-task-1', op: 'add' },
      },
    });
    const out = structured<{
      item: { linkedTaskIds: string[] } | null;
    }>(
      await ctx.client.callTool({
        name: 'contacts_link',
        arguments: {
          id: 'alice',
          link: { kind: 'task', targetId: 'seed-task-1', op: 'add' },
        },
      }),
    );
    // alice started with ['seed-task-1','seed-task-2']; idempotent
    // re-add leaves the array untouched.
    expect(out.item?.linkedTaskIds).toEqual([
      'seed-task-1',
      'seed-task-2',
    ]);
  });

  it('contacts_update with linkedTaskIds replaces the whole array (contrast with link add)', async () => {
    const out = structured<{ item: { linkedTaskIds: string[] } | null }>(
      await ctx.client.callTool({
        name: 'contacts_update',
        arguments: {
          id: 'alice',
          patch: { linkedTaskIds: ['only-this-one'] },
        },
      }),
    );
    expect(out.item?.linkedTaskIds).toEqual(['only-this-one']);
  });

  it('contacts_link returns { item: null } for unknown id', async () => {
    const out = structured<{ item: unknown }>(
      await ctx.client.callTool({
        name: 'contacts_link',
        arguments: {
          id: 'nope',
          link: { kind: 'task', targetId: 'stray', op: 'add' },
        },
      }),
    );
    expect(out.item).toBeNull();
  });
});

describe('contacts MCP — tri-field search (displayName OR email OR company)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: true });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('finds an email-only match — Contacts differentiator over Tasks+Notes', async () => {
    const out = structured<{
      items: Array<{ id: string }>;
      totalMatches: number;
    }>(
      await ctx.client.callTool({
        name: 'contacts_search',
        arguments: { query: 'carla.mendes@' },
      }),
    );
    expect(out.items.map((c) => c.id)).toEqual(['carla']);
    expect(out.totalMatches).toBe(1);
  });

  it('finds a company-only match', async () => {
    const out = structured<{
      items: Array<{ id: string }>;
      totalMatches: number;
    }>(
      await ctx.client.callTool({
        name: 'contacts_search',
        arguments: { query: 'Zenith' },
      }),
    );
    expect(out.items.map((c) => c.id)).toEqual(['bob']);
  });

  it('composes with tag filter', async () => {
    const out = structured<{ items: Array<{ id: string }> }>(
      await ctx.client.callTool({
        name: 'contacts_search',
        arguments: {
          query: 'Acme',
          filter: { tags: ['coworker'] },
        },
      }),
    );
    expect(out.items.map((c) => c.id)).toEqual(['alice']);
  });
});

describe('contacts MCP — list filter + sort', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: true });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('filters by favorite=true', async () => {
    const out = structured<{
      items: Array<{ id: string; favorite: boolean }>;
    }>(
      await ctx.client.callTool({
        name: 'contacts_list',
        arguments: { filter: { favorite: true } },
      }),
    );
    for (const i of out.items) expect(i.favorite).toBe(true);
    expect(out.items.map((c) => c.id).sort()).toEqual([
      'alice',
      'seed-contact-5',
    ]);
  });

  it('sort=displayName asc — alphabetical address book', async () => {
    const out = structured<{ items: Array<{ displayName: string }> }>(
      await ctx.client.callTool({
        name: 'contacts_list',
        arguments: { sort: { field: 'displayName', direction: 'asc' } },
      }),
    );
    expect(out.items.map((i) => i.displayName)).toEqual([
      'Alice Chen',
      'Bob Patel',
      'Carla Mendes',
      'David O.',
      'Erin Kim',
    ]);
  });

  it('sort=favorite desc puts favorites first', async () => {
    const out = structured<{
      items: Array<{ id: string; favorite: boolean }>;
    }>(
      await ctx.client.callTool({
        name: 'contacts_list',
        arguments: { sort: { field: 'favorite', direction: 'desc' } },
      }),
    );
    expect(out.items[0]?.favorite).toBe(true);
    expect(out.items[1]?.favorite).toBe(true);
  });
});

describe('contacts MCP — validation', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('rejects an invalid tag pattern (uppercase) at the schema regex', async () => {
    // Tag "Pricing" — uppercase — fails the regex at the SDK's
    // permissive zod parse BEFORE reaching the handler. SDK surfaces
    // as isError:true rather than a JSON-RPC throw.
    const result = await ctx.client.callTool({
      name: 'contacts_create',
      arguments: {
        input: {
          displayName: 'bad tag',
          tags: ['Pricing'],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
    });
    expect(result.isError).toBe(true);
  });

  it('rejects a malformed email', async () => {
    const result = await ctx.client.callTool({
      name: 'contacts_create',
      arguments: {
        input: {
          displayName: 'bad email',
          email: 'definitely-not-an-email',
          favorite: false,
          tags: [],
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
    });
    expect(result.isError).toBe(true);
  });
});
