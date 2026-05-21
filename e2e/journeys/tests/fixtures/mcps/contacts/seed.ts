/**
 * Deterministic seed rows for the Contacts MCP fixture.
 *
 * Five rows spanning:
 *   - favorite vs not,
 *   - tags present vs empty,
 *   - full comms (email + phone + company) vs partial vs identity-only,
 *   - structured name (given + family) vs display-only,
 *   - linkedTaskIds / linkedNoteIds populated vs empty.
 *
 * Ids match the string keys used as `aboutContactId` in
 * `../notes/seed.ts` and as `assigneeId` in `../tasks/seed.ts`
 * (`alice`, `bob`, `carla`). Slice 6.4 composition will lean on these
 * conventional ids to join across fixtures without ever implementing FK
 * validation at the schema layer (strategy §18).
 *
 * `linkedTaskIds` / `linkedNoteIds` are already populated on a subset
 * of rows to prove the reverse cross-ref surface renders correctly
 * today, without the Slice 6.4 negotiator. `contacts_link` can toggle
 * entries; `notes_search` / `tasks_search` for `aboutContactId=<id>` on
 * the other fixtures recovers the same information from the opposite
 * direction. Parity is an invariant, not a constraint — this fixture
 * does NOT maintain it at write time (would be cross-MCP coupling;
 * composition is explicitly deferred).
 */
import type { ContactEntity } from './schema.js';

/**
 * 2026-04-21T00:00:00.000Z — today (per session date), frozen.
 * Shared shape with `../notes/seed.ts::SEED_NOW` +
 * `../tasks/seed.ts::SEED_NOW` so cross-fixture tests see a coherent
 * "today".
 */
export const SEED_NOW = 1776556800000;

export const CONTACTS_SEED: readonly ContactEntity[] = [
  {
    id: 'alice',
    displayName: 'Alice Chen',
    givenName: 'Alice',
    familyName: 'Chen',
    email: 'alice@example.com',
    phone: '+1-555-0123',
    company: 'Acme Corp',
    tags: ['coworker', 'pricing'],
    favorite: true,
    linkedTaskIds: ['seed-task-1', 'seed-task-2'], // reverse of task.assigneeId='alice'
    linkedNoteIds: ['seed-note-2'], // reverse of note.aboutContactId='alice'
    createdAt: SEED_NOW - 4 * 86400_000,
    updatedAt: SEED_NOW - 1 * 86400_000,
  },
  {
    id: 'bob',
    displayName: 'Bob Patel',
    givenName: 'Bob',
    familyName: 'Patel',
    email: 'bob@example.com',
    phone: null,
    company: 'Zenith Partners',
    tags: ['coworker'],
    favorite: false,
    linkedTaskIds: ['seed-task-3'], // reverse of task.assigneeId='bob'
    linkedNoteIds: [],
    createdAt: SEED_NOW - 3 * 86400_000,
    updatedAt: SEED_NOW - 3 * 86400_000,
  },
  {
    id: 'carla',
    displayName: 'Carla Mendes',
    givenName: 'Carla',
    familyName: 'Mendes',
    email: 'carla.mendes@example.com',
    phone: '+1-555-0456',
    company: null, // candidate, no current company
    tags: ['hiring'],
    favorite: false,
    linkedTaskIds: [],
    linkedNoteIds: ['seed-note-5'], // reverse of note.aboutContactId='carla'
    createdAt: SEED_NOW - 2 * 86400_000,
    updatedAt: SEED_NOW - 2 * 86400_000,
  },
  {
    id: 'seed-contact-4',
    displayName: 'David O.',
    givenName: null,
    familyName: null,
    email: null,
    phone: '+1-555-0789',
    company: 'Acme Corp',
    tags: [],
    favorite: false,
    linkedTaskIds: [],
    linkedNoteIds: [],
    createdAt: SEED_NOW - 1 * 86400_000,
    updatedAt: SEED_NOW - 1 * 86400_000,
  },
  {
    id: 'seed-contact-5',
    displayName: 'Erin Kim',
    givenName: 'Erin',
    familyName: 'Kim',
    email: 'erin@example.com',
    phone: null,
    company: null,
    tags: ['investor', 'pricing'],
    favorite: true,
    linkedTaskIds: [],
    linkedNoteIds: [],
    createdAt: SEED_NOW,
    updatedAt: SEED_NOW,
  },
];
