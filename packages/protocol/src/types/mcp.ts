import type { z } from 'zod';
import type { DataContract, JsonObject, JsonSchema, JsonValue } from './data-contract';
import type { DeepReadonly } from './readonly';
import type {
  consumeInputSchema,
  getRenderSourceInputSchema,
  getSessionInputSchema,
  handshakeInputSchema,
  handshakeOutputSchema,
  renderBlueprintInputSchema,
  renderCacheMarkerSchema,
  renderErrorSchema,
  renderInputSchema,
  renderOutputSchema,
  resourceReadErrorCodeSchema,
  resourceReadErrorSchema,
  runtimePullInputSchema,
  runtimeTelemetryInputSchema,
  runtimeTelemetryOutputSchema,
  searchBlueprintsInputSchema,
  updateInputSchema,
  updateOutputSchema,
  amendInputSchema,
  amendOutputSchema,
  declareToolCatalogOutputSchema,
  gguiGetSessionOutputSchema,
  gguiSearchBlueprintsOutputSchema,
  consumeEventEntrySchema,
  gguiConsumeOutputSchema,
  gguiEmitOutputSchema,
  gguiListSessionsOutputSchema,
} from '../schemas/mcp';
import type {
  EventsResponse,
  ReplayHorizonPassedError,
} from './ggui-session-event';

export type { GguiSessionStatus } from './render';
// Zod schemas in ../schemas/mcp.ts are the runtime validation source of
// truth; tool input types here derive from them via `z.infer`. The few
// hand-authored shapes that remain (`GguiEmitInput`, the Output types)
// carry precise domain types (ConsumeEventEntry, GguiSession, etc.) that
// the loose runtime output schemas don't express; `GguiEmitInput`'s key
// set is drift-locked by `__tests__/ggui-emit.test-d.ts`.

/** Target screen size category for responsive layout */
export type Screen = 'mobile' | 'tablet' | 'desktop' | 'universal';

/**
 * Pending action stored server-side for agent consumption.
 *
 * `envelope` is the canonical {@link ConsumeEventEntry} row. `sequence`
 * is the render-scoped monotonic assigned at ingestion; it sits on the
 * row wrapper so consumers can detect gaps without parsing the payload.
 *
 * **Storage note**: the envelope is stored as either a JSON object or
 * a JSON-stringified object, depending on how the deployment's storage
 * layer serializes rows. Consume readers MUST accept both — see
 * {@link parsePendingEnvelope}.
 */
export interface PendingEvent {
  /** Stable row id — UUID assigned at ingestion. */
  id: string;
  /**
   * Canonical {@link ConsumeEventEntry} row payload. JSON object or
   * stringified JSON on the wire (both shapes round-trip through the
   * consume helpers).
   */
  envelope: ConsumeEventEntry | string;
  /**
   * GguiSession-scoped monotonic sequence assigned at ingestion. Mirrors
   * `GguiSession.eventSequence` at the moment this row was appended so
   * consumers can detect gaps without reading render state.
   */
  sequence: number;
  /** ISO datetime when the row was appended. */
  createdAt: string;
}

/**
 * Input for ggui_consume tool — long-poll for buffered events on a
 * specific render.
 *
 * Keyed by `sessionId`. The agent gets `sessionId` from
 * `renderOutput.sessionId`.
 *
 * Default semantic: long-poll, return on first event or server-default
 * timeout. Agent loops by re-calling. There is no `until` parameter —
 * the agent's loop policy is its own concern; the server delivers one
 * batch per call.
 *
 * Each drained entry on the output carries its own `uiContext` snapshot
 * captured at gesture time on the iframe; the top-level
 * `contextSnapshot` is intentionally absent from the output (see
 * {@link GguiConsumeOutput} / {@link ConsumeEventEntry}).
 *
 * Derived from `consumeInputSchema` — the schema (SPEC §7.3 timeout
 * bound: integer seconds in `[0, 25]`, default 0 = immediate) is the
 * source of truth.
 */
export type GguiConsumeInput = z.infer<typeof consumeInputSchema>;

