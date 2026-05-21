/**
 * Notes SharedHandler bundle — contract tests.
 *
 * Scope: prove the mount bundle from `./handlers.ts` surfaces the
 * exact 7-tool notes surface (same names, same order, same zod
 * shapes referentially) as the standalone `createNotesMcpServer` in
 * `./server.ts`, then smoke-test each handler's dispatch into the
 * `NotesStore`.
 *
 * Shape-parallel to `../tasks/handlers.test.ts` — drift between the
 * two surfaces fails loudly here so Contacts (Slice 6.3) can copy
 * the pattern without re-deriving parity rules.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { createNotesSharedHandlers } from './handlers.js';
import {
  notesAppendInputShape,
  notesAppendOutputShape,
  notesCreateInputShape,
  notesCreateOutputShape,
  notesDeleteInputShape,
  notesDeleteOutputShape,
  notesGetInputShape,
  notesGetOutputShape,
  notesListInputShape,
  notesListOutputShape,
  notesSearchInputShape,
  notesSearchOutputShape,
  notesUpdateInputShape,
  notesUpdateOutputShape,
} from './schema.js';
import { NOTES_TOOL_NAMES } from './server.js';
import { NotesStore } from './store.js';

const ctx: HandlerContext = { appId: 'builder', requestId: 'test' };

function makeStore(): NotesStore {
  // Monotonic clock — advance by 1s per call so two rows created in
  // the same test have distinct `createdAt` values. Default-sort
  // assertions (createdAt DESC) need this; a frozen clock would tie
  // every row and fall back to id ASC ordering, inverting the
  // semantic meaning of "reverse-chronological".
  let tick = 1_776_556_800_000;
  return new NotesStore({
    now: () => {
      const t = tick;
      tick += 1_000;
      return t;
    },
    generateId: (() => {
      let n = 0;
      return () => `new-${++n}`;
    })(),
  });
}

describe('createNotesSharedHandlers — tool surface parity', () => {
  it('returns exactly the 7 canonical tool names, in NOTES_TOOL_NAMES order', () => {
    const handlers = createNotesSharedHandlers({ store: makeStore() });
    expect(handlers.map((h) => h.name)).toEqual([...NOTES_TOOL_NAMES]);
  });

  it('every handler carries a non-empty title + description', () => {
    const handlers = createNotesSharedHandlers({ store: makeStore() });
    for (const h of handlers) {
      expect(h.title, `${h.name} title`).toBeTruthy();
      expect(h.description, `${h.name} description`).toBeTruthy();
    }
  });

  it('every handler declares a non-empty outputSchema — protects against the structuredContent-strip footgun', () => {
    // Documented silent-data-loss footgun: empty `outputSchema: {}`
    // silently strips structuredContent even when the handler returns
    // a populated object. This test pins the invariant at the fixture
    // boundary; the equivalent enforcement at `composeHandlersWithMounts`
    // lives in `packages/mcp-server/src/mcp-mounts.test.ts`.
    const handlers = createNotesSharedHandlers({ store: makeStore() });
    for (const h of handlers) {
      expect(
        Object.keys(h.outputSchema).length,
        `${h.name} declares an empty outputSchema`,
      ).toBeGreaterThan(0);
    }
  });

  it.each([
    ['notes_list', notesListInputShape, notesListOutputShape],
    ['notes_get', notesGetInputShape, notesGetOutputShape],
    ['notes_create', notesCreateInputShape, notesCreateOutputShape],
    ['notes_update', notesUpdateInputShape, notesUpdateOutputShape],
    ['notes_delete', notesDeleteInputShape, notesDeleteOutputShape],
    ['notes_search', notesSearchInputShape, notesSearchOutputShape],
    ['notes_append', notesAppendInputShape, notesAppendOutputShape],
  ])(
    'handler %s references the same raw-shape literals as the standalone MCP server',
    (name, inputShape, outputShape) => {
      const handlers = createNotesSharedHandlers({ store: makeStore() });
      const h = handlers.find((x) => x.name === name);
      expect(h).toBeDefined();
      expect(h?.inputSchema).toBe(inputShape);
      expect(h?.outputSchema).toBe(outputShape);
    },
  );
});

describe('createNotesSharedHandlers — dispatch into the store', () => {
  let store: NotesStore;
  let handlers: ReadonlyArray<
    ReturnType<typeof createNotesSharedHandlers>[number]
  >;

  beforeEach(() => {
    store = makeStore();
    handlers = createNotesSharedHandlers({ store });
  });

  function handler(name: string) {
    const h = handlers.find((x) => x.name === name);
    if (!h) throw new Error(`handler ${name} not found`);
    return h;
  }

  it('notes_create writes to the store and returns the new item', async () => {
    const out = (await handler('notes_create').handler(
      {
        input: {
          title: 'Slice 6.2 plan',
          body: 'Ship Notes mount via real ggui serve.',
          tags: ['planning'],
          pinned: false,
          linkedTaskIds: [],
        },
      },
      ctx,
    )) as {
      item: { id: string; title: string; body: string; tags: string[] };
    };
    expect(out.item.id).toBe('new-1');
    expect(out.item.title).toBe('Slice 6.2 plan');
    expect(out.item.body).toContain('Notes mount');
    expect(out.item.tags).toEqual(['planning']);
    expect(store.get('new-1')?.title).toBe('Slice 6.2 plan');
  });

  it('notes_list returns inserted items in reverse-chronological order', async () => {
    await handler('notes_create').handler(
      {
        input: { title: 'first', body: '', tags: [], pinned: false, linkedTaskIds: [] },
      },
      ctx,
    );
    await handler('notes_create').handler(
      {
        input: { title: 'second', body: '', tags: [], pinned: false, linkedTaskIds: [] },
      },
      ctx,
    );
    const out = (await handler('notes_list').handler({}, ctx)) as {
      items: Array<{ title: string }>;
    };
    // Default sort is createdAt DESC → latest first.
    expect(out.items.map((i) => i.title)).toEqual(['second', 'first']);
  });

  it('notes_get returns { item: null } for unknown ids — the not-found convention', async () => {
    const out = (await handler('notes_get').handler(
      { id: 'nope' },
      ctx,
    )) as { item: unknown };
    expect(out.item).toBeNull();
  });

  it('notes_delete returns { deleted: false } for unknown ids — idempotent', async () => {
    const out = (await handler('notes_delete').handler(
      { id: 'nope' },
      ctx,
    )) as { deleted: boolean };
    expect(out.deleted).toBe(false);
  });

  it('notes_update returns { item: null } for unknown ids', async () => {
    const out = (await handler('notes_update').handler(
      { id: 'nope', patch: { title: 'x' } },
      ctx,
    )) as { item: unknown };
    expect(out.item).toBeNull();
  });

  it('notes_append inserts a paragraph separator when body was non-empty', async () => {
    await handler('notes_create').handler(
      {
        input: {
          title: 'meeting',
          body: 'kicked off',
          tags: [],
          pinned: false,
          linkedTaskIds: [],
        },
      },
      ctx,
    );
    const out = (await handler('notes_append').handler(
      { id: 'new-1', markdown: 'follow-up sent' },
      ctx,
    )) as { item: { body: string } | null };
    expect(out.item?.body).toBe('kicked off\n\nfollow-up sent');
  });

  it('notes_search matches against titles OR bodies', async () => {
    await handler('notes_create').handler(
      {
        input: {
          title: 'alpha note',
          body: 'has nothing to do with pricing',
          tags: [],
          pinned: false,
          linkedTaskIds: [],
        },
      },
      ctx,
    );
    await handler('notes_create').handler(
      {
        input: {
          title: 'beta note',
          body: 'discusses pricing comparables at length',
          tags: [],
          pinned: false,
          linkedTaskIds: [],
        },
      },
      ctx,
    );
    const byBody = (await handler('notes_search').handler(
      { query: 'comparables' },
      ctx,
    )) as { items: Array<{ title: string }>; totalMatches: number };
    // Body-only match — the Tasks surface would miss this.
    expect(byBody.items.map((i) => i.title)).toEqual(['beta note']);
  });

  it('rejects unknown top-level fields via the strict-object re-parse', async () => {
    await expect(
      handler('notes_create').handler(
        {
          input: {
            title: 'x',
            body: '',
            tags: [],
            pinned: false,
            linkedTaskIds: [],
          },
          bogus: 1,
        },
        ctx,
      ),
    ).rejects.toThrow();
  });
});
