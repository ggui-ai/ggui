/**
 * InMemoryRenderStreamBuffer — reference implementation of
 * {@link RenderStreamBuffer}.
 *
 * Intended for the OSS `@ggui-ai/mcp-server` in its zero-config mode
 * and for tests. Bounded per-session ring that applies replay policy
 * at record time — `'none'` channels are NEVER stored, `'latest'`
 * channels keep a single slot per channel, `'all'` channels append
 * to a shared ring with FIFO eviction when the per-session cap is hit.
 *
 * Not persistent. Server restart drops all buffered envelopes — this
 * is documented on the interface, not worked around. Adapters that
 * need durability ship as separate packages against the same
 * {@link RenderStreamBuffer} interface.
 */
import { DEFAULT_STREAM_REPLAY_POLICY } from '@ggui-ai/protocol';
import { resolveStreamChannel } from '@ggui-ai/protocol';
import type { StreamSpec } from '@ggui-ai/protocol';
import { isKnownReservedChannel } from '@ggui-ai/protocol';
import { makeStreamEnvelope } from '@ggui-ai/protocol';
import {
  DEFAULT_SESSION_STREAM_BUFFER_MAX,
  type BufferedStreamEnvelope,
  type RecordResult,
  type ReplayResult,
  type RenderStreamBuffer,
  type RenderStreamBufferOptions,
  type StreamEnvelopeInput,
} from '../render-stream-buffer.js';

interface RenderBucket {
  /** Latest assigned seq for the session. 0 when never recorded. */
  seq: number;
  /**
   * FIFO ring of envelopes for channels with replay: 'all'.
   * Oldest at index 0, newest at tail. Capped by `maxPerSession`.
   */
  ring: BufferedStreamEnvelope[];
  /**
   * Tracks the oldest seq that has been evicted from `ring` due to
   * cap overflow. Used to compute the `truncated` flag in replay.
   * 0 when nothing has ever been evicted.
   */
  evictedAboveSeq: number;
  /**
   * Single-slot cache for channels with replay: 'latest'. Keyed by
   * channel name; value is the single most-recent envelope for that
   * channel. When a channel's `latest` is superseded, the prior
   * envelope is discarded.
   */
  latestByChannel: Map<string, BufferedStreamEnvelope>;
}

export class InMemoryRenderStreamBuffer implements RenderStreamBuffer {
  private readonly buckets = new Map<string, RenderBucket>();
  private readonly maxPerSession: number;

  constructor(opts: RenderStreamBufferOptions = {}) {
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_SESSION_STREAM_BUFFER_MAX;
    if (this.maxPerSession < 1) {
      throw new Error(
        `InMemoryRenderStreamBuffer: maxPerSession must be >= 1, got ${this.maxPerSession}`,
      );
    }
  }

  async record(
    input: StreamEnvelopeInput,
    spec?: StreamSpec,
  ): Promise<RecordResult> {
    const bucket = this.bucketFor(input.renderId);
    bucket.seq += 1;
    // Central stamp via makeStreamEnvelope. BufferedStreamEnvelope
    // narrows StreamEnvelope.seq?: number to required — re-assert seq
    // on the returned object so TS sees the narrowed shape without an
    // `as` cast. Byte-equivalent to the pre-refactor manual
    // construction: required fields + conditional complete +
    // schemaVersion stamp.
    const seq = bucket.seq;
    const stamped = makeStreamEnvelope({
      renderId: input.renderId,
      seq,
      channel: input.channel,
      mode: input.mode,
      payload: input.payload,
      ...(input.complete !== undefined ? { complete: input.complete } : {}),
    });
    const envelope: BufferedStreamEnvelope = { ...stamped, seq };

    // Reserved channels the runtime KNOWS it emits on are server-
    // owned and cannot appear in agent-declared `streamSpec`, so the
    // resolve below returns `undefined` for them and the policy
    // would fall back to `DEFAULT_STREAM_REPLAY_POLICY` (`'none'`).
    // That is wrong for recognized reserved channels — `_ggui:preview`
    // frames must replay to a late-subscribing viewer (the user's
    // browser navigates to `/r/<shortCode>` AFTER the agent's
    // `ggui_render` returns, so the WS attaches after the preamble
    // has fired). Force `'all'` for KNOWN reserved channels so the
    // late subscriber sees the assembling surface.
    //
    // Tightened to `isKnownReservedChannel` (closed set) rather than
    // the prefix check — a typo like `_ggui:preveiw` falls through
    // to the default `'none'` policy and isn't persisted, surfacing
    // the typo to the operator instead of silently being buffered.
    const policy = isKnownReservedChannel(input.channel)
      ? 'all'
      : (resolveStreamChannel(spec, input.channel)?.replay ??
        DEFAULT_STREAM_REPLAY_POLICY);

    switch (policy) {
      case 'none':
        // Seq is still assigned (so fan-out has a stable cursor), but
        // nothing is stored. A reconnecting subscriber will see
        // nothing from this channel.
        return { envelope, buffered: false };
      case 'latest':
        // Replace any prior latest for this channel — the new
        // envelope supersedes it. Do NOT touch the ring; `'latest'`
        // channels never participate in FIFO eviction.
        bucket.latestByChannel.set(input.channel, envelope);
        return { envelope, buffered: true };
      case 'all':
        // Append to the ring. Evict the oldest when at cap.
        bucket.ring.push(envelope);
        if (bucket.ring.length > this.maxPerSession) {
          const evicted = bucket.ring.shift();
          if (evicted && evicted.seq > bucket.evictedAboveSeq) {
            bucket.evictedAboveSeq = evicted.seq;
          }
        }
        return { envelope, buffered: true };
      default: {
        // TS exhaustiveness guard — StreamReplayPolicy is a closed
        // union; any new variant forces this function to be updated.
        const _exhaustive: never = policy;
        throw new Error(`Unhandled replay policy: ${String(_exhaustive)}`);
      }
    }
  }

