/**
 * Pure replay-policy operations — the stateless core of the
 * `SessionStreamBuffer` contract.
 *
 * These helpers drive both OSS (in-memory ring) and hosted (DDB-backed
 * Session row) implementations from a single set of rules. They take
 * the current buffer state as input and return the next state + the
 * stamped envelope — no IO, no allocation of storage adapters.
 *
 * Shape mirrors `@ggui-ai/mcp-server-core`'s `InMemorySessionStreamBuffer`
 * semantics one-for-one:
 *
 *   - `'none'`: seq is still assigned (so fan-out has a stable cursor),
 *     but nothing is buffered; a reconnecting subscriber sees nothing
 *     from this channel.
 *   - `'latest'`: single-slot per channel; the newest delivery
 *     supersedes any prior entry for the same channel. Never
 *     participates in cap-driven eviction.
 *   - `'all'`: append to a FIFO ring; evict the oldest entry when the
 *     ring exceeds `maxPerRender`. Tracks `evictedAboveSeq` so
 *     replay can honestly report `truncated` when a subscriber's
 *     `fromSeq` predates a dropped envelope.
 *
 * Why this lives in `@ggui-ai/mcp-server-handlers` (below core in the
 * layering): pure logic with no storage shape assumption, callable by
 * both the OSS `SessionStreamBuffer` adapter and the hosted Lambda/pod
 * DDB adapter. Keeps the replay contract single-source, independent
 * of where the buffer physically sits.
 *
 * No back-compat: the hosted rollout of this module is the FIRST
 * hosted replay path; there's nothing to bridge from.
 */
import type { JsonValue, StreamSpec } from '@ggui-ai/protocol';
import {
  DEFAULT_STREAM_REPLAY_POLICY,
  resolveStreamChannel,
  type StreamChannelMode,
} from '@ggui-ai/protocol';

/**
 * Producer-side input the ops accept. Peer of
 * `@ggui-ai/mcp-server-core.StreamEnvelopeInput` — kept here to avoid a
 * cross-layer import (handlers must NOT depend on core).
 */
export interface StreamReplayInput {
  readonly sessionId: string;
  readonly channel: string;
  readonly mode: StreamChannelMode;
  readonly payload: JsonValue;
  readonly complete?: boolean;
}

/**
 * Stamped + persistable envelope. Carries the assigned seq. Peer of
 * `@ggui-ai/mcp-server-core.BufferedStreamEnvelope`.
 *
 * Does NOT carry `sessionId` on the storage shape — that's redundant
 * (every buffer state is per-session by construction). Callers that
 * need a full wire `StreamEnvelope` upcast with `{sessionId, ...}`.
 */
export interface BufferedReplayEnvelope {
  readonly seq: number;
  readonly channel: string;
  readonly mode: StreamChannelMode;
  readonly payload: JsonValue;
  readonly complete?: boolean;
}

/**
 * Per-render replay state. Flat + serializable — every field maps
 * cleanly to a DDB column or AppSync custom-type field.
 *
 * Separation of `ring` vs `latestByChannel` matches the OSS in-memory
 * structure. `'latest'` entries NEVER participate in ring eviction —
 * they're held indefinitely, one per channel. `'all'` entries share
 * a FIFO ring capped by `maxPerRender`.
 */
export interface BufferState {
  /** Latest assigned seq for the session. 0 when never recorded. */
  readonly streamSeq: number;
  /** FIFO ring of envelopes for channels with `replay: 'all'`. */
  readonly ring: readonly BufferedReplayEnvelope[];
  /**
   * Single-slot cache keyed by channel for `replay: 'latest'`. Map
   * shape serializes to `Record<string, BufferedReplayEnvelope>` in
   * JSON-backed stores.
   */
  readonly latestByChannel: Readonly<Record<string, BufferedReplayEnvelope>>;
  /**
   * Tracks the newest seq that has been evicted from `ring` due to cap
   * overflow. Used to compute `truncated` in replay. 0 when nothing
   * has been evicted.
   */
  readonly evictedAboveSeq: number;
}

/**
 * Outcome of {@link applyRecordOp}. Producers fan out `envelope` to
 * subscribers; stores persist `next`.
 */
