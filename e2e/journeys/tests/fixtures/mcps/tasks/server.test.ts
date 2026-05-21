/**
 * MCP wire-level contract tests for the Tasks MCP fixture.
 *
 * Boots `createTasksMcpServer` over `InMemoryTransport`, connects a
 * real `Client`, and exercises every tool via `client.callTool()`. The
 * intent is to pin the contract at the MCP protocol boundary:
 *
 *   - `tools/list` surfaces every tool with the declared name.
 *   - Invalid inputs (unknown fields, wrong shape, out-of-enum) fail
 *     as JSON-RPC errors.
 *   - Valid inputs produce `structuredContent` matching the
 *     outputSchema.
 *   - Domain invariants survive the wire (e.g. `tasks_delete` is
 *     idempotent, `tasks_get` on unknown id returns `item: null`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { connectMcpInMemory } from '../_shared/mcp-test-client.js';
import { createTasksMcpServer, TASKS_TOOL_NAMES } from './server.js';
import { TasksStore } from './store.js';
import { TASKS_SEED, SEED_NOW } from './seed.js';

/**
 * The MCP SDK's `registerTool` runs the declared `inputSchema` zod
 * parse inside the transport layer and surfaces a failure as a
 * `{ isError: true, content: [...] }` tool result — NOT a thrown
 * JSON-RPC error. Contract tests for "invalid input" therefore
 * assert on that shape: `isError === true` + an error message body
 * that names the violating field/rule.
 */
async function expectInputValidationError(
  callToolPromise: ReturnType<Client['callTool']>,
  messageFragment: string,
): Promise<void> {
  const result = await callToolPromise;
  expect(result.isError, 'expected isError:true tool result').toBe(true);
  const text = Array.isArray(result.content)
    ? result.content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String(c.text) : ''))
        .join('\n')
    : '';
  expect(text).toContain(messageFragment);
}

interface Ctx {
  store: TasksStore;
  client: Client;
  close: () => Promise<void>;
}

async function boot(opts: { seeded?: boolean } = {}): Promise<Ctx> {
  let counter = 0;
  const store = new TasksStore({
    filename: ':memory:',
    now: () => SEED_NOW + 1_000,
    generateId: () => `new-task-${++counter}`,
  });
  if (opts.seeded ?? true) {
    store.seed(TASKS_SEED);
  }
  const server = createTasksMcpServer({ store });
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

describe('tasks MCP — tools/list', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('surfaces all seven canonical tools with the locked names', async () => {
    const { tools } = await ctx.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TASKS_TOOL_NAMES].sort());
  });

  it('each tool declares non-empty description + inputSchema + outputSchema', async () => {
    const { tools } = await ctx.client.listTools();
    for (const t of tools) {
      expect(t.description, `${t.name} description`).toBeTruthy();
      expect(t.inputSchema, `${t.name} inputSchema`).toBeTruthy();
      expect(t.outputSchema, `${t.name} outputSchema`).toBeTruthy();
    }
  });
});

describe('tasks MCP — tasks_list', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('returns the full seed set with items + no cursor', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_list',
      arguments: {},
    });
    const out = structured<{ items: unknown[]; nextCursor?: string }>(result);
    expect(out.items).toHaveLength(TASKS_SEED.length);
    expect(out.nextCursor).toBeUndefined();
  });

  it('filter.status narrows results', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_list',
      arguments: { filter: { status: ['todo'] } },
    });
    const out = structured<{ items: { id: string }[] }>(result);
    expect(out.items.map((t) => t.id).sort()).toEqual([
      'seed-task-2',
      'seed-task-5',
    ]);
  });

  it('strips unknown top-level fields before the handler runs (MCP SDK default)', async () => {
    // The MCP SDK wraps `inputSchema` in a non-strict `z.object` and
    // strips unknowns before the handler sees them. That's a real
    // contract of the wire today — documenting it here so a future
    // SDK upgrade that flips the default (or our own wrap) surfaces
    // as a visible test failure. Schema-STRICTNESS comes from the
    // field-level validators (string-min, enum, date-regex, …),
    // which is what the other negative-path tests cover.
    const result = await ctx.client.callTool({
      name: 'tasks_list',
      arguments: { bogusField: 123 },
    });
    const out = structured<{ items: unknown[] }>(result);
    expect(out.items).toHaveLength(TASKS_SEED.length);
  });

  it('rejects out-of-enum status in filter', async () => {
    await expectInputValidationError(
      ctx.client.callTool({
        name: 'tasks_list',
        arguments: { filter: { status: ['wat'] } },
      }),
      'filter',
    );
  });
});

