import type { CapabilityPermissions, QualityMetadata } from './capabilities';
import type { KNOWN_PERMISSION_NAMES } from '../validation/hygiene-rules';
import type {
  PropsSpec,
  StreamSpec,
  ActionSpec,
  ContextSpec,
  ClientCapabilitiesSpec,
  GadgetDescriptor,
  JsonSchema,
  JsonObject,
} from './data-contract';
import type { EndUserIdentity } from './auth';
import type { HostContextProjection } from './host-context';
import type { AppTheme } from '../schemas/app-theme';
// MCP Apps inbound variant lives behind a boundary subpath to keep core
// render typing opt-in. The import IS legitimate — the design lock
// explicitly treats the `GguiSession` union as core's one concession to MCP
// Apps. Root-barrel exposure stays narrow (see index.ts).
import type { McpAppsGguiSession } from '../integrations/mcp-apps';

// ============================================================================
// File status — Phase B render-identity collapse
// ============================================================================
//
// This file used to define `Session` (a vessel) wrapping
// `SessionStackEntry[]` (the actual rendered things). Post-Phase-A every
// session held a stack of exactly one entry, making the vessel dead
// weight; Phase B deletes the vessel and promotes the entries to a flat
// `GguiSession` shape.
//
// Renamed `session.ts`→`render.ts` in the render-identity cleanup; the
// EXPORTS were reworked end-to-end during Phase B:
//
//   Was                       →  Now
//   ──────────────────────────────────────────────────────
//   Session (interface)       →  DELETED (no vessel)
//   SessionView (interface)   →  DELETED (use GguiSession directly)
//   StackItem (interface)     →  ComponentGguiSession
//   SystemStackItem           →  SystemGguiSession
//   SessionStackEntry (union) →  GguiSession (the union)
//   Action (interface)        →  DELETED (was already @deprecated)
//   ProgressUpdate.sessionId +
//   ProgressUpdate.stackItemId →  ProgressUpdate.sessionId (collapsed)
//
// Conversation-scoped lookups (sibling renders, host continuity) flow
// via the unchanged `hostSessionId` channel — NOT by lifting fields
// from the deleted Session vessel onto every GguiSession. See
// [[session-concept-deletion-2026-05-27]] for the framing.

/**
 * Recognised system-card kinds the runtime renders via built-in
 * components. The wire is open-ended (string), but new kinds without a
 * matching renderer fall through to a generic "system message" card so
 * an old runtime + new server still produce something visible.
 */
export type SystemGguiSessionKind =
  | 'no-credentials'
  | 'mcp-apps-probe'
  // Future kinds: 'rate-limited' | 'quota-exceeded' | 'server-down' …
  | (string & {});

/**
 * Adapter permission status
 */
export type PermissionStatus = 'granted' | 'denied' | 'prompt';

/**
 * Adapter permissions — per-render map keyed by Web Permissions API
 * name (see `KNOWN_PERMISSION_NAMES` in `validation/hygiene-rules.ts`).
 *
 * Keys derive from `KNOWN_PERMISSION_NAMES` so there's one source of
 * truth for permission identifiers across the protocol surface
 * (schema validation, hygiene rules, and runtime SDK cache).
 */
export type AdapterPermissions = {
  readonly [K in (typeof KNOWN_PERMISSION_NAMES)[number]]?: PermissionStatus;
};

// ============================================================================
// GguiSession shape — the core protocol type
// ============================================================================

/**
 * Lifecycle status of a {@link GguiSession}. GguiSessionStore implementations MAY
 * populate this on `get`; absent ⇒ caller treats as `'active'`.
 *
 * Two states only:
 *   - `'active'` — within TTL, agent may still write/read.
 *   - `'expired'` — TTL elapsed; no further writes accepted, reads return
 *     a historical snapshot.
 *
 * There is no explicit terminal state. GguiSessions decay implicitly via TTL.
 * The dropped `'completed'` state was a vestige of the deleted Session
 * vessel — kept symmetrical with `ggui_new_session`, which was deleted
 * in the earlier handshake collapse. The companion `ggui_close` tool
 * that wrote it was removed in the same slice.
 */
