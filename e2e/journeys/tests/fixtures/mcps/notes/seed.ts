/**
 * Deterministic seed rows for the Notes MCP fixture.
 *
 * Five rows spanning:
 *   - pinned vs unpinned,
 *   - empty tags vs multi-tag,
 *   - body with content vs empty,
 *   - `aboutContactId` present vs null,
 *   - `linkedTaskIds[]` empty vs non-empty.
 *
 * Contacts (alice, bob, carla) are id-reference-by-convention —
 * matches `TASKS_SEED[0].assigneeId = 'alice'` so a future Contacts
 * fixture (Slice 6.3) can hit every link target without rewriting
 * the seed. Linked task ids (`seed-task-2`) similarly reference the
 * Tasks seed.
 */
import type { NoteEntity } from './schema.js';

/**
 * 2026-04-21T00:00:00.000Z — today (per session date), frozen.
 * Shared shape with `../tasks/seed.ts::SEED_NOW` so cross-fixture
 * tests see a coherent "today".
 */
export const SEED_NOW = 1776556800000;

export const NOTES_SEED: readonly NoteEntity[] = [
  {
    id: 'seed-note-1',
    title: 'Phase 5 launch announcement',
    body: '## Plan\n\n- Draft the blog post\n- Share in #launch-announcements\n- Schedule for 2026-05-05',
    tags: ['launch', 'marketing'],
    pinned: true,
    aboutContactId: null,
    linkedTaskIds: ['seed-task-2'],
    createdAt: SEED_NOW - 4 * 86400_000,
    updatedAt: SEED_NOW - 1 * 86400_000,
  },
  {
    id: 'seed-note-2',
    title: 'Alice 1:1 notes',
    body: 'Discussed Phase 5 scope + Q2 hiring plan. Follow-up: pair on rate-limiting review.',
    tags: ['1-1', 'alice'],
    pinned: false,
    aboutContactId: 'alice',
    linkedTaskIds: [],
    createdAt: SEED_NOW - 3 * 86400_000,
    updatedAt: SEED_NOW - 3 * 86400_000,
  },
  {
    id: 'seed-note-3',
    title: 'Onboarding walkthrough',
    body: '',
    tags: ['onboarding'],
    pinned: false,
    aboutContactId: null,
    linkedTaskIds: [],
    createdAt: SEED_NOW - 2 * 86400_000,
    updatedAt: SEED_NOW - 2 * 86400_000,
  },
  {
    id: 'seed-note-4',
    title: 'Pricing research',
    body: 'Collected comparables: Linear, Vercel v0, Cursor. Linear tiers at 8/16/28 per seat.',
    tags: ['pricing', 'research'],
    pinned: true,
    aboutContactId: null,
    linkedTaskIds: [],
    createdAt: SEED_NOW - 1 * 86400_000,
    // Bumped newer than seed-note-1's updatedAt so the
    // "pinned-first, then most-recent within bucket" sort has a
    // deterministic order. Staying within the same calendar day as
    // createdAt keeps the fixture narrative coherent ("I kept
    // adding comparables").
    updatedAt: SEED_NOW - 30 * 60_000,
  },
  {
    id: 'seed-note-5',
    title: 'Carla recruiting notes',
    body: '30m intro call. Strong on infra/k8s + LLM eval. Next step: reference check.',
    tags: ['hiring', 'carla'],
    pinned: false,
    aboutContactId: 'carla',
    linkedTaskIds: [],
    createdAt: SEED_NOW,
    updatedAt: SEED_NOW,
  },
];
