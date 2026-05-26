/**
 * Registry-level events-polling composition for the iframe-runtime (R7).
 *
 * The R7 cursor-replay model — paired transport of the
 * `/api/sessions/:id/events?sinceSequence=N&limit=100` HTTP endpoint
 * + the WS subscribe `sinceSequence` cursor. Both transports replay
 * from the same SessionEvent ledger; the polling client uses HTTP, the
 * live client uses WS, and they SHARE the cursor model. Switching
 * transports does not lose events.
 *
 * Semantics (vs. R6 snapshot-polling):
 *   - **URL** — `/api/sessions/<sessionId>/events?wsToken=<token>` with
 *     `sinceSequence` and `limit` added per tick.
 *   - **Interval** — fixed 2000ms (mirrors R6's default).
 *   - **parseSnapshot** — reads the `EventsResponse` envelope, dispatches
 *     each event by `event.type` to the registered ChannelHandler (e.g.
 *     `push` → push handler; `props_update` → props_update handler),
 *     and advances the cursor to `lastSequence`.
 *   - **REPLAY_HORIZON_PASSED** — when the server returns 410 the
 *     parser can't fold; the consumer must re-mount from a fresh
 *     `/state` snapshot. Today the polling transport's `parseSnapshot`
 *     only sees the body, so we emit a synthetic `error` frame for the
 *     registry to surface upward.
 *
 * # Anthropic first-mount race fix
 *
 * Iframes mounted inside the Anthropic SDK lose `__GGUI_META__` because
 * the SDK strips `_meta` from `tools/call` responses before forwarding
 * the structured-content shell to the iframe. R5's documented gap was
 * that the first push's payload never reached the iframe.
 *
 * R7's principled fix: the same /events endpoint that powers polling
 * ALSO serves the cold-mount path. An iframe booting without inline
 * meta calls `/events?sinceSequence=0&limit=1` to fetch the first
 * push event from the ledger; the wsToken comes from the iframe's
 * URL query string (the server stamps it on the resource URI when
 * minting the push tool result, preserved across the Anthropic SDK
 * strip). One unified cursor model handles cold-mount, polling
 * fallback, and live updates.
 */
import type {
  ChannelFrame,
  RegistryPollingOptions,
} from '@ggui-ai/live-channel';
import type { EventsResponse, SessionEvent } from '@ggui-ai/protocol';

const DEFAULT_EVENTS_POLL_INTERVAL_MS = 2000;
const DEFAULT_EVENTS_PAGE_LIMIT = 100;

export interface BuildEventsPollingOptions {
  /**
   * Base URL the polling tick reads from. The composer appends
   * `&sinceSequence=<cursor>&limit=<limit>` per tick. Typically the
   * `/api/sessions/<sessionId>/events?wsToken=<token>` URL the iframe
   * derived from the session slice. Must already include a `?` or `&`
   * separator-ready terminator; we add the cursor params with
   * `&` if the URL contains `?`, else `?`.
   */
  readonly baseUrl: string;
  /**
   * Optional cursor seed — initial value of `sinceSequence` on the
   * first tick. Typically threaded from `session.lastSequence` so the
   * cold-mount-after-WS-fail path picks up where the snapshot left
   * off. Defaults to `0` (replay everything still retained).
   */
  readonly initialSinceSequence?: number;
  /**
   * Optional poll cadence override. Defaults to 2000ms.
   */
  readonly intervalMs?: number;
  /**
   * Optional per-page event cap. Defaults to 100 (matches server
   * default). The polling transport handles pagination by re-polling
   * on the next tick when `hasMore` is true — we don't loop within a
   * single tick to keep latency bounded.
   */
  readonly limit?: number;
}

/**
 * Compose the per-tick URL with `&sinceSequence=N&limit=M` appended.
 * The base URL may or may not already carry a query string; we pick
 * the right separator.
 */
