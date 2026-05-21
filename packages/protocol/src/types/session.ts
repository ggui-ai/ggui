import type { EventSubscription } from './events';
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
import type { McpAppsMode } from './app-config';
// MCP Apps inbound variant lives behind a boundary subpath to keep core
// session typing opt-in. The import IS legitimate — the design lock
// explicitly treats the `StackItem` union as core's one concession to
// MCP Apps. Root-barrel exposure stays narrow (see index.ts).
import type { McpAppsStackItem } from '../integrations/mcp-apps';

/**
 * Declarative action for interactive UI elements.
 *
 * @deprecated Pre-actionSpec wire shape. New code declares user gestures
 * via {@link DataContract.actionSpec} ({@link ActionEntry}); the entry
 * carries `label` / `schema` / `nextStep` / `confirm` / `icon`. This
 * interface is retained because some stored stack items still carry an
 * `actions?: Action[]` field through denormalizers.
 *
 * Extends {@link JsonObject} so it can be serialized directly over
 * WebSocket or stored server-side without transformation.
 */
export interface Action extends JsonObject {
  /** Unique identifier for this action (returned in the event payload) */
  id: string;
  /** Human-readable label displayed on the UI element */
  label: string;
  /** Optional description shown as secondary text */
  description?: string;
  /** Optional icon hint (emoji or icon name) */
  icon?: string;
  /** Visual style hint */
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  /** Whether to show confirmation before triggering */
  confirm?: boolean | string;
  /** Whether currently disabled */
  disabled?: boolean;
}

/**
 * Stack item — the generated/native component variant.
 *
 * One of two variants in the {@link SessionStackEntry} discriminated
 * union (the other being {@link McpAppsStackItem} for inbound MCP Apps
 * hosting). The discriminator is the optional `type` field:
 *   - `type: 'component'` or absent  → this variant (generated UI).
 *   - `type: 'mcpApps'`              → {@link McpAppsStackItem}.
 *
 * Existing producers that don't populate `type` continue to create
 * component items — `type` is optional for back-compat with stored
 * data and producers from before the discriminated-union landed.
 * Consumers narrow via `item.type === 'mcpApps'` (or the
 * {@link isMcpAppsStackItem} helper in
 * `@ggui-ai/protocol/integrations/mcp-apps`).
 *
 * Generic `TProps` defaults to {@link JsonObject} for untyped usage.
 * When a contract is known, pass the inferred type for compile-time safety:
 * `StackItem<{ city: string; temperature: number }>`
 */
