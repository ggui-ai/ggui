import type { z } from 'zod';
import type { DataContract, JsonObject, JsonSchema, JsonValue } from './data-contract';
import type { Render, RenderStatus } from './render';
import type {
  handshakeInputSchema,
  handshakeOutputSchema,
  renderCacheMarkerSchema,
  renderInputSchema,
  renderOutputSchema,
  updateInputSchema,
  updateOutputSchema,
  declareToolCatalogInputSchema,
  declareToolCatalogOutputSchema,
} from '../schemas/mcp';

export type { RenderStatus } from './render';
// Zod schemas in ../schemas/mcp.ts are the runtime validation source of truth.
// These TypeScript types are the compile-time API surface with precise domain types
// (DataContract, InterfaceContext, etc.) that Zod can't express.
// Both define the same fields — kept in sync by convention.

/** Target screen size category for responsive layout */
export type Screen = 'mobile' | 'tablet' | 'desktop' | 'universal';

/**
 * Pending action stored server-side for agent consumption.
 *
 * `envelope` is the canonical {@link ConsumeEventEntry} row. `sequence`
 * is the render-scoped monotonic assigned at ingestion; it sits on the
 * row wrapper so consumers can detect gaps without parsing the payload.
 *
 * **Storage note**: the envelope is stored as either a JSON object
 * (direct DDB writes) or a JSON-stringified object (AppSync `a.json()`
 * semantics). Consume readers MUST accept both — see
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
   * Render-scoped monotonic sequence assigned at ingestion. Mirrors
   * `Render.eventSequence` at the moment this row was appended so
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
 * Keyed by `renderId`. The agent gets `renderId` from
 * `renderOutput.renderId`.
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
 */
export interface GguiConsumeInput {
  /**
   * Render to consume events from. Globally unique (UUID).
   * Cross-tenant access surfaces uniformly as `render_not_found`.
   */
  renderId: string;
  /**
   * Timeout in seconds for long-poll. Server-side wall-clock cap.
   * - 0: immediate return (no waiting)
   * - 1-25: synchronous long-poll (HTTP API, capped by 30s gateway limit)
   * - 26-900: SSE streaming via server-sent events (up to 15 min)
   * The MCP client SDK routes to the appropriate endpoint automatically.
   * Default: 0 (immediate).
   */
  timeout?: number;
}

/**
 * Input for `ggui_emit` — emit a new delivery on a declared channel of the
 * render's `streamSpec`.
 *
 * Canonical, post-rewrite shape. The agent describes what new data
 * exists; the server describes how the channel behaves.
 *
 * Fields the agent MUST NOT supply:
 *   - `mode` — derived from `streamSpec[channel].mode` (default `'append'`).
 *   - `seq` — server-assigned via `RenderStreamBuffer`.
 *   - `timestamp` — server clock.
 *   - `connectionId` / transport details — fan-out plumbing.
 *
 * Any of these appearing on `GguiEmitInput` is a drift regression and
 * guarded by `types.test.ts`.
 */
export interface GguiEmitInput<TPayload = JsonValue> {
  /** Render to stream to. Server enforces app-ownership. */
  renderId: string;

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
export interface GguiEmitOutput {
  /** True when the server accepted the delivery at the boundary. */
  accepted: boolean;

