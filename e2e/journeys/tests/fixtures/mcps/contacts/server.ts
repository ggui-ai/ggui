/**
 * Contacts MCP server.
 *
 * Registers the seven canonical tools locked in stateful-MCP strategy
 * §9.2 — the six `<entity>_*` CRUD+search tools plus the one
 * per-MCP domain tool (`contacts_link` — add/remove cross-ref entries
 * for future Tasks/Notes composition, symmetric with Tasks'
 * `tasks_complete` and Notes' `notes_append`).
 *
 * Wiring layers match `../notes/server.ts` + `../tasks/server.ts`
 * exactly:
 *
 *   1. `registerTool` — SDK attaches the raw-shape inputs; MCP's zod
 *      wrap parses permissively.
 *   2. Handler body — re-parses via the `z.strictObject` alias.
 *   3. Handler delegates to `store`; store trusts its input.
 *   4. Result wrapped in `{ structuredContent, content }`.
 *
 * Transport is pluggable; contract tests use `InMemoryTransport` via
 * `../_shared/mcp-test-client.ts`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ServerResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  contactsCreateInputShape,
  contactsCreateOutputShape,
  contactsDeleteInputShape,
  contactsDeleteOutputShape,
  contactsGetInputShape,
  contactsGetOutputShape,
  contactsLinkInputShape,
  contactsLinkOutputShape,
  contactsListInputShape,
  contactsListOutputShape,
  contactsSearchInputShape,
  contactsSearchOutputShape,
  contactsUpdateInputShape,
  contactsUpdateOutputShape,
  ContactsCreateInput,
  ContactsDeleteInput,
  ContactsGetInput,
  ContactsLinkInput,
  ContactsListInput,
  ContactsSearchInput,
  ContactsUpdateInput,
} from './schema.js';
import type { ContactsStore } from './store.js';

export interface CreateContactsMcpServerOptions {
  readonly store: ContactsStore;
  /** Optional override for tools/list `name` + `version`. */
  readonly info?: { readonly name?: string; readonly version?: string };
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: structured,
    content: [{ type: 'text', text: JSON.stringify(structured) }],
  };
}

export function createContactsMcpServer(
  opts: CreateContactsMcpServerOptions,
): McpServer {
  const { store } = opts;
  const server = new McpServer({
    name: opts.info?.name ?? 'contacts-mcp-fixture',
    version: opts.info?.version ?? '0.1.0',
  });

  server.registerTool(
    'contacts_list',
    {
      title: 'List contacts',
      description:
        'List contacts with optional filter (tags, favorite, company, hasEmail/hasPhone), sort, and cursor-based pagination.',
      inputSchema: contactsListInputShape,
      outputSchema: contactsListOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsListInput.parse(raw);
      return ok(store.list(parsed) as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'contacts_get',
    {
      title: 'Get contact',
      description:
        'Retrieve a single contact by id. Returns `{ item: null }` when no contact with that id exists.',
      inputSchema: contactsGetInputShape,
      outputSchema: contactsGetOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsGetInput.parse(raw);
      return ok({ item: store.get(parsed.id) });
    },
  );

  server.registerTool(
    'contacts_create',
    {
      title: 'Create contact',
      description:
        'Create a new contact. Only `displayName` is required; structured `givenName`/`familyName` are optional. `tags`/`linkedTaskIds`/`linkedNoteIds` default to `[]`, `favorite` to false. The new item is returned in full.',
      inputSchema: contactsCreateInputShape,
      outputSchema: contactsCreateOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsCreateInput.parse(raw);
      return ok({ item: store.create(parsed.input) });
    },
  );

  server.registerTool(
    'contacts_update',
    {
      title: 'Update contact',
      description:
        "Patch a contact's fields. Pass `null` in any nullable scalar to clear. `tags`/`linkedTaskIds`/`linkedNoteIds` replace the whole array — use `contacts_link` to add/remove a single linked id. Returns `{ item: null }` when no contact with that id exists.",
      inputSchema: contactsUpdateInputShape,
      outputSchema: contactsUpdateOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsUpdateInput.parse(raw);
      return ok({ item: store.update(parsed.id, parsed.patch) });
    },
  );

  server.registerTool(
    'contacts_delete',
    {
      title: 'Delete contact',
      description:
        'Delete a contact by id. Idempotent: `deleted: false` when no contact with that id existed.',
      inputSchema: contactsDeleteInputShape,
      outputSchema: contactsDeleteOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsDeleteInput.parse(raw);
      return ok({ deleted: store.delete(parsed.id) });
    },
  );

  server.registerTool(
    'contacts_search',
    {
      title: 'Search contacts',
      description:
        'Case-insensitive substring search over displayName OR email OR company, with optional filter composition. Returns matched items up to `limit` plus `totalMatches` (unbounded count).',
      inputSchema: contactsSearchInputShape,
      outputSchema: contactsSearchOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsSearchInput.parse(raw);
      return ok(store.search(parsed) as unknown as Record<string, unknown>);
    },
  );

  server.registerTool(
    'contacts_link',
    {
      title: 'Link contact to task or note',
      description:
        "Add or remove a single id on the contact's `linkedTaskIds[]` (kind='task') or `linkedNoteIds[]` (kind='note'). Idempotent. Distinct from `contacts_update({linkedTaskIds:[...]})` so the blueprint negotiator can distinguish link operations from contact-record edits. Returns `{ item: null }` when no contact with that id exists.",
      inputSchema: contactsLinkInputShape,
      outputSchema: contactsLinkOutputShape,
    },
    async (raw: Record<string, unknown>) => {
      const parsed = ContactsLinkInput.parse(raw);
      return ok({
        item: store.link(
          parsed.id,
          parsed.link.kind,
          parsed.link.targetId,
          parsed.link.op,
        ),
      });
    },
  );

  return server;
}

/**
 * The canonical tool name list, ordered to match server registration.
 * Exported so contract tests can assert on `tools/list` completeness
 * without hard-coding order in the test body. Shape-parallel to
 * `NOTES_TOOL_NAMES` and `TASKS_TOOL_NAMES`.
 */
export const CONTACTS_TOOL_NAMES = [
  'contacts_list',
  'contacts_get',
  'contacts_create',
  'contacts_update',
  'contacts_delete',
  'contacts_search',
  'contacts_link',
] as const;

export type { CallToolResult, ServerResult };
