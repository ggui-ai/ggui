/**
 * Notes MCP — strict zod schemas for tools + entity.
 *
 * Symmetric with `../tasks/schema.ts` (same split between
 * `*Input` / `*Output` strict objects + raw-shape literals for the
 * MCP SDK), intentionally different in domain shape:
 *
 *   - Freeform `body` markdown instead of structured status.
 *   - Multi-label `tags[]` instead of single-valued enum priority.
 *   - `pinned` boolean presence/absence instead of a state machine.
 *   - Cross-refs: `aboutContactId` (1→1) + `linkedTaskIds[]` (1→many).
 *     Both are id-reference-by-convention per strategy §18 — no FK
 *     validation against the contacts or tasks store.
 *
 * The **domain-specific** tool is `notes_append` (append markdown to
 * `body` without a full replace). Distinct from `notes_update` so the
 * blueprint negotiator can tell "edit note" apart from "add to
 * existing note" — symmetric with Tasks' `tasks_complete` vs
 * `tasks_update({status:'done'})` distinction.
 *
 * Entity shape follows stateful-MCP strategy §8.1:
 *   `Note = { id, title, body, tags[], pinned, aboutContactId?,
 *             linkedTaskIds[], createdAt, updatedAt }`.
 */
import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────
// Sort enums. Notes don't have a status machine, so the sort fields
// lean on timestamps + pinned instead of status ordering.
// ──────────────────────────────────────────────────────────────────

export const NoteSortFieldEnum = z.enum([
  'createdAt',
  'updatedAt',
  'pinned',
]);
export type NoteSortField = z.infer<typeof NoteSortFieldEnum>;

export const NoteSortDirectionEnum = z.enum(['asc', 'desc']);
export type NoteSortDirection = z.infer<typeof NoteSortDirectionEnum>;

// ──────────────────────────────────────────────────────────────────
// Tag — lowercase alphanumeric + hyphens. Enforced at the schema
// boundary so a typo like "Pricing" vs "pricing" can't silently
// produce two separate tag buckets.
// ──────────────────────────────────────────────────────────────────

const TagRegex = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const Tag = z
  .string()
  .regex(
    TagRegex,
    'Tags must be lowercase alphanumeric with hyphens, 1–32 chars, no leading hyphen',
  );

// ──────────────────────────────────────────────────────────────────
// Entity + create / update shapes
// ──────────────────────────────────────────────────────────────────

/**
 * The full canonical Note entity. `id`, `createdAt`, `updatedAt` are
 * server-owned (populated by the store on create/update). `pinned`
 * defaults to `false` at the zod level on create.
 */
export const NoteEntity = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(200),
    body: z.string().max(16_000),
    tags: z.array(Tag),
    pinned: z.boolean(),
    aboutContactId: z.string().min(1).nullable(),
    linkedTaskIds: z.array(z.string().min(1)),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type NoteEntity = z.infer<typeof NoteEntity>;

/**
 * Input for `notes_create`. `body` defaults to empty (a note with a
 * title + no content is a legitimate capture — "jot down the name,
 * write the body later"). `tags` defaults to empty, `pinned` to
 * false. Cross-ref ids accept only present-strings on create; `null`
 * is update-only (matches the Tasks convention).
 */
export const NoteCreateInput = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(16_000).default(''),
    tags: z.array(Tag).default([]),
    pinned: z.boolean().default(false),
    aboutContactId: z.string().min(1).optional(),
    linkedTaskIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type NoteCreateInput = z.infer<typeof NoteCreateInput>;

/**
 * Patch for `notes_update`. Every field optional; `null` accepted on
 * `aboutContactId` to mean "clear this reference". `tags` /
 * `linkedTaskIds` are whole-array replacements on update — there's no
 * per-element add/remove surface today (could be a future additive
 * if an agent asks for it). Body edits via this patch are a FULL
 * replace; use `notes_append` to append without losing existing
 * content.
 */
export const NoteUpdatePatch = z
  .object({
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(16_000).optional(),
    tags: z.array(Tag).optional(),
    pinned: z.boolean().optional(),
    aboutContactId: z.string().min(1).nullable().optional(),
    linkedTaskIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).length > 0,
    'Patch must include at least one field',
  );