export interface StackItem<TProps = JsonObject> {
  id: string;
  /**
   * Variant discriminator. Optional on this (component) variant — an
   * absent `type` implicitly means `'component'`. Required `'mcpApps'`
   * on the {@link McpAppsStackItem} variant.
   */
  type?: 'component';
  /**
   * Theme preset id for THIS stack item — agent-explicit per-push
   * override on the layered theme-resolution chain:
   *
   *   1. `StackItem.themeId`  — this field (rare; agent explicit)
   *   2. `Session.themeId`    — chat-scoped default (set on new_session)
   *   3. `App.defaultThemeId` — server-side per-app default
   *   4. server fallback      — `listThemes()[0]` / process default
   *
   * First non-undefined wins at bootstrap-meta projection time. Set
   * this only when the agent wants ONE push to render differently
   * from the session default (e.g. an urgent alert in `crimson` while
   * the rest of the chat stays on `slate`). Most pushes omit it and
   * inherit the session theme; that's the intended common case.
   */
  themeId?: string;
  /** Blueprint component code (pure UI) */
  componentCode: string;
  /** Props to pass to the component at render time.
   *  Carries request-specific data values (e.g., { city: "Seoul", temperature: 15 }).
   *  Renderer passes these as: <Component {...props} /> */
  props?: TProps;
  /** The prompt that produced this component (if LLM-generated) */
  prompt?: string;
  /** Human-readable description of what this component is */
  description?: string;
  /** Content type. Determines how componentCode is interpreted.
   *  Default: 'application/javascript+react' */
  contentType?: string;
  /** Agent message to display while the component generates (thinking indicator) */
  message?: string;
  /** JSON Schema for validating user-submitted form data */
  schema?: JsonSchema;
  /**
   * Event filter — pre-actionSpec event-routing surface.
   *
   * @deprecated The four-spec model (propsSpec/actionSpec/streamSpec/
   * contextSpec) on {@link DataContract} replaces wholesale event
   * filtering. Retained on stored stack items for back-compat.
   */
  subscription?: EventSubscription;
  /** Capability permissions granted to this component */
  capabilities?: CapabilityPermissions;
  /**
   * Declarative interaction contract — pre-actionSpec list shape.
   *
   * @deprecated Use {@link DataContract.actionSpec} ({@link ActionEntry})
   * instead. Retained on stored stack items for back-compat.
   */
  actions?: Action[];
  /** Quality evaluation metadata */
  quality?: QualityMetadata;
  /** Generation error message (populated on failure) */
  error?: string;
  /** Stream contract — describes what data the component accepts in real-time via ggui_emit */
  streamSpec?: StreamSpec;
  /** Props contract — initial render data interface (JSON Schema-based) */
  propsSpec?: PropsSpec;
  /** Action contract — user interaction callbacks (JSON Schema-based) */
  actionSpec?: ActionSpec;
  /** Context contract — observable client state surfaced to the agent's
   * LLM context via React Context Providers. See {@link ContextSpec}
   * for the full contract. */
  contextSpec?: ContextSpec;
  /**
   * Client capabilities catalog — declarative browser-capability gadget
   * hook bindings carried alongside this stack item. Mirrored verbatim
   * from `DataContract.clientCapabilities` at `ggui_push` commit time.
   *
   * The persisted shape is the **wire** view
   * ({@link ClientCapabilitiesSpec}) — package-keyed:
   * `Record<package, { exports: Record<exportName, …> }>`. Identity
   * (`package` + per-export `name`) is preserved verbatim from the
   * agent's push payload — no enrichment overlay, no `version` (it
   * resolves from `App.gadgets`). Resolution metadata (`version`,
   * `bundleUrl`, `bundleSri`, `bundleHost`, `permission`, `connect`,
   * `styleUrl`, ...) lives on the parallel
   * {@link SessionStackEntry.gadgetDescriptors} sidecar — a filtered
   * snapshot of `App.gadgets` covering only the descriptors referenced
   * by this contract.
   *
   * Absent ⇒ no permissions requested (default-deny). Bootstrap omits
   * `permissionsPolicy` and the public-render HTTP response sets no
   * `Permissions-Policy` header beyond the host's own defaults.
   */
  clientCapabilities?: ClientCapabilitiesSpec;
  /**
   * Descriptor sidecar. Subset of `App.gadgets` containing
   * exactly the descriptors referenced by `clientCapabilities.gadgets`
   * — matched by `(package, export name)`. `version` is not on the
   * wire; it resolves from each descriptor's `App.gadgets` entry.
   * Snapshot at push-time; never re-resolved at render. Permissions-Policy
   * + CSP + bundle-loader derivation read from this array (see
   * `bootstrap-meta-derivation.ts`).
   *
   * Smaller than the full `App.gadgets` (~1-5KB typical); the full
   * catalog stays recoverable from operator config if forensics need it.
   *
   * Omitted when `clientCapabilities` declares no gadgets.
   */
  gadgetDescriptors?: readonly GadgetDescriptor[];
  /**
   * Last-known snapshot of the contextSpec slot values, mirrored from
   * the runtime's `ui/update-model-context` posts via `ggui_runtime_sync_context`.
   * Keyed by slot name; values are JSON-serializable per the slot's
   * declared schema. Last-write-wins (REPLACE semantics, never merge).
   *
   * Resume contract — when chat-history rehydrate re-mounts the
   * iframe, the resource handler seeds `contextSlots[i].default` with
   * `contextSnapshot[name]` (when present) instead of the
   * authoring-time default. Without this field, rehydrate loses the
   * user's interactive state (typed text, counter values, toggle
   * positions); with it, the user sees their last-known state.
   *
   * Absent on initial render until the first context-update fires
   * from the runtime. The bootstrap-meta projection
   * (`deriveStackItemBootstrapView`) gracefully falls back to
   * `entry.default` per slot when this field is absent.
   */
  contextSnapshot?: JsonObject;
  createdAt: string; // ISO datetime string
}

/**
 * Recognised system-card kinds the runtime renders via built-in
 * components. The wire is open-ended (string), but new kinds without a
 * matching renderer fall through to a generic "system message" card so
 * an old runtime + new server still produce something visible.
 */
