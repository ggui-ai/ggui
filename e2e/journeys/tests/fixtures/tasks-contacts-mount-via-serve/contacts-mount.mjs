/**
 * Contacts half of the Slice 6.4 two-MCP composition fixture.
 *
 * Pairs with `./tasks-mount.mjs` — both declared in
 * `./ggui.json#mcpMounts` so a single `ggui serve` process aggregates
 * both domains onto the same `/mcp` surface. First exercise of a
 * two-entry `mcpMounts` array over the real operator path.
 *
 * Tool surface: `contacts_list`, `contacts_get`, `contacts_link`.
 * Narrower than the full 7-tool TS Contacts fixture at
 * `../mcps/contacts/` — the composition proof only needs read + the
 * cross-ref mutation (`contacts_link`), not the full CRUD. The TS
 * fixture remains the source of truth for per-tool contract coverage.
 *
 * Seed alignment with `./tasks-mount.mjs`:
 *
 *   - `alice.linkedTaskIds = ['seed-task-1', 'seed-task-2']` — the
 *     exact task ids that carry `assigneeId = 'alice'` in the tasks
 *     mount. The composition spec asserts this bidirectional
 *     agreement (Task.assigneeId ↔ Contact.linkedTaskIds) holds on
 *     seed AND after a cross-MCP mutation.
 *   - `bob.linkedTaskIds = []` — an unlinked contact confirms the
 *     reverse-ref is empty when no task names this person.
 *
 * `contacts_link` is the Contacts-specific cross-ref management
 * tool (symmetric with Tasks' `tasks_complete` and Notes'
 * `notes_append`). Idempotent `add`/`remove` on `linkedTaskIds[]`
 * (kind='task') or `linkedNoteIds[]` (kind='note'). The spec uses
 * kind='task' only; notes cross-refs remain present in the schema
 * but dormant for this slice.
 */
import { z } from 'zod';

const ContactItem = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  linkedTaskIds: z.array(z.string()),
  linkedNoteIds: z.array(z.string()),
});

export function createGguiMcpMount() {
  const store = new Map();
  // Alice is the person-centric anchor: carries `linkedTaskIds`
  // matching the two tasks whose `assigneeId = 'alice'` in the sibling
  // mount. Relational truth on seed = "alice owns seed-task-1 + seed-
  // task-2" via both reverse and forward refs.
  store.set('alice', {
    id: 'alice',
    displayName: 'Alice Chen',
    email: 'alice@example.com',
    linkedTaskIds: ['seed-task-1', 'seed-task-2'],
    linkedNoteIds: [],
  });
  // Bob has zero linked tasks — confirms the cross-ref is legitimately
  // empty when no task assigns to a contact, NOT a schema default
  // we're papering over.
  store.set('bob', {
    id: 'bob',
    displayName: 'Bob Patel',
    email: 'bob@example.com',
    linkedTaskIds: [],
    linkedNoteIds: [],
  });

  return {
    name: 'contacts',
    handlers: [
      {
        name: 'contacts_list',
        title: 'List contacts',
        description:
          'Return every seeded contact. The composition spec uses this to enumerate people for bidirectional-ref assertions.',
        inputSchema: {},
        outputSchema: { items: z.array(ContactItem) },
        async handler() {
          return { items: Array.from(store.values()) };
        },
      },
      {
        name: 'contacts_get',
        title: 'Get contact',
        description:
          'Retrieve a single contact by id. The composition spec reads `linkedTaskIds` from the returned item and cross-checks it against `tasks_list` entries that carry `assigneeId == id`.',
        inputSchema: { id: z.string().min(1) },
        outputSchema: { item: ContactItem.nullable() },
        async handler(raw) {
          const id =
            raw && typeof raw === 'object' && typeof raw.id === 'string'
              ? raw.id
              : '';
          if (id.length === 0) {
            throw new Error('contacts_get: `id` must be a non-empty string');
          }
          const item = store.get(id) ?? null;
          return { item };
        },
      },
      {
        name: 'contacts_link',
        title: 'Link contact to a task or note',
        description:
          "Add or remove a single id on the contact's `linkedTaskIds[]` (kind='task') or `linkedNoteIds[]` (kind='note'). Idempotent: add dedupes, remove is tolerant. Distinct from a generic patch so the blueprint negotiator reads 'link' as a separate signal from 'edit'.",
        inputSchema: {
          id: z.string().min(1),
          link: z.object({
            kind: z.enum(['task', 'note']),
            targetId: z.string().min(1),
            op: z.enum(['add', 'remove']),
          }),
        },
        outputSchema: { item: ContactItem.nullable() },
        async handler(raw) {
          const id =
            raw && typeof raw === 'object' && typeof raw.id === 'string'
              ? raw.id
              : '';
          const link =
            raw &&
            typeof raw === 'object' &&
            raw.link &&
            typeof raw.link === 'object'
              ? /** @type {{ kind?: unknown; targetId?: unknown; op?: unknown }} */ (
                  raw.link
                )
              : {};
          const kind = typeof link.kind === 'string' ? link.kind : '';
          const targetId =
            typeof link.targetId === 'string' ? link.targetId : '';
          const op = typeof link.op === 'string' ? link.op : '';
          if (
            id.length === 0 ||
            targetId.length === 0 ||
            (kind !== 'task' && kind !== 'note') ||
            (op !== 'add' && op !== 'remove')
          ) {
            throw new Error(
              "contacts_link: `id`, `link.kind` ('task'|'note'), `link.targetId`, and `link.op` ('add'|'remove') must all be present and valid",
            );
          }
          const existing = store.get(id);
          if (!existing) return { item: null };
          const column =
            kind === 'task' ? 'linkedTaskIds' : 'linkedNoteIds';
          const prev = existing[column];
          let next;
          if (op === 'add') {
            next = prev.includes(targetId) ? prev : [...prev, targetId];
          } else {
            next = prev.includes(targetId)
              ? prev.filter((x) => x !== targetId)
              : prev;
          }
          const updated = { ...existing, [column]: next };
          store.set(id, updated);
          return { item: updated };
        },
      },
    ],
  };
}
