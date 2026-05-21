/**
 * Contacts MCP — strict zod schemas for tools + entity.
 *
 * Shape-parallel to `../notes/schema.ts` (same split between strict
 * `z.strictObject` aliases for handler re-parse + raw `ZodRawShape`
 * literals for the MCP SDK), intentionally different in domain shape:
 *
 *   - **Entity-centric identity**: `displayName` + optional
 *     `givenName` / `familyName`. Contrast Tasks' `title` (single
 *     string action label) and Notes' `title` + freeform `body`.
 *   - **Communication metadata**: `email` / `phone` / `company`, all
 *     independently nullable, all participating in search.
 *   - **Relationship tags**: `tags[]` carries the SAME canonicalised
 *     lowercase-alphanumeric contract as Notes (`^[a-z0-9][a-z0-9-]{0,31}$`).
 *     Keeping the tag regex identical across Notes + Contacts means a
 *     future cross-MCP tag join (e.g. "find notes and contacts tagged
 *     #pricing") never trips a silent casing bucket mismatch.
 *   - **Cross-ref fields**: `linkedTaskIds[]` + `linkedNoteIds[]` —
 *     id-reference-by-convention (strategy §18, no FK validation).
 *     These are the reverse of `Task.assigneeId` / `Note.aboutContactId`
 *     maintained on THIS entity so Slice 6.4 has a composition seam
 *     without asking Tasks/Notes to know about Contacts.
 *   - **Favorite boolean**: the Contacts entity-level flag (symmetric
 *     with `Note.pinned`, different semantic — "starred address
 *     book entry" vs "keep this note on top").
 *
 * The **domain-specific** tool is `contacts_link` — add/remove one
 * cross-ref entry at a time on `linkedTaskIds[]` or `linkedNoteIds[]`.
 * Distinct from `contacts_update({linkedTaskIds:[...]})` so the
 * blueprint negotiator can distinguish "edit the contact record"
 * from "link this contact to a task/note" — symmetric with
 * `tasks_complete` vs `tasks_update({status:'done'})` and `notes_append`
 * vs `notes_update({body:...})`.
 *
 * Entity shape follows stateful-MCP strategy §8.1
 * (`{ id, name, email?, phone?, company? }`) + §9 cross-ref fields
 * (`linkedTaskIds[]`, `linkedNoteIds[]` — the reverse side of the
 * Task/Note → Contact references).
 */
import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────
// Sort enums. No status machine, so sorts lean on name + timestamps +
// favorite flag, much like Notes leans on timestamps + pinned.
// ──────────────────────────────────────────────────────────────────

export const ContactSortFieldEnum = z.enum([
  'displayName',
  'createdAt',
  'updatedAt',
  'favorite',
]);
export type ContactSortField = z.infer<typeof ContactSortFieldEnum>;

export const ContactSortDirectionEnum = z.enum(['asc', 'desc']);
export type ContactSortDirection = z.infer<typeof ContactSortDirectionEnum>;

// ──────────────────────────────────────────────────────────────────
// Tag — same contract as Notes (`^[a-z0-9][a-z0-9-]{0,31}$`). See
// `../notes/schema.ts::TagRegex`. Cross-MCP tag equality depends on
// the regex staying referentially shape-identical.
// ──────────────────────────────────────────────────────────────────

const TagRegex = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const Tag = z
  .string()
  .regex(
    TagRegex,
    'Tags must be lowercase alphanumeric with hyphens, 1–32 chars, no leading hyphen',
  );

// ──────────────────────────────────────────────────────────────────
// Email — RFC 5322 is out of scope for a fixture. zod's `.email()`
// is the reasonable compromise; matches what real apps ship.
// Phone is intentionally a free-form string — regional format
// normalisation belongs at the view layer, not the fixture schema.
// ──────────────────────────────────────────────────────────────────

export const ContactEmail = z.string().email();
export const ContactPhone = z.string().min(1).max(64);
export const ContactCompany = z.string().min(1).max(200);
export const ContactDisplayName = z.string().min(1).max(200);

