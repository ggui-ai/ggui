/**
 * InMemoryRenderStore — reference implementation of {@link RenderStore}.
 *
 * Intended for tests, dev, and the OSS `@ggui-ai/mcp-server` in its
 * zero-config mode. No persistence, no cross-process fanout. Append
 * is in-process atomic: `seq` is allocated under the single-threaded
 * JS turn and is gap-free within a render.
 *
 * Production bindings (SQLite, Postgres LISTEN/NOTIFY, DDB+AppSync)
 * ship as separate packages and MUST pass `renderStoreContract`.
 */
import type { Render } from '@ggui-ai/protocol';
import type {
  AppendEventInput,
  CommitRenderInput,
  CreateRenderInput,
  ObserveOptions,
  RenderEvent,
  RenderFilter,
  RenderPatch,
  RenderStore,
  StoredRender,
} from '../render-store.js';

interface RenderBucket {
  stored: StoredRender;
  events: RenderEvent[];
  /** Terminal `session.closed` has been written — no further appends allowed. */
  closed: boolean;
  /** Tail subscribers waiting for the next event or terminal close. */
  waiters: Array<(e: RenderEvent | null) => void>;
}

export interface InMemoryRenderStoreOptions {
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
   * paused for 7 days would surface as a `render_not_found` error
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

export class InMemoryRenderStore implements RenderStore {
  private readonly buckets = new Map<string, RenderBucket>();
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly defaultTtlMs: number;
  private idCounter = 0;

  constructor(opts: InMemoryRenderStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idGenerator = opts.idGenerator ?? (() => `render-${++this.idCounter}`);
    this.defaultTtlMs = opts.defaultTtlMs ?? EFFECTIVELY_INFINITE_TTL_MS;
  }

  async create(input: CreateRenderInput): Promise<StoredRender> {
    const id = input.id ?? this.idGenerator();
    if (this.buckets.has(id)) {
      throw new Error(
        `InMemoryRenderStore.create: render already exists: ${id}`,
      );
    }
    const t = this.now();
    // Placeholder ComponentRender — the visible-bits surface fills in
    // when `commit` runs at `ggui_render` time. The create path exists
    // so callers can mint a row + start streaming events before the
    // first commit (mirrors the pre-Phase-B create→appendStackItem flow).
    const placeholder: Render = {
      type: 'component',
      id,
      appId: input.appId,
      componentCode: '',
      eventSequence: 0,
      createdAt: t,
      lastActivityAt: t,
      expiresAt: t + this.defaultTtlMs,
    };
    const stored: StoredRender = {
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
    this.buckets.set(id, { stored, events: [], closed: false, waiters: [] });
    return cloneStored(stored);
  }

  async get(id: string): Promise<StoredRender | null> {
    const bucket = this.buckets.get(id);
    if (!bucket) return null;
    return cloneStored(withStatus(bucket.stored, bucket.closed, this.now()));
  }

  async list(filter: RenderFilter): Promise<StoredRender[]> {
    const now = this.now();
    const out: StoredRender[] = [];
    for (const bucket of this.buckets.values()) {
      const s = bucket.stored;
      if (filter.appId !== undefined && s.appId !== filter.appId) continue;
      if (filter.userId !== undefined && s.userId !== filter.userId) continue;
      if (filter.createdAfter !== undefined && s.createdAt <= filter.createdAfter) continue;
      if (filter.createdBefore !== undefined && s.createdAt >= filter.createdBefore) continue;
      if (filter.status !== undefined) {
        if (computeStatus(s, bucket.closed, now) !== filter.status) continue;
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

  async update(id: string, patch: RenderPatch): Promise<StoredRender> {
    const bucket = this.buckets.get(id);
    if (!bucket) {
      throw new Error(`InMemoryRenderStore.update: render not found: ${id}`);
    }
    const merged: StoredRender = {
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

  async commit(input: CommitRenderInput): Promise<StoredRender> {
    const { render: incoming } = input;
    const existing = this.buckets.get(incoming.id);
    const t = this.now();
    if (existing) {
      if (existing.closed) {
        throw new Error(
          `InMemoryRenderStore.commit: render is closed: ${incoming.id}`,
        );
      }
      // Replace visible-bits surface; preserve lifecycle fields owned
      // by the store (createdAt, eventSequence, identity slice captured
      // at create time).
      const merged: StoredRender = {
        ...existing.stored,
        lastActivityAt: t,
        render: incoming,
      };
      existing.stored = merged;
      return cloneStored(merged);
    }
    // First-write — mint a fresh bucket using the supplied lifecycle slice.
    const stored: StoredRender = {
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
      closed: false,
      waiters: [],
    });
    return cloneStored(stored);
  }

  async appendEvent(input: AppendEventInput): Promise<number> {
    const bucket = this.buckets.get(input.renderId);
    if (!bucket) {
      throw new Error(
        `InMemoryRenderStore.appendEvent: render not found: ${input.renderId}`,
      );
    }
    if (bucket.closed) {
      throw new Error(
        `InMemoryRenderStore.appendEvent: render is closed: ${input.renderId}`,
      );
    }
    const seq = bucket.stored.eventSequence + 1;
    const event: RenderEvent = {
      seq,
      type: input.type,
      timestamp: this.now(),
      data: input.data,
    };
    bucket.events.push(event);
    bucket.stored = {
      ...bucket.stored,
      eventSequence: seq,
      lastActivityAt: event.timestamp,
    };
    if (input.type === 'session.closed') bucket.closed = true;
    // Fan out to all waiters in FIFO order.
    for (const waiter of bucket.waiters.splice(0)) waiter(event);
    return seq;
  }

  async listEventsSince(
    renderId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly RenderEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null> {
    const bucket = this.buckets.get(renderId);
    if (!bucket) return null;
    // In-memory keeps every event for the render's lifetime — no
    // horizon eviction. `horizonSeq=0` ⇒ full history is always
    // replayable for as long as the render lives in the bucket.
    const horizonSeq = 0;
    const lastSequence = bucket.stored.eventSequence;
    if (sinceSeq < horizonSeq) {
      return { events: [], lastSequence, hasMore: false, horizonSeq };
    }
    const filtered: RenderEvent[] = [];
    for (const event of bucket.events) {
      if (event.seq <= sinceSeq) continue;
      if (filtered.length >= limit) {
        return { events: filtered, lastSequence, hasMore: true, horizonSeq };
      }
      filtered.push(event);
    }
    return { events: filtered, lastSequence, hasMore: false, horizonSeq };
  }

  observe(id: string, opts: ObserveOptions = {}): AsyncIterable<RenderEvent> {
    const fromSeq = opts.fromSeq ?? 1;
    const tail = opts.tail ?? true;
    const getBucket = (): RenderBucket | undefined => this.buckets.get(id);
    return {
      [Symbol.asyncIterator](): AsyncIterator<RenderEvent> {
        let nextSeq = fromSeq;
        let done = false;
        return {
          async next(): Promise<IteratorResult<RenderEvent>> {
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
            const event = await new Promise<RenderEvent | null>((resolve) => {
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
          async return(): Promise<IteratorResult<RenderEvent>> {
            done = true;
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}

function cloneStored(s: StoredRender): StoredRender {
  return {
    ...s,
    ...(s.endUserIdentity
      ? { endUserIdentity: { ...s.endUserIdentity } }
      : {}),
    render: s.render,
  };
}

function withStatus(s: StoredRender, closed: boolean, now: number): StoredRender {
  return { ...s, status: computeStatus(s, closed, now) };
}

function computeStatus(
  s: StoredRender,
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
