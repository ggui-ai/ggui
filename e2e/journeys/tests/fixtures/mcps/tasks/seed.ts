/**
 * Deterministic seed rows for the Tasks MCP fixture.
 *
 * Five rows spanning every `status` + every `priority` + both assigned
 * and unassigned + both dated and undated. Tests call
 * `store.reset(); store.seed(TASKS_SEED)` between cases.
 *
 * IDs are human-readable (`seed-task-1` …) so test assertions can refer
 * to them by name instead of fishing a UUID out of a response.
 */
import type { TaskEntity } from './schema.js';

/**
 * A fixed reference timestamp for all seed rows. Real tests use a
 * clock injector for anything dynamic; seeded rows keep their declared
 * timestamps so pagination cursors are reproducible.
 *
 * 2026-04-21T00:00:00.000Z — today (per session date), frozen.
 */
export const SEED_NOW = 1776556800000;

export const TASKS_SEED: readonly TaskEntity[] = [
  {
    id: 'seed-task-1',
    title: 'Ship Phase 5 OSS launch',
    status: 'doing',
    priority: 'high',
    assigneeId: 'alice',
    dueDate: '2026-04-30',
    linkedNoteId: null,
    createdAt: SEED_NOW - 4 * 86400_000,
    updatedAt: SEED_NOW - 1 * 86400_000,
  },
  {
    id: 'seed-task-2',
    title: 'Draft OSS announcement blog post',
    status: 'todo',
    priority: 'medium',
    assigneeId: 'alice',
    dueDate: '2026-05-05',
    linkedNoteId: 'note-announce',
    createdAt: SEED_NOW - 3 * 86400_000,
    updatedAt: SEED_NOW - 3 * 86400_000,
  },
  {
    id: 'seed-task-3',
    title: 'Review Q1 retrospective',
    status: 'done',
    priority: 'low',
    assigneeId: 'bob',
    dueDate: null,
    linkedNoteId: null,
    createdAt: SEED_NOW - 2 * 86400_000,
    updatedAt: SEED_NOW - 2 * 86400_000,
  },
  {
    id: 'seed-task-4',
    title: 'Unblock Phase 5 CI flake',
    status: 'blocked',
    priority: 'high',
    assigneeId: null,
    dueDate: '2026-04-25',
    linkedNoteId: null,
    createdAt: SEED_NOW - 1 * 86400_000,
    updatedAt: SEED_NOW - 1 * 86400_000,
  },
  {
    id: 'seed-task-5',
    title: 'Plan contacts MCP fixture',
    status: 'todo',
    priority: 'medium',
    assigneeId: null,
    dueDate: null,
    linkedNoteId: null,
    createdAt: SEED_NOW,
    updatedAt: SEED_NOW,
  },
];