describe('tasks MCP — tasks_get', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('returns the entity for a known id', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_get',
      arguments: { id: 'seed-task-1' },
    });
    const out = structured<{ item: { title: string; status: string } | null }>(
      result,
    );
    expect(out.item?.title).toBe('Ship Phase 5 OSS launch');
    expect(out.item?.status).toBe('doing');
  });

  it('returns item: null for unknown id', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_get',
      arguments: { id: 'nope' },
    });
    const out = structured<{ item: null }>(result);
    expect(out.item).toBeNull();
  });

  it('rejects missing id', async () => {
    await expectInputValidationError(
      ctx.client.callTool({ name: 'tasks_get', arguments: {} }),
      'id',
    );
  });
});

describe('tasks MCP — tasks_create', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot({ seeded: false });
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('creates with defaults and returns the full entity', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_create',
      arguments: { input: { title: 'Ship Phase 6' } },
    });
    const out = structured<{ item: { title: string; status: string; priority: string; id: string } }>(result);
    expect(out.item.title).toBe('Ship Phase 6');
    expect(out.item.status).toBe('todo');
    expect(out.item.priority).toBe('medium');
    expect(out.item.id).toBe('new-task-1');
  });

  it('persists nullable fields when supplied', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_create',
      arguments: {
        input: {
          title: 'Call Alice',
          status: 'doing',
          priority: 'high',
          assigneeId: 'alice',
          dueDate: '2026-05-20',
          linkedNoteId: 'note-call',
        },
      },
    });
    const out = structured<{
      item: {
        assigneeId: string | null;
        dueDate: string | null;
        linkedNoteId: string | null;
      };
    }>(result);
    expect(out.item.assigneeId).toBe('alice');
    expect(out.item.dueDate).toBe('2026-05-20');
    expect(out.item.linkedNoteId).toBe('note-call');
  });

  it('rejects invalid dueDate format', async () => {
    await expectInputValidationError(
      ctx.client.callTool({
        name: 'tasks_create',
        arguments: { input: { title: 'Bad date', dueDate: 'not-a-date' } },
      }),
      'dueDate',
    );
  });
});

describe('tasks MCP — tasks_update', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('applies a partial patch and returns the updated entity', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_update',
      arguments: { id: 'seed-task-1', patch: { priority: 'low' } },
    });
    const out = structured<{ item: { priority: string; title: string } | null }>(
      result,
    );
    expect(out.item?.priority).toBe('low');
    expect(out.item?.title).toBe('Ship Phase 5 OSS launch');
  });

  it('returns item: null for unknown id', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_update',
      arguments: { id: 'nope', patch: { title: 'x' } },
    });
    const out = structured<{ item: null }>(result);
    expect(out.item).toBeNull();
  });

  it('rejects an empty patch', async () => {
    await expectInputValidationError(
      ctx.client.callTool({
        name: 'tasks_update',
        arguments: { id: 'seed-task-1', patch: {} },
      }),
      'Patch must include at least one field',
    );
  });
});

describe('tasks MCP — tasks_delete', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('deletes a known row and returns deleted:true', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_delete',
      arguments: { id: 'seed-task-1' },
    });
    const out = structured<{ deleted: boolean }>(result);
    expect(out.deleted).toBe(true);
    expect(ctx.store.get('seed-task-1')).toBeNull();
  });

  it('is idempotent: unknown id returns deleted:false', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_delete',
      arguments: { id: 'nope' },
    });
    const out = structured<{ deleted: boolean }>(result);
    expect(out.deleted).toBe(false);
  });
});

describe('tasks MCP — tasks_search', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('returns case-insensitive title matches with totalMatches', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_search',
      arguments: { query: 'PHASE 5' },
    });
    const out = structured<{
      items: { id: string }[];
      totalMatches: number;
    }>(result);
    expect(out.items.map((t) => t.id).sort()).toEqual([
      'seed-task-1',
      'seed-task-4',
    ]);
    expect(out.totalMatches).toBe(2);
  });

  it('honors limit (items ≤ limit; totalMatches is unbounded)', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_search',
      arguments: { query: 'phase 5', limit: 1 },
    });
    const out = structured<{
      items: unknown[];
      totalMatches: number;
    }>(result);
    expect(out.items).toHaveLength(1);
    expect(out.totalMatches).toBe(2);
  });

  it('rejects empty query', async () => {
    await expectInputValidationError(
      ctx.client.callTool({
        name: 'tasks_search',
        arguments: { query: '' },
      }),
      'query',
    );
  });
});

describe('tasks MCP — tasks_complete', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await boot();
  });
  afterEach(async () => {
    await ctx.close();
  });

  it('transitions a task to status:done and echoes the updated entity', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_complete',
      arguments: { id: 'seed-task-2' },
    });
    const out = structured<{ item: { status: string; id: string } | null }>(
      result,
    );
    expect(out.item?.status).toBe('done');
    expect(out.item?.id).toBe('seed-task-2');
  });

  it('returns item: null for unknown id', async () => {
    const result = await ctx.client.callTool({
      name: 'tasks_complete',
      arguments: { id: 'nope' },
    });
    const out = structured<{ item: null }>(result);
    expect(out.item).toBeNull();
  });
});
