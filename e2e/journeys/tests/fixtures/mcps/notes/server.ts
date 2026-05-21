/**
 * Notes MCP server.
 *
 * Registers the seven canonical tools locked in stateful-MCP strategy
 * §9.2 — the six `<entity>_*` CRUD+search tools plus the one
 * per-MCP domain tool (`notes_append` — the "append markdown" op
 * that lets the blueprint negotiator distinguish "edit note" from
 * "add to existing note", symmetric with Tasks' `tasks_complete`).
 *
 * Wiring layers match `../tasks/server.ts` exactly:
 *
 *   1. `registerTool` — SDK attaches the raw-shape inputs; MCP's zod
 *      wrap parses permissively.
 *   2. Handler body — re-parses via the `z.strictObject` alias.
 *   3. Handler delegates to `store`; store trusts its input.
 *   4. Result wrapped in `{ structuredContent, content }`.
 *
 * Transport is pluggable; contract tests use `InMemoryTransport`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
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
  NotesAppendInput,
  NotesCreateInput,
  NotesDeleteInput,
  NotesGetInput,
  NotesListInput,
  NotesSearchInput,
  NotesUpdateInput,
} from './schema.js';
import type { NotesStore } from './store.js';

export interface CreateNotesMcpServerOptions {
  readonly store: NotesStore;
  /** Optional override for tools/list `name` + `version`. */
  readonly info?: { readonly name?: string; readonly version?: string };
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: structured,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
  };
}

export function createNotesMcpServer(
  opts: CreateNotesMcpServerOptions,
): McpServer {
  const { store } = opts;
  const server = new McpServer({
    name: opts.info?.name ?? 'notes-mcp-fixture',
    version: opts.info?.version ?? '0.1.0',
  });

  server.registerTool(
    'notes_list',
    {
      title: 'List notes',
      description:
        'List notes with optional filter (tags, pinned, aboutContactId, updatedAt window), sort, and cursor-based pagination.',
      inputSchema: notesListInputShape,
      outputSchema: notesListOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesListInput.parse(raw);
      return ok(store.list(parsed) as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'notes_get',
    {
      title: 'Get note',
      description:
        'Retrieve a single note by id. Returns `{ item: null }` when no note with that id exists.',
      inputSchema: notesGetInputShape,
      outputSchema: notesGetOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesGetInput.parse(raw);
      return ok({ item: store.get(parsed.id) });
    },
  );

  server.registerTool(
    'notes_create',
    {
      title: 'Create note',
      description:
        'Create a new note. `body` defaults to empty, `tags` to `[]`, `pinned` to false. The new item is returned in full.',
      inputSchema: notesCreateInputShape,
      outputSchema: notesCreateOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesCreateInput.parse(raw);
      return ok({ item: store.create(parsed.input) });
    },
  );

  server.registerTool(
    'notes_update',
    {
      title: 'Update note',
      description:
        "Patch a note's fields. Pass `null` in `aboutContactId` to clear. `tags` / `linkedTaskIds` replace the whole array. Body edits are a FULL replace; use `notes_append` to add without losing existing content. Returns `{ item: null }` when no note with that id exists.",
      inputSchema: notesUpdateInputShape,
      outputSchema: notesUpdateOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesUpdateInput.parse(raw);
      return ok({ item: store.update(parsed.id, parsed.patch) });
    },
  );

  server.registerTool(
    'notes_delete',
    {
      title: 'Delete note',
      description:
        'Delete a note by id. Idempotent: `deleted: false` when no note with that id existed.',
      inputSchema: notesDeleteInputShape,
      outputSchema: notesDeleteOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesDeleteInput.parse(raw);
      return ok({ deleted: store.delete(parsed.id) });
    },
  );

  server.registerTool(
    'notes_search',
    {
      title: 'Search notes',
      description:
        'Case-insensitive substring search over note titles AND bodies, with optional filter composition. Returns matched items up to `limit` plus `totalMatches` (unbounded count).',
      inputSchema: notesSearchInputShape,
      outputSchema: notesSearchOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesSearchInput.parse(raw);
      return ok(store.search(parsed) as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'notes_append',
    {
      title: 'Append to note body',
      description:
        "Append markdown to a note's body (separated by a blank line). Distinct from `notes_update({body:…})` so the blueprint negotiator can tell 'edit note' apart from 'add to existing note'. Returns `{ item: null }` when no note with that id exists.",
      inputSchema: notesAppendInputShape,
      outputSchema: notesAppendOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = NotesAppendInput.parse(raw);
      return ok({ item: store.appendBody(parsed.id, parsed.markdown) });
    },
  );

  return server;
}

/**
 * The canonical tool name list, ordered to match server registration.
 * Exported so contract tests can assert on `tools/list` completeness
 * without hard-coding order in the test body. Shape-parallel to
 * `TASKS_TOOL_NAMES` in the Tasks fixture.
 */
export const NOTES_TOOL_NAMES = [
  'notes_list',
  'notes_get',
  'notes_create',
  'notes_update',
  'notes_delete',
  'notes_search',
  'notes_append',
] as const;

export type { CallToolResult, ServerResult };