/**
 * Input for `ggui_emit` — emit a new delivery on a declared channel of the
 * render's `streamSpec`.
 *
 * Canonical, post-rewrite shape. The agent describes what new data
 * exists; the server describes how the channel behaves.
 *
 * Fields the agent MUST NOT supply:
 *   - `mode` — derived from `streamSpec[channel].mode` (default `'append'`).
 *   - `seq` — server-assigned via `GguiSessionStreamBuffer`.
 *   - `timestamp` — server clock.
 *   - `connectionId` / transport details — fan-out plumbing.
 *
 * Any of these appearing on `GguiEmitInput` is a drift regression and
 * guarded by `types.test.ts`.
 */
export interface GguiEmitInput<TPayload = JsonValue> {
  /** GguiSession to stream to. Server enforces app-ownership. */
  sessionId: string;

  /**
   * Channel name. MUST be declared on the resolved render's
   * `streamSpec`. Undeclared channels are rejected at call time.
   */
  channel: string;

  /**
   * Payload for this delivery. Validated against
   * `streamSpec[channel].schema`.
   */
  payload: TPayload;

  /**
   * Terminal delivery marker. Only valid when the channel was declared
   * with `complete: true` on the streamSpec. Setting it on a non-
   * completable channel is rejected at call time.
   *
   * Post-complete behavior is NOT enforced server-side — producers
   * SHOULD NOT emit further deliveries on the same channel after
   * sending `complete: true`, but the server won't reject them.
   */
  complete?: boolean;
}

/**
 * Output from `ggui_emit`.
 *
 * `accepted` — the server validated and enqueued the envelope. Fan-out
 * to subscribers and buffered retention happen independently; whether
 * any subscriber is currently connected is a separate concern and does
 * NOT affect this flag. No-subscriber is not an error.
 */
export type GguiEmitOutput = DeepReadonly<z.infer<typeof gguiEmitOutputSchema>>;

/** `ggui_list_sessions`' wire, derived from {@link gguiListSessionsOutputSchema} (ggui#817 part C2). */
export type GguiListSessionsOutput = DeepReadonly<z.infer<typeof gguiListSessionsOutputSchema>>;



/**
 * Input for ggui_get_session tool — retrieves render state.
 * Derived from `getSessionInputSchema`.
 */
export type GguiGetSessionInput = z.infer<typeof getSessionInputSchema>;

/**
 * `ggui_get_session`'s wire — the projection, never a `GguiSession`: `variant`
 * + the store row's six base fields, plus `contextSnapshot` when the row has
 * one. Nothing else on the row travels (the transport strip-parses to this).
 */
export type GguiGetSessionOutput = DeepReadonly<
  z.infer<typeof gguiGetSessionOutputSchema>
>;

/**
 * Input for ggui_get_render_source tool — read the generated source of
 * the calling app's own render. Derived from `getRenderSourceInputSchema`.
 */
export type GguiGetRenderSourceInput = z.infer<typeof getRenderSourceInputSchema>;

/**
 * Output from ggui_get_render_source tool — the render's generated
 * source, ready to feed into a blueprint-save call unreshaped.
 * `contract` is reassembled from the render's own propsSpec/actionSpec/
 * streamSpec/contextSpec (this IS `DataContract`'s field set); absent
 * when the render declares none. `fixtureProps` is the render's live
 * prop values, when present.
 */
export interface GguiGetRenderSourceOutput {
  readonly sessionId: string;
  readonly blueprint: {
    readonly source: string;
    readonly contract?: DataContract;
    readonly fixtureProps?: unknown;
  };
}

// =============================================================================
// MCP Tool Output Types
// =============================================================================

/**
 * Per-event entry returned by `ggui_consume`. The shape written by
 * `ggui_runtime_submit_action`'s `kind:'dispatch'` handler onto the
 * render-keyed pending-events pipe and surfaced verbatim on drain.
 *
 * `actionData` is WHAT the user did; `uiContext` is the snapshot of the
 * contract's `contextSpec` slot values at the moment they did it.
 * Capturing both per-event (instead of folding a top-level
 * `contextSnapshot` at drain time) means agents see the UI state AS IT
 * WAS WHEN THE USER ACTED, not the post-action state that might already
 * have mutated by the time consume returns.
 *
 * Distinct from the inbound live-channel `ActionEnvelope` (which has
 * `{sessionId, type, payload?, ...}` and lives on the WebSocket inbound
 * seam) — consume reads from a separate render-scoped pipe whose entries
 * originate at `submit_action`.
 */