  /**
   * Render-scoped monotonic outbound sequence assigned to this
   * delivery. Omitted on implementations without a
   * `RenderStreamBuffer` (hosted cloud today); required on OSS
   * `@ggui-ai/mcp-server`.
   */
  seq?: number;
}



/**
 * Input for ggui_get_render tool - retrieves render state
 */
export interface GguiGetRenderInput {
  /** Render ID to get state for */
  renderId: string;
}

/**
 * Output from ggui_get_render tool — full render snapshot.
 */
export type GguiGetRenderOutput = Render;

// =============================================================================
// Negotiator Types (V3)
// =============================================================================

/** Negotiator's decision on what UI to show. */
export interface NegotiatorDecision {
  /** What to do with the render. */
  action: 'create' | 'update' | 'compose' | 'replace';
  /** Why — visible to the agent. */
  reasoning: string;
  /** Matched blueprint (if any). */
  blueprintId?: string;
  /** The agreed data contract. */
  contract: DataContract;
  /** For update/compose/replace — which render to target. */
  targetRenderId?: string;
  /** UI adaptations based on user context. */
  adaptations?: {
    fontSize?: 'compact' | 'default' | 'large';
    density?: 'dense' | 'default' | 'spacious';
    complexity?: 'simplified' | 'default' | 'detailed';
  };
}

/** Alternative option (shown in suggestive/passive modes). */
export interface NegotiatorAlternative {
  id: string;
  type: 'blueprint' | 'brainstorm';
  description: string;
  blueprintId?: string;
  contract?: DataContract;
  renderTime: 'instant' | 'standard';
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
 * `{renderId, type, payload?, ...}` and lives on the WebSocket inbound
 * seam) — consume reads from a separate render-scoped pipe whose entries
 * originate at `submit_action`.
 */
export interface ConsumeEventEntry {
  /** Stable discriminator — always the literal `'action'`. */
  readonly type: 'action';
  /** Render the gesture targeted. */
  readonly renderId: string;
  /** Which `actionSpec[*]` entry the iframe dispatched against. */
  readonly intent: string;
  /**
   * Typed payload satisfying `actionSpec[intent].schema`. `null` for
   * no-payload gestures (bare button click).
   */
  readonly actionData: JsonValue | null;
  /**
   * Snapshot of the contract's `contextSpec` slot values at the moment
   * the user fired the gesture. Empty object `{}` when the contract
   * has no `contextSpec` or no slots have been mirrored yet.
   */
  readonly uiContext: JsonObject;
  /**
   * 8-hex FNV-1a correlation id of the gesture — matches the iframe-
   * runtime's outstanding-toast key and the server's `drain_ack` frame.
   */
  readonly actionId: string;
  /** ISO 8601 UTC timestamp of the gesture (iframe-local clock). */
  readonly firedAt: string;
}

/**
 * Output from `ggui_consume` — buffered consume-entries.
 *
 * `events` is an array of {@link ConsumeEventEntry} rows in append order.
 * The pre-2026-05-14 top-level `contextSnapshot` field was RETIRED in
 * favor of the per-event `uiContext` on each entry. The pipe is the
 * single source of truth — both the action and the local UI state are
 * atomic on a single entry.
 */
export interface GguiConsumeOutput {
  /** Buffered consume-entries (cleared after return). */
  events: ConsumeEventEntry[];
  /** Render status — `'expired'` means the render's TTL elapsed and
   *  no more events will arrive; the agent's long-poll loop terminates. */
  status: RenderStatus;
  /**
   * Client-side observations echoed back to the agent. Same shape
   * `ggui_handshake` exposes. Lets the agent pick up mid-render
   * changes (window resize, fullscreen toggle, etc.) without waiting
   * for the next handshake. Absent ⇒ no client observations yet.
   *
   */
  client?: {
    readonly hostContext?: import('./host-context.js').HostContextProjection;
  };
}

/**
 * Input for ggui_list_featured_blueprints tool - discovers available UI blueprints
 */
export interface GguiListFeaturedBlueprintsInput {
  /** Filter by component level. Canonical four-level hierarchy:
   *  `primitive` (Button) → `component` (SearchField) → `composite`
   *  (LoginForm, Modal) → `template` (ListDetail, Dashboard page). */
  level?: 'primitive' | 'component' | 'composite' | 'template';
  /** Filter by category */
  category?: string;
  /** Filter by tags (any match) */
  tags?: string[];
  /** Max results (default: 50) */
  limit?: number;
}

/**
 * Output from ggui_list_featured_blueprints tool
 */
export interface GguiListFeaturedBlueprintsOutput {
  /** List of matching blueprints */
  blueprints: Array<{
    id: string;
    name: string;
    source: 'predefined' | 'cached';
    description: string;
    category: string;
    level: string;
    props: Array<{ name: string; type: string; required: boolean; description: string }>;
    examples: string[];
    tags: string[];
    usageCount?: number;
  }>;
  /** Total number of matching blueprints */
  total: number;
}

/**
 * Input for ggui_search_blueprints tool - semantic search over blueprints
 */
export interface GguiSearchBlueprintsInput {
  /** Natural language description of the UI you're looking for */
  query: string;
  /** Max results (default: 10) */
  limit?: number;
}

/**
 * Output from ggui_search_blueprints tool
 */
export interface GguiSearchBlueprintsOutput {
  /** Matching blueprints ordered by relevance */
  results: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
    props: Array<{ name: string; type: string; required: boolean; description: string }>;
    callbacks: string[];
    /** Whether this is a featured/predefined blueprint (curated by the app developer) */
    featured: boolean;
    relevance: 'match';
    /** Cosine similarity score (0-1). Higher = better match. Agents can use this
     *  to decide whether to use a blueprint or generate from scratch. */
    score: number;
  }>;
  /** Total matches found */
  total: number;
  /** The query that was searched */
  query: string;
}

