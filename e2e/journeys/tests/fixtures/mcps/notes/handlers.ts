/**
 * Notes MCP — `SharedHandler` bundle for direct mount on a ggui
 * server's `/mcp` surface.
 *
 * Pairs with `../tasks/handlers.ts` — same wiring philosophy:
 *
 *   - Thin dispatch over the supplied `NotesStore` (no hidden state).
 *   - SDK-permissive input wrap → strict-alias re-parse inside each
 *     handler body → store call → structured output.
 *   - Not-found convention: `{ item: null }` on `get` / `update` /
 *     `append`, `{ deleted: false }` on `delete`. Strict-object
 *     re-parse failures throw → surface as `isError: true` at the
 *     transport boundary.
 *
 * Every tool name here is ALSO registered in `./server.ts` with the
 * same raw-shape references — the `handlers.test.ts` contract suite
 * grep-asserts referential parity so any drift fails loudly.
 *
 * Scope lock: this bundle is the Slice 6 mount seam only. The
 * standalone `createNotesMcpServer` in `./server.ts` remains the
 * process-mode consumer + the host for the 30-ish contract tests.
 */
import type { SharedHandler } from '@ggui-ai/mcp-server-handlers';
import type { ZodRawShape } from 'zod';
import {
  NotesAppendInput,
  NotesCreateInput,
  NotesDeleteInput,
  NotesGetInput,
  NotesListInput,
  NotesSearchInput,
  NotesUpdateInput,
  notesAppendInputShape,
  notesAppendOutputShape,
  notesCreateInputShape,
  notesCreateOutputShape,
  notesDeleteInputShape,
  notesDeleteOutputShape,
  notesGetInputShape,
  notesGetOutputShape,
  notesListInputShape,
  notesListOutputShape,
  notesSearchInputShape,
  notesSearchOutputShape,
  notesUpdateInputShape,
  notesUpdateOutputShape,
} from './schema.js';
import type { NotesStore } from './store.js';

type NotesSharedHandler = SharedHandler<ZodRawShape, ZodRawShape>;

export interface CreateNotesSharedHandlersOptions {
  /**
   * Backing store shared with the standalone `createNotesMcpServer`
   * consumers + any caller that holds the raw sqlite handle (e.g.
   * tests that `reset()` / `seed()` between scenarios).
   */
  readonly store: NotesStore;
}

/**
 * Build the notes-mount bundle. Every handler is a thin dispatch
 * over the supplied `NotesStore`; the factory captures no hidden
 * state of its own. Safe to call once per server composition.
 */
export function createNotesSharedHandlers(
  opts: CreateNotesSharedHandlersOptions,
): ReadonlyArray<NotesSharedHandler> {
  const { store } = opts;

  const notesList: NotesSharedHandler = {
    name: 'notes_list',
    title: 'List notes',
    description:
      'List notes with optional filter (tags, pinned, aboutContactId, updatedAt window), sort, and cursor-based pagination. Default sort is most-recent-first.',
    inputSchema: notesListInputShape,
    outputSchema: notesListOutputShape,
    async handler(raw) {
      const parsed = NotesListInput.parse(raw);
      return store.list(parsed) as unknown as Record<string, unknown>;
    },
  };

  const notesGet: NotesSharedHandler = {
    name: 'notes_get',
    title: 'Get note',
    description:
      'Retrieve a single note by id. Returns `{ item: null }` when no note with that id exists.',
    inputSchema: notesGetInputShape,
    outputSchema: notesGetOutputShape,
    async handler(raw) {
      const parsed = NotesGetInput.parse(raw);
      return { item: store.get(parsed.id) };
    },
  };

  const notesCreate: NotesSharedHandler = {
    name: 'notes_create',
    title: 'Create note',
    description:
      'Create a new note. `body` defaults to empty, `tags` to `[]`, `pinned` to false. The new item is returned in full.',
    inputSchema: notesCreateInputShape,
    outputSchema: notesCreateOutputShape,
    async handler(raw) {
      const parsed = NotesCreateInput.parse(raw);
      return { item: store.create(parsed.input) };
    },
  };

  const notesUpdate: NotesSharedHandler = {
    name: 'notes_update',
    title: 'Update note',
    description:
      "Patch a note's fields. Pass `null` in `aboutContactId` to clear. `tags` and `linkedTaskIds` are whole-array replacements on update — use patch semantics, not per-element add/remove. Body edits via this patch are a FULL replace; use `notes_append` to add without losing existing content. Returns `{ item: null }` when no note with that id exists.",
    inputSchema: notesUpdateInputShape,
    outputSchema: notesUpdateOutputShape,
    async handler(raw) {
      const parsed = NotesUpdateInput.parse(raw);
      return { item: store.update(parsed.id, parsed.patch) };
    },
  };

  const notesDelete: NotesSharedHandler = {
    name: 'notes_delete',
    title: 'Delete note',
    description:
      'Delete a note by id. Idempotent: `deleted: false` when no note with that id existed.',
    inputSchema: notesDeleteInputShape,
    outputSchema: notesDeleteOutputShape,
    async handler(raw) {
      const parsed = NotesDeleteInput.parse(raw);
      return { deleted: store.delete(parsed.id) };
    },
  };

  const notesSearch: NotesSharedHandler = {
    name: 'notes_search',
    title: 'Search notes',
    description:
      'Case-insensitive substring search over note titles AND bodies, with optional filter composition. Returns matched items up to `limit` plus `totalMatches` (unbounded count). The title-OR-body surface is the key Notes-vs-Tasks differentiator — a body-only match is legitimate.',
    inputSchema: notesSearchInputShape,
    outputSchema: notesSearchOutputShape,
    async handler(raw) {
      const parsed = NotesSearchInput.parse(raw);
      return store.search(parsed) as unknown as Record<string, unknown>;
    },
  };

  const notesAppend: NotesSharedHandler = {
    name: 'notes_append',
    title: 'Append to note body',
    description:
      "Append markdown to a note's body (separated by a blank line). Distinct from a generic `notes_update({body:…})` so the blueprint negotiator can tell 'edit note' apart from 'add to existing note'. Returns `{ item: null }` when no note with that id exists.",
    inputSchema: notesAppendInputShape,
    outputSchema: notesAppendOutputShape,
    async handler(raw) {
      const parsed = NotesAppendInput.parse(raw);
      return { item: store.appendBody(parsed.id, parsed.markdown) };
    },
  };

  // Order matches `NOTES_TOOL_NAMES` in `./server.ts` so callers can
  // grep-assert parity across the two surfaces. Any new tool MUST
  // land here AND in `./server.ts` AND in `NOTES_TOOL_NAMES` in the
  // same slice.
  return [
    notesList,
    notesGet,
    notesCreate,
    notesUpdate,
    notesDelete,
    notesSearch,
    notesAppend,
  ];
}
