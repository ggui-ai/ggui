/**
 * ContactsStore — sqlite-backed CRUD + search + linking for the Contacts
 * MCP fixture.
 *
 * Shape-parallel to `../notes/store.ts` (same sqlite + WAL + cursor +
 * clock-injection pattern), intentionally different in domain shape:
 *
 *   - **Three JSON columns**: `tags_json`, `linked_task_ids_json`,
 *     `linked_note_ids_json`. sqlite has no native arrays; tags are
 *     canonicalised (dedupe + sort) on write, linked-id arrays are
 *     canonicalised (dedupe, insertion-order preserved) on write.
 *   - **`favorite` as INTEGER 0/1** (same convention as `pinned` in
 *     Notes).
 *   - **Search matches displayName OR email OR company** substring,
 *     case-insensitive. The tri-field surface is the Contacts
 *     differentiator on the blueprint-signal ladder — Tasks is title-
 *     only, Notes is title-OR-body, Contacts spans the full
 *     identity+comms surface.
 *   - **`link(id, kind, targetId, op)`** — the domain op. Idempotent
 *     add (dedupe), tolerant remove (removing an id that wasn't there
 *     leaves the array untouched). Bumps `updatedAt` on every
 *     invocation that actually mutates.
 *   - **`hasEmail` / `hasPhone`** filter switches map to
 *     `email IS NOT NULL` / `phone IS NOT NULL`, so an agent can ask
 *     "contacts without phone numbers" without exposing NULL SQL to
 *     the schema surface.
 *
 * Error taxonomy mirrors Tasks + Notes:
 *   - `ContactStoreError` for recoverable conditions (bad cursor, empty
 *     update patch). Not-found is NOT an error — signaled via `null` /
 *     `{ deleted: false }` in the output shape.
 *   - Input validation is the handler's job (re-parse via the strict
 *     alias). The store trusts its inputs; that's the strict boundary.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  ContactCreateInput,
  ContactEntity,
  ContactFilter,
  ContactLinkKind,
  ContactLinkOp,
  ContactSort,
  ContactUpdatePatch,
} from './schema.js';

export interface ContactsStoreOptions {
  /** sqlite file path. Defaults to `:memory:` — ephemeral, test-friendly. */
  readonly filename?: string;
  /** Alternative: pass an existing better-sqlite3 handle. */
  readonly database?: SqliteDatabase;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
  /** ID generator injection for deterministic tests. */
  readonly generateId?: () => string;
}

export class ContactStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContactStoreError';
  }
}

type ContactRow = {
  id: string;
  display_name: string;
  given_name: string | null;
  family_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags_json: string;
  favorite: number;
  linked_task_ids_json: string;
  linked_note_ids_json: string;
  created_at: number;
  updated_at: number;
};

function canonicaliseTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags)).sort();
}

function canonicaliseLinkedIds(ids: readonly string[]): string[] {
  // Preserve insertion order but drop duplicates. `contacts_link
  // op=add` relies on this to keep the append-newest-last semantic.
  return Array.from(new Set(ids));
}

function rowToEntity(r: ContactRow): ContactEntity {
  return {
    id: r.id,
    displayName: r.display_name,
    givenName: r.given_name,
    familyName: r.family_name,
    email: r.email,
    phone: r.phone,
    company: r.company,
    tags: JSON.parse(r.tags_json) as string[],
    favorite: r.favorite !== 0,
    linkedTaskIds: JSON.parse(r.linked_task_ids_json) as string[],
    linkedNoteIds: JSON.parse(r.linked_note_ids_json) as string[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface CursorPayload {
  readonly createdAt: number;
  readonly id: string;
}

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(s: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(s, 'base64url').toString('utf8'),
    );
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'createdAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as { createdAt: unknown }).createdAt === 'number' &&
      typeof (parsed as { id: unknown }).id === 'string'
    ) {
      return parsed as CursorPayload;
    }
  } catch {
    // fall through
  }
  return null;
}