export type ConsumeEventEntry = Readonly<z.infer<typeof consumeEventEntrySchema>>;

/**
 * Output from `ggui_consume` — buffered consume-entries.
 *
 * `events` is an array of {@link ConsumeEventEntry} rows in append order.
 * The pre-2026-05-14 top-level `contextSnapshot` field was RETIRED in
 * favor of the per-event `uiContext` on each entry. The pipe is the
 * single source of truth — both the action and the local UI state are
 * atomic on a single entry.
 */
export type GguiConsumeOutput = DeepReadonly<z.infer<typeof gguiConsumeOutputSchema>>;

/**
 * Input for ggui_search_blueprints tool — semantic search over
 * blueprints. Derived from `searchBlueprintsInputSchema`.
 */
export type GguiSearchBlueprintsInput = z.infer<
  typeof searchBlueprintsInputSchema
>;

/**
 * Output from ggui_search_blueprints tool
 */
export type GguiSearchBlueprintsOutput = DeepReadonly<
  z.infer<typeof gguiSearchBlueprintsOutputSchema>
>;

/**
 * Input for ggui_render_blueprint tool — renders a specific blueprint.
 * Derived from `renderBlueprintInputSchema`.
 */
export type GguiRenderBlueprintInput = z.infer<
  typeof renderBlueprintInputSchema
>;

/**
 * Output from ggui_render_blueprint tool.
 *
 * The OSS path returns the compiled bundle inline (`code` + `contentType`)
 * so agents + viewers can consume it without a second round-trip. When
 * the hosted cloud re-introduces signed-URL rendering it will layer on
 * additional optional fields; the inline shape stays the baseline contract
 * every implementation honors.
 */
export interface GguiRenderBlueprintOutput {
  /** Blueprint ID that was rendered. */
  blueprintId: string;
  /** Blueprint name for display. */
  blueprintName: string;
  /**
   * Compiled JS bundle as a string. ESM `export default` producing the
   * component that should mount. Non-empty on success.
   */
  code: string;
  /**
   * MIME / content-type of `code`. Typically
   * `'application/javascript+react'` — pinned on the server's compile
   * pipeline; agents treat this as opaque.
   */
  contentType: string;
}

// =============================================================================
// MCP Protocol Types
// =============================================================================

/**
 * MCP JSON-RPC request.
 * Generic `TParams` defaults to {@link JsonObject} for the request parameters.
 */
export interface McpRequest<TParams = JsonObject> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: TParams;
}

/**
 * MCP JSON-RPC response.
 * Generic `TResult` defaults to {@link JsonValue} to accept any JSON-safe result.
 */
export interface McpResponse<TResult = JsonValue> {
  jsonrpc: '2.0';
  id: string | number;
  result?: TResult;
  error?: McpError;
}

/**
 * MCP error object.
 * The `data` field is {@link JsonValue} to carry any JSON-safe diagnostic data.
 */
export interface McpError {
  code: number;
  message: string;
  /** Additional error data. Typed as {@link JsonValue} (any JSON-safe value). */
  data?: JsonValue;
}

/**
 * MCP tool definition.
 * Extends {@link JsonObject} for JSON serialization compatibility.
 */
export interface McpToolDefinition extends JsonObject {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JsonSchema>;
    required?: string[];
  };
  // MCP 2025-06-18+ — schema of the tool's structuredContent result.
  outputSchema?: {
    type: 'object';
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
}

/**
 * MCP server info for initialize response.
 * Extends {@link JsonObject} for JSON serialization compatibility.
 */
export interface McpServerInfo extends JsonObject {
  name: string;
  version: string;
}

/**
 * MCP capabilities.
 * Extends {@link JsonObject} for JSON serialization compatibility.
 */
export interface McpCapabilities extends JsonObject {
  tools?: Record<string, never>;
}

// =============================================================================
// Lifecycle tool input/output types
// =============================================================================
//
// Types for the canonical `ggui_handshake` / `ggui_render` / `ggui_update`
// lifecycle tools. Derived from the Zod schemas in `schemas/mcp.ts` via
// `z.infer` — schemas are the runtime validation source of truth.

