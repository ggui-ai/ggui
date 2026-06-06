/**
 * GguiSessionStore — persistent + observable per-render state.
 *
 * Post-Phase-B (flatten-render-identity): the store holds {@link GguiSession}
 * records directly. Each row IS one rendered surface (component, system
 * card, or MCP-Apps iframe); there is no vessel that wraps a stack of
 * entries. The vessel concept (`Session`) is deleted from the protocol.
 *
 * Reference implementations:
 *   - InMemoryGguiSessionStore   (tests, dev)
 *   - SqliteGguiSessionStore     (OSS default; live tail via in-process EventEmitter)
 *   - PostgresGguiSessionStore   (optional; LISTEN/NOTIFY fanout)
 *   - DynamoGguiSessionStore     (hosted runtime; AppSync subscriptions)
 *
 * Conversation-context lookups (sibling renders within one host
 * conversation) flow via the unchanged `hostSession` pair on each
 * {@link GguiSession} — NOT by lifting fields from a vessel. See
 * [[session-concept-deletion-2026-05-27]] for the framing.
 */
import type {
  HostContextProjection,
  GguiSession,
  GguiSessionEvent,
  GguiSessionEventType,
} from '@ggui-ai/protocol';

// Re-export the protocol-level types so downstream importers
// (`@ggui-ai/mcp-server`, `@ggui-ai/iframe-runtime`, cloud adapters)
// can keep their existing `@ggui-ai/mcp-server-core` imports. The
// canonical definitions live in `@ggui-ai/protocol` (Wave 7 of
// flatten-render-identity, 2026-05-28); these aliases preserve the
// composition boundary without duplicating the types.
export type { GguiSessionEvent, GguiSessionEventType } from '@ggui-ai/protocol';

/**
 * Server-side persisted shape of a {@link GguiSession}. Wraps the protocol's
 * wire-shape `GguiSession` union (which intentionally narrows
 * `McpAppsGguiSession` to just locator metadata) with the lifecycle +
 * tenancy fields the server owns: `appId`, `userId`, `eventSequence`,
 * `createdAt`, `lastActivityAt`, `expiresAt`, `status?`,
 * `endUserIdentity?`, `themeId?`, `hostSession?`, `hostContext?`.
 *
 * Why a wrapper: `ComponentGguiSession` and `SystemGguiSession` extend
 * `GguiSessionBase` which already carries these fields, but `McpAppsGguiSession`
 * is a separately-defined wire shape that intentionally OMITS them
 * (it represents an inbound spec-canonical resource from the agent;
 * no server lifecycle attached to the wire). The store needs a single
 * uniform shape regardless of variant.
 *
 * `render` is the wire-shape payload (any `GguiSession` variant). The
 * sibling fields are what the store stamps + maintains independently.
 */
export interface StoredGguiSession {
  readonly id: string;
  readonly appId: string;
  readonly userId?: string;
  readonly endUserIdentity?: import('@ggui-ai/protocol').EndUserIdentity;
  readonly themeId?: string;
  readonly hostSession?: {
    readonly hostName: string;
    readonly hostSessionId: string;
  };
  readonly hostContext?: HostContextProjection;
  readonly eventSequence: number;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly expiresAt: number;
  readonly status?: 'active' | 'expired';
  /**
   * Visible-bits surface — the wire-shape `GguiSession` payload (any
   * variant). When the store mints a placeholder via `create()` before
   * any commit, `render` is a minimal `ComponentGguiSession` with empty
   * `componentCode`; subsequent `commit()` replaces it.
   */
  readonly render: GguiSession;
}

/**
 * Options for {@link GguiSessionStore.observe}.
 */
export interface ObserveOptions {
  /**
   * First sequence number to deliver. Default: `1` (replay from beginning).
   * On reconnect, pass `lastSeen + 1`.
   */
  fromSeq?: number;
  /**
   * Whether to keep the stream open after historical replay. Default: `true`.
   * Set `false` for a one-shot snapshot fetch.
   */
  tail?: boolean;
}

/**
 * Input for {@link GguiSessionStore.create}.
 */
