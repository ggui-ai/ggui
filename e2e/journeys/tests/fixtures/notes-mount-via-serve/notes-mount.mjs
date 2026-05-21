/**
 * Self-contained `ggui.json#mcpMounts` fixture for the
 * `notes-mount-via-serve.spec.ts` E2E proof (Slice 6.2).
 *
 * Symmetric with the sibling `../tasks-mount-via-serve/tasks-mount.mjs`:
 * a pure-ESM module with an in-memory Map store, seeded inline, exposing
 * three handlers (`notes_list`, `notes_create`, `notes_append`) — enough
 * to prove the mount path generalises beyond Tasks AND to exercise the
 * Notes-specific append semantics (paragraph separator between the
 * prior body and the appended chunk).
 *
 * The full-surface TS Notes fixture at `../mcps/notes/` stays the source
 * of truth for the 7-tool contract + vitest coverage. This `.mjs` is
 * specifically the "load through the real `ggui serve` CLI binary"
 * surface — requires no build step and no tsx loader.
 *
 * Entry-point contract is identical to the Tasks mount fixture (see
 * `packages/project-config/src/mcp-mount-discovery.ts`):
 *
 *   - Export a named `createGguiMcpMount` function.
 *   - Return `{ name: string, handlers: SharedHandler[] }`.
 *   - Every handler must declare a non-empty `outputSchema` — the
 *     compose-time guardrail at `composeHandlersWithMounts` rejects
 *     empty shapes so operators don't silently lose structuredContent.
 *
 * zod is resolved from `e2e/ggui-oss/node_modules` via Node's
 * walk-up-from-CWD resolution (the harness pins CWD to this fixture
 * dir).
 */
import { z } from 'zod';

/**
 * Note item shape — shared between `notes_list.items[]` and
 * `notes_create.item` / `notes_append.item`. Keeping the shape in one
 * place avoids the kind of drift that silently breaks
 * structuredContent parity.
 */
const NoteItem = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
});

export function createGguiMcpMount() {
  const store = new Map();
  // Deterministic seed — the E2E spec asserts exact titles + bodies.
  store.set('seed-1', {
    id: 'seed-1',
    title: 'Slice 6.2 plan',
    body: 'Ship the Notes mount through the real ggui serve path.',
  });
  store.set('seed-2', {
    id: 'seed-2',
    title: 'Pricing research',
    body: 'Collect Linear + Vercel v0 + Cursor tier comparables.',
  });

  return {
    name: 'notes',
    handlers: [
      {
        name: 'notes_list',
        title: 'List notes',
        description:
          'Return every seeded note. Proves the mount reads from state declared in createGguiMcpMount().',
        inputSchema: {},
        outputSchema: { items: z.array(NoteItem) },
        async handler() {
          return { items: Array.from(store.values()) };
        },
      },
      {
        name: 'notes_create',
        title: 'Create note',
        description:
          'Append a new note. Proves the mount handler dispatches writes through the real /mcp wire.',
        inputSchema: {
          input: z.object({
            title: z.string().min(1),
            body: z.string().default(''),
          }),
        },
        outputSchema: { item: NoteItem },
        async handler(raw) {
          const input =
            raw && typeof raw === 'object' && 'input' in raw
              ? /** @type {{ title?: unknown; body?: unknown }} */ (raw.input)
              : {};
          const title =
            input && typeof input === 'object' ? input.title : undefined;
          if (typeof title !== 'string' || title.length === 0) {
            throw new Error(
              'notes_create: `input.title` must be a non-empty string',
            );
          }
          const body =
            input && typeof input === 'object' && typeof input.body === 'string'
              ? input.body
              : '';
          const id = `local-${store.size + 1}`;
          const item = { id, title, body };
          store.set(id, item);
          return { item };
        },
      },
      {
        name: 'notes_append',
        title: 'Append to note body',
        description:
          "Append markdown to a note's body with a paragraph separator. Distinct from notes_update — this is the Notes-specific op that lets the blueprint negotiator tell 'edit' from 'add to'. Returns `{ item: null }` when the note does not exist.",
        inputSchema: {
          id: z.string().min(1),
          markdown: z.string().min(1),
        },
        outputSchema: { item: NoteItem.nullable() },
        async handler(raw) {
          const id =
            raw && typeof raw === 'object' && typeof raw.id === 'string'
              ? raw.id
              : '';
          const markdown =
            raw &&
            typeof raw === 'object' &&
            typeof raw.markdown === 'string'
              ? raw.markdown
              : '';
          if (id.length === 0 || markdown.length === 0) {
            throw new Error(
              'notes_append: `id` and `markdown` must be non-empty strings',
            );
          }
          const existing = store.get(id);
          if (!existing) return { item: null };
          const newBody =
            existing.body.length === 0
              ? markdown
              : `${existing.body}\n\n${markdown}`;
          const updated = { ...existing, body: newBody };
          store.set(id, updated);
          return { item: updated };
        },
      },
    ],
  };
}