  async replay(
    renderId: string,
    fromSeq: number | undefined,
    spec?: StreamSpec,
  ): Promise<ReplayResult> {
    const bucket = this.buckets.get(renderId);
    const streamSeq = bucket?.seq ?? 0;

    // Fresh subscribe (no fromSeq) never pulls history — return the
    // cursor only. This matches the "subscribe is not a replay
    // request" mental model; clients explicitly opt in to history.
    if (fromSeq === undefined) {
      return { envelopes: [], truncated: false, streamSeq };
    }

    if (!bucket) {
      return { envelopes: [], truncated: false, streamSeq };
    }

    // Walk every channel the live spec declares, decide per-channel
    // what to contribute. If `spec` is absent, the default policy
    // ('none') applies universally and nothing replays — a nil spec
    // means no live contract to honor.
    const collected: BufferedStreamEnvelope[] = [];
    let truncated = false;

    // Reserved channels the runtime RECOGNIZES are stored under
    // `'all'` policy at record-time regardless of the declared spec,
    // so late subscribers must also pull them back here. Iterate the
    // ring once for any recognized-reserved-channel envelopes the
    // subscriber hasn't seen yet — declared channels are handled by
    // the spec-walk that follows.
    //
    // Closed-set check mirrors the tightened record-time policy
    // above: anything that slipped past the emission gate with a
    // typo'd reserved-prefix name isn't replayed from the ring.
    for (const env of bucket.ring) {
      if (env.seq > fromSeq && isKnownReservedChannel(env.channel)) {
        collected.push(env);
      }
    }

    const channels = spec ?? {};
    for (const channelName of Object.keys(channels)) {
      const policy =
        resolveStreamChannel(spec, channelName)?.replay ??
        DEFAULT_STREAM_REPLAY_POLICY;
      switch (policy) {
        case 'none':
          // Never stored, never replayed.
          break;
        case 'latest': {
          const latest = bucket.latestByChannel.get(channelName);
          if (latest && latest.seq > fromSeq) {
            collected.push(latest);
          }
          break;
        }
        case 'all': {
          // Truncation: if fromSeq is older than the oldest
          // still-retained envelope AND we evicted something since,
          // the subscriber has a gap. The most accurate check is
          // "fromSeq < evictedAboveSeq" — i.e., we KNOW we dropped
          // envelopes the subscriber wanted.
          if (fromSeq < bucket.evictedAboveSeq) {
            truncated = true;
          }
          for (const env of bucket.ring) {
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

    // Stable-sort by seq ASC. `'latest'` single-slot entries mix
    // cleanly with `'all'` ring entries under the same seq order.
    collected.sort((a, b) => a.seq - b.seq);
    return { envelopes: collected, truncated, streamSeq };
  }

  async currentSeq(renderId: string): Promise<number> {
    return this.buckets.get(renderId)?.seq ?? 0;
  }

  async clear(renderId: string): Promise<void> {
    this.buckets.delete(renderId);
  }

  async getSize(): Promise<number> {
    let n = 0;
    for (const b of this.buckets.values()) {
      n += b.ring.length + b.latestByChannel.size;
    }
    return n;
  }

  private bucketFor(renderId: string): RenderBucket {
    let bucket = this.buckets.get(renderId);
    if (!bucket) {
      bucket = {
        seq: 0,
        ring: [],
        evictedAboveSeq: 0,
        latestByChannel: new Map(),
      };
      this.buckets.set(renderId, bucket);
    }
    return bucket;
  }
}