export interface CreateGguiSessionInput {
  appId: string;
  userId?: string;
  /**
   * Optional deterministic render id. Implementations that can honor
   * caller-provided ids SHOULD use this when present; implementations that
   * only generate ids (DDB auto-pk, UUID-on-insert, etc.) MAY ignore it
   * and assign their own.
   *
   * Motivating case: OSS live-channel `subscribe` messages provide the
   * sessionId the client wants to join, so the server can be idempotent
   * on reconnect without round-tripping through a separate mint step.
   */
  id?: string;
  /**
   * Optional structured authenticated end-user identity, populated by
   * the auth gate before the render is materialized. When supplied,
   * implementations MUST persist it as-is and surface it on
   * subsequent `get()` calls.
   *
   * Cloud's dynamoGguiSessionStore reads this via a separate auth-gate
   * write path today; threading it through `create()` here unifies
   * the surface and enables the conformance suite to pin round-trip
   * parity uniformly across impls.
   */
  endUserIdentity?: import('@ggui-ai/protocol').EndUserIdentity;
  /**
   * Theme preset id for this render — sits at layer 1 of the
   * bootstrap-meta theme-resolution chain (GguiSession.themeId >
   * App.defaultThemeId > server fallback). Sourced from
   * `ggui_render`'s `themeId?` input or the per-app
   * `App.defaultThemeId` default. Persisted across restart by stores
   * that survive restart (sqlite, dynamo); ephemeral on the in-memory
   * reference.
   */
  themeId?: string;
  /**
   * Host-supplied render-grouping slice, parsed from the inbound
   * `tools/call` request's `_meta["ai.ggui/host-session"]`. Set ONCE
   * at render creation (the first call materializing this row);
   * subsequent calls naming the same render id MUST NOT update it.
   *
   * Captures opt-in host identity for later rehydration via
   * `ggui_list_sessions(hostName, hostSessionId)`. Implementations
   * MUST persist both fields together on stores that survive restart;
   * the in-memory reference holds it for the process lifetime only.
   * Absent on legacy rows (pre-slice) — those renders are
   * non-rehydratable by design.
   */
  hostSession?: {
    readonly hostName: string;
    readonly hostSessionId: string;
  };
}

/**
 * Filter for {@link GguiSessionStore.list}.
 */
export interface GguiSessionFilter {
  appId?: string;
  userId?: string;
  status?: 'active' | 'expired';
  createdAfter?: number;
  createdBefore?: number;
  limit?: number;
  cursor?: string;
  /**
   * Filter by the host that created the render — paired with
   * {@link hostSessionId} for full-key lookups, or used alone to list
   * every render a given host has ever opened against this app.
   * Powers the `ggui_list_sessions` tool's host-scoped resume flow.
   */
  hostName?: string;
  /**
   * Filter by the host-supplied grouping key. Typically paired with
   * {@link hostName} so the same host-side id across two different
   * hosts cannot alias. Matches the persisted slice from
   * {@link CreateGguiSessionInput.hostSession}; renders without a host
   * slice never match (one-shot rows are non-rehydratable).
   */
  hostSessionId?: string;
}

/**
 * Patch shape for {@link GguiSessionStore.update}. Partial; only fields present
 * are updated. Writing an event is NOT done through `update` — use
 * `appendEvent`.
 */
export interface GguiSessionPatch {
  lastActivityAt?: number;
  expiresAt?: number;
  /**
   * Latest host-context projection echoed by the iframe-runtime.
   * Wire path: client →
   * `host_context_observed` live-channel message → server inbound
   * handler → `update(sessionId, { hostContext })` → persisted on
   * `GguiSession.hostContext`. Idempotent overwrite; merge logic lives
   * client-side in `host-context-emitter`.
   */
  hostContext?: HostContextProjection;
}

/**
 * Append-only event writer. Returns the assigned `seq`.
 * Implementations MUST ensure `seq` is monotonic + gap-free per render.
 */
export interface AppendEventInput {
  sessionId: string;
  type: GguiSessionEventType;
  data: unknown;
}

/**
 * Input for {@link GguiSessionStore.commit} — the full GguiSession payload
 * mints/replaces in one call. A render IS the top-level row, so
 * committing the visible-bits surface is just an upsert on the row
 * itself.
 *
 * Behavior:
 *
 *   - If no row with `render.id` exists, create one (with the standard
 *     lifecycle fields populated from `now`).
 *   - If a row with `render.id` exists, replace its visible-bits surface
 *     in place; lifecycle fields (`createdAt`, `eventSequence`,
 *     `hostSession`) are preserved across the upsert. `lastActivityAt`
 *     bumps to `now`.
 *
 * Implementations MAY refuse to commit to an expired render (past
 * `expiresAt`); the OSS in-memory + sqlite stores currently accept
 * the write either way and surface lifecycle exclusively via the
 * `status` field on subsequent reads.
 */
