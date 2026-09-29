/**
 * SqliteGguiSessionStreamBuffer — file-backed {@link GguiSessionStreamBuffer}
 * (ggui#1534).
 *
 * The in-memory buffer keeps a session's `seq` counter in process memory,
 * so a server that keeps its sessions across a restart (the SQLite session
 * store) starts every session's stream again at `seq` 1, in a new epoch.
 * That is detectable (SPEC §12.2.1 invariant 4's MUST holds) but misses
 * its SHOULD: a session's `seq` should not restart for the render's
 * lifetime. This buffer keeps the counter, its epoch and the retained
 * envelopes in SQLite, so after a restart a session continues its `seq`
 * in the same epoch and a reconnecting client replays what it missed.
 *
 * ## Storage layout
 *
 *   - `stream_counters(session_id PK, seq, epoch, evicted_above_seq)`:
 *     one row per session that has recorded, created with a fresh epoch
 *     and deleted by `clear`.
 *   - `stream_envelopes(session_id, seq, channel, slot, envelope JSON,
 *     PRIMARY KEY (session_id, seq))`: the retained envelopes. `slot` is
 *     `'latest'` (one row per channel) or `'all'` (the per-session ring,
 *     capped by `maxPerSession`, oldest evicted first).
 *
 * The table names do not collide with the session store's, so both can
 * live in one database file (pass the same `filename`, or share a
 * `database` handle).
 *
 * ## Concurrency
 *
 * Every `record` reads and advances the counter and writes its envelope
 * inside one `BEGIN IMMEDIATE` transaction. SQLite's single writer then
 * serializes producers across connections, so two processes on one file
 * share one gap-free counter and one epoch; `better-sqlite3`'s busy
 * timeout makes the second writer wait instead of failing.
 *
 * ## Rows are narrowed, never asserted
 *
 * The database file is operator-mutable, so every read narrows the row
 * and the stored envelope structurally and refuses a malformed one
 * loudly, as the session store does.
 */
import { randomUUID } from 'node:crypto';
import Database, {
  type Database as SqliteDatabase,
  type Statement as SqliteStatement,
} from 'better-sqlite3';
import {
  DEFAULT_STREAM_REPLAY_POLICY,
  isKnownReservedChannel,
  isRecord,
  makeStreamEnvelope,
  resolveStreamChannel,
} from '@ggui-ai/protocol';
import type { JsonValue, StreamChannelMode, StreamSpec } from '@ggui-ai/protocol';
import {
  DEFAULT_SESSION_STREAM_BUFFER_MAX,
  type BufferedStreamEnvelope,
  type GguiSessionStreamBuffer,
  type GguiSessionStreamBufferOptions,
  type RecordResult,
  type ReplayResult,
  type StreamCursor,
  type StreamEnvelopeInput,
} from '../ggui-session-stream-buffer.js';

export interface SqliteGguiSessionStreamBufferOptions extends GguiSessionStreamBufferOptions {
  /**
   * SQLite database file path. `:memory:` gives an ephemeral buffer (a
   * test double of the in-memory one). Default:
   * `./ggui-sessions.sqlite`, the session store's default, so the two
   * share a file unless told otherwise.
   */
  readonly filename?: string;
  /**
   * An existing `better-sqlite3` handle, e.g. the one the session store
   * uses. The buffer never closes a handle it was given. Wins over
   * `filename` when both are passed.
   */
  readonly database?: SqliteDatabase;
}

interface CounterRow {
  readonly seq: number;
  readonly epoch: string;
  readonly evicted_above_seq: number;
}

interface EnvelopeRow {
  readonly seq: number;
  readonly channel: string;
  readonly envelope: string;
}

type Slot = 'latest' | 'all';

/** Every stream channel mode, keyed so a mode added to the protocol fails to compile here until it is listed. */
const STREAM_CHANNEL_MODES: Readonly<Record<StreamChannelMode, true>> = { append: true, replace: true };