// ──────────────────────────────────────────────────────────────────
// Entity + create / update shapes
// ──────────────────────────────────────────────────────────────────

/**
 * The full canonical Contact entity. `id`, `createdAt`, `updatedAt`
 * are server-owned (populated by the store on create/update).
 * `favorite` defaults to `false` at the zod level on create.
 *
 * `displayName` is always present (it's what renders in a list). The
 * optional `givenName` / `familyName` carry the structured breakdown
 * when the agent captured it — absent when the user typed a single
 * string. Tests pin this semantic.
 */
export const ContactEntity = z
  .object({
    id: z.string().min(1),
    displayName: ContactDisplayName,
    givenName: z.string().min(1).max(100).nullable(),
    familyName: z.string().min(1).max(100).nullable(),
    email: ContactEmail.nullable(),
    phone: ContactPhone.nullable(),
    company: ContactCompany.nullable(),
    tags: z.array(Tag),
    favorite: z.boolean(),
    linkedTaskIds: z.array(z.string().min(1)),
    linkedNoteIds: z.array(z.string().min(1)),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type ContactEntity = z.infer<typeof ContactEntity>;

/**
 * Input for `contacts_create`. `displayName` is the only required
 * field — a contact with just a name is a legitimate capture
 * ("jot the name down, flesh it out later"). `tags` defaults to `[]`,
 * `favorite` to false, `linkedTaskIds` / `linkedNoteIds` to `[]`.
 * Cross-ref ids accept only present-strings on create; `null` is
 * update-only (matches Tasks + Notes convention).
 */
export const ContactCreateInput = z
  .object({
    displayName: ContactDisplayName,
    givenName: z.string().min(1).max(100).optional(),
    familyName: z.string().min(1).max(100).optional(),
    email: ContactEmail.optional(),
    phone: ContactPhone.optional(),
    company: ContactCompany.optional(),
    tags: z.array(Tag).default([]),
    favorite: z.boolean().default(false),
    linkedTaskIds: z.array(z.string().min(1)).default([]),
    linkedNoteIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ContactCreateInput = z.infer<typeof ContactCreateInput>;

/**
 * Patch for `contacts_update`. Every field optional; `null` accepted
 * on every nullable scalar to mean "clear this field". `tags` /
 * `linkedTaskIds` / `linkedNoteIds` are whole-array replacements on
 * update — per-element add/remove flows through `contacts_link`
 * (which only operates on the linked-id arrays).
 */
export const ContactUpdatePatch = z
  .object({
    displayName: ContactDisplayName.optional(),
    givenName: z.string().min(1).max(100).nullable().optional(),
    familyName: z.string().min(1).max(100).nullable().optional(),
    email: ContactEmail.nullable().optional(),
    phone: ContactPhone.nullable().optional(),
    company: ContactCompany.nullable().optional(),
    tags: z.array(Tag).optional(),
    favorite: z.boolean().optional(),
    linkedTaskIds: z.array(z.string().min(1)).optional(),
    linkedNoteIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).length > 0,
    'Patch must include at least one field',
  );
export type ContactUpdatePatch = z.infer<typeof ContactUpdatePatch>;

// ──────────────────────────────────────────────────────────────────
// Filter + sort
// ──────────────────────────────────────────────────────────────────

export const ContactFilter = z
  .object({
    tags: z.array(Tag).min(1).optional(),
    favorite: z.boolean().optional(),
    company: ContactCompany.optional(),
    hasEmail: z.boolean().optional(),
    hasPhone: z.boolean().optional(),
  })
  .strict();
export type ContactFilter = z.infer<typeof ContactFilter>;

export const ContactSort = z
  .object({
    field: ContactSortFieldEnum,
    direction: ContactSortDirectionEnum.default('asc'),
  })
  .strict();
export type ContactSort = z.infer<typeof ContactSort>;

// ──────────────────────────────────────────────────────────────────
// Link op — the `contacts_link` domain tool input.
//
// `kind` picks the array (`task` → `linkedTaskIds`, `note` →
// `linkedNoteIds`); `targetId` is the id to add/remove;
// `op` is `add` | `remove`. Add is idempotent (adding an id already
// present is a no-op); remove returns the pre-remove shape when the
// id wasn't there. The store owns dedupe + order rules.
// ──────────────────────────────────────────────────────────────────

export const ContactLinkKindEnum = z.enum(['task', 'note']);
export type ContactLinkKind = z.infer<typeof ContactLinkKindEnum>;

export const ContactLinkOpEnum = z.enum(['add', 'remove']);
export type ContactLinkOp = z.infer<typeof ContactLinkOpEnum>;

export const ContactLinkPayload = z
  .object({
    kind: ContactLinkKindEnum,
    targetId: z.string().min(1),
    op: ContactLinkOpEnum,
  })
  .strict();
export type ContactLinkPayload = z.infer<typeof ContactLinkPayload>;

// ──────────────────────────────────────────────────────────────────
// Per-tool input + output raw-shape literals (for the MCP SDK's
// `registerTool`). Same duplication pattern as Tasks + Notes — the
// SDK wants raw shapes + the handler re-parses via the strict alias.
// ──────────────────────────────────────────────────────────────────

export const contactsListInputShape = {
  filter: ContactFilter.optional(),
  sort: ContactSort.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
};

export const contactsListOutputShape = {
  items: z.array(ContactEntity),
  nextCursor: z.string().optional(),
};

export const contactsGetInputShape = {
  id: z.string().min(1),
};

export const contactsGetOutputShape = {
  /** `null` when no contact with this id exists. Clean not-found signal. */
  item: ContactEntity.nullable(),
};

export const contactsCreateInputShape = {
  input: ContactCreateInput,
};

export const contactsCreateOutputShape = {
  item: ContactEntity,
};

export const contactsUpdateInputShape = {
  id: z.string().min(1),
  patch: ContactUpdatePatch,
};

export const contactsUpdateOutputShape = {
  /** `null` when no contact with this id exists. */
  item: ContactEntity.nullable(),
};

export const contactsDeleteInputShape = {
  id: z.string().min(1),
};

export const contactsDeleteOutputShape = {
  /** `false` when no contact existed — idempotent. */
  deleted: z.boolean(),
};

export const contactsSearchInputShape = {
  query: z.string().min(1).max(500),
  filter: ContactFilter.optional(),
  limit: z.number().int().positive().max(200).optional(),
};

export const contactsSearchOutputShape = {
  items: z.array(ContactEntity),
  totalMatches: z.number().int().nonnegative(),
};

export const contactsLinkInputShape = {
  id: z.string().min(1),
  link: ContactLinkPayload,
};

export const contactsLinkOutputShape = {
  /** `null` when no contact with this id exists. */
  item: ContactEntity.nullable(),
};

// ──────────────────────────────────────────────────────────────────
// Strict-object aliases — used by the handlers to re-parse inputs
// after the MCP SDK's permissive raw-shape wrap.
// ──────────────────────────────────────────────────────────────────

export const ContactsListInput = z.strictObject(contactsListInputShape);
export const ContactsGetInput = z.strictObject(contactsGetInputShape);
export const ContactsCreateInput = z.strictObject(contactsCreateInputShape);
export const ContactsUpdateInput = z.strictObject(contactsUpdateInputShape);
export const ContactsDeleteInput = z.strictObject(contactsDeleteInputShape);
export const ContactsSearchInput = z.strictObject(contactsSearchInputShape);
export const ContactsLinkInput = z.strictObject(contactsLinkInputShape);

export type ContactsListInputT = z.infer<typeof ContactsListInput>;
export type ContactsListOutputT = {
  items: ContactEntity[];
  nextCursor?: string;
};
export type ContactsGetOutputT = { item: ContactEntity | null };
export type ContactsCreateOutputT = { item: ContactEntity };
export type ContactsUpdateOutputT = { item: ContactEntity | null };
export type ContactsDeleteOutputT = { deleted: boolean };
export type ContactsSearchOutputT = {
  items: ContactEntity[];
  totalMatches: number;
};
export type ContactsLinkOutputT = { item: ContactEntity | null };
