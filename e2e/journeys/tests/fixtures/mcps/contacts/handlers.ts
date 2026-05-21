/**
 * Contacts MCP — `SharedHandler` bundle for direct mount on a ggui
 * server's `/mcp` surface.
 *
 * Pairs with `../notes/handlers.ts` + `../tasks/handlers.ts` — same
 * wiring philosophy:
 *
 *   - Thin dispatch over the supplied `ContactsStore` (no hidden state).
 *   - SDK-permissive input wrap → strict-alias re-parse inside each
 *     handler body → store call → structured output.
 *   - Not-found convention: `{ item: null }` on `get` / `update` /
 *     `link`, `{ deleted: false }` on `delete`. Strict-object re-parse
 *     failures throw → surface as `isError: true` at the transport
 *     boundary.
 *
 * Every tool name here is ALSO registered in `./server.ts` with the
 * same raw-shape references — `handlers.test.ts` grep-asserts
 * referential parity so any drift fails loudly.
 *
 * Scope lock: this bundle is the Slice 6.x mount seam only. The
 * standalone `createContactsMcpServer` in `./server.ts` remains the
 * process-mode consumer + host for the contract tests.
 */
import type { SharedHandler } from '@ggui-ai/mcp-server-handlers';
import type { ZodRawShape } from 'zod';
import {
  ContactsCreateInput,
  ContactsDeleteInput,
  ContactsGetInput,
  ContactsLinkInput,
  ContactsListInput,
  ContactsSearchInput,
  ContactsUpdateInput,
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
} from './schema.js';
import type { ContactsStore } from './store.js';

type ContactsSharedHandler = SharedHandler<ZodRawShape, ZodRawShape>;

export interface CreateContactsSharedHandlersOptions {
  /**
   * Backing store shared with the standalone `createContactsMcpServer`
   * consumers + any caller that holds the raw sqlite handle (e.g.
   * tests that `reset()` / `seed()` between scenarios).
   */
  readonly store: ContactsStore;
}

/**
 * Build the contacts-mount bundle. Every handler is a thin dispatch
 * over the supplied `ContactsStore`; the factory captures no hidden
 * state of its own. Safe to call once per server composition.
 */
export function createContactsSharedHandlers(
  opts: CreateContactsSharedHandlersOptions,
): ReadonlyArray<ContactsSharedHandler> {
  const { store } = opts;

  const contactsList: ContactsSharedHandler = {
    name: 'contacts_list',
    title: 'List contacts',
    description:
      'List contacts with optional filter (tags, favorite, company, hasEmail/hasPhone switches), sort, and cursor-based pagination. Default sort is oldest-first (natural address-book order).',
    inputSchema: contactsListInputShape,
    outputSchema: contactsListOutputShape,
    async handler(raw) {
      const parsed = ContactsListInput.parse(raw);
      return store.list(parsed) as unknown as Record<string, unknown>;
    },
  };

  const contactsGet: ContactsSharedHandler = {
    name: 'contacts_get',
    title: 'Get contact',
    description:
      'Retrieve a single contact by id. Returns `{ item: null }` when no contact with that id exists.',
    inputSchema: contactsGetInputShape,
    outputSchema: contactsGetOutputShape,
    async handler(raw) {
      const parsed = ContactsGetInput.parse(raw);
      return { item: store.get(parsed.id) };
    },
  };

  const contactsCreate: ContactsSharedHandler = {
    name: 'contacts_create',
    title: 'Create contact',
    description:
      "Create a new contact. Only `displayName` is required — emit the structured `givenName`/`familyName` only when the user supplied both. `tags` defaults to `[]`, `favorite` to false. `linkedTaskIds` / `linkedNoteIds` default to `[]`; they're populated lazily via `contacts_link`. The new item is returned in full.",
    inputSchema: contactsCreateInputShape,
    outputSchema: contactsCreateOutputShape,
    async handler(raw) {
      const parsed = ContactsCreateInput.parse(raw);
      return { item: store.create(parsed.input) };
    },
  };

  const contactsUpdate: ContactsSharedHandler = {
    name: 'contacts_update',
    title: 'Update contact',
    description:
      "Patch a contact's fields. Pass `null` in any nullable scalar (`givenName`, `familyName`, `email`, `phone`, `company`) to clear. `tags` / `linkedTaskIds` / `linkedNoteIds` are whole-array replacements on update — use `contacts_link` to add/remove a single linked id without replacing the whole array. Returns `{ item: null }` when no contact with that id exists.",
    inputSchema: contactsUpdateInputShape,
    outputSchema: contactsUpdateOutputShape,
    async handler(raw) {
      const parsed = ContactsUpdateInput.parse(raw);
      return { item: store.update(parsed.id, parsed.patch) };
    },
  };

  const contactsDelete: ContactsSharedHandler = {
    name: 'contacts_delete',
    title: 'Delete contact',
    description:
      'Delete a contact by id. Idempotent: `deleted: false` when no contact with that id existed.',
    inputSchema: contactsDeleteInputShape,
    outputSchema: contactsDeleteOutputShape,
    async handler(raw) {
      const parsed = ContactsDeleteInput.parse(raw);
      return { deleted: store.delete(parsed.id) };
    },
  };

  const contactsSearch: ContactsSharedHandler = {
    name: 'contacts_search',
    title: 'Search contacts',
    description:
      "Case-insensitive substring search over displayName OR email OR company, with optional filter composition. Returns matched items up to `limit` plus `totalMatches` (unbounded count). Tri-field search is the key Contacts-vs-Notes-vs-Tasks differentiator — a search for 'alice@example.com' hits email only, 'Acme' hits company only, 'Alice' hits displayName only.",
    inputSchema: contactsSearchInputShape,
    outputSchema: contactsSearchOutputShape,
    async handler(raw) {
      const parsed = ContactsSearchInput.parse(raw);
      return store.search(parsed) as unknown as Record<string, unknown>;
    },
  };

  const contactsLink: ContactsSharedHandler = {
    name: 'contacts_link',
    title: 'Link contact to task or note',
    description:
      "Add or remove a single id on the contact's `linkedTaskIds[]` (when `kind='task'`) or `linkedNoteIds[]` (when `kind='note'`). Idempotent: adding an id already present is a no-op; removing an absent id is a no-op. Distinct from `contacts_update({linkedTaskIds:[...]})` so the blueprint negotiator can tell 'link this contact to task X' apart from 'edit the contact record'. Returns `{ item: null }` when no contact with that id exists.",
    inputSchema: contactsLinkInputShape,
    outputSchema: contactsLinkOutputShape,
    async handler(raw) {
      const parsed = ContactsLinkInput.parse(raw);
      return {
        item: store.link(
          parsed.id,
          parsed.link.kind,
          parsed.link.targetId,
          parsed.link.op,
        ),
      };
    },
  };

  // Order matches `CONTACTS_TOOL_NAMES` in `./server.ts` so callers
  // can grep-assert parity across the two surfaces. Any new tool
  // MUST land here AND in `./server.ts` AND in `CONTACTS_TOOL_NAMES`
  // in the same slice.
  return [
    contactsList,
    contactsGet,
    contactsCreate,
    contactsUpdate,
    contactsDelete,
    contactsSearch,
    contactsLink,
  ];
}
