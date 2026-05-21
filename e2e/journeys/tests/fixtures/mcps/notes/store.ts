/**
 * NotesStore — sqlite-backed CRUD + search for the Notes MCP fixture.
 *
 * Domain-driven shape departures from `../tasks/store.ts` (reference):
 *
 *   - Two JSON columns: `tags_json` (string[]) + `linked_task_ids_json`
 *     (string[]). sqlite has no native arrays and we want sub-millisecond
 *     reads, so arrays are serialised on write, deserialised on read.
 *     Both serialisations are canonicalised (sorted, deduped) — tag
 *     equality is set-equality, not array-equality, and stable storage
 *     makes filter predicates cheap.
 *   - `pinned` stored as INTEGER 0/1 (sqlite convention). The getter
 *     coerces back to `boolean`.
 *   - Search matches title **or** body substring (case-insensitive).
 *     Richer surface than Tasks' title-only LIKE — this is how Notes
 *     differentiates from Tasks at the blueprint-signal level.
 *   - `appendBody(id, markdown)` — the domain-specific op. Appends
 *     `\n\n<markdown>` to `body` (or just `<markdown>` when body is
 *     empty) + bumps `updatedAt`. Paragraph separator matches markdown
 *     rendering semantics so two appends render as two paragraphs.
 *
 * Everything else (WAL, :memory: default, clock+id injection,
 * `reset()` / `seed()`, cursor pagination on `(createdAt, id)`) mirrors
 * the Tasks store — the pattern is deliberately stable.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  NoteCreateInput,
  NoteEntity,
  NoteFilter,
  NoteSort,
  NoteUpdatePatch,
} from './schema.js';

export interface NotesStoreOptions {
  /** sqlite file path. Defaults to `:memory:` — ephemeral, test-friendly. */
  readonly filename?: string;
  /** Alternative: pass an existing better-sqlite3 handle. */
  readonly database?: SqliteDatabase;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
  /** ID generator injection for deterministic tests. */
  readonly generateId?: () => string;
}

export class NoteStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteStoreError';
  }
}

type NoteRow = {
  id: string;
  title: string;
  body: string;
  tags_json: string;
  pinned: number;
  about_contact_id: string | null;
  linked_task_ids_json: string;
  created_at: number;
  updated_at: number;
};

function canonicaliseTags(tags: readonly string[]): string[] {
  return Array.from(new Set(tags)).sort();
}

function canonicaliseLinkedIds(ids: readonly string[]): string[] {
  // Preserve insertion order but drop duplicates. Tests assert on
  // link-order, so we don't sort here.
  return Array.from(new Set(ids));
}

