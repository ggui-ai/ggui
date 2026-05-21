/**
 * Direct store-level contract tests for the Tasks MCP fixture.
 *
 * Pure vitest (Lane 3 per strategy §4.3). No MCP wire involvement —
 * `server.test.ts` covers that. These tests pin the semantics the
 * store is responsible for: CRUD invariants, filter/sort composition,
 * cursor pagination correctness, search behavior, and the
 * `complete()` transition.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { TasksStore, TaskStoreError } from './store.js';
import { TASKS_SEED, SEED_NOW } from './seed.js';

function makeStore(opts: { now?: number; idPrefix?: string } = {}): TasksStore {
  const nowValue = opts.now ?? SEED_NOW;
  let counter = 0;
  return new TasksStore({
    filename: ':memory:',
    now: () => nowValue,
    generateId: () => `${opts.idPrefix ?? 'new-task'}-${++counter}`,
  });
}

describe('TasksStore — construction + reset/seed', () => {
  it('boots on a fresh :memory: db and exposes zero rows', () => {
    const store = makeStore();
    const { items, nextCursor } = store.list({});
    expect(items).toEqual([]);
    expect(nextCursor).toBeUndefined();
  });

  it('seed() bulk-inserts deterministic rows; list returns them', () => {
    const store = makeStore();
    store.seed(TASKS_SEED);
    const { items } = store.list({});
    expect(items).toHaveLength(TASKS_SEED.length);
    const titles = items.map((t) => t.title).sort();
    expect(titles).toContain('Ship Phase 5 OSS launch');
    expect(titles).toContain('Plan contacts MCP fixture');
  });

  it('reset() drops every row; seed again yields the same shape', () => {
    const store = makeStore();
    store.seed(TASKS_SEED);
    store.reset();
    expect(store.list({}).items).toEqual([]);
    store.seed(TASKS_SEED);
    expect(store.list({}).items).toHaveLength(TASKS_SEED.length);
  });
});

describe('TasksStore — create', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore();
  });

  it('applies defaults for optional fields', () => {
    const item = store.create({
      title: 'Write spec',
      status: 'todo',
      priority: 'medium',
    });
    expect(item).toMatchObject({
      title: 'Write spec',
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      dueDate: null,
      linkedNoteId: null,
    });
    expect(item.id).toBeTruthy();
    expect(item.createdAt).toBe(SEED_NOW);
    expect(item.updatedAt).toBe(SEED_NOW);
  });

  it('persists assigneeId, dueDate, and linkedNoteId when supplied', () => {
    const item = store.create({
      title: 'Ping Alice',
      status: 'doing',
      priority: 'high',
      assigneeId: 'alice',
      dueDate: '2026-05-10',
      linkedNoteId: 'note-99',
    });
    expect(item).toMatchObject({
      assigneeId: 'alice',
      dueDate: '2026-05-10',
      linkedNoteId: 'note-99',
      status: 'doing',
      priority: 'high',
    });
    const fetched = store.get(item.id);
    expect(fetched).toEqual(item);
  });
});

describe('TasksStore — get', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(TASKS_SEED);
  });

  it('returns the entity shape for a known id', () => {
    const t = store.get('seed-task-1');
    expect(t).not.toBeNull();
    expect(t?.title).toBe('Ship Phase 5 OSS launch');
  });

  it('returns null for unknown id', () => {
    expect(store.get('does-not-exist')).toBeNull();
  });
});

describe('TasksStore — update', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore({ now: SEED_NOW + 10_000 });
    store.seed(TASKS_SEED);
  });

  it('partial patch updates only listed fields + bumps updatedAt', () => {
    const before = store.get('seed-task-1')!;
    const after = store.update('seed-task-1', { title: 'Retitled' });
    expect(after).not.toBeNull();
    expect(after!.title).toBe('Retitled');
    expect(after!.status).toBe(before.status);
    expect(after!.priority).toBe(before.priority);
    expect(after!.updatedAt).toBe(SEED_NOW + 10_000);
    expect(after!.createdAt).toBe(before.createdAt);
  });

  it('null on nullable fields clears them', () => {
    const after = store.update('seed-task-2', {
      assigneeId: null,
      dueDate: null,
      linkedNoteId: null,
    });
    expect(after).not.toBeNull();
    expect(after!.assigneeId).toBeNull();
    expect(after!.dueDate).toBeNull();
    expect(after!.linkedNoteId).toBeNull();
  });

  it('returns null for unknown id without throwing', () => {
    expect(store.update('nope', { title: 'x' })).toBeNull();
  });
});

describe('TasksStore — delete', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(TASKS_SEED);
  });

  it('removes the row and returns true', () => {
    expect(store.delete('seed-task-1')).toBe(true);
    expect(store.get('seed-task-1')).toBeNull();
  });

  it('idempotent: returns false for unknown id', () => {
    expect(store.delete('nope')).toBe(false);
  });
});

describe('TasksStore — complete', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore({ now: SEED_NOW + 20_000 });
    store.seed(TASKS_SEED);
  });

  it('transitions a todo task to done', () => {
    const item = store.complete('seed-task-2');
    expect(item?.status).toBe('done');
    expect(item?.updatedAt).toBe(SEED_NOW + 20_000);
  });

  it('returns null for unknown id', () => {
    expect(store.complete('nope')).toBeNull();
  });
});

describe('TasksStore — list (filters + sort + cursor)', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(TASKS_SEED);
  });

  it('filters by status[]', () => {
    const out = store.list({ filter: { status: ['todo'] } });
    const titles = out.items.map((t) => t.title).sort();
    expect(titles).toEqual([
      'Draft OSS announcement blog post',
      'Plan contacts MCP fixture',
    ]);
  });

  it('filters by assigneeId', () => {
    const out = store.list({ filter: { assigneeId: 'alice' } });
    expect(out.items.map((t) => t.id).sort()).toEqual([
      'seed-task-1',
      'seed-task-2',
    ]);
  });

  it('filters by priority[] + status[] in composition', () => {
    const out = store.list({
      filter: { priority: ['high'], status: ['doing', 'blocked'] },
    });
    expect(out.items.map((t) => t.id).sort()).toEqual([
      'seed-task-1',
      'seed-task-4',
    ]);
  });

  it('filters by dueBefore — excludes tasks with no due date', () => {
    const out = store.list({ filter: { dueBefore: '2026-05-01' } });
    expect(out.items.map((t) => t.id).sort()).toEqual([
      'seed-task-1',
      'seed-task-4',
    ]);
  });

  it('sorts by priority desc (high → low) deterministically', () => {
    const out = store.list({
      sort: { field: 'priority', direction: 'desc' },
    });
    const priorities = out.items.map((t) => t.priority);
    // Two highs, two mediums, one low — order respects rank.
    expect(priorities).toEqual(['high', 'high', 'medium', 'medium', 'low']);
  });

  it('sorts by dueDate asc with NULLs last', () => {
    const out = store.list({ sort: { field: 'dueDate', direction: 'asc' } });
    const ids = out.items.map((t) => t.id);
    // 4 (04-25), 1 (04-30), 2 (05-05), then the two null-due rows.
    expect(ids.slice(0, 3)).toEqual([
      'seed-task-4',
      'seed-task-1',
      'seed-task-2',
    ]);
    expect(out.items.slice(3).every((t) => t.dueDate === null)).toBe(true);
  });

  it('cursor pagination returns stable pages without overlap or gap', () => {
    const first = store.list({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = store.list({
      limit: 2,
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeTruthy();

    const third = store.list({
      limit: 2,
      ...(second.nextCursor ? { cursor: second.nextCursor } : {}),
    });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeUndefined();

    const seenIds = [...first.items, ...second.items, ...third.items].map(
      (t) => t.id,
    );
    const unique = new Set(seenIds);
    expect(unique.size).toBe(TASKS_SEED.length);
  });

  it('rejects a malformed cursor with TaskStoreError', () => {
    expect(() => store.list({ cursor: 'not-a-cursor' })).toThrow(
      TaskStoreError,
    );
  });
});

describe('TasksStore — search', () => {
  let store: TasksStore;
  beforeEach(() => {
    store = makeStore();
    store.seed(TASKS_SEED);
  });

  it('matches case-insensitive substring on title', () => {
    const out = store.search({ query: 'phase 5' });
    expect(out.items.map((t) => t.id).sort()).toEqual([
      'seed-task-1',
      'seed-task-4',
    ]);
    expect(out.totalMatches).toBe(2);
  });

  it('composes with a status filter', () => {
    const out = store.search({
      query: 'phase 5',
      filter: { status: ['doing'] },
    });
    expect(out.items.map((t) => t.id)).toEqual(['seed-task-1']);
    expect(out.totalMatches).toBe(1);
  });

  it('empty match returns empty items + 0 totalMatches', () => {
    const out = store.search({ query: 'nothing-matches-this' });
    expect(out.items).toEqual([]);
    expect(out.totalMatches).toBe(0);
  });

  it('reports totalMatches bigger than items when limit trims', () => {
    // Every seed row contains no common substring bigger than the pool —
    // force a known 2-row match, cap at 1.
    const out = store.search({ query: 'phase 5', limit: 1 });
    expect(out.items).toHaveLength(1);
    expect(out.totalMatches).toBe(2);
  });
});