export type GguiHandshakeInput = z.infer<typeof handshakeInputSchema>;
export type GguiHandshakeOutput = z.infer<typeof handshakeOutputSchema>;

/**
 * Server-side stream-transport capability advertised on every successful
 * `ggui_handshake` response (see {@link GguiHandshakeOutput.serverCapabilities}).
 *
 * Mirrors `handshakeOutputSchema.serverCapabilities` exactly — exported
 * here as a named TypeScript type so server-side composition layers
 * (the OSS `createGguiServer` resolver, the cloud pod composer) can hand
 * one back to the handshake factory without re-deriving the shape from
 * the schema.
 *
 * Semantics + transport-negotiation rules: see the inline docstring on
 * `handshakeOutputSchema.serverCapabilities` in `schemas/mcp.ts`.
 *
 * Absent ⇒ universal iframe-polling fallback. Present ⇒ `@ggui-ai/wire`
 * negotiates per channel against the allowlist.
 */
export interface ServerCapabilities {
  /**
   * WebSocket endpoint that fans out
   * `streamSpec[ch].source.tool` results. Iframe opens this socket on
   * bootstrap and sends a `channel_subscribe` frame per streamSpec entry
   * whose `source.tool` is in {@link streamWebSocketLocalTools}.
   */
  readonly streamWebSocket?: {
    readonly url: string;
  };
  /**
   * Whitelist of `source.tool` names the server can subscribe-for on
   * {@link streamWebSocket}. Channels whose `source.tool` is in this
   * set use the WebSocket subscribe path; channels whose source is
   * elsewhere fall through to iframe polling.
   */
  readonly streamWebSocketLocalTools?: readonly string[];
}

export type GguiRenderInput = z.infer<typeof renderInputSchema>;
export type GguiRenderOutput = z.infer<typeof renderOutputSchema>;

/**
 * Reuse outcome surfaced on a single `ggui_render`. Derived from
 * {@link renderCacheMarkerSchema} — the schema is the source of truth.
 */
export type RenderCacheMarker = z.infer<typeof renderCacheMarkerSchema>;

/**
 * Canonical failure code for the in-result `ggui_render` failure
 * envelope (SPEC §7.9 Plane 3). Derived from
 * {@link renderErrorCodeSchema} — the schema is the source of truth.
 * Canonical declaration lives beside the schema in `schemas/mcp.ts`;
 * re-exported here so existing importers keep their path.
 */
export type { RenderErrorCode } from '../schemas/mcp';

/**
 * In-result failure marker on `GguiRenderOutput.error` — present iff the
 * tool result is `isError: true`. Derived from {@link renderErrorSchema}.
 */
export type RenderError = z.infer<typeof renderErrorSchema>;

/**
 * The three-outcome discriminant on `GguiRenderOutput.outcome`
 * (ggui#786) and the PRE-GENERATION refusal marker on
 * `GguiRenderOutput.refusal`. Canonical declarations live beside their
 * schemas in `schemas/mcp.ts`; re-exported here so importers of the
 * output types find them on the same path.
 */
export type { PreGenerationRefusal, RenderOutcome } from '../schemas/mcp';

/**
 * Canonical failure code for a `resources/read` on a render locator
 * (SPEC §7.9 Plane 1). Derived from
 * {@link resourceReadErrorCodeSchema} — the schema is the source of
 * truth. Distinct from {@link RenderErrorCode}, which classifies a
 * `ggui_render` tool call rather than a resource read.
 */
export type ResourceReadErrorCode = z.infer<typeof resourceReadErrorCodeSchema>;

/**
 * Failure shape for a `resources/read` that cannot return a mount.
 * Derived from {@link resourceReadErrorSchema}.
 */
export type ResourceReadError = z.infer<typeof resourceReadErrorSchema>;

export type GguiUpdateInput = z.infer<typeof updateInputSchema>;
export type GguiUpdateOutput = z.infer<typeof updateOutputSchema>;

export type GguiAmendInput = z.infer<typeof amendInputSchema>;
export type GguiAmendOutput = z.infer<typeof amendOutputSchema>;