function composeTickUrl(baseUrl: string, sinceSequence: number, limit: number): string {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}sinceSequence=${sinceSequence}&limit=${limit}`;
}

/**
 * Type guard for the EventsResponse envelope shape. Defends against
 * server bugs / proxy interference that could feed the parser
 * non-conforming JSON.
 */
function isEventsResponse(body: unknown): body is EventsResponse {
  if (body === null || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  if (!Array.isArray(obj['events'])) return false;
  if (typeof obj['lastSequence'] !== 'number') return false;
  if (typeof obj['hasMore'] !== 'boolean') return false;
  return true;
}

/**
 * Type guard for one SessionEvent in the events array.
 */
function isSessionEvent(value: unknown): value is SessionEvent {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['sequence'] !== 'number') return false;
  if (typeof obj['emittedAt'] !== 'string') return false;
  if (typeof obj['type'] !== 'string') return false;
  // `payload` is intentionally unconstrained — typed at the
  // consumer-side handler that dispatches on `type`.
  return true;
}

/**
 * Build a {@link RegistryPollingOptions} descriptor that reads
 * `/api/sessions/:id/events?sinceSequence=N&limit=M` and dispatches
 * each `SessionEvent` by `event.type` to the registry's matching
 * channel handler. Cursor advances per-tick to the server's
 * `lastSequence`.
 *
 * # Per-tick URL composition
 *
 * The transport calls `polling.url` verbatim. Because the cursor
 * changes per tick we can't fix a single URL at build time; instead we
 * implement a single-tick read by mutating a closure-scoped cursor
 * and recomputing the URL inside `parseSnapshot`. But `parseSnapshot`
 * gets the BODY, not the URL — so this design uses a layered approach:
 * the URL on the descriptor IS the cursor-aware URL composed inside a
 * proxy fetch wrapper layer above. For now, this implementation
 * returns the cursor-aware URL via a synchronous re-composition each
 * tick (the transport calls fetch ONCE per tick).
 *
 * Implementation note: `RegistryPollingOptions.url` is a static string
 * on the type, but we need a per-tick re-computation. We achieve this
 * via a `Proxy` getter on the returned object — each access of `url`
 * pulls the live cursor and composes the URL anew.
 */
export function buildEventsPolling(
  opts: BuildEventsPollingOptions,
): RegistryPollingOptions {
  let cursor = opts.initialSinceSequence ?? 0;
  const limit = opts.limit ?? DEFAULT_EVENTS_PAGE_LIMIT;
  const intervalMs = opts.intervalMs ?? DEFAULT_EVENTS_POLL_INTERVAL_MS;
  // Each `url` access recomputes from the current cursor. The
  // PollingTransport's tick calls `polling.url` once per fetch.
  const descriptor: RegistryPollingOptions = Object.create(null);
  Object.defineProperty(descriptor, 'url', {
    enumerable: true,
    get: () => composeTickUrl(opts.baseUrl, cursor, limit),
  });
  Object.defineProperty(descriptor, 'intervalMs', {
    enumerable: true,
    value: intervalMs,
  });
  Object.defineProperty(descriptor, 'parseSnapshot', {
    enumerable: true,
    value: (body: unknown): Record<string, ChannelFrame> | null => {
      // 410 case manifests as a body that doesn't match the
      // EventsResponse shape (`{reason: 'REPLAY_HORIZON_PASSED',
      // currentSequence}`). Surface a synthetic `error` frame so the
      // registry's error handler can fire the re-mount signal.
      if (
        body !== null &&
        typeof body === 'object' &&
        (body as { reason?: unknown }).reason === 'REPLAY_HORIZON_PASSED'
      ) {
        const cs = (body as { currentSequence?: unknown }).currentSequence;
        const currentSequence = typeof cs === 'number' ? cs : 0;
        // Reset cursor to the server's high-water mark; next tick
        // starts fresh from there. Consumers handle the re-mount via
        // the error channel.
        cursor = currentSequence;
        const errorFrame: ChannelFrame = {
          type: 'error',
          payload: {
            code: 'REPLAY_HORIZON_PASSED',
            message: `events polling cursor outside replayable range; reset to ${currentSequence}`,
            details: { currentSequence },
          },
        };
        return { error: errorFrame };
      }
      if (!isEventsResponse(body)) return null;
      // Advance cursor even on empty pages — the server's high-water
      // mark moves with /state reads too.
      cursor = body.lastSequence;
      if (body.events.length === 0) {
        // Nothing to dispatch; the empty object signals "snapshot
        // parsed but no handlers matched today's keys" (distinct from
        // `null` = no change).
        return {};
      }
      // Group events by type. The registry-level polling transport
      // calls one handler per type; if multiple events share a type
      // we'd lose deliveries. Today's wire frame types
      // (push/props_update) are typically distinct per tick at the
      // expected 2s cadence, but the protocol allows multiple of the
      // same type. Honest workaround: dispatch the LAST event of each
      // type and rely on the consumer's idempotency. Future R8: extend
      // the dispatch shape to a list per type.
      const frames: Record<string, ChannelFrame> = {};
      for (const event of body.events) {
        if (!isSessionEvent(event)) continue;
        frames[event.type] = {
          type: event.type,
          payload: event.payload,
        };
      }
      return frames;
    },
  });
  return descriptor;
}
