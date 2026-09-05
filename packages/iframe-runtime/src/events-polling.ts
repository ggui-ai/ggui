/**
 * Registry-level events-polling composition for the iframe-runtime (R7).
 *
 * The R7 cursor-replay model — paired transport of the
 * `/api/sessions/:sessionId/events?sinceSequence=N&limit=100` HTTP endpoint
 * + the WS subscribe `sinceSequence` cursor. Both transports replay
 * from the same GguiSessionEvent ledger; the polling client uses HTTP, the
 * live client uses WS, and they SHARE the cursor model. Switching
 * transports does not lose events.
 *
 * Semantics (vs. R6 snapshot-polling):
 *   - **URL** — `/api/sessions/<sessionId>/events?wsToken=<token>` with
 *     `sinceSequence` and `limit` added per tick.
 *   - **Interval** — fixed 2000ms (mirrors R6's default).
 *   - **parseSnapshot** — reads the `EventsResponse` envelope, dispatches
 *     each event by `event.type` to the registered ChannelHandler (e.g.
 *     `render` → render handler; `props_update` → props_update handler),
 *     and advances the cursor to `lastSequence`.
 *   - **REPLAY_HORIZON_PASSED** — when the server returns 410 the
 *     parser can't fold; the consumer must re-mount from a fresh
 *     `/state` snapshot. Today the polling transport's `parseSnapshot`
 *     only sees the body, so we emit a synthetic `error` frame for the
 *     registry to surface upward.
 *
 * # Bridge-pull carrier (terminal rung)
 *
 * `buildBridgePolling` composes the SAME algorithm on the `fetchBody`
 * carrier: a CSP-jailed MCP-Apps iframe with no network path pulls the
 * same ledger by issuing `ggui_runtime_pull` `tools/call`s over the
 * host's postMessage bridge. One parse core
 * (`createEventsSnapshotParser`), two carriers — the tool's output is
 * byte-parity with the `/events` route by contract.
 *
 * # Anthropic first-mount race fix
 *
 * Iframes mounted inside the Anthropic SDK lose `__GGUI_META__` because
 * the SDK strips `_meta` from `tools/call` responses before forwarding
 * the structured-content shell to the iframe. R5's documented gap was
 * that the first render's payload never reached the iframe.
 *
 * R7's principled fix: the same /events endpoint that powers polling
 * ALSO serves the cold-mount path. An iframe booting without inline
 * meta calls `/events?sinceSequence=0&limit=1` to fetch the first
 * render event from the ledger; the wsToken comes from the iframe's
 * URL query string (the server stamps it on the resource URI when
 * minting the render tool result, preserved across the Anthropic SDK
 * strip). One unified cursor model handles cold-mount, polling
 * fallback, and live updates.
 */
import type {
  ChannelFrame,
  RegistryPollingOptions,
} from '@ggui-ai/live-channel';
import type {
  EventsResponse,
  GguiRuntimePullInput,
  GguiSessionEvent,
} from '@ggui-ai/protocol/wire';
import { unwrapCallToolResult } from './call-tool-unwrap.js';

const DEFAULT_EVENTS_POLL_INTERVAL_MS = 2000;
const DEFAULT_EVENTS_PAGE_LIMIT = 100;
const DEFAULT_BRIDGE_PULL_INTERVAL_MS = 3000;
// Subscription-mode defaults (transport-ladder ruling 20). The hold
// stays under ggui_consume's proven 25s host tolerance; K=3 empty
// holds (~1 min of silence) demotes to sparse idle pulls.
const DEFAULT_BRIDGE_HOLD_SECONDS = 20;
const DEFAULT_BRIDGE_DEMOTE_AFTER_EMPTIES = 3;
const DEFAULT_BRIDGE_IDLE_INTERVAL_MS = 15_000;

/**
 * Shared, monotonic event-ledger cursor for the failover ladder.
 *
 * The SSE rung advances it via `RegistrySseOptions.onSequence` (the
 * SSE `id:` field IS the ledger sequence); the polling descriptor
 * reads it per tick — so an SSE→polling demotion resumes from the
 * last streamed event instead of re-replaying from the boot snapshot.
 */