export type NoteUpdatePatch = z.infer<typeof NoteUpdatePatch>;

// ──────────────────────────────────────────────────────────────────
// Filter + sort
// ──────────────────────────────────────────────────────────────────

export const NoteFilter = z
  .object({
    tags: z.array(Tag).min(1).optional(),
    pinned: z.boolean().optional(),
    aboutContactId: z.string().min(1).optional(),
    updatedBefore: z.number().int().nonnegative().optional(),
    updatedOnOrAfter: z.number().int().nonnegative().optional(),
  })
  .strict();
export type NoteFilter = z.infer<typeof NoteFilter>;

export const NoteSort = z
  .object({
    field: NoteSortFieldEnum,
    direction: NoteSortDirectionEnum.default('desc'),
  })
  .strict();
export type NoteSort = z.infer<typeof NoteSort>;

// ──────────────────────────────────────────────────────────────────
// Per-tool input + output raw-shape literals (for the MCP SDK's
// `registerTool`). Same duplication pattern as Tasks — the SDK
// wants raw shapes + the handler re-parses via the strict alias.
// ──────────────────────────────────────────────────────────────────

export const notesListInputShape = {
  filter: NoteFilter.optional(),
  sort: NoteSort.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
};

export const notesListOutputShape = {
  items: z.array(NoteEntity),
  nextCursor: z.string().optional(),
};

export const notesGetInputShape = {
  id: z.string().min(1),
};

export const notesGetOutputShape = {
  /** `null` when no note with this id exists. Clean not-found signal. */
  item: NoteEntity.nullable(),
};

export const notesCreateInputShape = {
  input: NoteCreateInput,
};

export const notesCreateOutputShape = {
  item: NoteEntity,
};

export const notesUpdateInputShape = {
  id: z.string().min(1),
  patch: NoteUpdatePatch,
};

export const notesUpdateOutputShape = {
  /** `null` when no note with this id exists. */
  item: NoteEntity.nullable(),
};

export const notesDeleteInputShape = {
  id: z.string().min(1),
};

export const notesDeleteOutputShape = {
  /** `false` when no note existed — idempotent. */
  deleted: z.boolean(),
};

export const notesSearchInputShape = {
  query: z.string().min(1).max(500),
  filter: NoteFilter.optional(),
  limit: z.number().int().positive().max(200).optional(),
};

export const notesSearchOutputShape = {
  items: z.array(NoteEntity),
  totalMatches: z.number().int().nonnegative(),
};

export const notesAppendInputShape = {
  id: z.string().min(1),
  /** Markdown appended to the existing body. A blank line is
   *  inserted between the existing body (if any) and the appended
   *  chunk so two markdown paragraphs render separately. */
  markdown: z.string().min(1).max(16_000),
};

export const notesAppendOutputShape = {
  /** `null` when no note with this id exists. */
  item: NoteEntity.nullable(),
};

// ──────────────────────────────────────────────────────────────────
// Strict-object aliases — used by the store to validate inputs after
// the MCP SDK parses through the permissive raw-shape wrap.
// ──────────────────────────────────────────────────────────────────

export const NotesListInput = z.strictObject(notesListInputShape);
export const NotesGetInput = z.strictObject(notesGetInputShape);
export const NotesCreateInput = z.strictObject(notesCreateInputShape);
export const NotesUpdateInput = z.strictObject(notesUpdateInputShape);
export const NotesDeleteInput = z.strictObject(notesDeleteInputShape);
export const NotesSearchInput = z.strictObject(notesSearchInputShape);
export const NotesAppendInput = z.strictObject(notesAppendInputShape);

export type NotesListInputT = z.infer<typeof NotesListInput>;
export type NotesListOutputT = {
  items: NoteEntity[];
  nextCursor?: string;
};
export type NotesGetOutputT = { item: NoteEntity | null };
export type NotesCreateOutputT = { item: NoteEntity };
export type NotesUpdateOutputT = { item: NoteEntity | null };
export type NotesDeleteOutputT = { deleted: boolean };
export type NotesSearchOutputT = {
  items: NoteEntity[];
  totalMatches: number;
};
export type NotesAppendOutputT = { item: NoteEntity | null };
