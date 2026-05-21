/**
 * Tasks SharedHandler bundle — contract tests.
 *
 * Scope: prove the mount bundle from `./handlers.ts` surfaces the
 * exact 7-tool tasks surface (same names, same order, same zod shapes
 * referentially) as the standalone `createTasksMcpServer` in
 * `./server.ts`, then smoke-test each handler's dispatch into the
 * `TasksStore`.
 *
 * Any drift between the two surfaces fails loudly here so future
 * Notes/Contacts mount work can copy the pattern without re-deriving
 * the parity rules.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { createTasksSharedHandlers } from './handlers.js';
import {
  tasksCompleteInputShape,
  tasksCompleteOutputShape,
  tasksCreateInputShape,
  tasksCreateOutputShape,
  tasksDeleteInputShape,
  tasksDeleteOutputShape,
  tasksGetInputShape,
  tasksGetOutputShape,
  tasksListInputShape,
  tasksListOutputShape,
  tasksSearchInputShape,
  tasksSearchOutputShape,
  tasksUpdateInputShape,
  tasksUpdateOutputShape,
} from './schema.js';
import { TASKS_TOOL_NAMES } from './server.js';
import { TasksStore } from './store.js';

const ctx: HandlerContext = { appId: 'builder', requestId: 'test' };

function makeStore(): TasksStore {
  return new TasksStore({
    now: () => 1_776_556_800_000,
    generateId: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
  });
}

describe('createTasksSharedHandlers — tool surface parity', () => {
  it('returns exactly the 7 canonical tool names, in TASKS_TOOL_NAMES order', () => {
    const handlers = createTasksSharedHandlers({ store: makeStore() });
    expect(handlers.map((h) => h.name)).toEqual([...TASKS_TOOL_NAMES]);
  });

  it('every handler carries a non-empty title + description', () => {
    const handlers = createTasksSharedHandlers({ store: makeStore() });
    for (const h of handlers) {
      expect(h.title, `${h.name} title`).toBeTruthy();
      expect(h.description, `${h.name} description`).toBeTruthy();
    }
  });

  it.each([
    ['tasks_list', tasksListInputShape, tasksListOutputShape],
    ['tasks_get', tasksGetInputShape, tasksGetOutputShape],
    ['tasks_create', tasksCreateInputShape, tasksCreateOutputShape],
    ['tasks_update', tasksUpdateInputShape, tasksUpdateOutputShape],
    ['tasks_delete', tasksDeleteInputShape, tasksDeleteOutputShape],
    ['tasks_search', tasksSearchInputShape, tasksSearchOutputShape],
    ['tasks_complete', tasksCompleteInputShape, tasksCompleteOutputShape],
  ])(
    'handler %s references the same raw-shape literals as the standalone MCP server',
    (name, inputShape, outputShape) => {
      const handlers = createTasksSharedHandlers({ store: makeStore() });
      const h = handlers.find((x) => x.name === name);
      expect(h).toBeDefined();
      // Referential equality — same shape literal used by ./server.ts,
      // so any drift would show up as a different import.
      expect(h?.inputSchema).toBe(inputShape);
      expect(h?.outputSchema).toBe(outputShape);
    },
  );
});

describe('createTasksSharedHandlers — dispatch into the store', () => {
  let store: TasksStore;
  let handlers: ReadonlyArray<ReturnType<typeof createTasksSharedHandlers>[number]>;

  beforeEach(() => {
    store = makeStore();
    handlers = createTasksSharedHandlers({ store });
  });

  function handler(name: string) {
    const h = handlers.find((x) => x.name === name);
    if (!h) throw new Error(`handler ${name} not found`);
    return h;
  }

  it('tasks_create writes to the store and returns the new item', async () => {
    const out = (await handler('tasks_create').handler(
      { input: { title: 'ship slice 6' } },
      ctx,
    )) as { item: { id: string; title: string; status: string } };
    expect(out.item.id).toBe('new-1');
    expect(out.item.title).toBe('ship slice 6');
    expect(out.item.status).toBe('todo');
    // Observable in the store.
    expect(store.get('new-1')?.title).toBe('ship slice 6');
  });

  it('tasks_list returns inserted items', async () => {
    await handler('tasks_create').handler(
      { input: { title: 'task 1' } },
      ctx,
    );
    await handler('tasks_create').handler(
      { input: { title: 'task 2' } },
      ctx,
    );
    const out = (await handler('tasks_list').handler({}, ctx)) as {
      items: Array<{ title: string }>;
    };
    expect(out.items.map((i) => i.title)).toEqual(['task 1', 'task 2']);
  });

  it('tasks_get returns { item: null } for unknown ids — the not-found convention', async () => {
    const out = (await handler('tasks_get').handler(
      { id: 'nope' },
      ctx,
    )) as { item: unknown };
    expect(out.item).toBeNull();
  });

  it('tasks_delete returns { deleted: false } for unknown ids — idempotent', async () => {
    const out = (await handler('tasks_delete').handler(
      { id: 'nope' },
      ctx,
    )) as { deleted: boolean };
    expect(out.deleted).toBe(false);
  });

  it('tasks_update returns { item: null } for unknown ids', async () => {
    const out = (await handler('tasks_update').handler(
      { id: 'nope', patch: { title: 'x' } },
      ctx,
    )) as { item: unknown };
    expect(out.item).toBeNull();
  });

  it('tasks_complete flips status to done', async () => {
    await handler('tasks_create').handler(
      { input: { title: 'work' } },
      ctx,
    );
    const out = (await handler('tasks_complete').handler(
      { id: 'new-1' },
      ctx,
    )) as { item: { status: string } | null };
    expect(out.item?.status).toBe('done');
  });

  it('tasks_search matches by title substring', async () => {
    await handler('tasks_create').handler(
      { input: { title: 'alpha task' } },
      ctx,
    );
    await handler('tasks_create').handler(
      { input: { title: 'beta task' } },
      ctx,
    );
    const out = (await handler('tasks_search').handler(
      { query: 'alpha' },
      ctx,
    )) as { items: Array<{ title: string }>; totalMatches: number };
    expect(out.totalMatches).toBe(1);
    expect(out.items.map((i) => i.title)).toEqual(['alpha task']);
  });

  it('rejects unknown top-level fields via the strict-object re-parse', async () => {
    await expect(
      handler('tasks_create').handler(
        { input: { title: 'x' }, bogus: 1 },
        ctx,
      ),
    ).rejects.toThrow();
  });
});