function rowToEntity(r: NoteRow): NoteEntity {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    tags: JSON.parse(r.tags_json) as string[],
    pinned: r.pinned !== 0,
    aboutContactId: r.about_contact_id,
    linkedTaskIds: JSON.parse(r.linked_task_ids_json) as string[],
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

export class NotesStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly generateId: () => string;

  private readonly stInsert: SqliteStatement;
  private readonly stGet: SqliteStatement;
  private readonly stDelete: SqliteStatement;
  private readonly stDeleteAll: SqliteStatement;

  constructor(opts: NotesStoreOptions = {}) {
    this.db = opts.database ?? new Database(opts.filename ?? ':memory:');
    this.now = opts.now ?? Date.now;
    this.generateId = opts.generateId ?? randomUUID;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        body                 TEXT NOT NULL,
        tags_json            TEXT NOT NULL,
        pinned               INTEGER NOT NULL CHECK (pinned IN (0,1)),
        about_contact_id     TEXT,
        linked_task_ids_json TEXT NOT NULL,
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_pinned        ON notes(pinned);
      CREATE INDEX IF NOT EXISTS idx_notes_about_contact ON notes(about_contact_id);
      CREATE INDEX IF NOT EXISTS idx_notes_created       ON notes(created_at);
      CREATE INDEX IF NOT EXISTS idx_notes_updated       ON notes(updated_at);
    `);

    this.stInsert = this.db.prepare(
      `INSERT INTO notes
        (id,title,body,tags_json,pinned,about_contact_id,linked_task_ids_json,created_at,updated_at)
       VALUES
        (@id,@title,@body,@tags_json,@pinned,@about_contact_id,@linked_task_ids_json,@created_at,@updated_at)`,
    );
    this.stGet = this.db.prepare(`SELECT * FROM notes WHERE id = ?`);
    this.stDelete = this.db.prepare(`DELETE FROM notes WHERE id = ?`);
    this.stDeleteAll = this.db.prepare(`DELETE FROM notes`);
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
  seed(rows: readonly NoteEntity[]): void {
    const insert = this.db.transaction((entries: readonly NoteEntity[]) => {
      for (const r of entries) {
        this.stInsert.run({
          id: r.id,
          title: r.title,
          body: r.body,
          tags_json: JSON.stringify(canonicaliseTags(r.tags)),
          pinned: r.pinned ? 1 : 0,
          about_contact_id: r.aboutContactId,
          linked_task_ids_json: JSON.stringify(
            canonicaliseLinkedIds(r.linkedTaskIds),
          ),
          created_at: r.createdAt,
          updated_at: r.updatedAt,
        });
      }
    });
    insert(rows);
  }

  create(input: NoteCreateInput): NoteEntity {
    const now = this.now();
    const row: NoteEntity = {
      id: this.generateId(),
      title: input.title,
      body: input.body,
      tags: canonicaliseTags(input.tags),
      pinned: input.pinned,
      aboutContactId: input.aboutContactId ?? null,
      linkedTaskIds: canonicaliseLinkedIds(input.linkedTaskIds),
      createdAt: now,
      updatedAt: now,
    };
    this.stInsert.run({
      id: row.id,
      title: row.title,
      body: row.body,
      tags_json: JSON.stringify(row.tags),
      pinned: row.pinned ? 1 : 0,
      about_contact_id: row.aboutContactId,
      linked_task_ids_json: JSON.stringify(row.linkedTaskIds),
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
    return row;
  }

  get(id: string): NoteEntity | null {
    const row = this.stGet.get(id) as NoteRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  update(id: string, patch: NoteUpdatePatch): NoteEntity | null {
    const existing = this.stGet.get(id) as NoteRow | undefined;
    if (!existing) return null;

    const fields: string[] = [];
    const bind: Record<string, unknown> = { id };

    if (patch.title !== undefined) {
      fields.push('title = @title');
      bind.title = patch.title;
    }
    if (patch.body !== undefined) {
      fields.push('body = @body');
      bind.body = patch.body;
    }
    if (patch.tags !== undefined) {
      fields.push('tags_json = @tags_json');
      bind.tags_json = JSON.stringify(canonicaliseTags(patch.tags));
    }
    if (patch.pinned !== undefined) {
      fields.push('pinned = @pinned');
      bind.pinned = patch.pinned ? 1 : 0;
    }
    if (patch.aboutContactId !== undefined) {
      fields.push('about_contact_id = @about_contact_id');
      bind.about_contact_id = patch.aboutContactId;
    }
    if (patch.linkedTaskIds !== undefined) {
      fields.push('linked_task_ids_json = @linked_task_ids_json');
      bind.linked_task_ids_json = JSON.stringify(
        canonicaliseLinkedIds(patch.linkedTaskIds),
      );
    }

    // refine() on the schema already guarantees ≥1 field. Defense-in-depth:
    if (fields.length === 0) {
      throw new NoteStoreError('update: patch must include at least one field');
    }

    const now = this.now();
    fields.push('updated_at = @updated_at');
    bind.updated_at = now;

    const sql = `UPDATE notes SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(bind);
    const updated = this.stGet.get(id) as NoteRow;
    return rowToEntity(updated);
  }

  delete(id: string): boolean {
    const res = this.stDelete.run(id);
    return res.changes > 0;
  }

  /**
   * Append markdown to an existing note's body. Body gets a `\n\n`
   * paragraph separator between the old content and the new chunk
   * (unless body was empty — in which case the chunk becomes the
   * body directly). Also bumps `updatedAt`. Returns `null` when the
   * note doesn't exist.
   */
  appendBody(id: string, markdown: string): NoteEntity | null {
    const existing = this.stGet.get(id) as NoteRow | undefined;
    if (!existing) return null;
    const newBody =
      existing.body.length === 0 ? markdown : `${existing.body}\n\n${markdown}`;
    const now = this.now();
    this.db
      .prepare(
        `UPDATE notes SET body = @body, updated_at = @updated_at WHERE id = @id`,
      )
      .run({ id, body: newBody, updated_at: now });
    const updated = this.stGet.get(id) as NoteRow;
    return rowToEntity(updated);
  }

  list(opts: {
    readonly filter?: NoteFilter;
    readonly sort?: NoteSort;
    readonly cursor?: string;
    readonly limit?: number;
  }): { items: NoteEntity[]; nextCursor?: string } {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    const f = opts.filter;
    if (f?.tags && f.tags.length > 0) {
      // sqlite doesn't understand arrays; use JSON functions. Every
      // declared tag must be present.
      f.tags.forEach((t, i) => {
        bind[`tag${i}`] = t;
        where.push(
          `EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = @tag${i})`,
        );
      });
    }
    if (f?.pinned !== undefined) {
      where.push('pinned = @pinned');
      bind.pinned = f.pinned ? 1 : 0;
    }
    if (f?.aboutContactId !== undefined) {
      where.push('about_contact_id = @aboutContactId');
      bind.aboutContactId = f.aboutContactId;
    }
    if (f?.updatedBefore !== undefined) {
      where.push('updated_at < @updatedBefore');
      bind.updatedBefore = f.updatedBefore;
    }
    if (f?.updatedOnOrAfter !== undefined) {
      where.push('updated_at >= @updatedOnOrAfter');
      bind.updatedOnOrAfter = f.updatedOnOrAfter;
    }

    if (opts.cursor !== undefined) {
      const decoded = decodeCursor(opts.cursor);
      if (!decoded) {
        throw new NoteStoreError('list: invalid cursor');
      }
      where.push('(created_at, id) > (@cursorCreatedAt, @cursorId)');
      bind.cursorCreatedAt = decoded.createdAt;
      bind.cursorId = decoded.id;
    }

    const sort = opts.sort;
    const limit = opts.limit ?? 50;

    let orderBy: string;
    if (sort?.field === 'updatedAt') {
      const dir = sort.direction === 'asc' ? 'ASC' : 'DESC';
      orderBy = `updated_at ${dir}, created_at DESC, id ASC`;
    } else if (sort?.field === 'pinned') {
      // Pinned first by default; direction flips the sense.
      const pinnedDir = sort.direction === 'asc' ? 'ASC' : 'DESC';
      orderBy = `pinned ${pinnedDir}, updated_at DESC, id ASC`;
    } else {
      // Default + explicit 'createdAt'. Default direction is DESC so
      // "most recent first" feels natural for a note list.
      const dir = sort?.direction === 'asc' ? 'ASC' : 'DESC';
      orderBy = `created_at ${dir}, id ASC`;
    }

    const sql = `
      SELECT * FROM notes
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT @limit
    `;
    bind.limit = limit + 1; // over-fetch by 1 to detect hasMore
    const rows = this.db.prepare(sql).all(bind) as NoteRow[];

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
   * Title **or** body substring search (case-insensitive). The richer
   * search surface vs Tasks' title-only is the blueprint-signal
   * differentiator — a Notes search result can have zero title
   * matches and still be legitimate if the body mentions the query.
   */
  search(opts: {
    readonly query: string;
    readonly filter?: NoteFilter;
    readonly limit?: number;
  }): { items: NoteEntity[]; totalMatches: number } {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    where.push('(title LIKE @q COLLATE NOCASE OR body LIKE @q COLLATE NOCASE)');
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
    if (f?.pinned !== undefined) {
      where.push('pinned = @pinned');
      bind.pinned = f.pinned ? 1 : 0;
    }
    if (f?.aboutContactId !== undefined) {
      where.push('about_contact_id = @aboutContactId');
      bind.aboutContactId = f.aboutContactId;
    }
    if (f?.updatedBefore !== undefined) {
      where.push('updated_at < @updatedBefore');
      bind.updatedBefore = f.updatedBefore;
    }
    if (f?.updatedOnOrAfter !== undefined) {
      where.push('updated_at >= @updatedOnOrAfter');
      bind.updatedOnOrAfter = f.updatedOnOrAfter;
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM notes ${whereSql}`)
      .get(bind) as { n: number };

    const limit = opts.limit ?? 50;
    bind.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT * FROM notes ${whereSql} ORDER BY updated_at DESC, id ASC LIMIT @limit`,
      )
      .all(bind) as NoteRow[];

    return {
      items: rows.map(rowToEntity),
      totalMatches: totalRow.n,
    };
  }
}
