/**
 * Direct store-level contract tests for the Notes MCP fixture.
 *
 * Pure vitest (Lane 3 per strategy §4.3). No MCP wire involvement —
 * `server.test.ts` covers that. These tests pin the semantics the
 * store is responsible for: CRUD invariants, tag-set composition,
 * filter/sort, cursor pagination, `appendBody` paragraph semantics,
 * and the title-OR-body search surface that differentiates Notes
 * from Tasks.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { NotesStore, NoteStoreError } from './store.js';
import { NOTES_SEED, SEED_NOW } from './seed.js';

function makeStore(opts: { now?: number; idPrefix?: string } = {}): NotesStore {
  const nowValue = opts.now ?? SEED_NOW;
  let counter = 0;
  return new NotesStore({
    filename: ':memory:',
    now: () => nowValue,
    generateId: () => `${opts.idPrefix ?? 'new-note'}-${++counter}`,
  });
}

describe('NotesStore — construction + reset/seed', () => {
  it('boots on a fresh :memory: db and exposes zero rows', () => {
    const store = makeStore();
    const { items, nextCursor } = store.list({});
    expect(items).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });

  it('seed() bulk-inserts deterministic rows; list returns them', () => {
    const store = makeStore();
    store.seed(NOTES_SEED);
    const { items } = store.list({});
    expect(items).toHaveLength(NOTES_SEED.length);
    const titles = items.map((n) => n.title).sort();
    expect(titles).toContain('Alice 1:1 notes');
    expect(titles).toContain('Pricing research');
  });

  it('reset() drops every row; seed again yields the same shape', () => {
    const store = makeStore();
    store.seed(NOTES_SEED);
    store.reset();
    expect(store.list({}).items).toEqual([]);
    store.seed(NOTES_SEED);
    expect(store.list({}).items).toHaveLength(NOTES_SEED.length);
  });

  it('seed() canonicalises tags (dedupe + sort) so downstream filter predicates stay stable', () => {
    const store = makeStore();
    store.seed([
      {
        id: 'raw-tags',
        title: 'raw-tags',
        body: '',
        tags: ['pricing', 'pricing', 'alice'], // duplicate + unsorted
        pinned: false,
        aboutContactId: null,
        linkedTaskIds: [],
        createdAt: SEED_NOW,
        updatedAt: SEED_NOW,
      },
    ]);
    const got = store.get('raw-tags');
    expect(got?.tags).toEqual(['alice', 'pricing']);
  });
});

describe('NotesStore — create', () => {
  let store: NotesStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('applies defaults for optional fields', () => {
    const item = store.create({
      title: 'Check pricing comps',
      body: '',
      tags: [],
      pinned: false,
      linkedTaskIds: [],
    });
    expect(item.id).toBe('new-note-1');
    expect(item.body).toBe('');
    expect(item.tags).toEqual([]);
    expect(item.pinned).toBe(false);
    expect(item.aboutContactId).toBeNull();
    expect(item.linkedTaskIds).toEqual([]);
    expect(item.createdAt).toBe(SEED_NOW);
    expect(item.updatedAt).toBe(SEED_NOW);
  });

  it('stores body markdown verbatim', () => {
    const markdown =
      '## Plan\n\n- first\n- second\n\n```ts\nconsole.log("hello");\n```';
    const item = store.create({
      title: 'Release plan',
      body: markdown,
      tags: [],
      pinned: false,
      linkedTaskIds: [],
    });
    expect(item.body).toBe(markdown);
    expect(store.get(item.id)?.body).toBe(markdown);
  });

  it('canonicalises create-time tags', () => {
    const item = store.create({
      title: 'Tag wrangling',
      body: '',
      tags: ['beta', 'alpha', 'beta'], // duplicate + unsorted
      pinned: false,
      linkedTaskIds: [],
    });
    expect(item.tags).toEqual(['alpha', 'beta']);
  });
});

describe('NotesStore — update + appendBody', () => {
  let store: NotesStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(NOTES_SEED);
  });

  it('update() returns null for unknown id', () => {
    expect(store.update('nope', { title: 'x' })).toBeNull();
  });

  it('update() replaces body wholesale (NOT append)', () => {
    const updated = store.update('seed-note-1', { body: 'replaced' });
    expect(updated?.body).toBe('replaced');
  });

  it('update() clears aboutContactId when passed null', () => {
    const updated = store.update('seed-note-2', { aboutContactId: null });
    expect(updated?.aboutContactId).toBeNull();
  });

  it('update() whole-array-replaces tags (not merge)', () => {
    const updated = store.update('seed-note-1', { tags: ['announcement'] });
    expect(updated?.tags).toEqual(['announcement']);
  });

  it('appendBody() returns null for unknown id', () => {
    expect(store.appendBody('nope', 'x')).toBeNull();
  });

  it('appendBody() inserts a blank-line paragraph separator when body is non-empty', () => {
    const existing = store.get('seed-note-2');
    expect(existing?.body.length).toBeGreaterThan(0);
    const appended = store.appendBody(
      'seed-note-2',
      'Follow-up sent 2026-04-22.',
    );
    // Body = old + "\n\n" + new
    expect(appended?.body).toBe(
      `${existing!.body}\n\nFollow-up sent 2026-04-22.`,
    );
  });

  it('appendBody() sets body directly when the note had an empty body', () => {
    const empty = store.get('seed-note-3');
    expect(empty?.body).toBe('');
    const appended = store.appendBody('seed-note-3', 'Step 1: intro screen.');
    expect(appended?.body).toBe('Step 1: intro screen.');
  });
});

describe('NotesStore — list filter + sort', () => {
  let store: NotesStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(NOTES_SEED);
  });

  it('filters by pinned=true', () => {
    const { items } = store.list({ filter: { pinned: true } });
    const titles = items.map((n) => n.title).sort();
    expect(titles).toEqual(['Phase 5 launch announcement', 'Pricing research']);
  });

  it('filters by a single tag — returns every note carrying it', () => {
    const { items } = store.list({ filter: { tags: ['alice'] } });
    expect(items.map((n) => n.id)).toEqual(['seed-note-2']);
  });

  it('filters by aboutContactId', () => {
    const { items } = store.list({ filter: { aboutContactId: 'carla' } });
    expect(items.map((n) => n.id)).toEqual(['seed-note-5']);
  });

  it('sorts by updatedAt desc by default when no sort supplied', () => {
    const { items } = store.list({});
    // Default order is createdAt DESC (fallback branch). Confirm
    // deterministic ordering vs the seed.
    const ids = items.map((n) => n.id);
    // Seeded newest first (createdAt ordering: 5 > 4 > 3 > 2 > 1).
    expect(ids).toEqual([
      'seed-note-5',
      'seed-note-4',
      'seed-note-3',
      'seed-note-2',
      'seed-note-1',
    ]);
  });

  it('sorts by pinned=desc (pinned-first), then most-recent within buckets', () => {
    const { items } = store.list({
      sort: { field: 'pinned', direction: 'desc' },
    });
    // Pinned first: note-4 (most recent pinned), note-1 (older pinned).
    // Then unpinned by updated_at DESC: 5, 3, 2.
    expect(items.map((n) => n.id)).toEqual([
      'seed-note-4',
      'seed-note-1',
      'seed-note-5',
      'seed-note-3',
      'seed-note-2',
    ]);
  });
});

describe('NotesStore — search', () => {
  let store: NotesStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(NOTES_SEED);
  });

  it('matches against titles', () => {
    const { items, totalMatches } = store.search({ query: 'pricing' });
    // seed-note-4 title "Pricing research"
    const ids = items.map((n) => n.id);
    expect(ids).toContain('seed-note-4');
    expect(totalMatches).toBeGreaterThan(0);
  });

  it('matches against bodies — the key Notes-vs-Tasks differentiator', () => {
    const { items } = store.search({ query: 'reference check' });
    // Only matches seed-note-5's body; title has no such phrase.
    expect(items.map((n) => n.id)).toEqual(['seed-note-5']);
  });

  it('case-insensitive', () => {
    const byUpper = store.search({ query: 'LINEAR' });
    const byLower = store.search({ query: 'linear' });
    expect(byUpper.totalMatches).toBe(byLower.totalMatches);
    expect(byUpper.totalMatches).toBeGreaterThan(0);
  });

  it('composes with tag filter', () => {
    // "launch" is the only note with the launch tag; it mentions
    // "blog post" in the body.
    const { items } = store.search({
      query: 'blog',
      filter: { tags: ['launch'] },
    });
    expect(items.map((n) => n.id)).toEqual(['seed-note-1']);
  });

  it('returns empty result + totalMatches 0 when nothing matches', () => {
    const out = store.search({ query: 'zzz-no-such-content' });
    expect(out.items).toEqual([]);
    expect(out.totalMatches).toBe(0);
  });
});

describe('NotesStore — delete + invalid cursor', () => {
  let store: NotesStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(NOTES_SEED);
  });

  it('delete() returns true on existing row, false on unknown (idempotent)', () => {
    expect(store.delete('seed-note-1')).toBe(true);
    expect(store.delete('seed-note-1')).toBe(false);
    expect(store.delete('nope')).toBe(false);
  });

  it('list() with a malformed cursor throws NoteStoreError', () => {
    expect(() => store.list({ cursor: 'not-base64-json' })).toThrow(
      NoteStoreError,
    );
  });
});