export interface SequenceCursor {
  get(): number;
  /**
   * Monotonic max — no-op when `seq <= current`, guaranteeing a stale
   * rung can never rewind progress another rung already made. Normal
   * delivery path (SSE `id:`, polling `lastSequence`).
   */
  advance(seq: number): void;
  /**
   * Unconditional server-truth override — the REPLAY_HORIZON_PASSED
   * escape hatch, and ONLY that. When the server declares the cursor
   * outside the replayable window it reports its actual high-water
   * mark, which can be BELOW the client cursor (a re-minted or reset
   * session whose ledger restarted). A monotonic `advance` would no-op
   * there and every subsequent tick would re-ask ahead of the horizon —
   * a permanent error loop. `reset` adopts the server's number so the
   * next tick lands inside the window and the ladder self-heals.
   */
  reset(seq: number): void;
}

/**
 * Create a {@link SequenceCursor} seeded at `seed` (default `0`).
 */
export function createSequenceCursor(seed = 0): SequenceCursor {
  let current = seed;
  return {
    get: () => current,
    advance: (seq: number): void => {
      if (seq > current) current = seq;
    },
    reset: (seq: number): void => {
      current = seq;
    },
  };
}

export interface BuildEventsPollingOptions {
  /**
   * Base URL the polling tick reads from. The composer appends
   * `&sinceSequence=<cursor>&limit=<limit>` per tick. Typically the
   * `/api/sessions/<sessionId>/events?wsToken=<token>` URL the iframe
   * derived from the render slice. Must already include a `?` or `&`
   * separator-ready terminator; we add the cursor params with
   * `&` if the URL contains `?`, else `?`.
   */
  readonly baseUrl: string;
  /**
   * Optional cursor seed — initial value of `sinceSequence` on the
   * first tick. Typically threaded from `render.lastSequence` so the
   * cold-mount-after-WS-fail path picks up where the snapshot left
   * off. Defaults to `0` (replay everything still retained). Ignored
   * when {@link cursor} is supplied — the shared cursor carries its
   * own seed.
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
  /**
   * Shared ladder cursor (WS → SSE → polling). When supplied, the
   * descriptor reads/advances it instead of a private closure cursor,
   * so SSE deliveries observed via `RegistrySseOptions.onSequence`
   * move the polling replay point forward. Absent → private internal
   * cursor seeded from {@link initialSinceSequence} (today's behavior).
   */
  readonly cursor?: SequenceCursor;
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
 * Type guard for one GguiSessionEvent in the events array.
 */
function isGguiSessionEvent(value: unknown): value is GguiSessionEvent {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['seq'] !== 'number') return false;
  if (typeof obj['timestamp'] !== 'string') return false;
  if (typeof obj['type'] !== 'string') return false;
  // `data` is intentionally unconstrained — typed at the
  // consumer-side handler that dispatches on `type`.
  return true;
}

/**
 * Build a {@link RegistryPollingOptions} descriptor that reads
 * `/api/sessions/:sessionId/events?sinceSequence=N&limit=M` and dispatches
 * each `GguiSessionEvent` by `event.type` to the registry's matching
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
  // Shared ladder cursor when supplied; else a private cursor seeded
  // from `initialSinceSequence` — behaviorally identical to the old
  // closure `let cursor`, modulo monotonicity (advance() never rewinds).
  const cur = opts.cursor ?? createSequenceCursor(opts.initialSinceSequence ?? 0);
  const limit = opts.limit ?? DEFAULT_EVENTS_PAGE_LIMIT;
  const intervalMs = opts.intervalMs ?? DEFAULT_EVENTS_POLL_INTERVAL_MS;
  // Each `url` access recomputes from the current cursor. The
  // PollingTransport's tick calls `polling.url` once per fetch.
  const descriptor: RegistryPollingOptions = Object.create(null);
  Object.defineProperty(descriptor, 'url', {
    enumerable: true,
    get: () => composeTickUrl(opts.baseUrl, cur.get(), limit),
  });
  Object.defineProperty(descriptor, 'intervalMs', {
    enumerable: true,
    value: intervalMs,
  });
  Object.defineProperty(descriptor, 'parseSnapshot', {
    enumerable: true,
    value: createEventsSnapshotParser(cur),
  });
  return descriptor;
}

/**
 * The ONE per-tick `EventsResponse` parse core behind BOTH ledger-pull
 * carriers — HTTP polling ({@link buildEventsPolling}) and bridge-pull
 * ({@link buildBridgePolling}). Byte-parity between `GET
 * /api/sessions/:sessionId/events` and `ggui_runtime_pull` output is
 * contractual precisely so this single parser handles both.
 *
 * Reads the `EventsResponse` envelope, dispatches each event by
 * `event.type` to the registered channel handler, advances the shared
 * cursor to `lastSequence`, and folds the REPLAY_HORIZON_PASSED
 * escape hatch through `cursor.reset()` + a synthetic `error` frame.
 */