export interface ApplyRecordResult {
  readonly envelope: BufferedReplayEnvelope;
  readonly next: BufferState;
  /** True when the envelope was retained (policy != 'none'). */
  readonly buffered: boolean;
}

/**
 * Outcome of {@link replayFromBufferOp}. Matches
 * `@ggui-ai/mcp-server-core.ReplayResult` field-for-field.
 */
export interface ReplayResult {
  readonly envelopes: readonly BufferedReplayEnvelope[];
  readonly truncated: boolean;
  readonly streamSeq: number;
}

/**
 * Empty state — the starting point for a never-recorded session.
 * Stores that hydrate from a persisted row project missing fields onto
 * this shape via {@link normalizeBufferState}.
 */
export const EMPTY_BUFFER_STATE: BufferState = {
  streamSeq: 0,
  ring: [],
  latestByChannel: {},
  evictedAboveSeq: 0,
};

/**
 * Default per-render ring cap. Mirrors the OSS
 * `DEFAULT_SESSION_STREAM_BUFFER_MAX`. Hosted may pick a smaller cap
 * because on-row storage is constrained by the 400KB DDB item limit.
 */
export const DEFAULT_REPLAY_MAX_PER_RENDER = 256;

/**
 * Bump the render's seq and (conditionally) persist the stamped
 * envelope per the channel's replay policy.
 *
 * Pure: returns a new {@link BufferState} rather than mutating the
 * input. Consumers that want reference equality for unchanged fields
 * pass the result's `next` through to storage.
 *
 * @throws {TypeError} when `maxPerRender < 1`.
 */
