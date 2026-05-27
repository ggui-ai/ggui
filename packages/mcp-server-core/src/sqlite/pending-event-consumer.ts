/**
 * `SqlitePendingEventConsumer` — file-backed reference implementation
 * of {@link PendingEventConsumer}.
 *
 * Ships as a persistent option for OSS hosts that want the pending-
 * events buffer to survive process restarts (the
 * {@link InMemoryPendingEventConsumer} doesn't). Cloud uses its own
 * Dynamo adapter; this one stays in `@ggui-ai/mcp-server-core` for
 * dev / single-process / on-prem self-hosters.
 *
 * ## Storage layout (renderId-keyed)
 *
 * Two tables. The on-disk column is `stack_item_id` for back-compat
 * with already-deployed sqlite databases; semantically it stores a
 * `renderId`.
 *
 *   - `pending_event_pipes(stack_item_id PK, status, last_activity_at,
 *     expires_at)` — per-pipe lifecycle row. Created via
 *     {@link markCreated}; status flipped via {@link markStatus};
 *     removed via {@link markDeleted}. Read on every
 *     `consumeAndClear` so the result carries the current status.
 *   - `pending_events(stack_item_id, seq, event_json, enqueued_at,
 *     PRIMARY KEY (stack_item_id, seq))` — FIFO buffer. `seq` is
 *     monotonic + gap-free per pipe; consumeAndClear drains then
 *     resets it back to 0 (the pipe can keep appending).
 *
 * Writes go through `BEGIN IMMEDIATE` transactions so concurrent
 * callers can't tear sequence state. The transaction is short — a
 * read + delete + update — and SQLite's WAL keeps reads from
 * blocking each other.
 *
 * ## Honest behavior notes
 *
 *   - `consumeAndClear` is atomic per-render: SELECT events,
 *     DELETE them, UPDATE the pipe activity row — all inside one
 *     transaction. Two racing consumers can't both see the same
 *     events; one sees all of them, the other sees empty.
 *   - `append` writes the next monotonic `seq` for the pipe under
 *     a transaction so concurrent appends preserve FIFO ordering.
 *   - `markCreated` is idempotent — calling on an existing pipe is
 *     a no-op rather than resetting state.
 *   - Cross-process fanout (e.g., second `ggui serve` reading the
 *     same database) is **not modeled** here. SQLite serializes
 *     writers; readers see the latest committed state on their next
 *     query. Long-poll loops on a separate process will see new
 *     events on the next poll cycle. Real-time fan-out across
 *     processes needs an external broker.
 */

import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import type { RenderStatus } from '@ggui-ai/protocol';
import {
  type PendingEventConsumeResult,
  type PendingEventConsumer,
  PendingPipeNotFoundError,
} from '../pending-event-consumer.js';