function createEventsSnapshotParser(
  cur: SequenceCursor,
): (body: unknown) => Record<string, ChannelFrame> | null {
  return (body: unknown): Record<string, ChannelFrame> | null => {
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
      // Advance to the server's high-water mark; next tick starts
      // fresh from there (monotonic — inside the replayable-range
      // contract the high-water mark is >= the cursor, and a shared
      // ladder cursor must never rewind another rung's progress).
      // Consumers handle the re-mount via the error channel.
      // Server-truth override, NOT advance(): the horizon error can
      // report a high-water mark BELOW this cursor (re-minted/reset
      // session ledger) — monotonic advance would no-op and every
      // subsequent tick would re-ask ahead of the horizon forever.
      cur.reset(currentSequence);
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
    cur.advance(body.lastSequence);
    if (body.events.length === 0) {
      // Nothing to dispatch; the empty object signals "snapshot
      // parsed but no handlers matched today's keys" (distinct from
      // `null` = no change).
      return {};
    }
    // Group events by type. The registry-level polling transport
    // calls one handler per type; if multiple events share a type
    // we'd lose deliveries. Today's wire frame types
    // (render/props_update) are typically distinct per tick at the
    // expected 2s cadence, but the protocol allows multiple of the
    // same type. Honest workaround: dispatch the LAST event of each
    // type and rely on the consumer's idempotency. Future R8: extend
    // the dispatch shape to a list per type.
    const frames: Record<string, ChannelFrame> = {};
    for (const event of body.events) {
      if (!isGguiSessionEvent(event)) continue;
      // Two namespaces meet here, and THIS is the single translation
      // point: the ledger speaks the canonical event taxonomy
      // ('ui.updated', 'user.submitted', …) while the registry's
      // handler map speaks live-channel FRAME types ('props_update',
      // …). `ggui_update` appends 'ui.updated' with the exact
      // `{sessionId, props}` payload the props_update handler
      // expects — map the name so pull rungs repaint through the
      // same handler the WS/SSE push planes use.
      const frameType =
        event.type === 'ui.updated' ? 'props_update' : event.type;
      frames[frameType] = {
        type: frameType,
        payload: event.data,
      };
    }
    return frames;
  };
}

export interface BuildBridgePollingOptions {
  /**
   * Host `tools/call` dispatcher the tick pulls through. The runtime
   * binds this to `app.callServerTool` on the connected MCP-Apps App
   * handle — in a CSP-jailed host the postMessage bridge is the only
   * carrier the iframe has, which is why this rung exists. The
   * resolved value is the raw `CallToolResult`; the tick unwraps it
   * via the shared 3-tier {@link unwrapCallToolResult} (the same
   * unwrap submit-action responses use, so host-normalization
   * quirks — claude.ai's text-only collapse included — are handled
   * identically on both paths).
   */
  readonly callTool: (
    name: 'ggui_runtime_pull',
    args: GguiRuntimePullInput,
  ) => Promise<unknown>;
  /** Active render id — threaded verbatim as the tool's `sessionId`. */
  readonly sessionId: string;
  /**
   * Shared ladder cursor (WS → SSE → polling → bridge). REQUIRED —
   * unlike {@link BuildEventsPollingOptions.cursor} there is no
   * private-cursor fallback, because the bridge rung never exists
   * alone: the runtime always creates the ladder cursor when it
   * composes this rung, and a demotion into the bridge must resume
   * from whatever the rungs above already delivered.
   */
  readonly cursor: SequenceCursor;
  /**
   * Failure-pacing interval. Defaults to 3000ms. In subscription mode
   * the chain paces via `nextDelayMs`; this value only paces retries
   * after FAILED ticks (transport contract).
   */
  readonly intervalMs?: number;
  /**
   * Server-side hold per subscription-mode pull, in seconds. Defaults
   * to 20 (under ggui_consume's proven 25s host tolerance). `0`
   * disables holding entirely — every pull returns immediately and
   * pacing degrades to {@link idleIntervalMs}.
   */
  readonly holdSeconds?: number;
  /**
   * Consecutive empty holds before demoting subscription → idle
   * polling. Defaults to 3. Any delivered event re-promotes.
   */
  readonly demoteAfterEmpties?: number;
  /**
   * Idle-mode pull cadence. Defaults to 15000ms.
   */
  readonly idleIntervalMs?: number;
  /**
   * Optional per-page event cap, forwarded as the tool's `limit`
   * argument only when set. Absent → the key is omitted and the
   * server default applies.
   */
  readonly limit?: number;
}