export type GguiSessionStatus = 'active' | 'expired';

/**
 * Common base for every {@link GguiSession} variant. Carries identity,
 * tenancy, lifecycle, and conversation-scoped context that every
 * rendered thing has regardless of how its visible bits are
 * produced (LLM-generated component, server-emitted system card,
 * embedded MCP-App iframe).
 *
 * **Conversation-scoped context note** — fields that convey "this
 * GguiSession belongs to a logical group of GguiSessions within a host
 * conversation" (hostContext continuity, sibling-GguiSession discovery)
 * are NOT duplicated onto each GguiSession. They look up via the optional
 * {@link GguiSessionBase.hostSession} pair instead. See
 * [[session-concept-deletion-2026-05-27]] for the framing.
 */
export interface GguiSessionBase {
  /** GguiSession identity. The value an iframe's bootstrap meta and every
   *  wire reference (props_update, consume, update) keys by. */
  readonly id: string;
  /** App identity (tenancy boundary, always per-render). */
  readonly appId: string;
  /** Authenticated end-user (after the auth gate). Absent for anon
   *  flows. */
  readonly userId?: string;
  /** Full authenticated end-user identity (populated after auth gate). */
  readonly endUserIdentity?: EndUserIdentity;
  /**
   * Host-supplied conversation-grouping pair, captured ONCE at render
   * creation from `_meta["ai.ggui/host-session"]` on the inbound tool
   * call. Identifies the MCP host (claude.ai, sample, etc.) and the
   * host's opaque grouping key for "this conversation" — typically
   * the host's thread/chat id.
   *
   * Multiple GguiSessions inside one host conversation share the same
   * `hostSessionId`. The `ggui_list_sessions(hostName, hostSessionId)`
   * tool enumerates GguiSessions belonging to a host conversation; absent
   * `hostSession` ⇒ the GguiSession is one-shot (functional but
   * non-rehydratable).
   *
   * Once captured, immutable for the GguiSession's lifetime.
   */
  readonly hostSession?: {
    readonly hostName: string;
    readonly hostSessionId: string;
  };
  /**
   * Theme preset id for this render. Resolution chain:
   *   1. `GguiSession.themeId` — agent-explicit per-render override
   *   2. `App.defaultThemeId` — server-side per-app default
   *   3. server fallback (process default)
   * First non-undefined wins at bootstrap-meta projection.
   */
  readonly themeId?: string;
  /**
   * Latest `HostContextProjection` echoed from the iframe-runtime via
   * the live-channel `host_context_observed` message. Captured at
   * iframe `ui/initialize` time + updated on every spec-defined
   * `ui/notifications/host-context-changed` notification.
   *
   * Surfaced to the agent via `client.hostContext` on `ggui_handshake`
   * and `ggui_consume` output so the agent can reason about device
   * class, available display modes, and container dimensions.
   *
   * Absent ⇒ the iframe has not echoed a HostContext yet; agent falls
   * back to ggui's `InterfaceContext`.
   */
  readonly hostContext?: HostContextProjection;
  /**
   * Per-render Web Permissions API status map. Populated as the user
   * grants / denies adapter requests (geolocation, camera, etc.) over
   * the GguiSession's lifetime.
   */
  readonly adapterPermissions?: AdapterPermissions;
  /** Resolved lifecycle status. Absent ⇒ caller treats as `'active'`. */
  readonly status?: GguiSessionStatus;
  /** Monotonic event ledger sequence (per-render — each GguiSession has its
   *  own GguiSessionEvent ledger). */
  readonly eventSequence: number;
  /** Creation timestamp (epoch ms). */
  readonly createdAt: number;
  /** Last activity timestamp (epoch ms). */
  readonly lastActivityAt: number;
  /** Expiry timestamp (epoch ms). */
  readonly expiresAt: number;
}