export function applyRecordOp(
  current: BufferState,
  input: StreamReplayInput,
  spec: StreamSpec | undefined,
  maxPerRender: number = DEFAULT_REPLAY_MAX_PER_RENDER,
): ApplyRecordResult {
  if (maxPerRender < 1) {
    throw new TypeError(
      `applyRecordOp: maxPerRender must be >= 1, got ${maxPerRender}`,
    );
  }
  const newSeq = current.streamSeq + 1;
  const envelope: BufferedReplayEnvelope = {
    seq: newSeq,
    channel: input.channel,
    mode: input.mode,
    payload: input.payload,
    ...(input.complete !== undefined ? { complete: input.complete } : {}),
  };

  const policy =
    resolveStreamChannel(spec, input.channel)?.replay ??
    DEFAULT_STREAM_REPLAY_POLICY;

  switch (policy) {
    case 'none':
      return {
        envelope,
        next: {
          streamSeq: newSeq,
          ring: current.ring,
          latestByChannel: current.latestByChannel,
          evictedAboveSeq: current.evictedAboveSeq,
        },
        buffered: false,
      };
    case 'latest':
      return {
        envelope,
        next: {
          streamSeq: newSeq,
          ring: current.ring,
          latestByChannel: {
            ...current.latestByChannel,
            [input.channel]: envelope,
          },
          evictedAboveSeq: current.evictedAboveSeq,
        },
        buffered: true,
      };
    case 'all': {
      const nextRing: BufferedReplayEnvelope[] = [...current.ring, envelope];
      let evictedAboveSeq = current.evictedAboveSeq;
      while (nextRing.length > maxPerRender) {
        const evicted = nextRing.shift();
        if (evicted && evicted.seq > evictedAboveSeq) {
          evictedAboveSeq = evicted.seq;
        }
      }
      return {
        envelope,
        next: {
          streamSeq: newSeq,
          ring: nextRing,
          latestByChannel: current.latestByChannel,
          evictedAboveSeq,
        },
        buffered: true,
      };
    }
    default: {
      // TS exhaustiveness — StreamReplayPolicy is a closed union; any
      // new variant forces this case to be updated.
      const _exhaustive: never = policy;
      throw new Error(`Unhandled replay policy: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Return the envelopes a reconnecting subscriber should receive.
 *
 * Rules — mirror the OSS `SessionStreamBuffer.replay` contract:
 *
 *   - `fromSeq === undefined` (fresh subscribe) → empty envelopes;
 *     caller transitions straight to the live tail.
 *   - `fromSeq` supplied → per-channel filter:
 *     - `'none'` channels contribute nothing.
 *     - `'latest'` channels contribute their single slot IFF its
 *       `seq > fromSeq`.
 *     - `'all'` channels contribute every retained envelope for the
 *       channel with `seq > fromSeq`, in seq order.
 *   - `truncated` is true only when at least one `'all'` channel has
 *     evicted envelopes the subscriber requested (`fromSeq <
 *     evictedAboveSeq`). For `'none'` / `'latest'`-only specs,
 *     truncation is meaningless.
 *   - Absent spec → default policy (`'none'`) applies to every
 *     channel; empty result. The buffer does not second-guess the
 *     spec — if the live stack item says `'none'` but historical
 *     records exist, replay yields nothing.
 *
 * Output is stable-sorted by `seq` ASC across channels.
 */
export function replayFromBufferOp(
  state: BufferState,
  fromSeq: number | undefined,
  spec: StreamSpec | undefined,
): ReplayResult {
  const streamSeq = state.streamSeq;
  if (fromSeq === undefined) {
    return { envelopes: [], truncated: false, streamSeq };
  }

  const collected: BufferedReplayEnvelope[] = [];
  let truncated = false;

  const channels = spec ?? {};
  for (const channelName of Object.keys(channels)) {
    const policy =
      resolveStreamChannel(spec, channelName)?.replay ??
      DEFAULT_STREAM_REPLAY_POLICY;
    switch (policy) {
      case 'none':
        break;
      case 'latest': {
        const latest = state.latestByChannel[channelName];
        if (latest && latest.seq > fromSeq) {
          collected.push(latest);
        }
        break;
      }
      case 'all': {
        if (fromSeq < state.evictedAboveSeq) {
          truncated = true;
        }
        for (const env of state.ring) {
          if (env.channel === channelName && env.seq > fromSeq) {
            collected.push(env);
          }
        }
        break;
      }
      default: {
        const _exhaustive: never = policy;
        throw new Error(`Unhandled replay policy: ${String(_exhaustive)}`);
      }
    }
  }

  collected.sort((a, b) => a.seq - b.seq);
  return { envelopes: collected, truncated, streamSeq };
}

/**
 * Project a partially-hydrated persisted row onto a full
 * {@link BufferState}. Adapters that read from DDB/AppSync typically
 * get nullable fields for each slice — this folds them into the
 * canonical shape, returning {@link EMPTY_BUFFER_STATE} when all
 * fields are absent.
 *
 * Does NOT validate array/map entry shapes — callers that read from
 * trusted server-owned storage (hosted Session row) can rely on them
 * being well-formed by construction.
 */
export function normalizeBufferState(partial: {
  readonly streamSeq?: number | null;
  readonly ring?: readonly BufferedReplayEnvelope[] | null;
  readonly latestByChannel?: Readonly<Record<string, BufferedReplayEnvelope>> | null;
  readonly evictedAboveSeq?: number | null;
}): BufferState {
  return {
    streamSeq: partial.streamSeq ?? 0,
    ring: partial.ring ?? [],
    latestByChannel: partial.latestByChannel ?? {},
    evictedAboveSeq: partial.evictedAboveSeq ?? 0,
  };
}

// ── Sequenced-record primitive (optimistic concurrency) ─────────────
//
// Hosted adapters (Lambda connector fan-out + MCP pod `ggui_emit`)
// share a read-apply-write flow. Without a seq fence, concurrent
// writers to the same session can both read `streamSeq=N`, both
// compute `N+1`, and both persist — last-writer-wins overwrites a
// retained envelope and duplicates `seq` on the wire.
//
// `runSequencedRecord` centralizes the OCC loop: read → apply →
// conditional-write (expected-old-seq); on conflict, re-read + retry.
// Matching OSS `InMemorySessionStreamBuffer`'s single-writer property
// at the DDB layer — the conditional check is the fence.
//
// Errors are typed so adapters can surface the right thing to callers:
//   - `ReplayConflictError` is transient; the loop retries up to
//     `maxRetries` before promoting to `ReplayMaxRetriesExceededError`.
//   - `ReplayRenderNotFoundError` is terminal; no retry makes a
//     vanished render reappear.

/** Thrown by a sequencer's `persist` when the expected-seq check fails.
 *  The outer loop retries — callers typically never see this. */
export class ReplayConflictError extends Error {
  constructor(
    public readonly renderId: string,
    public readonly expectedOldSeq: number,
  ) {
    super(
      `replay conflict on render ${renderId}: streamSeq changed from ${expectedOldSeq} mid-flight`,
    );
    this.name = 'ReplayConflictError';
  }
}

/** Thrown when retry budget is exhausted. Callers surface as 5xx.
 *  Indicates sustained contention — the render row saw more writers
 *  than the retry budget could absorb. */
export class ReplayMaxRetriesExceededError extends Error {
  constructor(
    public readonly renderId: string,
    public readonly attempts: number,
  ) {
    super(
      `replay sequencer exhausted ${attempts} retries on render ${renderId}`,
    );
    this.name = 'ReplayMaxRetriesExceededError';
  }
}

/** Thrown when the sequencer's `fetchState` returns null — the render
 *  row is gone (TTL-reaped or explicitly closed between writer reads).
 *  Terminal — no retry brings the row back. */
export class ReplayRenderNotFoundError extends Error {
  constructor(public readonly renderId: string) {
    super(`replay sequencer: render ${renderId} not found`);
    this.name = 'ReplayRenderNotFoundError';
  }
}

/** Snapshot the sequencer returns to the retry loop. */
export interface FetchedReplayState {
  readonly state: BufferState;
  readonly spec: StreamSpec | undefined;
}

/**
 * Storage-backed seam the retry loop uses. Adapters implement this
 * inline (one shared deps object per renderId call is fine —
 * `fetchState` closes over the storage client, `persist` closes
 * over the same).
 */
export interface ReplaySequencerDeps {
  /**
   * Read the current replay state + active streamSpec. Return `null`
   * when the render row is missing — the loop surfaces a
   * {@link ReplayRenderNotFoundError}.
   */
  readonly fetchState: (renderId: string) => Promise<FetchedReplayState | null>;
  /**
   * Persist the new state conditional on `expectedOldSeq` matching
   * the current stored `streamSeq`. Throw {@link ReplayConflictError}
   * on mismatch; any other error propagates as-is.
   */
  readonly persist: (
    renderId: string,
    expectedOldSeq: number,
    newState: BufferState,
  ) => Promise<void>;
}

/** Default retry budget — 5 attempts is enough for bursty contention
 *  without giving up under sustained chaos. */
export const DEFAULT_REPLAY_MAX_RETRIES = 5;

export interface RunSequencedRecordOptions {
  readonly maxPerRender?: number;
  readonly maxRetries?: number;
}

/**
 * Optimistic-concurrency record: fetch state → apply policy →
 * conditional-write → retry on conflict. Returns the same
 * {@link ApplyRecordResult} a single-writer `applyRecordOp` would.
 *
 * Invariant: on success, the returned `envelope.seq` is the
 * authoritative render-scoped monotonic sequence for this emission.
 * Two concurrent calls MUST observe two distinct seqs.
 *
 * @throws {@link ReplayRenderNotFoundError} — render row gone.
 * @throws {@link ReplayMaxRetriesExceededError} — contention too high.
 */
export async function runSequencedRecord(
  renderId: string,
  input: StreamReplayInput,
  deps: ReplaySequencerDeps,
  options: RunSequencedRecordOptions = {},
): Promise<ApplyRecordResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_REPLAY_MAX_RETRIES;
  const maxPerRender = options.maxPerRender ?? DEFAULT_REPLAY_MAX_PER_RENDER;
  let attempts = 0;
  while (attempts <= maxRetries) {
    const read = await deps.fetchState(renderId);
    if (!read) {
      throw new ReplayRenderNotFoundError(renderId);
    }
    const result = applyRecordOp(read.state, input, read.spec, maxPerRender);
    try {
      await deps.persist(renderId, read.state.streamSeq, result.next);
      return result;
    } catch (err) {
      if (err instanceof ReplayConflictError) {
        attempts += 1;
        continue;
      }
      throw err;
    }
  }
  throw new ReplayMaxRetriesExceededError(renderId, attempts);
}
