/**
 * Registry-level polling composition for the iframe-runtime (R6).
 *
 * Replaces the pre-R6 per-handler polling descriptor on
 * `createPropsUpdateHandler`. The runtime composes ONE polling
 * descriptor at bind time:
 *
 *   - **URL** — `session.pollingUrl`, which the server stamps with
 *     `/api/sessions/<sessionId>/state?wsToken=<token>` (R6 +
 *     content-negotiated /r/ route). Absent → no polling fallback
 *     (the registry stays WS-only).
 *   - **Interval** — fixed 2000ms (well inside the 10s drain-claim
 *     budget; 5 ticks of safety, mirrors the pre-R6 default).
 *   - **parseSnapshot** — reads the slice envelope `{ "ai.ggui/session":
 *     {...}, "ai.ggui/stack-item": {...} }`, computes a hash of the
 *     envelope, short-circuits on no-change, and synthesizes a
 *     `props_update` frame whenever the `propsJson` or `stackItemId`
 *     on the stack-item slice differs from the last seen value.
 *
 * R7 will extend this to also produce frames for new events delivered
 * via `/api/sessions/:id/events?sinceSequence=N` (the cursor model).
 * For R6 the snapshot path covers props refresh — the primary signal
 * the iframe needs to stay in sync.
 */
import type {
  ChannelFrame,
  RegistryPollingOptions,
} from '@ggui-ai/live-channel';
import type {
  JsonObject,
  PropsUpdatePayload,
} from '@ggui-ai/protocol';

const DEFAULT_POLLING_INTERVAL_MS = 2000;

/**
 * Tiny FNV-1a 32-bit hash — stable, no protocol dep. We only need diff
 * detection (not collision resistance), so the trade-off is fine.
 * Returns a hex string for human-readable logs.
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash =
      (hash +
        ((hash << 1) +
          (hash << 4) +
          (hash << 7) +
          (hash << 8) +
          (hash << 24))) >>>
      0;
  }
  return hash.toString(16);
}

export interface BuildSnapshotPollingOptions {
  /**
   * Snapshot URL the `PollingTransport` fetches on each tick. Typically
   * `session.pollingUrl` (server-stamped at push time pointing at
   * `/api/sessions/<sessionId>/state?wsToken=<token>`).
   */
  readonly url: string;
  /**
   * Optional polling cadence override. Defaults to 2000ms.
   */
  readonly intervalMs?: number;
  /**
   * Optional cursor seed (R7 forward-compat). Threaded from
   * `session.lastSequence` so future /events cursor reads start at the
   * right offset. Unused by the snapshot-only R6 path but recorded
   * here so the closure can hand it off to R7 wiring without a fresh
   * composition.
   */
  readonly seedLastSequence?: number;
}

/**
 * Build a {@link RegistryPollingOptions} descriptor that parses the
 * `/api/sessions/:id/state` slice envelope into a `props_update`
 * frame on change.
 *
 * Diff posture: hash of the WHOLE envelope is the short-circuit gate;
 * `propsJson` + `stackItemId` change drives `props_update` synthesis.
 * First tick fires unconditionally (lastSnapshotHash is `null`) so
 * polling clients see the current props as their starting state when
 * WS is absent.
 */
export function buildSnapshotPolling(
  opts: BuildSnapshotPollingOptions,
): RegistryPollingOptions {
  // Closure state — last-seen envelope hash + last-seen propsJson /
  // stackItemId so we both short-circuit the whole-snapshot fetch when
  // nothing changed AND only re-dispatch `props_update` when the
  // render-affecting fields actually moved.
  let lastSnapshotHash: string | null = null;
  let lastSeenPropsHash: string | null = null;
  let lastSeenStackItemId: string | null = null;
  // R7 forward-compat — captured for hand-off to a future /events
  // composer; the R6 snapshot path doesn't consume it directly.
  let cursor: number | undefined = opts.seedLastSequence;
  void cursor; // silence unused-var warning until R7 wires it.
  return {
    url: opts.url,
    intervalMs: opts.intervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    parseSnapshot: (body: unknown): Record<string, ChannelFrame> | null => {
      if (body === null || typeof body !== 'object') return null;
      // Whole-envelope hash gate — when the body is byte-identical to
      // the last poll, short-circuit before per-field diffing.
      let envelopeStr: string;
      try {
        envelopeStr = JSON.stringify(body);
      } catch {
        return null;
      }
      const envelopeHash = fnv1a(envelopeStr);
      if (envelopeHash === lastSnapshotHash) return null;
      lastSnapshotHash = envelopeHash;

      // Update cursor if the session slice carries a fresh lastSequence
      // — keeps the R7 cursor aligned even if no other field changed.
      const sessionSlice = (body as { ['ai.ggui/session']?: unknown })[
        'ai.ggui/session'
      ];
      if (
        sessionSlice !== null &&
        typeof sessionSlice === 'object' &&
        typeof (sessionSlice as { lastSequence?: unknown }).lastSequence ===
          'number'
      ) {
        cursor = (sessionSlice as { lastSequence: number }).lastSequence;
      }

      const stackItemSlice = (body as { ['ai.ggui/stack-item']?: unknown })[
        'ai.ggui/stack-item'
      ];
      if (stackItemSlice === null || typeof stackItemSlice !== 'object') {
        // Snapshot changed (session slice may have moved) but no
        // stack-item — nothing to dispatch on the props channel.
        return {};
      }
      const propsJson = (stackItemSlice as { propsJson?: unknown }).propsJson;
      const sliceStackItemId = (stackItemSlice as { stackItemId?: unknown })
        .stackItemId;
      if (
        typeof propsJson !== 'string' ||
        typeof sliceStackItemId !== 'string' ||
        sliceStackItemId.length === 0
      ) {
        return {};
      }
      const propsHash = fnv1a(propsJson);
      if (
        propsHash === lastSeenPropsHash &&
        sliceStackItemId === lastSeenStackItemId
      ) {
        return {};
      }
      lastSeenPropsHash = propsHash;
      lastSeenStackItemId = sliceStackItemId;
      let parsedProps: unknown;
      try {
        parsedProps = JSON.parse(propsJson);
      } catch {
        return {};
      }
      if (
        parsedProps === null ||
        typeof parsedProps !== 'object' ||
        Array.isArray(parsedProps)
      ) {
        return {};
      }
      const payload: PropsUpdatePayload = {
        stackItemId: sliceStackItemId,
        props: parsedProps as JsonObject,
      };
      const frame: ChannelFrame<PropsUpdatePayload> = {
        type: 'props_update',
        payload,
      };
      return { ['props_update']: frame };
    },
  };
}
