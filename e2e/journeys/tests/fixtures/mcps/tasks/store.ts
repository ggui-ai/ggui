/**
 * TasksStore — sqlite-backed CRUD + search for the tasks MCP fixture.
 *
 * Load-bearing choices:
 *
 *   - `better-sqlite3`, not `node:sqlite` — every other sqlite store in
 *     this repo uses it (`@ggui-ai/mcp-server-core/src/sqlite/*`), and
 *     the peer dep is already installed. Test-time default is
 *     `:memory:` so nothing touches the fs.
 *   - One table, no joins — the fixture proves "stateful with strict
 *     schema", not "production data model". A future Slice 6.2/6.3
 *     (notes/contacts) may link by id-reference-by-convention per
 *     strategy §18.
 *   - `reset()` truncates; `seed(fixture)` bulk-inserts. Tests call
 *     both between scenarios to keep state deterministic without
 *     reconstructing the whole store.
 *   - Cursor pagination uses a synthetic `(createdAt, id)` composite
 *     key encoded in base64. Keyset pagination is correct under
 *     concurrent inserts; offset pagination silently skips rows when
 *     the ordering key shifts.
 *
 * Search is a simple LIKE on title — the MCP fixture's job is to
 * exercise the blueprint-negotiator's decision-making over a
 * schema-heavy tool surface, NOT to be a production search engine.
 * Full-text search (FTS5) is an easy follow-up if we find the
 * negotiator needs richer signal.
 *
 * Error taxonomy:
 *
 *   - `TaskStoreError` for anything the caller could reasonably
 *     recover from — e.g. bad-input escaping past the zod parse.
 *     Not-found is NOT an error; it's signaled via `null` /
 *     `{ deleted: false }` in the output shape.
 *   - Input validation is the caller's job (tool handler parses with
 *     the `strictObject` alias before invoking the store). The store
 *     trusts its inputs; that's the strict boundary.
 */
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  TaskCreateInput,
  TaskEntity,
  TaskFilter,
  TaskPriority,
  TaskSort,
  TaskStatus,
  TaskUpdatePatch,
} from './schema.js';

export interface TasksStoreOptions {
  /** sqlite file path. Defaults to `:memory:` — ephemeral, test-friendly. */
  readonly filename?: string;
  /** Alternative: pass an existing better-sqlite3 handle. */
  readonly database?: SqliteDatabase;
  /** Clock injection for deterministic tests. */
  readonly now?: () => number;
  /**
   * ID generator injection for deterministic tests. Default is
   * `crypto.randomUUID`. Tests that assert on exact ids pass a
   * counter-style generator.
   */
  readonly generateId?: () => string;
}

export class TaskStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskStoreError';
  }
}

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee_id: string | null;
  due_date: string | null;
  linked_note_id: string | null;
  created_at: number;
  updated_at: number;
};