export interface SqlitePendingEventConsumerOptions {
  /**
   * Path to the SQLite database. Default:
   * `./ggui-pending-events.sqlite` (relative to process cwd).
   * Pass `':memory:'` for an ephemeral in-test instance.
   */
  filename?: string;
  /**
   * Optional pre-opened `better-sqlite3` Database instance. Lets
   * hosts share one connection between RenderStore and consumer.
   * Mutually exclusive with `filename`.
   */
  db?: SqliteDatabase;
  /**
   * Clock override for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

interface PipeRow {
  stack_item_id: string;
  status: RenderStatus;
  last_activity_at: number;
  expires_at: number;
}

interface EventRow {
  stack_item_id: string;
  seq: number;
  event_json: string;
  enqueued_at: number;
}

export class SqlitePendingEventConsumer implements PendingEventConsumer {
  private readonly db: SqliteDatabase;
  private readonly ownsDb: boolean;
  private readonly now: () => number;

  private readonly stmts: {
    getPipe: SqliteStatement<unknown[], PipeRow>;
    insertPipe: SqliteStatement<unknown[]>;
    updateActivity: SqliteStatement<unknown[]>;
    updateStatus: SqliteStatement<unknown[]>;
    deletePipe: SqliteStatement<unknown[]>;
    deleteEventsForPipe: SqliteStatement<unknown[]>;
    selectEventsForPipe: SqliteStatement<unknown[], EventRow>;
    insertEvent: SqliteStatement<unknown[]>;
    nextSeq: SqliteStatement<unknown[], { next_seq: number }>;
  };

  constructor(opts: SqlitePendingEventConsumerOptions = {}) {
    this.now = opts.now ?? Date.now;
    if (opts.db && opts.filename) {
      throw new Error(
        'SqlitePendingEventConsumer: pass either `db` or `filename`, not both',
      );
    }
    if (opts.db) {
      this.db = opts.db;
      this.ownsDb = false;
    } else {
      this.db = new Database(
        opts.filename ?? './ggui-pending-events.sqlite',
      );
      this.ownsDb = true;
    }
    // WAL keeps long-poll readers from blocking writers.
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA_SQL);
    this.stmts = {
      getPipe: this.db.prepare<unknown[], PipeRow>(
        `SELECT * FROM pending_event_pipes WHERE stack_item_id = ?`,
      ),
      insertPipe: this.db.prepare<unknown[]>(
        `INSERT OR IGNORE INTO pending_event_pipes
          (stack_item_id, status, last_activity_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ),
      updateActivity: this.db.prepare<unknown[]>(
        `UPDATE pending_event_pipes
         SET last_activity_at = ?, expires_at = ?
         WHERE stack_item_id = ?`,
      ),
      updateStatus: this.db.prepare<unknown[]>(
        `UPDATE pending_event_pipes SET status = ? WHERE stack_item_id = ?`,
      ),
      deletePipe: this.db.prepare<unknown[]>(
        `DELETE FROM pending_event_pipes WHERE stack_item_id = ?`,
      ),
      deleteEventsForPipe: this.db.prepare<unknown[]>(
        `DELETE FROM pending_events WHERE stack_item_id = ?`,
      ),
      selectEventsForPipe: this.db.prepare<unknown[], EventRow>(
        `SELECT * FROM pending_events WHERE stack_item_id = ? ORDER BY seq ASC`,
      ),
      insertEvent: this.db.prepare<unknown[]>(
        `INSERT INTO pending_events
          (stack_item_id, seq, event_json, enqueued_at)
         VALUES (?, ?, ?, ?)`,
      ),
      nextSeq: this.db.prepare<unknown[], { next_seq: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
         FROM pending_events WHERE stack_item_id = ?`,
      ),
    };
  }

  /** Close the backing database (only when this instance owns it). */
  close(): void {
    if (this.ownsDb) this.db.close();
  }

  async consumeAndClear(
    renderId: string,
    ttlMs: number,
  ): Promise<PendingEventConsumeResult> {
    const txn = this.db.transaction(() => {
      const pipe = this.stmts.getPipe.get(renderId);
      if (!pipe) {
        throw new PendingPipeNotFoundError(renderId);
      }
      const eventRows = this.stmts.selectEventsForPipe.all(renderId);
      this.stmts.deleteEventsForPipe.run(renderId);
      const t = this.now();
      this.stmts.updateActivity.run(t, t + ttlMs, renderId);
      return {
        events: eventRows.map((row) =>
          parseEventJson(row.event_json),
        ) as ReadonlyArray<Record<string, unknown>>,
        status: pipe.status,
      };
    });
    return txn();
  }

  async append(
    renderId: string,
    event: Record<string, unknown>,
  ): Promise<void> {
    const txn = this.db.transaction(() => {
      const pipe = this.stmts.getPipe.get(renderId);
      if (!pipe) {
        throw new PendingPipeNotFoundError(renderId);
      }
      const seqRow = this.stmts.nextSeq.get(renderId);
      const seq = seqRow?.next_seq ?? 1;
      const t = this.now();
      this.stmts.insertEvent.run(
        renderId,
        seq,
        JSON.stringify(event),
        t,
      );
      this.stmts.updateActivity.run(t, pipe.expires_at, renderId);
    });
    txn();
  }

  markCreated(renderId: string, ttlMs = Number.MAX_SAFE_INTEGER): void {
    const t = this.now();
    // INSERT OR IGNORE — idempotent on re-mark.
    this.stmts.insertPipe.run(renderId, 'active', t, t + ttlMs);
  }

  markStatus(renderId: string, status: RenderStatus): void {
    this.stmts.updateStatus.run(status, renderId);
  }

  markDeleted(renderId: string): void {
    const txn = this.db.transaction(() => {
      this.stmts.deleteEventsForPipe.run(renderId);
      this.stmts.deletePipe.run(renderId);
    });
    txn();
  }

  /** Inspector for tests: how many events are queued? */
  pendingCount(renderId: string): number {
    const rows = this.stmts.selectEventsForPipe.all(renderId);
    return rows.length;
  }
}

function parseEventJson(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pending_event_pipes (
  stack_item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'active',
  last_activity_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_events (
  stack_item_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (stack_item_id, seq),
  FOREIGN KEY (stack_item_id) REFERENCES pending_event_pipes(stack_item_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_events_pipe
  ON pending_events(stack_item_id, enqueued_at);
`;
