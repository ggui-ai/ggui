/**
 * Contacts SharedHandler bundle — contract tests.
 *
 * Scope: prove the mount bundle from `./handlers.ts` surfaces the
 * exact 7-tool contacts surface (same names, same order, same zod
 * shapes referentially) as the standalone `createContactsMcpServer`
 * in `./server.ts`, then smoke-test each handler's dispatch into the
 * `ContactsStore`.
 *
 * Shape-parallel to `../notes/handlers.test.ts`. Drift between the
 * two surfaces fails loudly here so the trio-locked pattern stays
 * reliable into Slice 6.4 composition.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { createContactsSharedHandlers } from './handlers.js';
import {
  contactsCreateInputShape,
  contactsCreateOutputShape,
  contactsDeleteInputShape,
  contactsDeleteOutputShape,
  contactsGetInputShape,
  contactsGetOutputShape,
  contactsLinkInputShape,
  contactsLinkOutputShape,
  contactsListInputShape,
  contactsListOutputShape,
  contactsSearchInputShape,
  contactsSearchOutputShape,
  contactsUpdateInputShape,
  contactsUpdateOutputShape,
} from './schema.js';
import { CONTACTS_TOOL_NAMES } from './server.js';
import { ContactsStore } from './store.js';

const ctx: HandlerContext = { appId: 'builder', requestId: 'test' };

function makeStore(): ContactsStore {
  // Monotonic clock — see notes/handlers.test.ts for rationale. A
  // frozen clock would collide on `createdAt` and make sort assertions
  // fall back to id order, inverting the semantic meaning.
  let tick = 1_776_556_800_000;
  return new ContactsStore({
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

describe('createContactsSharedHandlers — tool surface parity', () => {
  it('returns exactly the 7 canonical tool names, in CONTACTS_TOOL_NAMES order', () => {
    const handlers = createContactsSharedHandlers({ store: makeStore() });
    expect(handlers.map((h) => h.name)).toEqual([...CONTACTS_TOOL_NAMES]);
  });

  it('every handler carries a non-empty title + description', () => {
    const handlers = createContactsSharedHandlers({ store: makeStore() });
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
    const handlers = createContactsSharedHandlers({ store: makeStore() });
    for (const h of handlers) {
      expect(
        Object.keys(h.outputSchema).length,
        `${h.name} declares an empty outputSchema`,
      ).toBeGreaterThan(0);
    }
  });

  it.each([
    ['contacts_list', contactsListInputShape, contactsListOutputShape],
    ['contacts_get', contactsGetInputShape, contactsGetOutputShape],
    ['contacts_create', contactsCreateInputShape, contactsCreateOutputShape],
    ['contacts_update', contactsUpdateInputShape, contactsUpdateOutputShape],
    ['contacts_delete', contactsDeleteInputShape, contactsDeleteOutputShape],
    ['contacts_search', contactsSearchInputShape, contactsSearchOutputShape],
    ['contacts_link', contactsLinkInputShape, contactsLinkOutputShape],
  ])(
    'handler %s references the same raw-shape literals as the standalone MCP server',
    (name, inputShape, outputShape) => {
      const handlers = createContactsSharedHandlers({ store: makeStore() });
      const h = handlers.find((x) => x.name === name);
      expect(h).toBeDefined();
      expect(h?.inputSchema).toBe(inputShape);
      expect(h?.outputSchema).toBe(outputShape);
    },
  );
});

describe('createContactsSharedHandlers — dispatch into the store', () => {
  let store: ContactsStore;
  let handlers: ReadonlyArray<
    ReturnType<typeof createContactsSharedHandlers>[number]
  >;

  beforeEach(() => {
    store = makeStore();
    handlers = createContactsSharedHandlers({ store });
  });

  function handler(name: string) {
    const h = handlers.find((x) => x.name === name);
    if (!h) throw new Error(`handler ${name} not found`);
    return h;
  }

  it('contacts_create writes to the store and returns the new item', async () => {
    const out = (await handler('contacts_create').handler(
      {
        input: {
          displayName: 'Alice Chen',
          givenName: 'Alice',
          familyName: 'Chen',
          email: 'alice@example.com',
          tags: ['coworker'],
          favorite: true,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    )) as {
      item: {
        id: string;
        displayName: string;
        email: string | null;
        favorite: boolean;
        tags: string[];
      };
    };
    expect(out.item.id).toBe('new-1');
    expect(out.item.displayName).toBe('Alice Chen');
    expect(out.item.email).toBe('alice@example.com');
    expect(out.item.favorite).toBe(true);
    expect(out.item.tags).toEqual(['coworker']);
    expect(store.get('new-1')?.displayName).toBe('Alice Chen');
  });

  it('contacts_list returns inserted items in oldest-first chronological order', async () => {
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'first',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    );
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'second',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    );
    const out = (await handler('contacts_list').handler({}, ctx)) as {
      items: Array<{ displayName: string }>;
    };
    // Default sort is createdAt ASC → oldest first.
    expect(out.items.map((i) => i.displayName)).toEqual(['first', 'second']);
  });

  it('contacts_get returns { item: null } for unknown ids — the not-found convention', async () => {
    const out = (await handler('contacts_get').handler(
      { id: 'nope' },
      ctx,
    )) as { item: unknown };
    expect(out.item).toBeNull();
  });

  it('contacts_delete returns { deleted: false } for unknown ids — idempotent', async () => {
    const out = (await handler('contacts_delete').handler(
      { id: 'nope' },
      ctx,
    )) as { deleted: boolean };
    expect(out.deleted).toBe(false);
  });

  it('contacts_update returns { item: null } for unknown ids', async () => {
    const out = (await handler('contacts_update').handler(
      { id: 'nope', patch: { displayName: 'x' } },
      ctx,
    )) as { item: unknown };
    expect(out.item).toBeNull();
  });

  it('contacts_link op=add appends to linkedTaskIds via the handler', async () => {
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'link-target',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    );
    const out = (await handler('contacts_link').handler(
      {
        id: 'new-1',
        link: { kind: 'task', targetId: 'task-42', op: 'add' },
      },
      ctx,
    )) as { item: { linkedTaskIds: string[] } | null };
    expect(out.item?.linkedTaskIds).toEqual(['task-42']);
  });

  it('contacts_link op=remove drops the id from linkedNoteIds via the handler', async () => {
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'remove-target',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: ['note-1', 'note-2'],
        },
      },
      ctx,
    );
    const out = (await handler('contacts_link').handler(
      {
        id: 'new-1',
        link: { kind: 'note', targetId: 'note-1', op: 'remove' },
      },
      ctx,
    )) as { item: { linkedNoteIds: string[] } | null };
    expect(out.item?.linkedNoteIds).toEqual(['note-2']);
  });

  it('contacts_search matches across displayName OR email OR company', async () => {
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'Display-Only Person',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    );
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'Email-Bearing Record',
          email: 'acme-billing@example.com',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    );
    await handler('contacts_create').handler(
      {
        input: {
          displayName: 'Company-Bearing Record',
          company: 'AcmeCorp',
          tags: [],
          favorite: false,
          linkedTaskIds: [],
          linkedNoteIds: [],
        },
      },
      ctx,
    );
    // Query "acme" should match both the email-bearing and
    // company-bearing record (via their respective fields), NOT the
    // display-only one.
    const out = (await handler('contacts_search').handler(
      { query: 'acme' },
      ctx,
    )) as {
      items: Array<{ displayName: string }>;
      totalMatches: number;
    };
    const names = out.items.map((i) => i.displayName).sort();
    expect(names).toEqual(['Company-Bearing Record', 'Email-Bearing Record']);
    expect(out.totalMatches).toBe(2);
  });

  it('rejects unknown top-level fields via the strict-object re-parse', async () => {
    await expect(
      handler('contacts_create').handler(
        {
          input: {
            displayName: 'x',
            tags: [],
            favorite: false,
            linkedTaskIds: [],
            linkedNoteIds: [],
          },
          bogus: 1,
        },
        ctx,
      ),
    ).rejects.toThrow();
  });

  it('rejects an invalid email via the schema email() guard', async () => {
    await expect(
      handler('contacts_create').handler(
        {
          input: {
            displayName: 'x',
            email: 'not-an-email',
            tags: [],
            favorite: false,
            linkedTaskIds: [],
            linkedNoteIds: [],
          },
        },
        ctx,
      ),
    ).rejects.toThrow();
  });
});