/**
 * `GguiSession` — the canonical protocol shape for a single rendered UI.
 *
 * Three variants share {@link GguiSessionBase} (identity, tenancy,
 * lifecycle); each variant adds its own visible-bits surface:
 *
 *   - {@link ComponentGguiSession} — LLM-generated / native React component.
 *     Carries `componentCode`, `propsSpec`, `actionSpec`, `streamSpec`,
 *     `contextSpec`, `gadgetDescriptors`, etc.
 *   - {@link SystemGguiSession} — server-emitted system card. Carries an
 *     opaque `kind` + structured `props`; the runtime maps the kind to
 *     a built-in `.tsx` renderer.
 *   - {@link McpAppsGguiSession} — embedded third-party MCP-App iframe.
 *     Carries `resourceUri` + MCP server config. (Lives in
 *     `@ggui-ai/protocol/integrations/mcp-apps` to keep core typing
 *     MCP-Apps-opt-in.)
 *
 * Narrowing pattern:
 * ```ts
 * if (render.type === 'mcpApps') {
 *   // McpAppsGguiSession — render via host-role adapter
 * } else if (render.type === 'system') {
 *   // SystemGguiSession — render via built-in card registry
 * } else {
 *   // ComponentGguiSession — render via DynamicComponent
 * }
 * ```
 */
export type GguiSession<TProps = JsonObject> =
  | ComponentGguiSession<TProps>
  | SystemGguiSession
  | McpAppsGguiSession;

/**
 * GguiSession variant: LLM-generated / native React component.
 *
 * Discriminator: `type === 'component'` OR `type` absent (back-compat
 * default — every producer that omits `type` is producing this variant).
 */
export interface ComponentGguiSession<TProps = JsonObject> extends GguiSessionBase {
  /** Variant discriminator. Optional; absent ⇒ `'component'`. */
  readonly type?: 'component';
  /** Blueprint component code (pure UI). */
  readonly componentCode: string;
  /** Props passed to the component at render time. Carries
   *  request-specific data values (e.g., `{ city: 'Seoul', temperature: 15 }`). */
  readonly props?: TProps;
  /** The prompt that produced this component (when LLM-generated). */
  readonly prompt?: string;
  /** Human-readable description of what this component is. */
  readonly description?: string;
  /** Content type. Determines how `componentCode` is interpreted.
   *  Default: `'application/javascript+react'`. */
  readonly contentType?: string;
  /** Agent message to display while the component generates
   *  (thinking indicator). */
  readonly message?: string;
  /** JSON Schema for validating user-submitted form data. */
  readonly schema?: JsonSchema;
  /** Capability permissions granted to this component. */
  readonly capabilities?: CapabilityPermissions;
  /** Quality evaluation metadata. */
  readonly quality?: QualityMetadata;
  /** Generation error message (populated on failure). */
  readonly error?: string;
  /** Stream contract — describes what data the component accepts in
   *  real-time via `ggui_emit`. */
  readonly streamSpec?: StreamSpec;
  /** Props contract — initial render data interface
   *  (JSON Schema-based). */
  readonly propsSpec?: PropsSpec;
  /** Action contract — user interaction callbacks
   *  (JSON Schema-based). */
  readonly actionSpec?: ActionSpec;
  /** Context contract — observable client state surfaced to the agent's
   *  LLM context via React Context Providers. */
  readonly contextSpec?: ContextSpec;
  /**
   * Client capabilities catalog — declarative browser-capability gadget
   * hook bindings carried alongside this render. Mirrored verbatim from
   * `DataContract.clientCapabilities` at `ggui_render` commit time.
   *
   * Package-keyed wire shape; identity (`package` + per-export `name`)
   * preserved verbatim from the agent's render payload — no enrichment
   * overlay, no `version` (resolves from `App.gadgets`). Resolution
   * metadata lives on the parallel
   * {@link ComponentGguiSession.gadgetDescriptors} sidecar.
   */
  readonly clientCapabilities?: ClientCapabilitiesSpec;
  /**
   * Descriptor sidecar — subset of `App.gadgets` containing exactly
   * the descriptors referenced by `clientCapabilities`. Snapshot at
   * render-commit time; never re-resolved at runtime. Permissions-Policy
   * + CSP + bundle-loader derivation read from this array.
   */
  readonly gadgetDescriptors?: readonly GadgetDescriptor[];
  /**
   * Theme sidecar — the resolved per-app theme overlay (mode +
   * `--ggui-*` CSS-variable map) snapshotted from `App.theme` at
   * render-commit time. Sibling to {@link ComponentGguiSession.gadgetDescriptors}:
   * a render-time snapshot the slice-meta derivation reads without
   * re-resolving against the App record. The bootstrap projection
   * (`deriveRenderMeta`) surfaces it on the
   * `_meta["ai.ggui/render"].theme` slice so the iframe applies the
   * operator-curated overlay at boot. Absent ⇒ the renderer's default
   * theme.
   */
  readonly theme?: AppTheme;
  /**
   * Last-known snapshot of the contextSpec slot values, mirrored from
   * the runtime's `ui/update-model-context` posts via
   * `ggui_runtime_sync_context`. Last-write-wins (REPLACE semantics,
   * never merge).
   *
   * Resume contract — when chat-history rehydrate re-mounts the
   * iframe, the resource handler seeds `contextSlots[i].default` with
   * `contextSnapshot[name]` (when present) instead of the
   * authoring-time default.
   *
   * Absent on initial render until the first context-update fires
   * from the runtime.
   */
  readonly contextSnapshot?: JsonObject;
}

