/**
 * InMemorySessionStore — reference implementation of {@link SessionStore}.
 *
 * Intended for tests, dev, and the OSS `@ggui-ai/mcp-server` in its
 * zero-config mode. No persistence, no cross-process fanout. Append
 * is in-process atomic: `seq` is allocated under the single-threaded
 * JS turn and is gap-free within a session.
 *
 * Production bindings (SQLite, Postgres LISTEN/NOTIFY, DDB+AppSync)
 * ship as separate packages and MUST pass `sessionStoreContract`.
 */
import type { Session } from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  CreateSessionInput,
  ObserveOptions,
  SessionEvent,
  SessionFilter,
  SessionPatch,
  SessionStore,
} from '../session-store.js';

interface SessionBucket {
  session: Session;
  events: SessionEvent[];
  /** Terminal `session.closed` has been written — no further appends allowed. */
  closed: boolean;
  /** Tail subscribers waiting for the next event or terminal close. */
  waiters: Array<(e: SessionEvent | null) => void>;
}

export interface InMemorySessionStoreOptions {
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
  /** Id generator. Defaults to a counter-based "sess-N" id. */
  idGenerator?: () => string;
  /**
   * Default session TTL in ms. Defaults to "effectively infinite"
   * (`Number.MAX_SAFE_INTEGER` ms ≈ 285k years) — sessions persist
   * indefinitely unless the operator opts into a finite TTL. Chat
   * conversations on hosted clients (Claude.ai, ChatGPT) routinely
   * span weeks of inactivity; reaping a session because the agent
   * paused for 7 days would surface as a `session_not_found` error
   * to a freshly-resumed agent. Monetization-driven expiration is a
   * separate concern (gated by quota/billing, not TTL).
   *
   * Pass a finite ms value to enable TTL eviction (e.g. `7 * 24 * 60
   * * 60 * 1000` for the prior 7-day default).
   */
  defaultTtlMs?: number;
}

/** Sentinel for "effectively infinite" TTL — `Number.MAX_SAFE_INTEGER` ms. */
const EFFECTIVELY_INFINITE_TTL_MS = Number.MAX_SAFE_INTEGER;

export class InMemorySessionStore implements SessionStore {
  private readonly buckets = new Map<string, SessionBucket>();
  /**
   * Secondary index: stackItemId → owning session metadata. Maintained
   * incrementally on `appendStackItem` (insert / replace) and cleared
   * en-bloc on `delete`. Lookup powers `ggui_update`'s stackItemId-only
   * input shape (no sessionId on the wire — the server resolves it).
   */
  private readonly pageIndex = new Map<
    string,
    { readonly sessionId: string; readonly appId: string }
  >();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;
  private idCounter = 0;