export class SqliteGguiSessionStreamBuffer implements GguiSessionStreamBuffer {
  private readonly db: SqliteDatabase;
  private readonly ownsDatabase: boolean;
  private readonly maxPerSession: number;
  private readonly stmts: {
    getCounter: SqliteStatement<unknown[]>;
    insertCounter: SqliteStatement<unknown[]>;
    bumpCounter: SqliteStatement<unknown[]>;
    setEvictedAbove: SqliteStatement<unknown[]>;
    deleteCounter: SqliteStatement<unknown[]>;
    insertEnvelope: SqliteStatement<unknown[]>;
    deleteLatestForChannel: SqliteStatement<unknown[]>;
    countRing: SqliteStatement<unknown[]>;
    oldestRing: SqliteStatement<unknown[]>;
    deleteEnvelope: SqliteStatement<unknown[]>;
    deleteEnvelopes: SqliteStatement<unknown[]>;
    ringAfter: SqliteStatement<unknown[]>;
    latestForChannel: SqliteStatement<unknown[]>;
    countAll: SqliteStatement<unknown[]>;
  };

  constructor(opts: SqliteGguiSessionStreamBufferOptions = {}) {
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_SESSION_STREAM_BUFFER_MAX;
    if (this.maxPerSession < 1) {
      throw new Error(`SqliteGguiSessionStreamBuffer: maxPerSession must be >= 1, got ${this.maxPerSession}`);
    }
    if (opts.database) {
      this.db = opts.database;
      this.ownsDatabase = false;
    } else {
      this.db = new Database(opts.filename ?? './ggui-sessions.sqlite');
      this.ownsDatabase = true;
    }
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stream_counters (
        session_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        epoch TEXT NOT NULL,
        evicted_above_seq INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS stream_envelopes (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        channel TEXT NOT NULL,
        slot TEXT NOT NULL CHECK (slot IN ('latest', 'all')),
        envelope TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_stream_envelopes_slot_channel
        ON stream_envelopes (session_id, slot, channel);
    `);
    this.stmts = {
      getCounter: this.db.prepare('SELECT seq, epoch, evicted_above_seq FROM stream_counters WHERE session_id = ?'),
      insertCounter: this.db.prepare(
        'INSERT INTO stream_counters (session_id, seq, epoch, evicted_above_seq) VALUES (?, 1, ?, 0)',
      ),
      bumpCounter: this.db.prepare('UPDATE stream_counters SET seq = seq + 1 WHERE session_id = ?'),
      setEvictedAbove: this.db.prepare(
        'UPDATE stream_counters SET evicted_above_seq = MAX(evicted_above_seq, ?) WHERE session_id = ?',
      ),
      deleteCounter: this.db.prepare('DELETE FROM stream_counters WHERE session_id = ?'),
      insertEnvelope: this.db.prepare(
        'INSERT INTO stream_envelopes (session_id, seq, channel, slot, envelope) VALUES (?, ?, ?, ?, ?)',
      ),
      deleteLatestForChannel: this.db.prepare(
        "DELETE FROM stream_envelopes WHERE session_id = ? AND slot = 'latest' AND channel = ?",
      ),
      countRing: this.db.prepare("SELECT COUNT(*) AS n FROM stream_envelopes WHERE session_id = ? AND slot = 'all'"),
      oldestRing: this.db.prepare(
        "SELECT seq FROM stream_envelopes WHERE session_id = ? AND slot = 'all' ORDER BY seq ASC LIMIT ?",
      ),
      deleteEnvelope: this.db.prepare('DELETE FROM stream_envelopes WHERE session_id = ? AND seq = ?'),
      deleteEnvelopes: this.db.prepare('DELETE FROM stream_envelopes WHERE session_id = ?'),
      ringAfter: this.db.prepare(
        "SELECT seq, channel, envelope FROM stream_envelopes WHERE session_id = ? AND slot = 'all' AND seq > ? ORDER BY seq ASC",
      ),
      latestForChannel: this.db.prepare(
        "SELECT seq, channel, envelope FROM stream_envelopes WHERE session_id = ? AND slot = 'latest' AND channel = ?",
      ),
      countAll: this.db.prepare('SELECT COUNT(*) AS n FROM stream_envelopes'),
    };
  }

  async record(input: StreamEnvelopeInput, spec?: StreamSpec): Promise<RecordResult> {
    // Same policy resolution as the in-memory reference: a known reserved
    // channel is always kept ('all'); anything else follows its declared
    // replay, or the default ('none') when undeclared.
    const policy = isKnownReservedChannel(input.channel)
      ? 'all'
      : (resolveStreamChannel(spec, input.channel)?.replay ?? DEFAULT_STREAM_REPLAY_POLICY);

    const txn = this.db.transaction((): RecordResult => {
      const existing = asCounterRow(this.stmts.getCounter.get(input.sessionId));
      let seq: number;
      let epoch: string;
      if (existing) {
        this.stmts.bumpCounter.run(input.sessionId);
        seq = existing.seq + 1;
        epoch = existing.epoch;
      } else {
        // A new counter is a new epoch (ggui#1531): 32 hex characters, 122 random bits.
        epoch = randomUUID().replace(/-/g, '');
        this.stmts.insertCounter.run(input.sessionId, epoch);
        seq = 1;
      }
      const stamped = makeStreamEnvelope({
        sessionId: input.sessionId,
        seq,
        streamEpoch: epoch,
        channel: input.channel,
        mode: input.mode,
        payload: input.payload,
        ...(input.complete !== undefined ? { complete: input.complete } : {}),
      });
      const envelope: BufferedStreamEnvelope = { ...stamped, seq };

      switch (policy) {
        case 'none':
          return { envelope, buffered: false };
        case 'latest':
          this.stmts.deleteLatestForChannel.run(input.sessionId, input.channel);
          this.store(envelope, 'latest');
          return { envelope, buffered: true };
        case 'all': {
          this.store(envelope, 'all');
          // Trim to THIS instance's cap, however far over it the ring is: a
          // ring filled under a larger cap (an earlier run, or another
          // connection on the file) comes back to the cap on its next record.
          const excess = asCount(this.stmts.countRing.get(input.sessionId)) - this.maxPerSession;
          if (excess > 0) {
            const evicted = this.stmts.oldestRing.all(input.sessionId, excess).map(requireSeqRow);
            for (const row of evicted) this.stmts.deleteEnvelope.run(input.sessionId, row.seq);
            const highest = evicted.reduce((max, row) => Math.max(max, row.seq), 0);
            if (highest > 0) this.stmts.setEvictedAbove.run(highest, input.sessionId);
          }
          return { envelope, buffered: true };
        }
        default: {
          const _exhaustive: never = policy;
          throw new Error(`Unhandled replay policy: ${String(_exhaustive)}`);
        }
      }
    });
    return txn.immediate();
  }

  async replay(sessionId: string, fromSeq: number | undefined, spec?: StreamSpec): Promise<ReplayResult> {
    const counter = asCounterRow(this.stmts.getCounter.get(sessionId));
    if (!counter) return { envelopes: [], truncated: false, streamSeq: 0 };
    const cursor = { streamSeq: counter.seq, streamEpoch: counter.epoch };
    // A fresh subscribe (no fromSeq) pulls no history.
    if (fromSeq === undefined) return { envelopes: [], truncated: false, ...cursor };

    const collected: BufferedStreamEnvelope[] = [];
    let truncated = false;
    const ring = this.stmts.ringAfter.all(sessionId, fromSeq).map(requireEnvelopeRow);
    // Known reserved channels are kept whatever the spec declares, so they
    // replay whatever it declares; declared channels follow their policy.
    for (const row of ring) {
      if (isKnownReservedChannel(row.channel)) collected.push(parseEnvelope(row, sessionId));
    }
    for (const channelName of Object.keys(spec ?? {})) {
      const policy = resolveStreamChannel(spec, channelName)?.replay ?? DEFAULT_STREAM_REPLAY_POLICY;
      switch (policy) {
        case 'none':
          break;
        case 'latest': {
          const row = asEnvelopeRow(this.stmts.latestForChannel.get(sessionId, channelName));
          if (row && row.seq > fromSeq) collected.push(parseEnvelope(row, sessionId));
          break;
        }
        case 'all': {
          if (fromSeq < counter.evicted_above_seq) truncated = true;
          for (const row of ring) {
            if (row.channel === channelName) collected.push(parseEnvelope(row, sessionId));
          }
          break;
        }
        default: {
          const _exhaustive: never = policy;
          throw new Error(`Unhandled replay policy: ${String(_exhaustive)}`);
        }
      }
    }
    // Only the current epoch's generation replays (ggui#1531). Every row
    // this buffer writes carries the counter's epoch and `clear` removes a
    // generation whole, so this drops only rows written from outside.
    const current = collected.filter((e) => e.streamEpoch === counter.epoch);
    current.sort((a, b) => a.seq - b.seq);
    return { envelopes: current, truncated, ...cursor };
  }

  async currentSeq(sessionId: string): Promise<number> {
    return asCounterRow(this.stmts.getCounter.get(sessionId))?.seq ?? 0;
  }

  async currentCursor(sessionId: string): Promise<StreamCursor> {
    const counter = asCounterRow(this.stmts.getCounter.get(sessionId));
    return counter ? { seq: counter.seq, epoch: counter.epoch } : { seq: 0 };
  }

  async clear(sessionId: string): Promise<void> {
    this.db
      .transaction((): void => {
        this.stmts.deleteEnvelopes.run(sessionId);
        this.stmts.deleteCounter.run(sessionId);
      })
      .immediate();
  }

  async getSize(): Promise<number> {
    return asCount(this.stmts.countAll.get());
  }

  /** Close the database when this buffer opened it; a shared handle stays open. */
  close(): void {
    if (this.ownsDatabase) this.db.close();
  }

  private store(envelope: BufferedStreamEnvelope, slot: Slot): void {
    this.stmts.insertEnvelope.run(envelope.sessionId, envelope.seq, envelope.channel, slot, JSON.stringify(envelope));
  }
}

function malformed(table: string, detail: string): Error {
  return new Error(`SqliteGguiSessionStreamBuffer: malformed ${table} row (${detail})`);
}

function asCounterRow(raw: unknown): CounterRow | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw malformed('stream_counters', 'not an object');
  const { seq, epoch, evicted_above_seq } = raw;
  if (typeof seq !== 'number' || typeof epoch !== 'string' || typeof evicted_above_seq !== 'number') {
    throw malformed('stream_counters', 'column types');
  }
  return { seq, epoch, evicted_above_seq };
}

function asEnvelopeRow(raw: unknown): EnvelopeRow | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw malformed('stream_envelopes', 'not an object');
  const { seq, channel, envelope } = raw;
  if (typeof seq !== 'number' || typeof channel !== 'string' || typeof envelope !== 'string') {
    throw malformed('stream_envelopes', 'column types');
  }
  return { seq, channel, envelope };
}

function requireEnvelopeRow(raw: unknown): EnvelopeRow {
  const row = asEnvelopeRow(raw);
  if (!row) throw malformed('stream_envelopes', 'missing');
  return row;
}

function requireSeqRow(raw: unknown): { readonly seq: number } {
  if (!isRecord(raw) || typeof raw.seq !== 'number') throw malformed('stream_envelopes', 'seq');
  return { seq: raw.seq };
}

function asCount(raw: unknown): number {
  if (!isRecord(raw) || typeof raw.n !== 'number') throw malformed('count', 'n');
  return raw.n;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
}

function isStreamChannelMode(value: unknown): value is StreamChannelMode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STREAM_CHANNEL_MODES, value);
}

/** Narrow a stored envelope back to the shape `record` returned, refusing anything else. */
function parseEnvelope(row: EnvelopeRow, sessionId: string): BufferedStreamEnvelope {
  const parsed: unknown = JSON.parse(row.envelope);
  if (!isRecord(parsed)) throw malformed('stream_envelopes', 'envelope is not an object');
  const { seq, channel, mode, payload, complete, schemaVersion, streamEpoch } = parsed;
  if (
    parsed.sessionId !== sessionId ||
    seq !== row.seq ||
    channel !== row.channel ||
    !isStreamChannelMode(mode) ||
    !isJsonValue(payload) ||
    (complete !== undefined && typeof complete !== 'boolean') ||
    (schemaVersion !== undefined && typeof schemaVersion !== 'string') ||
    (streamEpoch !== undefined && typeof streamEpoch !== 'string')
  ) {
    throw malformed('stream_envelopes', `envelope fields at seq ${row.seq}`);
  }
  return {
    sessionId,
    seq: row.seq,
    channel: row.channel,
    mode,
    payload,
    ...(complete !== undefined ? { complete } : {}),
    ...(schemaVersion !== undefined ? { schemaVersion } : {}),
    ...(streamEpoch !== undefined ? { streamEpoch } : {}),
  };
}