/**
 * `ggui_runtime_declare_tool_catalog` output. Derived from
 * {@link declareToolCatalogOutputSchema} — the schema is the source of
 * truth. See `declareToolCatalogInputSchema` for the
 * canonical-tool-identity rationale (handlers consume that schema
 * directly; no separate Input type alias is published).
 */
export type DeclareToolCatalogOutput = z.infer<typeof declareToolCatalogOutputSchema>;

/**
 * `ggui_runtime_pull` input. Derived from
 * {@link runtimePullInputSchema} — the schema is the source of truth.
 */
export type GguiRuntimePullInput = z.infer<typeof runtimePullInputSchema>;

/**
 * `ggui_runtime_pull` output. Deliberately NOT `z.infer` of
 * `runtimePullOutputSchema`: byte-parity with
 * `GET /api/sessions/:sessionId/events` is the contract, so the output
 * type IS the canonical ledger pair from `./ggui-session-event` — the
 * same types the route's handlers produce. The zod union validates the
 * same language; `schemas/mcp.test.ts` pins schema ↔ type parity.
 */
export type GguiRuntimePullOutput = EventsResponse | ReplayHorizonPassedError;

/**
 * `ggui_runtime_telemetry` input. Derived from
 * {@link runtimeTelemetryInputSchema} — the schema is the source of
 * truth.
 */
export type GguiRuntimeTelemetryInput = z.infer<typeof runtimeTelemetryInputSchema>;

/**
 * `ggui_runtime_telemetry` output — bare `{ok: true}` acknowledgement.
 */
export type GguiRuntimeTelemetryOutput = z.infer<typeof runtimeTelemetryOutputSchema>;

// =============================================================================
// MCP Error Codes
// =============================================================================

/**
 * Core protocol error codes (per spec Section 7.9)
 *
 * `-32004` is RETIRED-RESERVED: it was assigned to `PRODUCTION_FAILED`,
 * a phantom code no first-party implementation ever emitted as a
 * JSON-RPC error. `PRODUCTION_FAILED` is now an in-result tool-error
 * code on the `ggui_render` failure envelope (SPEC §7.9 Plane 3 /
 * §7.1; see {@link RenderErrorCode}). The slot stays unassigned so a
 * future canonical code can't silently collide with stale consumers.
 *
 * `-32006` is assigned to `MOUNT_UNAVAILABLE`; new canonical codes come
 * at `-32007` onwards.
 */
export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Protocol-specific error codes (-32004 retired-reserved — see above)
  UNAUTHORIZED: -32001,
  SESSION_NOT_FOUND: -32002,
  APP_NOT_FOUND: -32003,
  CAPABILITY_DENIED: -32005,
  /**
   * A `resources/read` identified the resource but cannot return a
   * mount for it — the component behind it is gone, the server keeps no
   * durable record to restore from, or nothing can deliver it. See
   * {@link ResourceReadErrorCode} for the classification carried on
   * `error.data.code`.
   *
   * Deliberately NOT `INTERNAL_ERROR`. These outcomes are deterministic
   * and correctly served: the server is working, and retrying the same
   * read will fail the same way. Reporting them as `-32603` would tell
   * hosts the server malfunctioned and invite a retry that cannot
   * succeed. A read for a resource that does not exist (or that the
   * caller may not see) is `SESSION_NOT_FOUND` instead.
   */
  MOUNT_UNAVAILABLE: -32006,
} as const;

/**
 * Platform-specific error codes (-32010 range).
 * These are ggui platform extensions, not part of the core protocol.
 */
export const PLATFORM_ERROR_CODES = {
  GENERATION_QUOTA_EXCEEDED: -32010,
  APP_LIMIT_EXCEEDED: -32011,
  CONCURRENT_SESSION_LIMIT: -32012,
  RATE_LIMIT_EXCEEDED: -32013,
  /**
   * The generation queue is saturated — the server, not the caller, is
   * the limit (contrast `RATE_LIMIT_EXCEEDED`: the caller slows down). HTTP
   * 503 with `Retry-After`, which governs the retry; a parsed request's
   * refusal, so it speaks this table (ggui#836 follow-up).
   */
  GENERATION_OVERLOADED: -32014,
  CONTRACT_VIOLATION: -32020,
} as const;