/**
 * Input for ggui_render_blueprint tool - renders a specific blueprint.
 * Generic `TProps` defaults to {@link JsonObject} for blueprint props.
 */
export interface GguiRenderBlueprintInput<TProps = JsonObject> {
  /** Blueprint ID to render */
  blueprintId: string;
  /** Props to pass to the blueprint */
  props?: TProps;
}

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

/**
 * Input for ggui_discover tool - discovers platform capabilities
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface GguiDiscoverInput {
  /** Reserved for future use (e.g., filtering by capability category) */
}

/**
 * Output from ggui_discover tool - platform capabilities and app configuration
 */
export interface GguiDiscoverOutput {
  /** Protocol version (e.g., 'draft-2026-04-19'). Prelaunch drafts use
   *  `draft-YYYY-MM-DD`; the first frozen release will be `1.0.0`. */
  protocolVersion: string;
  /** Supported content types (e.g., 'application/javascript+react') */
  contentTypes: string[];
  /** Available shell types (e.g., 'chat', 'fullscreen', 'spatial') */
  shellTypes: string[];
  /**
   * Available component capabilities — informational catalog string list
   * surfaced for discovery clients. The load-bearing per-app permission
   * grant flows via `DataContract.clientCapabilities.gadgets[*].permission`
   * (projected onto the bootstrap as `Permissions-Policy`); this field is
   * not consulted at boot or dispatch time.
   */
  componentCapabilities: string[];
  /** App-specific configuration (present when the app is found in the database) */
  app?: {
    /** Adapters enabled for this app */
    enabledAdapters: string[];
    /** Component capabilities granted to this app */
    grantedCapabilities: string[];
    /** Default shell type for new renders */
    defaultShellType: string;
    /** Authentication mode for end users */
    authMode: string;
    /** Rate limit in requests per minute (0 = unlimited) */
    rateLimitPerMinute: number;
  };
}

// =============================================================================
// Credential Request Tool
// =============================================================================

/**
 * Input for ggui_request_credential — request OAuth consent from the user.
 * Called by agents when MCP proxy returns 401 (credential_required).
 */
export interface GguiRequestCredentialInput {
  /** OAuth service ID (e.g., "bashdoor", "ubot") */
  serviceId: string;
  /** Why the agent needs this credential (shown to user) */
  reason?: string;
  /** Existing render to render consent UI into */
  renderId?: string;
}

/**
 * Output from ggui_request_credential — consent result.
 */
export interface GguiRequestCredentialOutput {
  /** Whether the user granted consent */
  granted: boolean;
  /** Grant mode (once or always) — only present when granted=true */
  mode?: 'once' | 'always';
  /** Service display info */
  service?: {
    name: string;
    icon: string;
  };
  /** Reason for denial (timeout, user denied, error) */
  reason?: string;
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

export type GguiUpdateInput = z.infer<typeof updateInputSchema>;
export type GguiUpdateOutput = z.infer<typeof updateOutputSchema>;

/**
 * `ggui_runtime_declare_tool_catalog` input/output. Derived from
 * {@link declareToolCatalogInputSchema} / {@link declareToolCatalogOutputSchema}
 * — the schemas are the source of truth. See those for the
 * canonical-tool-identity rationale.
 */
export type DeclareToolCatalogInput = z.infer<typeof declareToolCatalogInputSchema>;
export type DeclareToolCatalogOutput = z.infer<typeof declareToolCatalogOutputSchema>;

// =============================================================================
// MCP Error Codes
// =============================================================================

/**
 * Core protocol error codes (per spec Section 7.9)
 */
export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  // Protocol-specific error codes
  UNAUTHORIZED: -32001,
  RENDER_NOT_FOUND: -32002,
  APP_NOT_FOUND: -32003,
  PRODUCTION_FAILED: -32004,
  CAPABILITY_DENIED: -32005,
} as const;

/**
 * Platform-specific error codes (-32010 range).
 * These are ggui platform extensions, not part of the core protocol.
 */
export const PLATFORM_ERROR_CODES = {
  GENERATION_QUOTA_EXCEEDED: -32010,
  APP_LIMIT_EXCEEDED: -32011,
  CONCURRENT_RENDER_LIMIT: -32012,
  RATE_LIMIT_EXCEEDED: -32013,
  CONTRACT_VIOLATION: -32020,
} as const;
