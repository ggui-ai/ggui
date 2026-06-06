/**
 * InMemoryGguiSessionStore — reference implementation of {@link GguiSessionStore}.
 *
 * Intended for tests, dev, and the OSS `@ggui-ai/mcp-server` in its
 * zero-config mode. No persistence, no cross-process fanout. Append
 * is in-process atomic: `seq` is allocated under the single-threaded
 * JS turn and is gap-free within a render.
 *
 * Production bindings (SQLite, Postgres LISTEN/NOTIFY, DDB+AppSync)
 * ship as separate packages and MUST pass `gguiSessionStoreContract`.
 */
import type { GguiSession } from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  CommitGguiSessionInput,
  CreateGguiSessionInput,
  ObserveOptions,
  GguiSessionEvent,
  GguiSessionFilter,
  GguiSessionPatch,
  GguiSessionStore,
  StoredGguiSession,
} from '../ggui-session-store.js';

interface RenderBucket {
  stored: StoredGguiSession;
  events: GguiSessionEvent[];
  /** Tail subscribers waiting for the next event or for `delete`. */
  waiters: Array<(e: GguiSessionEvent | null) => void>;
}

export interface InMemoryGguiSessionStoreOptions {
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
  /** Id generator. Defaults to a counter-based "render-N" id. */
  idGenerator?: () => string;
  /**
   * Default render TTL in ms. Defaults to "effectively infinite"
   * (`Number.MAX_SAFE_INTEGER` ms ≈ 285k years) — renders persist
   * indefinitely unless the operator opts into a finite TTL. Chat
   * conversations on hosted clients (Claude.ai, ChatGPT) routinely
   * span weeks of inactivity; reaping a render because the agent
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

export class InMemoryGguiSessionStore implements GguiSessionStore {
  private readonly buckets = new Map<string, RenderBucket>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;
  private idCounter = 0;

  constructor(opts: InMemoryGguiSessionStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `render-${++this.idCounter}`);
    this.defaultTtlMs = opts.defaultTtlMs ?? EFFECTIVELY_INFINITE_TTL_MS;
  }

  async create(input: CreateGguiSessionInput): Promise<StoredGguiSession> {
    const id = input.id ?? this.idGenerator();
    if (this.buckets.has(id)) {
      throw new Error(
        `InMemoryGguiSessionStore.create: render already exists: ${id}`,
      );
    }
    const t = this.now();
    // Placeholder ComponentGguiSession — the visible-bits surface fills in
    // when `commit` runs at `ggui_render` time. The create path exists
    // so callers can mint a row + start streaming events before the
    // first commit.
    const placeholder: GguiSession = {
      type: 'component',
      id,
      appId: input.appId,
      componentCode: '',
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
    };
    const stored: StoredGguiSession = {
      id,
      appId: input.appId,
      userId: input.userId,
      ...(input.endUserIdentity
        ? { endUserIdentity: input.endUserIdentity }
        : {}),
      ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
      ...(input.hostSession !== undefined
        ? { hostSession: input.hostSession }
        : {}),
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
      render: placeholder,
    };
    this.buckets.set(id, { stored, events: [], waiters: [] });
    return cloneStored(stored);
  }

  async get(id: string): Promise<StoredGguiSession | null> {
    const bucket = this.buckets.get(id);
    if (!bucket) return null;
    return cloneStored(withStatus(bucket.stored, this.now()));
  }

  async list(filter: GguiSessionFilter): Promise<StoredGguiSession[]> {
    const now = this.now();
    const out: StoredGguiSession[] = [];
    for (const bucket of this.buckets.values()) {
      const s = bucket.stored;
      if (filter.appId !== undefined && s.appId !== filter.appId) continue;
      if (filter.userId !== undefined && s.userId !== filter.userId) continue;
      if (filter.createdAfter !== undefined && s.createdAt <= filter.createdAfter) continue;
      if (filter.createdBefore !== undefined && s.createdAt >= filter.createdBefore) continue;
      if (filter.status !== undefined) {
        if (computeStatus(s, now) !== filter.status) continue;
      }
      if (
        filter.hostName !== undefined
        && s.hostSession?.hostName !== filter.hostName
      ) continue;
      if (
        filter.hostSessionId !== undefined
        && s.hostSession?.hostSessionId !== filter.hostSessionId
      ) continue;
      out.push(cloneStored(s));
    }
    // Stable, predictable ordering for test assertions: createdAt ASC, id tiebreak.
    out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    // Cursor is opaque — we encode `offset:N`. Implementations MAY encode
    // differently; the contract only requires round-trip correctness.
    const offset = parseCursor(filter.cursor);
    const limit = filter.limit ?? out.length;
    return out.slice(offset, offset + limit);
  }

  async update(id: string, patch: GguiSessionPatch): Promise<StoredGguiSession> {
    const bucket = this.buckets.get(id);
    if (!bucket) {
      throw new Error(`InMemoryGguiSessionStore.update: render not found: ${id}`);
    }
    const merged: StoredGguiSession = {
      ...bucket.stored,
      ...(patch.lastActivityAt !== undefined
        ? { lastActivityAt: patch.lastActivityAt }
        : {}),
      ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
      ...(patch.hostContext !== undefined
        ? { hostContext: patch.hostContext }
        : {}),
    };
    bucket.stored = merged;
    return cloneStored(merged);
  }

  async delete(id: string): Promise<void> {
    const bucket = this.buckets.get(id);
    if (!bucket) return;
    // Wake any tail waiters with null — the iterable ends cleanly.
    for (const waiter of bucket.waiters.splice(0)) waiter(null);
    this.buckets.delete(id);
  }

  async commit(input: CommitGguiSessionInput): Promise<StoredGguiSession> {
    const { render: incoming } = input;
    const existing = this.buckets.get(incoming.id);
    const t = this.now();
    if (existing) {
      // Replace visible-bits surface; preserve lifecycle fields owned
      // by the store (createdAt, eventSequence, identity slice captured
      // at create time).
      const merged: StoredGguiSession = {
        ...existing.stored,
        lastActivityAt: t,
        render: incoming,
      };
      existing.stored = merged;
      return cloneStored(merged);
    }
    // First-write — mint a fresh bucket using the supplied lifecycle slice.
    const stored: StoredGguiSession = {
      id: incoming.id,
      appId: input.appId,
      userId: input.userId,
      ...(input.endUserIdentity ? { endUserIdentity: input.endUserIdentity } : {}),
      ...(input.themeId !== undefined ? { themeId: input.themeId } : {}),
      ...(input.hostSession !== undefined ? { hostSession: input.hostSession } : {}),
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
      render: incoming,
    };
    this.buckets.set(stored.id, {
      stored,
      events: [],
      waiters: [],
    });
    return cloneStored(stored);
  }

  async appendEvent(input: AppendEventInput): Promise<number> {
    const bucket = this.buckets.get(input.sessionId);
    if (!bucket) {
      throw new Error(
        `InMemoryGguiSessionStore.appendEvent: render not found: ${input.sessionId}`,
      );
    }
    const seq = bucket.stored.eventSequence + 1;
    const nowMs = this.now();
    const event: GguiSessionEvent = {
      seq,
      type: input.type,
      timestamp: new Date(nowMs).toISOString(),
      data: input.data,
    };
    bucket.events.push(event);
    bucket.stored = {
      ...bucket.stored,
      eventSequence: seq,
      lastActivityAt: nowMs,
    };
    // Fan out to all waiters in FIFO order.
    for (const waiter of bucket.waiters.splice(0)) waiter(event);
    return seq;
  }

  async listEventsSince(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly GguiSessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return null;
    // In-memory keeps every event for the render's lifetime — no
    // horizon eviction. `horizonSeq=0` ⇒ full history is always
    // replayable for as long as the render lives in the bucket.
    const horizonSeq = 0;
    const lastSequence = bucket.stored.eventSequence;
    if (sinceSeq < horizonSeq) {
      return { events: [], lastSequence, hasMore: false, horizonSeq };
    }
    const filtered: GguiSessionEvent[] = [];
    for (const event of bucket.events) {
      if (event.seq <= sinceSeq) continue;
      if (filtered.length >= limit) {
        return { events: filtered, lastSequence, hasMore: true, horizonSeq };
      }
      filtered.push(event);
    }
    return { events: filtered, lastSequence, hasMore: false, horizonSeq };
  }

  observe(id: string, opts: ObserveOptions = {}): AsyncIterable<GguiSessionEvent> {
    const fromSeq = opts.fromSeq ?? 1;
    const tail = opts.tail ?? true;
    const getBucket = (): RenderBucket | undefined => this.buckets.get(id);
    return {
      [Symbol.asyncIterator](): AsyncIterator<GguiSessionEvent> {
        let nextSeq = fromSeq;
        let done = false;
        return {
          async next(): Promise<IteratorResult<GguiSessionEvent>> {
            if (done) return { value: undefined, done: true };
            const bucket = getBucket();
            if (!bucket) {
              done = true;
              return { value: undefined, done: true };
            }
            const backlog = bucket.events.find((e) => e.seq >= nextSeq);
            if (backlog) {
              nextSeq = backlog.seq + 1;
              return { value: backlog, done: false };
            }
            if (!tail) {
              done = true;
              return { value: undefined, done: true };
            }
            const event = await new Promise<GguiSessionEvent | null>((resolve) => {
              bucket.waiters.push(resolve);
            });
            if (event === null) {
              done = true;
              return { value: undefined, done: true };
            }
            nextSeq = event.seq + 1;
            return { value: event, done: false };
          },
          async return(): Promise<IteratorResult<GguiSessionEvent>> {
            done = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

function cloneStored(s: StoredGguiSession): StoredGguiSession {
  return {
    ...s,
    ...(s.endUserIdentity
      ? { endUserIdentity: { ...s.endUserIdentity } }
      : {}),
    render: s.render,
  };
}

function withStatus(s: StoredGguiSession, now: number): StoredGguiSession {
  return { ...s, status: computeStatus(s, now) };
}

function computeStatus(
  s: StoredGguiSession,
  now: number,
): 'active' | 'expired' {
  if (s.expiresAt <= now) return 'expired';
  return 'active';
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const match = cursor.match(/^offset:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
