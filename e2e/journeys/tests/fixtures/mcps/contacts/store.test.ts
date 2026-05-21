/**
 * Direct store-level contract tests for the Contacts MCP fixture.
 *
 * Pure vitest (Lane 3 per strategy §4.3). No MCP wire involvement —
 * `server.test.ts` covers that. These tests pin the semantics the
 * store is responsible for: CRUD invariants, tag-set canonicalisation,
 * filter/sort, cursor pagination, `link()` idempotent add/remove
 * semantics, and the tri-field search surface (displayName OR email OR
 * company) that differentiates Contacts from Notes + Tasks.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ContactsStore, ContactStoreError } from './store.js';
import { CONTACTS_SEED, SEED_NOW } from './seed.js';

function makeStore(opts: {
  now?: number;
  idPrefix?: string;
} = {}): ContactsStore {
  const nowValue = opts.now ?? SEED_NOW;
  let counter = 0;
  return new ContactsStore({
    filename: ':memory:',
    now: () => nowValue,
    generateId: () => `${opts.idPrefix ?? 'new-contact'}-${++counter}`,
  });
}

describe('ContactsStore — construction + reset/seed', () => {
  it('boots on a fresh :memory: db and exposes zero rows', () => {
    const store = makeStore();
    const { items, nextCursor } = store.list({});
    expect(items).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });

  it('seed() bulk-inserts deterministic rows; list returns them', () => {
    const store = makeStore();
    store.seed(CONTACTS_SEED);
    const { items } = store.list({});
    expect(items).toHaveLength(CONTACTS_SEED.length);
    const names = items.map((c) => c.displayName).sort();
    expect(names).toContain('Alice Chen');
    expect(names).toContain('Erin Kim');
  });

  it('reset() drops every row; seed again yields the same shape', () => {
    const store = makeStore();
    store.seed(CONTACTS_SEED);
    store.reset();
    expect(store.list({}).items).toEqual([]);
    store.seed(CONTACTS_SEED);
    expect(store.list({}).items).toHaveLength(CONTACTS_SEED.length);
  });

  it('seed() canonicalises tags (dedupe + sort) so downstream filter predicates stay stable', () => {
    const store = makeStore();
    store.seed([
      {
        id: 'raw-tags',
        displayName: 'raw-tags contact',
        givenName: null,
        familyName: null,
        email: null,
        phone: null,
        company: null,
        tags: ['pricing', 'pricing', 'alice'], // duplicate + unsorted
        favorite: false,
        linkedTaskIds: [],
        linkedNoteIds: [],
        createdAt: SEED_NOW,
        updatedAt: SEED_NOW,
      },
    ]);
    const got = store.get('raw-tags');
    expect(got?.tags).toEqual(['alice', 'pricing']);
  });

  it('seed() deduplicates linked ids while preserving insertion order', () => {
    const store = makeStore();
    store.seed([
      {
        id: 'raw-links',
        displayName: 'raw-links contact',
        givenName: null,
        familyName: null,
        email: null,
        phone: null,
        company: null,
        tags: [],
        favorite: false,
        // Duplicate 'b' should collapse; first-insertion order should
        // survive (a, b, c — NOT a, c, b).
        linkedTaskIds: ['a', 'b', 'a', 'c', 'b'],
        linkedNoteIds: [],
        createdAt: SEED_NOW,
        updatedAt: SEED_NOW,
      },
    ]);
    expect(store.get('raw-links')?.linkedTaskIds).toEqual(['a', 'b', 'c']);
  });
});

describe('ContactsStore — create', () => {
  let store: ContactsStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('applies defaults for optional fields', () => {
    const item = store.create({
      displayName: 'Just a Name',
      tags: [],
      favorite: false,
      linkedTaskIds: [],
      linkedNoteIds: [],
    });
    expect(item.id).toBe('new-contact-1');
    expect(item.displayName).toBe('Just a Name');
    expect(item.givenName).toBeNull();
    expect(item.familyName).toBeNull();
    expect(item.email).toBeNull();
    expect(item.phone).toBeNull();
    expect(item.company).toBeNull();
    expect(item.tags).toEqual([]);
    expect(item.favorite).toBe(false);
    expect(item.linkedTaskIds).toEqual([]);
    expect(item.linkedNoteIds).toEqual([]);
    expect(item.createdAt).toBe(SEED_NOW);
    expect(item.updatedAt).toBe(SEED_NOW);
  });

  it('stores structured + comms fields verbatim', () => {
    const item = store.create({
      displayName: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      email: 'jane@example.com',
      phone: '+1-555-0199',
      company: 'Acme',
      tags: [],
      favorite: true,
      linkedTaskIds: [],
      linkedNoteIds: [],
    });
    expect(item.email).toBe('jane@example.com');
    expect(item.phone).toBe('+1-555-0199');
    expect(item.company).toBe('Acme');
    expect(item.favorite).toBe(true);
  });

  it('canonicalises create-time tags', () => {
    const item = store.create({
      displayName: 'Tag wrangler',
      tags: ['beta', 'alpha', 'beta'], // duplicate + unsorted
      favorite: false,
      linkedTaskIds: [],
      linkedNoteIds: [],
    });
    expect(item.tags).toEqual(['alpha', 'beta']);
  });
});

describe('ContactsStore — update', () => {
  let store: ContactsStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(CONTACTS_SEED);
  });

  it('update() returns null for unknown id', () => {
    expect(store.update('nope', { displayName: 'x' })).toBeNull();
  });

  it('update() clears email when passed null', () => {
    const updated = store.update('alice', { email: null });
    expect(updated?.email).toBeNull();
  });

  it('update() preserves other nullable fields when only one is patched', () => {
    const updated = store.update('alice', { email: null });
    expect(updated?.phone).toBe('+1-555-0123'); // unchanged
    expect(updated?.company).toBe('Acme Corp'); // unchanged
  });

  it('update() whole-array-replaces tags (not merge)', () => {
    const updated = store.update('alice', { tags: ['vip'] });
    expect(updated?.tags).toEqual(['vip']);
  });

  it('update() whole-array-replaces linkedTaskIds (not merge)', () => {
    // alice starts with ['seed-task-1','seed-task-2']; a whole-array
    // replace should NOT merge.
    const updated = store.update('alice', { linkedTaskIds: ['brand-new'] });
    expect(updated?.linkedTaskIds).toEqual(['brand-new']);
  });
});

describe('ContactsStore — link (contacts_link)', () => {
  let store: ContactsStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(CONTACTS_SEED);
  });

  it('returns null for unknown id', () => {
    expect(store.link('nope', 'task', 'x', 'add')).toBeNull();
  });

  it('link kind=task op=add appends to linkedTaskIds', () => {
    const updated = store.link('bob', 'task', 'seed-task-4', 'add');
    // bob started with ['seed-task-3']; 'seed-task-4' appended.
    expect(updated?.linkedTaskIds).toEqual(['seed-task-3', 'seed-task-4']);
  });

  it('link kind=note op=add appends to linkedNoteIds (independent of tasks)', () => {
    const updated = store.link('bob', 'note', 'seed-note-99', 'add');
    // bob started with []; the target array was linkedNoteIds only.
    expect(updated?.linkedNoteIds).toEqual(['seed-note-99']);
    // The sibling linkedTaskIds array must be untouched by kind='note'.
    expect(updated?.linkedTaskIds).toEqual(['seed-task-3']);
  });

  it('link op=add is idempotent — re-adding the same id is a no-op', () => {
    const first = store.link('alice', 'task', 'seed-task-1', 'add');
    const second = store.link('alice', 'task', 'seed-task-1', 'add');
    expect(first?.linkedTaskIds).toEqual(second?.linkedTaskIds);
    expect(first?.updatedAt).toBe(second?.updatedAt);
  });

  it('link op=remove drops the id from the array', () => {
    const updated = store.link('alice', 'task', 'seed-task-1', 'remove');
    expect(updated?.linkedTaskIds).toEqual(['seed-task-2']);
  });

  it('link op=remove is tolerant — removing an absent id is a no-op', () => {
    const before = store.get('alice');
    const after = store.link('alice', 'note', 'does-not-exist', 'remove');
    expect(after?.linkedNoteIds).toEqual(before?.linkedNoteIds);
    expect(after?.updatedAt).toBe(before?.updatedAt);
  });

  it('effective add bumps updatedAt', () => {
    const store2 = new ContactsStore({
      filename: ':memory:',
      now: (() => {
        let tick = SEED_NOW;
        return () => {
          tick += 1_000;
          return tick;
        };
      })(),
      generateId: () => 'c1',
    });
    store2.seed(CONTACTS_SEED);
    const before = store2.get('bob');
    const after = store2.link('bob', 'task', 'brand-new', 'add');
    expect(after?.updatedAt).toBeGreaterThan(before!.updatedAt);
  });
});

describe('ContactsStore — list filter + sort', () => {
  let store: ContactsStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(CONTACTS_SEED);
  });

  it('filters by favorite=true', () => {
    const { items } = store.list({ filter: { favorite: true } });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(['alice', 'seed-contact-5']);
  });

  it('filters by a single tag', () => {
    const { items } = store.list({ filter: { tags: ['investor'] } });
    expect(items.map((c) => c.id)).toEqual(['seed-contact-5']);
  });

  it('filters by company (exact match)', () => {
    const { items } = store.list({ filter: { company: 'Acme Corp' } });
    expect(items.map((c) => c.id).sort()).toEqual(['alice', 'seed-contact-4']);
  });

  it('filters by hasEmail=false — contacts without an email', () => {
    const { items } = store.list({ filter: { hasEmail: false } });
    // seed-contact-4 has no email.
    expect(items.map((c) => c.id)).toEqual(['seed-contact-4']);
  });

  it('filters by hasPhone=false — contacts without a phone', () => {
    const { items } = store.list({ filter: { hasPhone: false } });
    const ids = items.map((c) => c.id).sort();
    // bob, seed-contact-5 have no phone.
    expect(ids).toEqual(['bob', 'seed-contact-5']);
  });

  it('default sort is createdAt ASC (oldest first, natural address-book order)', () => {
    const { items } = store.list({});
    // Seeded timestamps: alice (-4d) < bob (-3d) < carla (-2d) <
    // seed-contact-4 (-1d) < seed-contact-5 (today).
    expect(items.map((c) => c.id)).toEqual([
      'alice',
      'bob',
      'carla',
      'seed-contact-4',
      'seed-contact-5',
    ]);
  });

  it('sort=displayName asc — alphabetical', () => {
    const { items } = store.list({
      sort: { field: 'displayName', direction: 'asc' },
    });
    expect(items.map((c) => c.displayName)).toEqual([
      'Alice Chen',
      'Bob Patel',
      'Carla Mendes',
      'David O.',
      'Erin Kim',
    ]);
  });

  it('sort=favorite desc — favorites first, then alphabetical within buckets', () => {
    const { items } = store.list({
      sort: { field: 'favorite', direction: 'desc' },
    });
    // Favorites by displayName ASC: Alice Chen, Erin Kim.
    // Non-favorites by displayName ASC: Bob Patel, Carla Mendes, David O.
    expect(items.map((c) => c.id)).toEqual([
      'alice',
      'seed-contact-5',
      'bob',
      'carla',
      'seed-contact-4',
    ]);
  });
});

describe('ContactsStore — search (tri-field: displayName OR email OR company)', () => {
  let store: ContactsStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(CONTACTS_SEED);
  });

  it('matches against displayName', () => {
    const { items } = store.search({ query: 'Alice' });
    expect(items.map((c) => c.id)).toContain('alice');
  });

  it('matches against email only — a displayName-less email search still hits', () => {
    const { items } = store.search({ query: 'carla.mendes@' });
    // carla's displayName "Carla Mendes" also matches via NOCASE on
    // "carla", so the asserting contract is: the row is returned.
    // Scope the assertion to avoid false-positives on an unrelated
    // text: we pick a uniquely-email substring.
    expect(items.map((c) => c.id)).toEqual(['carla']);
  });

  it('matches against company only — neither name nor email share the query', () => {
    const { items } = store.search({ query: 'Zenith' });
    // Only bob's company is 'Zenith Partners'. His name "Bob Patel"
    // and email "bob@example.com" contain no "Zenith".
    expect(items.map((c) => c.id)).toEqual(['bob']);
  });

  it('case-insensitive', () => {
    const up = store.search({ query: 'ACME' });
    const lo = store.search({ query: 'acme' });
    expect(up.totalMatches).toBe(lo.totalMatches);
    expect(up.totalMatches).toBeGreaterThan(0);
  });

  it('composes with tag filter', () => {
    const { items } = store.search({
      query: 'Alice',
      filter: { tags: ['pricing'] },
    });
    // Alice carries the 'pricing' tag; Erin Kim does too but her
    // displayName lacks "Alice".
    expect(items.map((c) => c.id)).toEqual(['alice']);
  });

  it('composes with hasEmail filter', () => {
    const { items } = store.search({
      query: 'Acme Corp',
      filter: { hasEmail: true },
    });
    // Both alice + seed-contact-4 work at Acme Corp, but only alice
    // has an email on file.
    expect(items.map((c) => c.id)).toEqual(['alice']);
  });

  it('returns empty + totalMatches=0 when nothing matches', () => {
    const out = store.search({ query: 'zzz-no-such-person' });
    expect(out.items).toEqual([]);
    expect(out.totalMatches).toBe(0);
  });
});

describe('ContactsStore — delete + invalid cursor', () => {
  let store: ContactsStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(CONTACTS_SEED);
  });

  it('delete() returns true on existing row, false on unknown (idempotent)', () => {
    expect(store.delete('alice')).toBe(true);
    expect(store.delete('alice')).toBe(false);
    expect(store.delete('nope')).toBe(false);
  });

  it('list() with a malformed cursor throws ContactStoreError', () => {
    expect(() => store.list({ cursor: 'not-base64-json' })).toThrow(
      ContactStoreError,
    );
  });
});