/**
 * GguiSession variant: server-emitted system card.
 *
 * Used when the SERVER (not an LLM, not an MCP host) needs to render
 * a UI card the operator can act on: "set up your LLM key", "rate
 * limited, try later", "server is misconfigured", etc.
 *
 * Wire shape is intentionally tiny — server emits identifier + data,
 * not code. The runtime maps `kind` to a built-in `.tsx` component.
 */
export interface SystemGguiSession<TProps extends JsonObject = JsonObject>
  extends GguiSessionBase {
  readonly type: 'system';
  /**
   * Identifier the runtime maps to a built-in renderer. Stable strings
   * (kebab-case) that survive runtime version skew — adding a new kind
   * never breaks an older runtime; it just falls through to a generic
   * card carrying the props as raw JSON.
   */
  readonly kind: SystemGguiSessionKind;
  /** Props forwarded to the built-in renderer. */
  readonly props?: TProps;
  /** Optional descriptive text the server can attach (telemetry, logs). */
  readonly description?: string;
}

// =============================================================================
// Conversation History (Spec Section 6.4)
// =============================================================================

/**
 * A single turn in the agent-user conversation.
 * Platforms SHOULD record conversation turns automatically and forward
 * them to agents.
 *
 * Generic `TToolArgs` defaults to {@link JsonObject} for the tool call
 * arguments type.
 */
export interface ConversationTurn<TToolArgs = JsonObject> {
  role: 'user' | 'agent';
  content: string;
  toolCalls?: { name: string; args: TToolArgs }[];
  timestamp: string; // ISO 8601
}

// =============================================================================
// Thinking Indicator Progress (Spec Section 2.8.2)
// =============================================================================

/**
 * Progress update emitted by a producer (UI generator) during component
 * production. Producer-internal vocabulary — consumed by the server's
 * generator seam (`@ggui-ai/mcp-server-core`), never delivered to
 * clients directly. Client-visible generation progress flows as
 * `{type: 'data'}` envelopes on the reserved `_ggui:lifecycle` channel.
 *
 * Post-Phase-B: collapsed from `{ sessionId, stackItemId }` to a single
 * `sessionId` (the two identifiers were the same value once each render
 * was its own thing).
 */
export interface ProgressUpdate {
  sessionId: string;
  step:
    | 'queued'
    | 'negotiating'
    | 'matching'
    | 'generating'
    | 'compiling'
    | 'evaluating'
    | 'complete'
    | 'error';
  label: string;
  percent: number; // 0-100
  message?: string;
}