function rowToEntity(r: TaskRow): TaskEntity {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    assigneeId: r.assignee_id,
    dueDate: r.due_date,
    linkedNoteId: r.linked_note_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Priority collation — `high > medium > low` for ORDER BY. */
const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

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

export class TasksStore {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly generateId: () => string;

  private readonly stInsert: SqliteStatement;
  private readonly stGet: SqliteStatement;
  private readonly stDelete: SqliteStatement;
  private readonly stDeleteAll: SqliteStatement;

  constructor(opts: TasksStoreOptions = {}) {
    this.db = opts.database ?? new Database(opts.filename ?? ':memory:');
    this.now = opts.now ?? Date.now;
    this.generateId = opts.generateId ?? randomUUID;

    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id              TEXT PRIMARY KEY,
        title           TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('todo','doing','done','blocked')),
        priority        TEXT NOT NULL CHECK (priority IN ('low','medium','high')),
        assignee_id     TEXT,
        due_date        TEXT,
        linked_note_id  TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_created  ON tasks(created_at);
    `);

    this.stInsert = this.db.prepare(
      `INSERT INTO tasks (id,title,status,priority,assignee_id,due_date,linked_note_id,created_at,updated_at)
       VALUES (@id,@title,@status,@priority,@assignee_id,@due_date,@linked_note_id,@created_at,@updated_at)`,
    );
    this.stGet = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`);
    this.stDelete = this.db.prepare(`DELETE FROM tasks WHERE id = ?`);
    this.stDeleteAll = this.db.prepare(`DELETE FROM tasks`);
  }

  /** Close the underlying database. After this, all calls throw. */
  close(): void {
    this.db.close();
  }

  /** Drop every row. `seed()` and `reset()+seed()` are the test pattern. */
  reset(): void {
    this.stDeleteAll.run();
  }

  /**
   * Insert a deterministic fixture. Each row is inserted with its
   * declared id + createdAt — skipping the id/timestamp auto-fill — so
   * test assertions can hard-code exact values.
   */
  seed(rows: readonly TaskEntity[]): void {
    const insert = this.db.transaction((entries: readonly TaskEntity[]) => {
      for (const r of entries) {
        this.stInsert.run({
          id: r.id,
          title: r.title,
          status: r.status,
          priority: r.priority,
          assignee_id: r.assigneeId,
          due_date: r.dueDate,
          linked_note_id: r.linkedNoteId,
          created_at: r.createdAt,
          updated_at: r.updatedAt,
        });
      }
    });
    insert(rows);
  }

  create(input: TaskCreateInput): TaskEntity {
    const now = this.now();
    const row: TaskEntity = {
      id: this.generateId(),
      title: input.title,
      status: input.status,
      priority: input.priority,
      assigneeId: input.assigneeId ?? null,
      dueDate: input.dueDate ?? null,
      linkedNoteId: input.linkedNoteId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.stInsert.run({
      id: row.id,
      title: row.title,
      status: row.status,
      priority: row.priority,
      assignee_id: row.assigneeId,
      due_date: row.dueDate,
      linked_note_id: row.linkedNoteId,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    });
    return row;
  }

  get(id: string): TaskEntity | null {
    const row = this.stGet.get(id) as TaskRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  update(id: string, patch: TaskUpdatePatch): TaskEntity | null {
    const existing = this.stGet.get(id) as TaskRow | undefined;
    if (!existing) return null;

    const fields: string[] = [];
    const bind: Record<string, unknown> = { id };

    if (patch.title !== undefined) {
      fields.push('title = @title');
      bind.title = patch.title;
    }
    if (patch.status !== undefined) {
      fields.push('status = @status');
      bind.status = patch.status;
    }
    if (patch.priority !== undefined) {
      fields.push('priority = @priority');
      bind.priority = patch.priority;
    }
    if (patch.assigneeId !== undefined) {
      fields.push('assignee_id = @assignee_id');
      bind.assignee_id = patch.assigneeId;
    }
    if (patch.dueDate !== undefined) {
      fields.push('due_date = @due_date');
      bind.due_date = patch.dueDate;
    }
    if (patch.linkedNoteId !== undefined) {
      fields.push('linked_note_id = @linked_note_id');
      bind.linked_note_id = patch.linkedNoteId;
    }

    // refine() on the schema already guarantees ≥1 field. Defense-in-depth:
    if (fields.length === 0) {
      throw new TaskStoreError('update: patch must include at least one field');
    }

    const now = this.now();
    fields.push('updated_at = @updated_at');
    bind.updated_at = now;

    const sql = `UPDATE tasks SET ${fields.join(', ')} WHERE id = @id`;
    this.db.prepare(sql).run(bind);
    const updated = this.stGet.get(id) as TaskRow;
    return rowToEntity(updated);
  }

  delete(id: string): boolean {
    const res = this.stDelete.run(id);
    return res.changes > 0;
  }

  /** Status transition — the dedicated blueprint-signal tool. */
  complete(id: string): TaskEntity | null {
    return this.update(id, { status: 'done' });
  }

  list(opts: {
    readonly filter?: TaskFilter;
    readonly sort?: TaskSort;
    readonly cursor?: string;
    readonly limit?: number;
  }): { items: TaskEntity[]; nextCursor?: string } {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    const f = opts.filter;
    if (f?.status && f.status.length > 0) {
      const keys = f.status.map((_, i) => `@s${i}`);
      f.status.forEach((s, i) => (bind[`s${i}`] = s));
      where.push(`status IN (${keys.join(',')})`);
    }
    if (f?.assigneeId !== undefined) {
      where.push('assignee_id = @assigneeId');
      bind.assigneeId = f.assigneeId;
    }
    if (f?.priority && f.priority.length > 0) {
      const keys = f.priority.map((_, i) => `@p${i}`);
      f.priority.forEach((p, i) => (bind[`p${i}`] = p));
      where.push(`priority IN (${keys.join(',')})`);
    }
    if (f?.dueBefore !== undefined) {
      where.push('due_date IS NOT NULL AND due_date < @dueBefore');
      bind.dueBefore = f.dueBefore;
    }
    if (f?.dueOnOrAfter !== undefined) {
      where.push('due_date IS NOT NULL AND due_date >= @dueOnOrAfter');
      bind.dueOnOrAfter = f.dueOnOrAfter;
    }

    // Cursor: always tied to `(createdAt, id)` keyset for stability.
    if (opts.cursor !== undefined) {
      const decoded = decodeCursor(opts.cursor);
      if (!decoded) {
        throw new TaskStoreError('list: invalid cursor');
      }
      where.push('(created_at, id) > (@cursorCreatedAt, @cursorId)');
      bind.cursorCreatedAt = decoded.createdAt;
      bind.cursorId = decoded.id;
    }

    const sort = opts.sort;
    const limit = opts.limit ?? 50;

    // Priority sort needs the ranked collation; other fields are
    // directly orderable by column.
    let orderBy: string;
    if (sort?.field === 'priority') {
      const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
      orderBy = `CASE priority WHEN 'high' THEN ${PRIORITY_RANK.high} WHEN 'medium' THEN ${PRIORITY_RANK.medium} ELSE ${PRIORITY_RANK.low} END ${dir}, created_at ASC, id ASC`;
    } else if (sort?.field === 'dueDate') {
      const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
      // NULLs last regardless of direction so "tasks with due dates"
      // always cluster first when sorted by due date.
      orderBy = `CASE WHEN due_date IS NULL THEN 1 ELSE 0 END ASC, due_date ${dir}, created_at ASC, id ASC`;
    } else if (sort?.field === 'updatedAt') {
      const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
      orderBy = `updated_at ${dir}, created_at ASC, id ASC`;
    } else {
      // Default + `createdAt` case.
      const dir = sort?.direction === 'desc' ? 'DESC' : 'ASC';
      orderBy = `created_at ${dir}, id ASC`;
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${orderBy}
      LIMIT @limit
    `;
    bind.limit = limit + 1; // over-fetch by 1 to detect hasMore
    const rows = this.db.prepare(sql).all(bind) as TaskRow[];

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
   * Title LIKE search with optional filter composition. Returns full
   * matched rows up to `limit`, plus `totalMatches` (the unbounded
   * count) so the UI can show "showing N of M".
   */
  search(opts: {
    readonly query: string;
    readonly filter?: TaskFilter;
    readonly limit?: number;
  }): { items: TaskEntity[]; totalMatches: number } {
    const where: string[] = [];
    const bind: Record<string, unknown> = {};

    where.push('title LIKE @q COLLATE NOCASE');
    bind.q = `%${opts.query}%`;

    const f = opts.filter;
    if (f?.status && f.status.length > 0) {
      const keys = f.status.map((_, i) => `@s${i}`);
      f.status.forEach((s, i) => (bind[`s${i}`] = s));
      where.push(`status IN (${keys.join(',')})`);
    }
    if (f?.assigneeId !== undefined) {
      where.push('assignee_id = @assigneeId');
      bind.assigneeId = f.assigneeId;
    }
    if (f?.priority && f.priority.length > 0) {
      const keys = f.priority.map((_, i) => `@p${i}`);
      f.priority.forEach((p, i) => (bind[`p${i}`] = p));
      where.push(`priority IN (${keys.join(',')})`);
    }
    if (f?.dueBefore !== undefined) {
      where.push('due_date IS NOT NULL AND due_date < @dueBefore');
      bind.dueBefore = f.dueBefore;
    }
    if (f?.dueOnOrAfter !== undefined) {
      where.push('due_date IS NOT NULL AND due_date >= @dueOnOrAfter');
      bind.dueOnOrAfter = f.dueOnOrAfter;
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM tasks ${whereSql}`)
      .get(bind) as { n: number };

    const limit = opts.limit ?? 50;
    bind.limit = limit;
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks ${whereSql} ORDER BY created_at ASC, id ASC LIMIT @limit`,
      )
      .all(bind) as TaskRow[];

    return {
      items: rows.map(rowToEntity),
      totalMatches: totalRow.n,
    };
  }
}