export type SystemStackItemKind =
  | 'no-credentials'
  | 'mcp-apps-probe'
  // Future kinds: 'rate-limited' | 'quota-exceeded' | 'server-down' …
  | (string & {});

/**
 * Stack item — server-emitted system card.
 *
 * The third StackItem variant. Used when the SERVER (not an LLM, not
 * an MCP host) needs to render a UI card the operator can act on:
 * "set up your LLM key", "rate limited, try later", "server is
 * misconfigured", etc.
 *
 * Why a separate variant: prior to this, system cards were authored
 * as raw ESM source strings inlined alongside generated `componentCode`
 * (see deleted `CONNECT_CLAUDE_CARD_COMPONENT_CODE`). That pattern
 * bypasses TS, lint, and design-system co-evolution, and forces server
 * code to hand-emit `React.createElement` calls. The system variant
 * carries an opaque `kind` + structured `props`; the runtime maps the
 * kind to a real `.tsx` component bundled inside it.
 *
 * Wire shape is intentionally tiny — server emits identifier + data,
 * not code.
 */
export interface SystemStackItem<TProps extends JsonObject = JsonObject> {
  id: string;
  type: 'system';
  /**
   * Identifier the runtime maps to a built-in renderer. Stable strings
   * (kebab-case) that survive runtime version skew — adding a new kind
   * never breaks an older runtime; it just falls through to a generic
   * card carrying the props as raw JSON.
   */
  kind: SystemStackItemKind;
  /** Props forwarded to the built-in renderer. */
  props?: TProps;
  /** Optional descriptive text the server can attach (telemetry, logs). */
  description?: string;
  createdAt: string;
}

/**
 * Canonical session-stack entry — discriminated union over the three
 * stack-item variants ggui supports:
 *
 *   - {@link StackItem} — generated / native component (has
 *     `componentCode`, `actionSpec`, `streamSpec`, etc.).
 *   - {@link McpAppsStackItem} — embedded third-party MCP App iframe.
 *   - {@link SystemStackItem} — server-emitted system card (carries a
 *     stable `kind` + props; runtime renders via a built-in
 *     component).
 *
 * Narrowing pattern:
 * ```ts
 * if (entry.type === 'mcpApps') {
 *   // McpAppsStackItem — render via host-role adapter
 * } else if (entry.type === 'system') {
 *   // SystemStackItem — render via built-in card registry
 * } else {
 *   // StackItem — render via DynamicComponent
 * }
 * ```
 *
 * Or use the {@link isMcpAppsStackItem} / component helpers exported
 * from `@ggui-ai/protocol/integrations/mcp-apps`.
 */
export type SessionStackEntry<TProps = JsonObject> =
  | StackItem<TProps>
  | McpAppsStackItem
  | SystemStackItem;

/**
 * Adapter permission status
 */
export type PermissionStatus = 'granted' | 'denied' | 'prompt';

/**
 * Adapter permissions — per-session map keyed by Web Permissions API
 * name (see `KNOWN_PERMISSION_NAMES` in `validation/hygiene-rules.ts`).
 *
 * Keys derive from `KNOWN_PERMISSION_NAMES` so there's one source of
 * truth for permission identifiers across the protocol surface
 * (schema validation, hygiene rules, and runtime SDK cache).
 *
 * Pre-launch posture: no backward-compat alias for the old field
 * names — every consumer reads/writes through the runtime SDK
 * `requestPermission` call, which itself is gated against the same
 * enum.
 */
export type AdapterPermissions = {
  readonly [K in (typeof KNOWN_PERMISSION_NAMES)[number]]?: PermissionStatus;
};

/**
 * Session state (internal — includes implementation details like connectionId)
 */