export interface CommitGguiSessionInput {
  render: GguiSession;
  /**
   * Carries the tenancy + identity slice when the row doesn't yet
   * exist. Required so first-write `commit` calls can mint the row
   * without a separate `create` round-trip.
   */
  appId: string;
  userId?: string;
  endUserIdentity?: import('@ggui-ai/protocol').EndUserIdentity;
  themeId?: string;
  hostSession?: {
    readonly hostName: string;
    readonly hostSessionId: string;
  };
}

export interface GguiSessionStore {
  create(input: CreateGguiSessionInput): Promise<StoredGguiSession>;
  get(id: string): Promise<StoredGguiSession | null>;
  list(filter: GguiSessionFilter): Promise<StoredGguiSession[]>;
  update(id: string, patch: GguiSessionPatch): Promise<StoredGguiSession>;
  delete(id: string): Promise<void>;

  /**
   * Upsert a render row with the supplied {@link GguiSession} payload. Used
   * by `ggui_render` at commit time — the agent has produced the full
   * render shape and the server persists it.
   *
   * See {@link CommitGguiSessionInput} for the create-vs-replace behavior.
   * Returns the committed render.
   */
  commit(input: CommitGguiSessionInput): Promise<StoredGguiSession>;

  /** Write a new event and return the assigned `seq`. */
  appendEvent(input: AppendEventInput): Promise<number>;

  /**
   * List events for a render with `seq > sinceSeq`, capped at `limit`.
   *
   * Backs the R7 `GET /api/sessions/:id/events?sinceSequence=N&limit=M`
   * HTTP endpoint and the WS-subscribe `sinceSequence` cursor replay
   * (`SubscribePayload.sinceSequence`). Returns `{events, lastSequence,
   * hasMore, horizonSeq}` where:
   *
   *   - `events` — strictly ascending by `seq`, only entries with
   *     `seq > sinceSeq`, up to `limit` items.
   *   - `lastSequence` — the render's current high-water mark
   *     (`GguiSession.eventSequence`) regardless of pagination. Clients use
   *     this to advance their cursor on empty pages.
   *   - `hasMore` — `true` when the page was truncated by `limit`.
   *   - `horizonSeq` — the lowest `seq` the implementation can still
   *     replay (events with `seq <= horizonSeq` have been evicted from
   *     the bounded retention window). `0` means "no horizon — full
   *     history is replayable since render creation". A caller's
   *     `sinceSeq < horizonSeq` MUST be treated as
   *     REPLAY_HORIZON_PASSED.
   *
   * Returns `null` when the render does not exist (404-equivalent;
   * distinct from an empty `events[]` page on a live render).
   *
   * Implementations MUST honor `limit` strictly — even if more events
   * are available, `events.length <= limit`.
   */
  listEventsSince(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{
    readonly events: readonly GguiSessionEvent[];
    readonly lastSequence: number;
    readonly hasMore: boolean;
    readonly horizonSeq: number;
  } | null>;

  /**
   * Subscribe to the append-only event stream for a render.
   *
   * **Normative semantics** (every implementation MUST satisfy these):
   *
   * - **Snapshot + tail.** Default: replay all historical events in order
   *   (from `opts.fromSeq`, default 1), then yield new events as written.
   *   `tail: false` stops after historical replay.
   *
   * - **Ordering.** FIFO within a single render. `seq` is monotonic and
   *   gap-free starting at 1. No ordering guarantee across renders.
   *
   * - **Reconnect / resume.** Consumers track the last `seq` they processed
   *   and pass `fromSeq` on reconnect to resume without full replay.
   *   Delivery is at-least-once; consumers MUST dedupe by `seq`.
   *
   * - **Stream shape.** Append-only typed events, NOT state-change diffs.
   *   Consumers reconstruct current state by folding events.
   *
   * - **End-of-life.** The iterable ends cleanly when the render is
   *   deleted (`delete` wakes waiters with null) or when the consumer
   *   disposes. There is no terminal event — renders decay implicitly
   *   via TTL, and a consumer of an expired render simply stops
   *   receiving new entries (the historical replay is still served).
   */
  observe(id: string, opts?: ObserveOptions): AsyncIterable<GguiSessionEvent>;
}
