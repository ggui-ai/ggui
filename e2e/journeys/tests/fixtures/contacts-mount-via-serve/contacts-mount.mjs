/**
 * Self-contained `ggui.json#mcpMounts` fixture for the
 * `contacts-mount-via-serve.spec.ts` E2E proof (Slice 6.3).
 *
 * Symmetric with the sibling `../tasks-mount-via-serve/tasks-mount.mjs`
 * + `../notes-mount-via-serve/notes-mount.mjs`: a pure-ESM module with
 * an in-memory Map store, seeded inline, exposing three handlers
 * (`contacts_list`, `contacts_create`, `contacts_link`) — enough to
 * prove the mount path generalises to a third domain AND to exercise
 * the Contacts-specific `contacts_link` cross-ref op (the equivalent
 * of Notes' `notes_append` paragraph-break semantic, but for
 * `linkedTaskIds[]`/`linkedNoteIds[]` array mutation).
 *
 * The full-surface TS Contacts fixture at `../mcps/contacts/` stays
 * the source of truth for the 7-tool contract + vitest coverage. This
 * `.mjs` is specifically the "load through the real `ggui serve` CLI
 * binary" surface — requires no build step and no tsx loader.
 *
 * Entry-point contract is identical to the Tasks + Notes mount
 * fixtures (see `packages/project-config/src/mcp-mount-discovery.ts`):
 *
 *   - Export a named `createGguiMcpMount` function.
 *   - Return `{ name: string, handlers: SharedHandler[] }`.
 *   - Every handler MUST declare a non-empty `outputSchema` — the
 *     compose-time guardrail at `composeHandlersWithMounts` rejects
 *     empty shapes so operators don't silently lose structuredContent.
 *
 * zod is resolved from `e2e/ggui-oss/node_modules` via Node's
 * walk-up-from-CWD resolution (the harness pins CWD to this fixture
 * dir).
 */
import { z } from 'zod';

/**
 * Contact item shape — shared between `contacts_list.items[]`,
 * `contacts_create.item`, and `contacts_link.item`. Keeping the shape
 * in one place avoids the structuredContent drift that bit the first
 * Tasks mount fixture before the outputSchema guardrail landed.
 */
const ContactItem = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  linkedTaskIds: z.array(z.string()),
  linkedNoteIds: z.array(z.string()),
});

export function createGguiMcpMount() {
  const store = new Map();
  // Deterministic seed — the E2E spec asserts exact displayNames.
  store.set('seed-alice', {
    id: 'seed-alice',
    displayName: 'Alice Chen',
    email: 'alice@example.com',
    linkedTaskIds: ['seed-task-1'],
    linkedNoteIds: [],
  });
  store.set('seed-bob', {
    id: 'seed-bob',
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
          'Return every seeded contact. Proves the mount reads from state declared in createGguiMcpMount().',
        inputSchema: {},
        outputSchema: { items: z.array(ContactItem) },
        async handler() {
          return { items: Array.from(store.values()) };
        },
      },
      {
        name: 'contacts_create',
        title: 'Create contact',
        description:
          'Append a new contact. Proves the mount handler dispatches writes through the real /mcp wire.',
        inputSchema: {
          input: z.object({
            displayName: z.string().min(1),
            email: z.string().email().optional(),
          }),
        },
        outputSchema: { item: ContactItem },
        async handler(raw) {
          const input =
            raw && typeof raw === 'object' && 'input' in raw
              ? /** @type {{ displayName?: unknown; email?: unknown }} */ (
                  raw.input
                )
              : {};
          const displayName =
            input && typeof input === 'object' ? input.displayName : undefined;
          if (typeof displayName !== 'string' || displayName.length === 0) {
            throw new Error(
              'contacts_create: `input.displayName` must be a non-empty string',
            );
          }
          const email =
            input &&
            typeof input === 'object' &&
            typeof input.email === 'string'
              ? input.email
              : null;
          const id = `local-${store.size + 1}`;
          const item = {
            id,
            displayName,
            email,
            linkedTaskIds: [],
            linkedNoteIds: [],
          };
          store.set(id, item);
          return { item };
        },
      },
      {
        name: 'contacts_link',
        title: 'Link contact to a task or note',
        description:
          "Add or remove a single id on the contact's `linkedTaskIds[]` (kind='task') or `linkedNoteIds[]` (kind='note'). Idempotent: add is dedup, remove is tolerant. Distinct from contacts_update — this is the Contacts-specific op that lets the blueprint negotiator tell 'link this contact' from 'edit the contact'. Returns `{ item: null }` when the contact does not exist.",
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
            raw && typeof raw === 'object' && raw.link && typeof raw.link === 'object'
              ? /** @type {{ kind?: unknown; targetId?: unknown; op?: unknown }} */ (
                  raw.link
                )
              : {};
          const kind = typeof link.kind === 'string' ? link.kind : '';
          const targetId = typeof link.targetId === 'string' ? link.targetId : '';
          const op = typeof link.op === 'string' ? link.op : '';
          if (id.length === 0 || targetId.length === 0 ||
              (kind !== 'task' && kind !== 'note') ||
              (op !== 'add' && op !== 'remove')) {
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