export interface Session {
  id: string;
  appId: string;
  connectionId?: string;
  userId?: string;
  /** Full authenticated end-user identity (populated after auth gate) */
  endUserIdentity?: EndUserIdentity;
  /**
   * Theme preset id for this chat-scoped session. Set on
   * `ggui_new_session` from the agent's explicit `themeId` input or
   * the per-app `App.defaultThemeId` default. Read at every
   * `ggui_push` commit so the bootstrap-meta projection can resolve
   * the layered theme chain (see {@link StackItem.themeId} for the
   * full ordering). Absent ⇒ the chain falls through to the app /
   * server default at render time.
   */
  themeId?: string;
  stack: SessionStackEntry[];
  currentStackIndex: number;
  adapterPermissions: AdapterPermissions;
  eventSequence: number;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
  /**
   * Resolved session lifecycle status. SessionStore implementations
   * MAY populate this on `get` (e.g. InMemory + Sqlite compute from
   * internal `closed` flag + `expiresAt`; cloud Dynamo reads
   * `sessionStatus` row column). Absent = caller treats as
   * `'active'` — the legacy default for stores that don't surface
   * lifecycle state.
   */
  status?: 'active' | 'completed' | 'expired';
  /**
   * Latest `HostContextProjection` echoed from the iframe-runtime via
   * the live-channel `host_context_observed` message. Captured at iframe
   * `ui/initialize` time + updated on every spec-defined
   * `ui/notifications/host-context-changed` notification.
   *
   * Surfaced to the agent via `client.hostContext` on `ggui_handshake`
   * and `ggui_consume` output so the agent can reason about device
   * class, available display modes, and container dimensions on each
   * turn..
   *
   * Absent ⇒ the iframe has not echoed a HostContext yet (first push
   * before iframe mount, or non-spec-compliant host that doesn't
   * supply `McpUiHostContext`). Agent falls back to ggui's own
   * `InterfaceContext` in that case.
   */
  hostContext?: HostContextProjection;
  /**
   * Resolved MCP-Apps presentation mode for this session. Persisted at
   * `ggui_new_session` time from the app config's `defaultMcpAppsMode`
   * so mid-session app-config changes don't disrupt live sessions.
   *
   *   - `'inline'` (default): each `ggui_push` returns its own ui://
   *     resource. Today's behavior.
   *   - `'canvas'`: a session-scoped iframe was minted by
   *     `ggui_new_session`. `ggui_push` delivers via live-channel WS once
   *     the canvas iframe completes its `ui/initialize` handshake (see
   *     {@link canvasLoaded}).
   *
   * Absent ⇒ `'inline'` (zero-config default for legacy sessions).
   * 
   */
  mcpAppsMode?: McpAppsMode;
  /**
   * Set to `true` when the canvas iframe (for `mcpAppsMode === 'canvas'`
   * sessions) has completed its `ui/initialize` handshake AND opened
   * its live-channel subscription. Read by `ggui_push` to decide whether
   * to deliver state via WS (canvas loaded) or return a per-push
   * resource (canvas not yet loaded → fallback to inline-style
   * delivery for that single push).
   *
   * Always undefined / false for `mcpAppsMode === 'inline'` sessions.
   * 
   */
  canvasLoaded?: boolean;
  /**
   * Currently-active stack item id from the canvas's user nav stack.
   * Updated server-side on every `canvas_navigated` envelope from the
   * iframe. Drives `ggui_consume`'s active-pipe resolution (consumer
   * picks events targeting the active item, ignoring background
   * cold-gen for items the user has navigated away from) and gates
   * which in-flight `runGeneration` AbortSignals should fire.
   *
   * Distinct from `currentStackIndex`: that field tracks the SERVER's
   * stack mutation cursor (last push location); this tracks the
   * USER's navigation focus. They can diverge when the agent pushes
   * item C while the user is on item B — currentStackIndex points
   * to C, activeStackItemId stays B.
   *
   * Absent for inline sessions + the first push of a canvas session
   * before any `canvas_navigated` lands..
   */
  activeStackItemId?: string;
}

/**
 * Session view — clean protocol representation (no internal fields).
 * This is what agents see via getSession.
 */
export interface SessionView {
  id: string;
  appId: string;
  status: 'active' | 'completed' | 'expired';
  stack: SessionStackEntry[];
  currentStackIndex: number;
  eventSequence: number;
  endUserIdentity?: EndUserIdentity;
  adapterPermissions?: AdapterPermissions;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
}

// =============================================================================
// Conversation History (Spec Section 6.4)
// =============================================================================

/**
 * A single turn in the agent-user conversation.
 * Platforms SHOULD record conversation turns automatically and forward them to agents.
 *
 * Generic `TToolArgs` defaults to {@link JsonObject} for the tool call arguments type.
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
 * Progress update emitted by a producer during component production.
 * Delivered via the `ggui:logs` bridge event.
 */
export interface ProgressUpdate {
  sessionId: string;
  stackItemId: string;
  step: 'queued' | 'negotiating' | 'matching' | 'generating' | 'compiling' | 'evaluating' | 'complete' | 'error';
  label: string;
  percent: number; // 0-100
  message?: string;
}