/**
 * Build the bridge-pull rung of the failover ladder — the SAME
 * polling algorithm as {@link buildEventsPolling} on a different
 * carrier: instead of an HTTP `url`, the descriptor supplies a
 * `fetchBody` that pulls the event ledger through the host's
 * `tools/call` postMessage bridge (`ggui_runtime_pull`). Terminal
 * rung: the registry never arms a failure budget on it.
 *
 * Per tick: `callTool('ggui_runtime_pull', {sessionId, sinceSequence:
 * <cursor>, limit?})` → unwrap the CallToolResult via the shared
 * 3-tier {@link unwrapCallToolResult} → the unwrapped body feeds the
 * SAME parse core as the HTTP rung (`EventsResponse` dispatch,
 * `lastSequence` advance, REPLAY_HORIZON_PASSED reset — the tool's
 * output is byte-parity with `GET /api/sessions/:sessionId/events` by
 * contract).
 */
export function buildBridgePolling(
  opts: BuildBridgePollingOptions,
): RegistryPollingOptions {
  const { callTool, sessionId, cursor } = opts;
  const limit = opts.limit;
  const intervalMs = opts.intervalMs ?? DEFAULT_BRIDGE_PULL_INTERVAL_MS;
  const holdSeconds = opts.holdSeconds ?? DEFAULT_BRIDGE_HOLD_SECONDS;
  const demoteAfterEmpties =
    opts.demoteAfterEmpties ?? DEFAULT_BRIDGE_DEMOTE_AFTER_EMPTIES;
  const idleIntervalMs = opts.idleIntervalMs ?? DEFAULT_BRIDGE_IDLE_INTERVAL_MS;
  // Subscription-mode state (transport-ladder ruling 20). Two modes,
  // one counter:
  //   - SUBSCRIPTION (hot): each pull carries `wait` — the server
  //     holds the call until an event lands or the hold times out —
  //     and the next pull fires IMMEDIATELY on return. Back-to-back
  //     held single-shots emulate push: event→screen ≈ one relay RTT.
  //   - POLLING (idle): after `demoteAfterEmpties` consecutive empty
  //     holds the card is presumed quiet; drop to sparse un-held
  //     pulls every `idleIntervalMs` so a dormant card doesn't pin
  //     the host's relay open forever.
  // Any delivered event promotes straight back to subscription mode.
  let consecutiveEmpties = 0;
  const hot = (): boolean => consecutiveEmpties < demoteAfterEmpties;
  return {
    intervalMs,
    fetchBody: async (): Promise<unknown> => {
      const result = await callTool('ggui_runtime_pull', {
        sessionId,
        sinceSequence: cursor.get(),
        ...(limit !== undefined ? { limit } : {}),
        ...(hot() ? { wait: holdSeconds } : {}),
      });
      return unwrapCallToolResult(result);
    },
    parseSnapshot: createEventsSnapshotParser(cursor),
    nextDelayMs: (body: unknown): number => {
      if (isEventsResponse(body)) {
        if (body.events.length > 0) {
          consecutiveEmpties = 0;
          return 0;
        }
        consecutiveEmpties += 1;
        return hot() ? 0 : idleIntervalMs;
      }
      if (
        body !== null &&
        typeof body === 'object' &&
        (body as { reason?: unknown }).reason === 'REPLAY_HORIZON_PASSED'
      ) {
        // Cursor just self-healed to the server's high-water mark
        // (parseSnapshot reset it) — one immediate re-pull lands
        // inside the window.
        return 0;
      }
      // Unrecognized body — pace like idle rather than hot-looping on
      // garbage.
      return idleIntervalMs;
    },
  };
}