export class ContactsStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly generateId: () => string;

  private readonly stInsert: SqliteStatement;
  private readonly stGet: SqliteStatement;
  private readonly stDelete: SqliteStatement;
  private readonly stDeleteAll: SqliteStatement;

  constructor(opts: ContactsStoreOptions = {}) {
    this.db = opts.database ?? new Database(opts.filename ?? ':memory:');
    this.now = opts.now ?? Date.now;
    this.generateId = opts.generateId ?? randomUUID;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id                   TEXT PRIMARY KEY,
        display_name         TEXT NOT NULL,
        given_name           TEXT,
        family_name          TEXT,
        email                TEXT,
        phone                TEXT,
        company              TEXT,
        tags_json            TEXT NOT NULL,
        favorite             INTEGER NOT NULL CHECK (favorite IN (0,1)),
        linked_task_ids_json TEXT NOT NULL,
        linked_note_ids_json TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_contacts_favorite     ON contacts(favorite);
      CREATE INDEX IF NOT EXISTS idx_contacts_company      ON contacts(company);
      CREATE INDEX IF NOT EXISTS idx_contacts_display_name ON contacts(display_name);
      CREATE INDEX IF NOT EXISTS idx_contacts_created      ON contacts(created_at);
    `);

    this.stInsert = this.db.prepare(
      `INSERT INTO contacts
        (id,display_name,given_name,family_name,email,phone,company,
         tags_json,favorite,linked_task_ids_json,linked_note_ids_json,
         created_at,updated_at)
       VALUES
        (@id,@display_name,@given_name,@family_name,@email,@phone,@company,
         @tags_json,@favorite,@linked_task_ids_json,@linked_note_ids_json,
         @created_at,@updated_at)`,
    );
    this.stGet = this.db.prepare(`SELECT * FROM contacts WHERE id = ?`);
    this.stDelete = this.db.prepare(`DELETE FROM contacts WHERE id = ?`);
    this.stDeleteAll = this.db.prepare(`DELETE FROM contacts`);
  }

  close(): void {
    this.db.close();
  }

  reset(): void {
    this.stDeleteAll.run();
  }

  /**
   * Insert deterministic fixture rows. Each row is inserted with its
   * declared id + timestamps, skipping id/now auto-fill, so test
   * assertions can hard-code exact values.
   */
  seed(rows: readonly ContactEntity[]): void {
    const insert = this.db.transaction((entries: readonly ContactEntity[]) => {
      for (const r of entries) {
        this.stInsert.run({
          id: r.id,
          display_name: r.displayName,
          given_name: r.givenName,
          family_name: r.familyName,
          email: r.email,
          phone: r.phone,
          company: r.company,
          tags_json: JSON.stringify(canonicaliseTags(r.tags)),
          favorite: r.favorite ? 1 : 0,
          linked_task_ids_json: JSON.stringify(
            canonicaliseLinkedIds(r.linkedTaskIds),
          ),
          linked_note_ids_json: JSON.stringify(
            canonicaliseLinkedIds(r.linkedNoteIds),
          ),
          created_at: r.createdAt,
          updated_at: r.updatedAt,
        });
      }
    });
    insert(rows);
  }

  create(input: ContactCreateInput): ContactEntity {
    const now = this.now();
    const row: ContactEntity = {
      id: this.generateId(),
      displayName: input.displayName,
      givenName: input.givenName ?? null,
      familyName: input.familyName ?? null,
      email: input.email ?? null,
      phone: input.phone ?? null,
      company: input.company ?? null,
      tags: canonicaliseTags(input.tags),
      favorite: input.favorite,
      linkedTaskIds: canonicaliseLinkedIds(input.linkedTaskIds),
      linkedNoteIds: canonicaliseLinkedIds(input.linkedNoteIds),
      createdAt: now,
      updatedAt: now,
    };
    this.stInsert.run({
      id: row.id,
      display_name: row.displayName,
      given_name: row.givenName,
      family_name: row.familyName,
      email: row.email,
      phone: row.phone,
      company: row.company,
      tags_json: JSON.stringify(row.tags),
      favorite: row.favorite ? 1 : 0,
      linked_task_ids_json: JSON.stringify(row.linkedTaskIds),
      linked_note_ids_json: JSON.stringify(row.linkedNoteIds),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
    return row;
  }

  get(id: string): ContactEntity | null {
    const row = this.stGet.get(id) as ContactRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  update(id: string, patch: ContactUpdatePatch): ContactEntity | null {
    const existing = this.stGet.get(id) as ContactRow | undefined;
    if (!existing) return null;

    const fields: string[] = [];
    const bind: Record<string, unknown> = { id };

    if (patch.displayName !== undefined) {
      fields.push('display_name = @display_name');
      bind.display_name = patch.displayName;
    }
    if (patch.givenName !== undefined) {
      fields.push('given_name = @given_name');
      bind.given_name = patch.givenName;
    }
    if (patch.familyName !== undefined) {
      fields.push('family_name = @family_name');
      bind.family_name = patch.familyName;
    }
    if (patch.email !== undefined) {
      fields.push('email = @email');
      bind.email = patch.email;
    }
    if (patch.phone !== undefined) {
      fields.push('phone = @phone');
      bind.phone = patch.phone;
    }
    if (patch.company !== undefined) {
      fields.push('company = @company');
      bind.company = patch.company;
    }
    if (patch.tags !== undefined) {
      fields.push('tags_json = @tags_json');
      bind.tags_json = JSON.stringify(canonicaliseTags(patch.tags));
    }
    if (patch.favorite !== undefined) {
      fields.push('favorite = @favorite');
      bind.favorite = patch.favorite ? 1 : 0;
    }
    if (patch.linkedTaskIds !== undefined) {
      fields.push('linked_task_ids_json = @linked_task_ids_json');
      bind.linked_task_ids_json = JSON.stringify(
        canonicaliseLinkedIds(patch.linkedTaskIds),
      );
    }
    if (patch.linkedNoteIds !== undefined) {
      fields.push('linked_note_ids_json = @linked_note_ids_json');
      bind.linked_note_ids_json = JSON.stringify(
        canonicaliseLinkedIds(patch.linkedNoteIds),
      );
    }

    // refine() on the schema already guarantees ≥1 field. Defense-in-depth:
    if (fields.length === 0) {
      throw new ContactStoreError(
        'update: patch must include at least one field',
      );
    }

    const now = this.now();
    fields.push('updated_at = @updated_at');
    bind.updated_at = now;

    const sql = `UPDATE contacts SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(bind);
    const updated = this.stGet.get(id) as ContactRow;
    return rowToEntity(updated);
  }

  delete(id: string): boolean {
    const res = this.stDelete.run(id);
    return res.changes > 0;
  }

  /**
   * Add or remove a single id on a linked-id array. Idempotent:
   * adding an id already present is a no-op; removing an id that
   * wasn't there is a no-op. Both still bump `updatedAt` when the
   * array actually changed (an effective mutation); no-ops leave
   * `updatedAt` alone so repeated link calls don't churn the timestamp.
   * Returns `null` when the contact doesn't exist.
   */
  link(
    id: string,
    kind: ContactLinkKind,
    targetId: string,
    op: ContactLinkOp,
  ): ContactEntity | null {
    const existing = this.stGet.get(id) as ContactRow | undefined;
    if (!existing) return null;

    const column =
      kind === 'task' ? 'linked_task_ids_json' : 'linked_note_ids_json';
    const prev = JSON.parse(existing[column]) as string[];

    let next: string[];
    if (op === 'add') {
      next = prev.includes(targetId) ? prev : [...prev, targetId];
    } else {
      next = prev.includes(targetId)
        ? prev.filter((x) => x !== targetId)
        : prev;
    }

    if (next === prev) {
      // add-that-was-already-present OR remove-of-absent-id: both
      // branches above return `prev` by reference, so a strict-equal
      // check is the no-op signal. Leave `updatedAt` untouched.
      return rowToEntity(existing);
    }

    const now = this.now();
    this.db
      .prepare(
        `UPDATE contacts SET ${column} = @val, updated_at = @updated_at WHERE id = @id`,
      )
      .run({ id, val: JSON.stringify(next), updated_at: now });
    const updated = this.stGet.get(id) as ContactRow;
    return rowToEntity(updated);
  }

  list(opts: {
    readonly filter?: ContactFilter;
    readonly sort?: ContactSort;
    readonly cursor?: string;
    readonly limit?: number;
  }): { items: ContactEntity[]; nextCursor?: string } {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    const f = opts.filter;
    if (f?.tags && f.tags.length > 0) {
      f.tags.forEach((t, i) => {
        bind[`tag${i}`] = t;
        where.push(
          `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = @tag${i})`,
        );
      });
    }
    if (f?.favorite !== undefined) {
      where.push('favorite = @favorite');
      bind.favorite = f.favorite ? 1 : 0;
    }
    if (f?.company !== undefined) {
      where.push('company = @company');
      bind.company = f.company;
    }
    if (f?.hasEmail !== undefined) {
      where.push(f.hasEmail ? 'email IS NOT NULL' : 'email IS NULL');
    }
    if (f?.hasPhone !== undefined) {
      where.push(f.hasPhone ? 'phone IS NOT NULL' : 'phone IS NULL');
    }

    if (opts.cursor !== undefined) {
      const decoded = decodeCursor(opts.cursor);
      if (!decoded) {
        throw new ContactStoreError('list: invalid cursor');
      }
      where.push('(created_at, id) > (@cursorCreatedAt, @cursorId)');
      bind.cursorCreatedAt = decoded.createdAt;
      bind.cursorId = decoded.id;
    }

    const sort = opts.sort;
    const limit = opts.limit ?? 50;

    let orderBy: string;
    if (sort?.field === 'displayName') {
      const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
      orderBy = `display_name COLLATE NOCASE ${dir}, created_at ASC, id ASC`;
    } else if (sort?.field === 'updatedAt') {
      const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
      orderBy = `updated_at ${dir}, created_at DESC, id ASC`;
    } else if (sort?.field === 'favorite') {
      // Favorite first by default; direction flips.
      const favoriteDir = sort.direction === 'asc' ? 'ASC' : 'DESC';
      orderBy = `favorite ${favoriteDir}, display_name COLLATE NOCASE ASC, id ASC`;
    } else {
      // Default + explicit 'createdAt'. `asc` is the natural order for
      // an address book ("oldest first, chronological"); flipping to
      // `desc` yields recent-first.
      const dir = sort?.direction === 'desc' ? 'DESC' : 'ASC';
      orderBy = `created_at ${dir}, id ASC`;
    }

    const sql = `
      SELECT * FROM contacts
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT @limit
    `;
    bind.limit = limit + 1; // over-fetch by 1 to detect hasMore
    const rows = this.db.prepare(sql).all(bind) as ContactRow[];

    let nextCursor: string | undefined;
    let items = rows;
    if (rows.length > limit) {
      items = rows.slice(0, limit);
      const last = items[items.length - 1];
      if (last) {
        nextCursor = encodeCursor({
          createdAt: last.created_at,
          id: last.id,
        });
      }
    }

    return {
      items: items.map(rowToEntity),
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }

  /**
   * Tri-field search (displayName OR email OR company), case-insensitive,
   * with optional filter composition. The wider-than-Notes search
   * surface is the Contacts-vs-Notes blueprint-signal differentiator —
   * an agent asking "find alice@example.com" hits email only; "find
   * Acme" hits company only; "find Alice" hits displayName only.
   */
  search(opts: {
    readonly query: string;
    readonly filter?: ContactFilter;
    readonly limit?: number;
  }): { items: ContactEntity[]; totalMatches: number } {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    where.push(
      '(display_name LIKE @q COLLATE NOCASE' +
        ' OR email LIKE @q COLLATE NOCASE' +
        ' OR company LIKE @q COLLATE NOCASE)',
    );
    bind.q = `%${opts.query}%`;

    const f = opts.filter;
    if (f?.tags && f.tags.length > 0) {
      f.tags.forEach((t, i) => {
        bind[`tag${i}`] = t;
        where.push(
          `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = @tag${i})`,
        );
      });
    }
    if (f?.favorite !== undefined) {
      where.push('favorite = @favorite');
      bind.favorite = f.favorite ? 1 : 0;
    }
    if (f?.company !== undefined) {
      where.push('company = @company');
      bind.company = f.company;
    }
    if (f?.hasEmail !== undefined) {
      where.push(f.hasEmail ? 'email IS NOT NULL' : 'email IS NULL');
    }
    if (f?.hasPhone !== undefined) {
      where.push(f.hasPhone ? 'phone IS NOT NULL' : 'phone IS NULL');
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM contacts ${whereSql}`)
      .get(bind) as { n: number };

    const limit = opts.limit ?? 50;
    bind.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT * FROM contacts ${whereSql} ORDER BY display_name COLLATE NOCASE ASC, id ASC LIMIT @limit`,
      )
      .all(bind) as ContactRow[];

    return {
      items: rows.map(rowToEntity),
      totalMatches: totalRow.n,
    };
  }
}