  constructor(opts: InMemorySessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `sess-${++this.idCounter}`);
    this.defaultTtlMs = opts.defaultTtlMs ?? EFFECTIVELY_INFINITE_TTL_MS;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const id = input.id ?? this.idGenerator();
    if (this.buckets.has(id)) {
      throw new Error(
        `InMemorySessionStore.create: session already exists: ${id}`,
      );
    }
    const t = this.now();
    const session: Session = {
      id,
      appId: input.appId,
      userId: input.userId,
      ...(input.endUserIdentity
        ? { endUserIdentity: input.endUserIdentity }
        : {}),
      ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
      stack: [],
      currentStackIndex: -1,
      adapterPermissions: {},
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
    };
    this.buckets.set(id, { session, events: [], closed: false, waiters: [] });
    return cloneSession(session);
  }

  async get(id: string): Promise<Session | null> {
    const bucket = this.buckets.get(id);
    if (!bucket) return null;
    const cloned = cloneSession(bucket.session);
    cloned.status = computeStatus(bucket.session, bucket.closed, this.now());
    return cloned;
  }

  async list(filter: SessionFilter): Promise<Session[]> {
    const now = this.now();
    const out: Session[] = [];
    for (const bucket of this.buckets.values()) {
      const s = bucket.session;
      if (filter.appId !== undefined && s.appId !== filter.appId) continue;
      if (filter.userId !== undefined && s.userId !== filter.userId) continue;
      if (filter.createdAfter !== undefined && s.createdAt <= filter.createdAfter) continue;
      if (filter.createdBefore !== undefined && s.createdAt >= filter.createdBefore) continue;
      if (filter.status !== undefined) {
        if (computeStatus(s, bucket.closed, now) !== filter.status) continue;
      }
      out.push(cloneSession(s));
    }
    // Stable, predictable ordering for test assertions: createdAt ASC, id tiebreak.
    out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    // Cursor is opaque — we encode `offset:N`. Implementations MAY encode
    // differently; the contract only requires round-trip correctness.
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? out.length;
    return out.slice(offset, offset + limit);
  }

  async update(id: string, patch: SessionPatch): Promise<Session> {
    const bucket = this.buckets.get(id);
    if (!bucket) {
      throw new Error(`InMemorySessionStore.update: session not found: ${id}`);
    }
    if (patch.lastActivityAt !== undefined) bucket.session.lastActivityAt = patch.lastActivityAt;
    if (patch.expiresAt !== undefined) bucket.session.expiresAt = patch.expiresAt;
    // metadata is not on the Session protocol type today; implementations
    // that need it layer it onto their own storage shape. We keep the
    // patch parameter accepted so the contract test can exercise the
    // write path without failing for unknown-field reasons.
    if (patch.hostContext !== undefined) bucket.session.hostContext = patch.hostContext;
    if (patch.mcpAppsMode !== undefined) bucket.session.mcpAppsMode = patch.mcpAppsMode;
    if (patch.canvasLoaded !== undefined) bucket.session.canvasLoaded = patch.canvasLoaded;
    // `null` clears the field — used when
    // the user pops to an empty navStack so the next ggui_consume
    // falls back to the legacy active-item resolution (currentStackIndex).
    if (patch.activeStackItemId !== undefined) {
      if (patch.activeStackItemId === null) {
        delete bucket.session.activeStackItemId;
      } else {
        bucket.session.activeStackItemId = patch.activeStackItemId;
      }
    }
    return cloneSession(bucket.session);
  }

  async delete(id: string): Promise<void> {
    const bucket = this.buckets.get(id);
    if (!bucket) return;
    // Wake any tail waiters with null — the iterable ends cleanly.
    for (const waiter of bucket.waiters.splice(0)) waiter(null);
    // Drop pageIndex entries owned by this session — keeps the
    // secondary index from leaking entries to stale sessions.
    for (const item of bucket.session.stack) {
      const indexed = this.pageIndex.get(item.id);
      if (indexed && indexed.sessionId === id) {
        this.pageIndex.delete(item.id);
      }
    }
    this.buckets.delete(id);
  }

  async getSessionByStackItemId(
    stackItemId: string,
  ): Promise<{ readonly sessionId: string; readonly appId: string } | null> {
    const entry = this.pageIndex.get(stackItemId);
    if (!entry) return null;
    // Defensive read: confirm the owning session still exists. The
    // index SHOULD always be in lockstep with `buckets` (delete
    // cleans both), but a torn write would surface as a stale
    // pageIndex entry — return null so callers don't dereference
    // a vanished session.
    return this.buckets.has(entry.sessionId) ? entry : null;
  }

  async appendStackItem(
    sessionId: string,
    entry: import('@ggui-ai/protocol').SessionStackEntry,
  ): Promise<Session> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) {
      throw new Error(
        `InMemorySessionStore.appendStackItem: session not found: ${sessionId}`,
      );
    }
    if (bucket.closed) {
      throw new Error(
        `InMemorySessionStore.appendStackItem: session is closed: ${sessionId}`,
      );
    }
    // Upsert by id — see SessionStore.appendStackItem JSDoc for the why.
    const existingIdx = bucket.session.stack.findIndex(
      (existing) => existing.id === entry.id,
    );
    if (existingIdx >= 0) {
      bucket.session.stack[existingIdx] = entry;
      bucket.session.currentStackIndex = existingIdx;
    } else {
      bucket.session.stack.push(entry);
      bucket.session.currentStackIndex = bucket.session.stack.length - 1;
    }
    // Maintain the stackItemId secondary index. Reuse-replace keeps the
    // same (sessionId, appId) pair so this is idempotent on
    // re-upsert; first-time-write inserts.
    this.pageIndex.set(entry.id, {
      sessionId,
      appId: bucket.session.appId,
    });
    bucket.session.lastActivityAt = this.now();
    return cloneSession(bucket.session);
  }

  async popStackItem(
    sessionId: string,
  ): Promise<{ readonly poppedId: string | null; readonly stackSize: number }> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) {
      throw new Error(
        `InMemorySessionStore.popStackItem: session not found: ${sessionId}`,
      );
    }
    if (bucket.closed) {
      throw new Error(
        `InMemorySessionStore.popStackItem: session is closed: ${sessionId}`,
      );
    }
    if (bucket.session.stack.length === 0) {
      // Idempotent at bottom — bump activity but no mutation otherwise.
      bucket.session.lastActivityAt = this.now();
      return { poppedId: null, stackSize: 0 };
    }
    const popped = bucket.session.stack[bucket.session.stack.length - 1]!;
    bucket.session.stack.pop();
    // Remove the popped id from the secondary index so a subsequent
    // getSessionByStackItemId returns null for it.
    this.pageIndex.delete(popped.id);
    bucket.session.currentStackIndex = Math.max(
      0,
      bucket.session.stack.length - 1,
    );
    bucket.session.lastActivityAt = this.now();
    return {
      poppedId: popped.id,
      stackSize: bucket.session.stack.length,
    };
  }

  async appendEvent(input: AppendEventInput): Promise<number> {
    const bucket = this.buckets.get(input.sessionId);
    if (!bucket) {
      throw new Error(
        `InMemorySessionStore.appendEvent: session not found: ${input.sessionId}`,
      );
    }
    if (bucket.closed) {
      throw new Error(
        `InMemorySessionStore.appendEvent: session is closed: ${input.sessionId}`,
      );
    }
    const seq = bucket.session.eventSequence + 1;
    const event: SessionEvent = {
      seq,
      type: input.type,
      timestamp: this.now(),
      data: input.data,
    };
    bucket.events.push(event);
    bucket.session.eventSequence = seq;
    bucket.session.lastActivityAt = event.timestamp;
    if (input.type === 'session.closed') bucket.closed = true;
    // Fan out to all waiters in FIFO order.
    for (const waiter of bucket.waiters.splice(0)) waiter(event);
    return seq;
  }

  async listEventsSince(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly SessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return null;
    // In-memory keeps every event for the session's lifetime — no
    // horizon eviction. `horizonSeq=0` ⇒ full history is always
    // replayable for as long as the session lives in the bucket.
    const horizonSeq = 0;
    const lastSequence = bucket.session.eventSequence;
    if (sinceSeq < horizonSeq) {
      return { events: [], lastSequence, hasMore: false, horizonSeq };
    }
    const filtered: SessionEvent[] = [];
    for (const event of bucket.events) {
      if (event.seq <= sinceSeq) continue;
      if (filtered.length >= limit) {
        return { events: filtered, lastSequence, hasMore: true, horizonSeq };
      }
      filtered.push(event);
    }
    return { events: filtered, lastSequence, hasMore: false, horizonSeq };
  }

  observe(id: string, opts: ObserveOptions = {}): AsyncIterable<SessionEvent> {
    const fromSeq = opts.fromSeq ?? 1;
    const tail = opts.tail ?? true;
    const getBucket = (): SessionBucket | undefined => this.buckets.get(id);
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionEvent> {
        let nextSeq = fromSeq;
        let done = false;
        return {
          async next(): Promise<IteratorResult<SessionEvent>> {
            if (done) return { value: undefined, done: true };
            const bucket = getBucket();
            if (!bucket) {
              done = true;
              return { value: undefined, done: true };
            }
            const backlog = bucket.events.find((e) => e.seq >= nextSeq);
            if (backlog) {
              nextSeq = backlog.seq + 1;
              if (backlog.type === 'session.closed') done = true;
              return { value: backlog, done: false };
            }
            if (!tail || bucket.closed) {
              done = true;
              return { value: undefined, done: true };
            }
            const event = await new Promise<SessionEvent | null>((resolve) => {
              bucket.waiters.push(resolve);
            });
            if (event === null) {
              done = true;
              return { value: undefined, done: true };
            }
            nextSeq = event.seq + 1;
            if (event.type === 'session.closed') done = true;
            return { value: event, done: false };
          },
          async return(): Promise<IteratorResult<SessionEvent>> {
            done = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

function cloneSession(s: Session): Session {
  return {
    ...s,
    stack: s.stack.slice(),
    adapterPermissions: { ...s.adapterPermissions },
    ...(s.endUserIdentity ? { endUserIdentity: { ...s.endUserIdentity } } : {}),
  };
}

function computeStatus(
  s: Session,
  closed: boolean,
  now: number,
): 'active' | 'completed' | 'expired' {
  if (closed) return 'completed';
  if (s.expiresAt <= now) return 'expired';
  return 'active';
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
