// packages/protocol/src/types/data-contract.ts
//
// `DataContract` — the typed declaration an agent author hands to ggui
// describing one screen of generated UI. Defines the wire surface the
// component compiles against AND the runtime surface the agent reads
// back via `ggui_consume`.
//
// Mental model — four typed specs + two catalogs:
//
//   propsSpec          : agent → client one-shot (initial render data)
//   streamSpec         : agent → client live    (live-channel emits)
//   actionSpec         : client → agent gesture (discrete events;
//                        agent reacts on next turn via `ggui_consume`)
//   contextSpec        : client → agent state   (observable last-write-wins)
//   agentCapabilities  : catalog of MCP tools the contract references
//                        (cross-ref target for `actionSpec[*].nextStep`
//                        and `streamSpec[*].source.tool`)
//   clientCapabilities : catalog of browser-capability hooks the component
//                        imports (`useGeolocation`, `useClipboardWrite`, …)
//
// Placement rule for the two inbound specs (actionSpec vs contextSpec):
// "does this thing need the agent's next-turn reasoning?" Yes →
// actionSpec (actions drive turns). No → contextSpec (context observes
// state). There is no third category.
//
// Shape: `actionSpec` / `streamSpec` / `contextSpec` are flat
// `Record<name, Entry>` maps. `propsSpec` is a wrapper
// `{description?, properties: Record<name, Entry>}` — `properties` is
// the JSON Schema field name for a property bag, and the wrapper-level
// `description` documents the props contract as a whole.
//
// Every entry under `propsSpec.properties` / `actionSpec` / `streamSpec`
// / `contextSpec` is a WRAPPER that contains a JSON Schema in its
// `schema:` field; the JSON Schema does NOT sit flat at the entry level.
// (The #1 LLM authoring mistake. See {@link PropEntry} / {@link ActionEntry}.)

// =============================================================================
// JSON Value — any JSON-serializable value
// =============================================================================

/**
 * A JSON object — the object branch of {@link JsonValue}.
 * Allows `undefined` values because TypeScript optional properties (`?:`)
 * produce `T | undefined`, and JSON objects can have missing keys.
 *
 * Used as the default generic parameter throughout the protocol where a
 * JSON-serializable object shape is expected (e.g., props, payloads, context).
 * Typed interfaces with optional properties satisfy `JsonObject` because
 * missing keys are `undefined` at runtime, which `JSON.stringify` omits.
 */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

/**
 * Recursive type for any JSON-serializable value.
 * Use instead of `unknown` when the value MUST be JSON-safe
 * (no functions, symbols, bigint, etc.).
 *
 * Used as the default for fields that carry arbitrary JSON data
 * (e.g., error details, schema defaults, example values).
 * Prefer `JsonObject` when the value is known to be an object,
 * and `JsonValue` when it could be any JSON leaf or structure.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

// =============================================================================
// JSON Schema (draft-07 subset)
// =============================================================================

/**
 * JSON Schema subset for defining data shapes in ggui contract.
 * Covers the types that map cleanly to TypeScript: primitives, objects, arrays, enums.
 *
 * Extends {@link JsonObject} so it can be used anywhere a JSON-serializable
 * object is expected (e.g., stored server-side, sent over WebSocket).
 * Fields like `default`, `example`, and `const` are typed as {@link JsonValue}
 * to accept any JSON-safe value.
 */
export interface JsonSchema extends JsonObject {
  /** JSON Schema type. Optional when using `oneOf`/`anyOf` unions. */
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null';
  description?: string;
  /** Allowed values (enum constraint) */
  enum?: JsonValue[];
  /** Default value */
  default?: JsonValue;
  /** Example value (for documentation / sample rendering) */
  example?: JsonValue;
  /** For type: 'array' — schema of each array element */
  items?: JsonSchema;
  /** For type: 'object' — property definitions */
  properties?: Record<string, JsonSchema>;
  /** For type: 'object' — which properties are required */
  required?: string[];
  /** For type: 'object' — schema for additional properties beyond `properties` */
  additionalProperties?: JsonSchema | boolean;
  /** For type: 'string' — format hint (e.g., 'date', 'email', 'uri') */
  format?: string;
  /** For type: 'number' / 'integer' — minimum value */
  minimum?: number;
  /** For type: 'number' / 'integer' — maximum value */
  maximum?: number;
  /** Union: exactly one of these schemas */
  oneOf?: JsonSchema[];
  /** Union: any of these schemas */
  anyOf?: JsonSchema[];
  /** Constant literal value */
  const?: JsonValue;
  /** OpenAPI 3.0 nullable shorthand */
  nullable?: boolean;
}

// =============================================================================
// Props Contract
// =============================================================================

/**
 * Per-prop metadata in a PropsSpec.
 * The `default` and `example` fields are {@link JsonValue} to accept any JSON-safe value
 * (string, number, boolean, null, array, or object).
 */
export interface PropEntry {
  /** Human-readable description of this prop */
  description?: string;
  /** JSON Schema for this prop's type */
  schema: JsonSchema;
  /** Whether this prop is required (component must accept it) */
  required?: boolean;
  /** Default value if not provided. Typed as {@link JsonValue} (any JSON-safe value). */
  default?: JsonValue;
  /** Example value (used for preview rendering). Typed as {@link JsonValue}. */
  example?: JsonValue;
  /**
   * Which MCP tool produces this prop's data, if any.
   * Data-lineage metadata. When set, the agent must have this tool available
   * (or `required: false` on this prop) for the contract to be satisfiable.
   * When absent, the agent populates the prop by its own means (memory,
   * reasoning, search, etc.). Blueprint matcher aggregates these for GSI
   * queries on `byPrimaryDataTool`.
   */
  sourceTool?: string;
}

/**
 * Props contract — defines the prop interface a generated component MUST implement.
 *
 * Shape: a wrapper `{description?, properties}` over the per-prop map.
 *
 * NOT flat like {@link ActionSpec} / {@link StreamSpec}, which dropped
 * their `{description, actions}` / `{description, channels}` wrappers
 * because their inner key name duplicated the parent
 * (`actionSpec.actions.createTask`). `PropsSpec.properties` is different:
 * `properties` is the JSON Schema field name for the per-property bag on
 * an object schema, so the wrapper matches a convention an external
 * implementer already knows from reading JsonSchema itself. Flattening
 * would also cost the top-level `description`, which documents the
 * props contract as a whole — a genuine load-bearing field, unlike the
 * vestigial descriptions on actionSpec / streamSpec.
 *
 * Symmetry is with {@link JsonSchema.properties}, not with sibling specs.
 * Implementers walking `DataContract` must special-case `props` vs
 * `actionSpec` / `streamSpec`.
 */
export interface PropsSpec {
  /** Human-readable description of the overall props contract */
  description?: string;
  /** Per-prop definitions keyed by prop name */
  properties: Record<string, PropEntry>;
}

// =============================================================================
// Stream Contract
// =============================================================================
//
// ── streamSpec design-lock ──────────────────────────────────────────────────
//
// `StreamSpec` declares the typed CHANNELS the component consumes on the
// live session plane (the live channel in the three-channel topology). Each
// entry in `channels` is one named channel:
//
//   - `schema` (required) is the payload contract — the SAME field every
//     live-channel enforcement point validates against (hosted fan-out, OSS
//     `/ws` fan-out, `@ggui-ai/react` data receipt, `@ggui-ai/
//     react-native` data receipt). `validateStreamData` enforces this.
//
//   - `mode` / `replay` / `complete` (optional) declare runtime semantics
//     OF the channel — how subscribers should fold deliveries into state,
//     what a reconnecting subscriber sees, and whether the channel has a
//     terminal marker. They are informational: payload-shape validation
//     does not touch them.
//
// Channels are the unit of streaming. When a subscriber attaches to a
// session, every channel declared in the active stack item's `streamSpec`
// is a typed pipe it can observe. The `data.type` field on every inbound
// delivery keys into this map.
//
// Explicit non-goals (do NOT silently regress):
//
//   1. NO envelope type wiring in THIS definition. The outbound stream
//      envelope shape (`seq`, `mode`, `complete`, etc.) lives in a
//      separate module — the declaration here tells envelope work
//      what semantics to honor.
//   2. NO server-side replay infrastructure. Declaring `replay: 'latest'`
//      or `'all'` is forward-compatible but consumers MUST NOT assume a
//      reconnecting subscriber receives history until the
//      `@ggui-ai/mcp-server-core` ring-buffer work lands.
//   3. NO conflation of channel SEMANTICS with channel PAYLOAD SHAPE.
//      `validateStreamData` validates shape only. Consumers that honor
//      `mode` / `replay` / `complete` do so at their own boundary, not
//      inside the shared validator.

/**
 * Per-channel state-folding mode. Tells subscribers whether each
 * delivery on a channel is a new event to accumulate or a full
 * replacement of the channel's current value.
 *
 * Default when omitted on a {@link StreamChannelEntry}:
 * {@link DEFAULT_STREAM_CHANNEL_MODE} (`'append'`).
 *
 * Maps 1:1 to the outbound stream envelope's `mode` field in the
 * three-channel-topology doctrine.
 */
export type StreamChannelMode = 'append' | 'replace';

/**
 * Per-channel replay policy. Declares what a reconnecting subscriber
 * sees before the live tail resumes.
 *
 * Default when omitted on a {@link StreamChannelEntry}:
 * {@link DEFAULT_STREAM_REPLAY_POLICY} (`'none'`).
 *
 * This is a DECLARATION. Replay infrastructure (ring buffer,
 * resumption tokens) lives in `@ggui-ai/mcp-server-core`. Consumers
 * MUST NOT assume replay is implemented just because the spec declares
 * `'latest'` or `'all'`; until the infra ships, the field is advisory.
 *
 * - `'latest'` — subscriber sees only the most recent payload for the
 *   channel (useful for state-broadcast channels).
 * - `'all'` — subscriber sees the full buffered history (useful for
 *   event logs / append-only feeds).
 * - `'none'` — no replay; subscriber only sees deliveries after
 *   attachment.
 */
export type StreamReplayPolicy = 'latest' | 'all' | 'none';

/** Locked default applied when {@link StreamChannelEntry.mode} is omitted. */
export const DEFAULT_STREAM_CHANNEL_MODE: StreamChannelMode = 'append';

/** Locked default applied when {@link StreamChannelEntry.replay} is omitted. */
export const DEFAULT_STREAM_REPLAY_POLICY: StreamReplayPolicy = 'none';

/** Locked default applied when {@link StreamChannelEntry.complete} is omitted. */
export const DEFAULT_STREAM_CHANNEL_COMPLETE = false;

/**
 * Per-channel metadata in a {@link StreamSpec}. Declares one named
 * channel's payload contract plus its runtime semantics.
 *
 * The payload `schema` is the authoritative contract — every live-channel
 * enforcement point validates deliveries against it. The semantics
 * fields (`mode` / `replay` / `complete`) are informational: consumers
 * that care about them honor them at their own boundary. Default
 * behavior when a field is omitted is documented per-field.
 */
export interface StreamChannelEntry {
  /** Human-readable description of this channel */
  description?: string;
  /**
   * JSON Schema for the channel payload. This is the authoritative
   * shape guard for every delivery on this channel — live-channel
   * enforcement points (hosted fan-out, OSS `/ws`, `@ggui-ai/react`
   * data receipt, `@ggui-ai/react-native` data receipt) all validate
   * deliveries against it.
   *
   * **Author invariant when paired with {@link StreamChannelEntry.tool}:**
   * when a refresh tool is declared, the values the tool returns MUST
   * be a superset of the values `schema` accepts — i.e., every
   * possible tool return passes validation. Drift in the opposite
   * direction (tool returns shapes the schema rejects) produces
   * `_ggui:contract-error` envelopes with `code: 'SCHEMA_VIOLATION'`
   * rather than silent data, but channel subscribers see fewer
   * refreshes than expected, which looks like a broken tool to
   * operators.
   *
   * **F4 schema compat checker.** The compat relation — every value
   * the tool returns MUST be accepted by this channel schema — is
   * encoded as `isSchemaSubset(channelSchema, toolReturnSchema)` and
   * is checked at push-time (before the stack item commits) and at
   * blueprint-registration time (when the blueprint pre-declares
   * tool refs). Mismatches surface as `SCHEMA_MISMATCH_ERROR` on
   * the reserved `_ggui:contract-error` channel rather than showing
   * up as downstream `SCHEMA_VIOLATION` rejections on individual
   * refreshes. Default policy is `'reject'`; see the docstring on
   * {@link ActionEntry.schema} for the full policy flag contract.
   */
  schema: JsonSchema;
  /** Example payload (used for documentation and smoke testing). Typed as {@link JsonValue}. */
  example?: JsonValue;
  /**
   * Client-side state-folding mode. See {@link StreamChannelMode}. When
   * omitted, consumers SHOULD apply {@link DEFAULT_STREAM_CHANNEL_MODE}
   * (`'append'`). Not a validator input — informational only.
   */
  mode?: StreamChannelMode;
  /**
   * Server-side replay policy. See {@link StreamReplayPolicy}. When
   * omitted, consumers SHOULD apply {@link DEFAULT_STREAM_REPLAY_POLICY}
   * (`'none'`). Advisory until the `@ggui-ai/mcp-server-core`
   * ring-buffer infrastructure ships.
   */
  replay?: StreamReplayPolicy;
  /**
   * Declares whether this channel has a terminal completion marker.
   * When omitted, consumers SHOULD treat the channel as open-ended
   * (default: {@link DEFAULT_STREAM_CHANNEL_COMPLETE}, `false`).
   *
   * Envelope-level plumbing (the outbound envelope's terminal marker)
   * is NOT wired by the current `StreamSpec` definition — declaring
   * `complete: true` here is forward-compatible but consumers MUST NOT
   * assume the envelope carries a completion field until the envelope
   * work lands.
   */
  complete?: boolean;
  /**
   * Optional MCP tool name this channel is refreshed from when a
   * wired action fires. Consumed by the server-side wiredActionRouter
   * (see `@ggui-ai/mcp-server` session-channel) as a declarative hint:
   * after a wired action on this stack item succeeds, the router
   * invokes the named tool and emits its return value on THIS channel.
   *
   * Name-scoping invariant:
   *
   *   A bare tool name (`"tasks_list"`) MUST be unique across every
   *   mount registered on the server. `composeHandlersWithMounts` in
   *   `@ggui-ai/mcp-server` rejects collisions at boot and names both
   *   owners in the error — an operator with two mounts both exposing
   *   `list` is forced to rename one. No namespace syntax is accepted
   *   here: MCP protocol requires unique tool names on `tools/list` /
   *   `tools/call` regardless, so two mounts can't both expose the
   *   same name at the wire level. Authors adding a second mount to
   *   an existing `ggui.json` SHOULD re-check this invariant; a newly-
   *   registered duplicate will fail server boot with a message
   *   naming both mounts.
   *
   * Refresh semantics (locked):
   *
   *   - The refresh tool SHOULD be idempotent-read-only. The router
   *     calls it after every wired action targeting this channel.
   *   - On failure, the router emits a `_ggui:contract-error` envelope
   *     (see {@link ContractErrorPayload}) and the channel's previous
   *     state is preserved — the router does NOT fall back to the
   *     wired action's own return value.
   *   - Authors who want write-then-read semantics SHOULD chain via a
   *     single action tool that returns the new state directly.
   *
   * Absent ⇒ no refresh fires; channel is written to by the agent (or
   * by some other server-emitted source). Declarative hint only — it
   * does NOT alter payload shape validation, which remains
   * `schema`-driven.
   */
  tool?: string;
  /**
   * Optional source declaration — when present, the channel is fed by
   * a tool called periodically (poll) or subscribed-to (push) by the
   * runtime. Replaces the retired top-level `broadcast` config.
   *
   * `tool` references an `agentCapabilities.tools[*]` key (structural
   * cross-ref enforced by the protocol linter: `CTR_REF_STREAM_SOURCE`).
   * `args` are passed on each call.
   *
   * Transport selection is NOT in the contract — it's runtime-negotiated
   * by `@ggui-ai/wire` between WebSocket subscribe (when the server
   * declares `serverCapabilities.streamWebSocket` AND the tool is in
   * `streamWebSocketLocalTools`) and iframe polling fallback.
   */
  source?: {
    /** agentCapabilities.tools key whose tool feeds this channel. */
    tool: string;
    /** Arguments passed to the source tool on each call. */
    args?: JsonObject;
  };
}

/**
 * Stream contract — describes the typed channels the component consumes
 * on the live session plane (the live channel in the three-channel doctrine).
 *
 * Shape: flat map keyed by channel name → entry.
 * `DataContract.streamSpec[channelName]` IS the entry.
 *
 * See the design-lock block above for what each channel declares and
 * what is explicitly NOT in scope for this shape.
 */
export type StreamSpec = Record<string, StreamChannelEntry>;


// =============================================================================
// Action Contract
// =============================================================================

/**
 * Per-action metadata in an ActionSpec. Actions are GESTURES — discrete
 * client-originated events the agent reacts to on its next turn. There
 * is one and only one routing target: the agent (no synchronous
 * server-side dispatch). Authors who want a hint about which tool the
 * agent SHOULD invoke next declare it via the optional `nextStep` field
 * below.
 *
 * Actions without a `schema` have void payload (fire-and-forget).
 * The `example` field is {@link JsonValue} to accept any JSON-safe sample.
 */
export interface ActionEntry {
  /** Human-readable description of this action */
  description?: string;
  /** Label shown on the UI element */
  label: string;
  /**
   * JSON Schema for the callback payload. Optional — actions without a
   * `schema` have void payload (fire-and-forget).
   *
   * **Author invariant when paired with `nextStep`:** the values
   * accepted by `ActionEntry.schema` SHOULD be a subset of the values
   * accepted by the hinted tool's `inputSchema`. The validation is
   * advisory — the agent owns the actual tool call on its next turn
   * and is responsible for shaping the payload as the tool expects.
   * For tools registered on THIS server, the F4 schema-compat checker
   * surfaces a `SCHEMA_MISMATCH_ERROR` at push-time / blueprint-
   * registration-time so authors get fail-loud feedback.
   *
   * The canonical algorithm lives in
   * `@ggui-ai/protocol/validation/schema-subset`; zod → JsonSchema
   * conversion uses `@ggui-ai/protocol/validation/zod-to-json-schema`.
   * Default policy is `'reject'`; hosts MAY configure `'warn'` or
   * `'off'` via `CreateGguiServerOptions.schemaCompatCheck`.
   *
   * P0 checker scope covers type match, required-set, property
   * recursion, items recursion, and `additionalProperties`.
   * Unsupported constructs (`oneOf` / `anyOf` / `enum` / `const` /
   * `$ref` / `allOf`) are flagged honestly rather than silently
   * passing — authors using them see a `'unsupported'` violation
   * reason and the check falls back to operator discipline for
   * those constructs. P1/P2 algorithm coverage is a follow-up.
   */
  schema?: JsonSchema;
  /** Example callback payload (used for documentation). Typed as {@link JsonValue}. */
  example?: JsonValue;
  /** Icon hint (emoji or icon name) */
  icon?: string;
  /** Whether to show confirmation before triggering */
  confirm?: boolean;
  /**
   * OPTIONAL. Author-declared hint for the agent's next turn — the
   * `agentCapabilities.tools[*]` key the agent INTENDS to call when
   * this action fires. The value MUST resolve to a declared
   * `agentCapabilities.tools` entry on the same contract (cross-ref
   * invariant `CTR_REF_NEXT_STEP`, enforced by
   * `@ggui-ai/protocol/validation/cross-references`).
   *
   * Hint, not binding. The runtime emits the action as an event; the
   * agent decides whether to honor the intent on its next turn based
   * on its broader context (other tools available, user history, etc.).
   *
   * When absent, the action is a pure event signal — the agent receives
   * `{action: <name>, data: <payload>}` and decides what to do
   * unconstrained by author intent.
   *
   * Implementations MUST forward `nextStep` as event metadata to the
   * agent without rejection. If the named tool isn't in the agent's
   * toolbox at dispatch time, the agent surfaces the gap on its next
   * turn (typically as `TOOL_UNAVAILABLE`); the protocol does NOT
   * fail at push.
   */
  nextStep?: string;
}

/**
 * Action contract — declarative callbacks the component must wire.
 *
 * Shape: flat map keyed by action name → entry.
 * `DataContract.actionSpec[actionName]` IS the entry.
 */
export type ActionSpec = Record<string, ActionEntry>;

/**
 * Input passed to a refresh tool when the wiredActionRouter fires it
 * after a wired action succeeds. See {@link StreamChannelEntry.tool}
 * for the broader refresh-semantics lock.
 *
 * **v1 constraint: always empty.** Refresh tools MUST be parameterless
 * (filter-less, context-less). Authors who need filtered / contextual
 * reads should chain the filter into a single action tool that returns
 * the filtered state directly — the refresh path is deliberately a
 * read-only re-fetch of the channel's canonical state.
 *
 * Typed as `Record<string, never>` (empty object with no properties)
 * rather than an empty interface so the type stays structurally
 * assignable to `Record<string, unknown>` call sites (e.g.,
 * `WiredActionRouter.invoke`) without any cast.
 *
 * This type is named separately from `{}` so that:
 *
 *   1. Call sites are grep-able — producers and consumers that need to
 *      reason about the refresh-input contract can find each other.
 *   2. v2 evolution (e.g., passing `{renderId}` / `{actor}` context on
 *      refresh) has a single point to widen; today's `{}` literal
 *      wouldn't trip any compile error if the wire expectation
 *      changed.
 *   3. Implementations of {@link WiredActionRouter} that want to treat
 *      refresh inputs specially (e.g., route through a different
 *      invoker) can pattern-match on the type.
 */
export type RefreshInput = Record<string, never>;

/**
 * Frozen singleton instance of {@link RefreshInput}. Pass this to
 * refresh-tool invocations instead of a fresh `{}` literal so that:
 *
 *   - Every call site emits exactly the same reference (cheap identity
 *     checks in mocks / spies / test harnesses).
 *   - `Object.freeze` catches accidental mutation that would otherwise
 *     surface as cross-invocation interference in long-running servers.
 */
export const EMPTY_REFRESH_INPUT: RefreshInput = Object.freeze(
  {},
) as RefreshInput;

// =============================================================================
// Agent Capabilities Contract
// =============================================================================

/**
 * Per-tool metadata in an {@link AgentCapabilitiesSpec}, keyed by the
 * bare MCP tool name (the catalog key) in {@link AgentCapabilitiesSpec.tools}.
 *
 * Documents an MCP tool the contract references — by `actionSpec[*].nextStep`,
 * by `streamSpec[*].source.tool`, or simply for the LLM-authoring catalog.
 *
 * Shape: `serverInfo` (OPTIONAL) carries the owning MCP server identity
 * from the `initialize` handshake; `(server, toolName)` is the canonical
 * cross-framework identity — `serverInfo.version` is metadata, NOT
 * identity (so it never enters the canonical contract hash). `toolInfo`
 * echoes the MCP `tools/list` descriptor (minus `name`, which is the
 * catalog key). The ggui authoring layer adds `usage` + `example` on top
 * of the MCP-native descriptor. The `example` field's `input`/`output`
 * keys align with MCP's tool envelope naming so the contract reads
 * identically to what the agent's MCP client sees.
 */
export interface AgentToolEntry {
  /** Owning MCP server identity. OPTIONAL: populated by the agent-server
   *  catalog-builder (Tier 1) or derived by the LLM from the mcp__<server>__
   *  prefix (Tier 2). (serverInfo.name, toolName) is the canonical identity;
   *  `version` is OPTIONAL metadata (catalog fills it; prefix-authoring omits it)
   *  and is stripped from the canonical hash. */
  serverInfo?: { name: string; version?: string };
  /** MCP tool descriptor, echoed from `tools/list` (minus name = the catalog key). */
  toolInfo: {
    /** JSON Schema for the tool input. REQUIRED — every MCP tool has one. */
    inputSchema: JsonSchema;
    description?: string;
    outputSchema?: JsonSchema;
  };
  /** ggui authoring layer (not MCP): when/why/by-whom the tool is called. */
  usage?: string;
  example?: { input: JsonValue; output: JsonValue };
}

/**
 * Agent-capabilities catalog — declares the MCP tools the contract references.
 *
 * The agent's MCP toolbox is the source of truth at dispatch time; this
 * catalog is the **contract author's documentation** of which tools the
 * UI relies on. Cross-referenced from:
 *
 *   - `actionSpec[*].nextStep`           (agent's next-turn hint)
 *   - `streamSpec[*].source.tool`        (channel data source)
 *
 * Shape mirrors {@link ClientCapabilitiesSpec} — both are capability
 * catalogs grouped under a `*Capabilities` parent so the protocol's
 * capability namespace reads symmetrically (agent-side tools vs.
 * client-side gadgets).
 */
export interface AgentCapabilitiesSpec {
  /** Per-tool definitions keyed by tool name. */
  tools: Record<string, AgentToolEntry>;
}

// =============================================================================
// Client Capability Contract
// =============================================================================

/**
 * Per-export metadata shared by every {@link GadgetExport} kind —
 * LLM-targeted teaching text plus the runtime gates an export needs.
 *
 * Required-ness lives in the schemas, not the type system: the
 * registry-side `strictGadgetExportSchema` requires `description` /
 * `usage` / `example`; the wire-permissive `gadgetExportSchema`
 * leaves them optional.
 */
export interface GadgetExportBase {
  /**
   * Human-readable description of what this export does. REQUIRED on
   * the registry side; optional on the contract side (push-time merge
   * inherits the registry copy when absent).
   */
  description?: string;
  /**
   * When / why / by-whom this export is used — the free-form
   * "context-of-use" hint bare `description` lacks. Parallel to
   * {@link AgentToolEntry.usage}.
   */
  usage?: string;
  /**
   * Concrete usage example for boilerplate generation + prompt
   * priming. Free-form `JsonValue` (typically an object describing
   * the call / render shape + expected return).
   */
  example?: JsonValue;
  /**
   * Anti-patterns + known gotchas surfaced in code-gen prompts so the
   * LLM avoids the same traps every time.
   */
  gotchas?: string;
  /**
   * Optional permission identifier this export gates on (Web
   * Permissions API + MCP Apps enum — see `KNOWN_PERMISSION_NAMES`).
   * The registry-side schema enum-checks it; the wire side never
   * carries it.
   */
  permission?: string;
}

/**
 * A hook export — a `use`-prefixed React hook the generated component
 * calls. Implementations MUST satisfy {@link GadgetHook}.
 */
export interface GadgetHookExport extends GadgetExportBase {
  /**
   * Hook name — `use`-prefixed camelCase (e.g. `'useLeafletMap'`,
   * `'useGeolocation'`). Boilerplate emits `import { <hook> } from
   * '<package>'` plus a call site against this value.
   */
  hook: string;
  /**
   * Mutually exclusive with {@link GadgetComponentExport.component}.
   * `component?: never` makes {@link GadgetExport} a type-EXCLUSIVE
   * union — a both-fields object `{hook, component}` no longer
   * type-checks, so field-presence kind discrimination is order-
   * independent.
   */
  component?: never;
}

/**
 * A component export — a PascalCase React component the generated
 * code renders as JSX (`<Chart … />`).
 */
export interface GadgetComponentExport extends GadgetExportBase {
  /**
   * Component name — PascalCase (e.g. `'Chart'`, `'MapView'`).
   * Boilerplate emits `import { <component> } from '<package>'` plus
   * a JSX render site against this value.
   */
  component: string;
  /**
   * Mutually exclusive with {@link GadgetHookExport.hook}.
   * `hook?: never` makes {@link GadgetExport} a type-EXCLUSIVE union —
   * a both-fields object `{hook, component}` no longer type-checks, so
   * field-presence kind discrimination is order-independent.
   */
  hook?: never;
}

/**
 * One export of a gadget package — a hook or a component,
 * distinguished by which identifier field is present (`hook` vs
 * `component`). A gadget package ({@link GadgetDescriptor}) bundles
 * one or more of these behind a single npm identity; a wire-side
 * {@link GadgetExportUse} entry points at exactly one.
 */
export type GadgetExport = GadgetHookExport | GadgetComponentExport;

/**
 * **Wire-side** per-export use entry — one value in a package's
 * {@link GadgetPackageUse} map on
 * `DataContract.clientCapabilities.gadgets`.
 *
 * The export NAME is the map key, not a field — and its grammar
 * discriminates kind (a `use`-prefixed key is a hook, a PascalCase
 * key is a component). The only wire-authored payload is optional
 * intent-specific override prose.
 *
 * Design intent (S+ protocol bar): the wire carries IDENTITY ONLY —
 * `(package, export name)`. It CANNOT carry `version`, transport
 * fields (`bundleUrl`, `bundleSri`, `bundleHost`, `connect`,
 * `requires`, `typesUrl`, …) or per-export registry metadata
 * (`permission`, `example`, `gotchas`). All of that belongs to the
 * registered {@link GadgetDescriptor} the ggui server resolves from
 * the app's `App.gadgets` catalog at push time — `version` is the
 * operator's deployment pin, not the agent's to author.
 */
export interface GadgetExportUse {
  /**
   * Intent-specific override of the registered export's description.
   * When omitted, push-time resolution inherits the registered
   * description verbatim; when present, the agent's prose wins.
   */
  description?: string;
  /**
   * Intent-specific override of the registered usage hint. Same
   * "agent wins" merge semantics as `description`.
   */
  usage?: string;
}

/**
 * **Wire-side** per-package gadget use — the value type of
 * {@link ClientCapabilitiesSpec.gadgets}, which is keyed by npm
 * package name.
 *
 * A map of export name → {@link GadgetExportUse} — the exports of one
 * package the UI uses, keyed by export name (≥1; a `use`-prefixed
 * hook or a PascalCase component). The wire carries no package-level
 * field — `version` and transport metadata are registry-side — so a
 * package entry IS its export map, with no `exports` wrapper.
 */
export type GadgetPackageUse = Record<string, GadgetExportUse>;

/**
 * Flattened view of one gadget export a contract uses — produced by
 * `listContractGadgets` from the package-keyed
 * {@link ClientCapabilitiesSpec.gadgets}.
 *
 * NOT a wire type: an internal convenience so the push gates, the
 * descriptor resolver, and code-gen can iterate `(package, name)`
 * pairs uniformly instead of re-walking the nested wire map.
 */
export interface GadgetUse {
  /** npm package name — the `clientCapabilities.gadgets` map key. */
  package: string;
  /** Export name — `use`-prefixed hook or PascalCase component. */
  name: string;
  /** Intent-specific description override, when the contract set one. */
  description?: string;
  /** Intent-specific usage override, when the contract set one. */
  usage?: string;
}

/**
 * Registered descriptor for a gadget **package** (registry side).
 *
 * A gadget package bundles one or more {@link GadgetExport}s — hooks
 * and/or components — behind a single npm identity (`package` +
 * `version`) and a single bundle. Transport metadata (`bundleUrl`,
 * `bundleSri`, `bundleHost`, `styleUrl`, `connect`, `requires`,
 * `typesUrl`, `typesSri`) is per-PACKAGE; teaching text + `permission`
 * are per-EXPORT (on each `exports[*]`).
 *
 * One shape used by:
 *
 *   - **Registry side** (`App.gadgets` + wrapper SDK output) — every
 *     export's `description` / `usage` / `example` SHOULD be
 *     populated. `strictGadgetDescriptorSchema` enforces required
 *     teaching text + an enum-tight `permission` per export;
 *     `registeredGadgetDescriptorSchema` additionally requires
 *     `typesUrl` for non-stdlib packages.
 *   - **Resolved sidecar side** — at push time
 *     `filterDescriptorsToContract` snapshots the subset of
 *     `App.gadgets` the contract references onto
 *     `SessionStackEntry.gadgetDescriptors`. Wire-side authors NEVER
 *     see this shape; they author the package-keyed
 *     {@link ClientCapabilitiesSpec} map of {@link GadgetPackageUse}.
 *
 * Strictness lives in the schemas, not the type system.
 *
 * See {@link GadgetHook} for the runtime hook contract every hook
 * export MUST satisfy.
 */
export interface GadgetDescriptor {
  /**
   * The exports this package provides — hooks and/or components. At
   * least one (enforced by the schema). Each {@link GadgetExport}
   * carries its own identifier (`hook` or `component`) + teaching text
   * (`description` / `usage` / `example` / `gotchas`) + per-export
   * `permission`.
   */
  exports: GadgetExport[];
  /**
   * Exact semver pin (e.g., `'0.0.1'`, `'1.2.3-beta.1'`). REQUIRED.
   * Registry-side ONLY — the wire carries no version; the operator's
   * `App.gadgets` catalog is the sole version pin, resolved
   * server-side at push time. `(package, version)` is the registry's
   * frozen identity tuple. Bumping requires a new `bundleSri` /
   * `typesSri` (registry-immutability invariant enforced by
   * `lintGadgetCatalog`).
   *
   * No ranges (no `^`, `~`, `>=`).
   */
  version: string;
  /**
   * Bare npm package name the wrapper is imported from (e.g.,
   * `'@my-org/leaflet'`, `'@ggui-ai/gadgets'`). REQUIRED. The wire
   * references this package by name — it is the key of the
   * `clientCapabilities.gadgets` map; `(package, version)` is the
   * registry's frozen identity tuple.
   *
   * Boilerplate emits `import { <hook> } from '<package>';` against
   * this value. NOT a URL — registry hostnames live on `bundleUrl` /
   * `typesUrl`. The gadget author bundles all underlying 3rd-party
   * dependencies into the wrapper bundle.
   */
  package: string;
  /**
   * ggui-hosted bundle URL — the preferred distribution path. Same
   * origin as the iframe in single-tenant OSS deployments (served
   * from `/_ggui/libs/<libId>/bundle.js`) and the ggui marketplace
   * CDN in cloud deployments. CSP `script-src` allowlists only the
   * ggui origin — no per-plugin third-party origins.
   *
   * When set, the boilerplate generator imports from this URL
   * instead of `package`. Either `package` OR `bundleUrl` MUST be
   * present.
   *
   * Escape hatch: authors who want CDN-distributed bundles can point
   * `bundleUrl` at a 3rd-party URL (e.g., `'https://esm.sh/...'`)
   * and accept that origin in the CSP allowlist. The preferred path
   * is to publish to ggui's bundle host and stay same-origin.
   */
  bundleUrl?: string;
  /**
   * Registry hostname (no scheme, no path) the server uses to resolve
   * `bundleUrl` + `styleUrl` at push time:
   *
   *   `https://<bundleHost>/bundles/<scope>/<name>/<version>/bundle.js`
   *   `https://<bundleHost>/bundles/<scope>/<name>/<version>/style.css`
   *
   * Resolution order (operator wins over author wins over spec default):
   *
   *   1. operator's `app.gadgets[*].bundleUrl` — explicit full URL,
   *      escape hatch that bypasses bundleHost resolution entirely.
   *   2. operator's `app.gadgets[*].bundleHost` — hostname override
   *      for e2e / sandbox testing.
   *   3. gadget author's `ggui.gadget.json#bundleHost` (default the
   *      author shipped).
   *   4. spec default `registry.ggui.ai`.
   *
   * Resolution requires `package` (`@scope/name`) and `version` on the
   * same entry — without them the server cannot assemble the path.
   * The `strictGadgetDescriptorSchema` refinement enforces this trio.
   *
   * Hostname-only constraint: lowercase alphanumerics + dots/hyphens +
   * optional `:port`. See {@link BUNDLE_HOST_RE}. Non-HTTPS or
   * non-standard paths require the `bundleUrl` escape hatch instead.
   */
  bundleHost?: string;
  /**
   * SHA-384 SRI hash of the bundle, formatted as `sha384-<base64>`.
   * When present, iframe-runtime emits the bundle import as a
   * `<script type="module" integrity="<bundleSri>" src="<bundleUrl>">`
   * element so the browser refuses execution on hash mismatch — the
   * defense against CDN compromise that turned a marketplace bundle
   * into an attack surface.
   *
   * Authors do NOT set this manually — registry install writes it
   * from the value the publish Lambda computed server-side over the
   * immutable bundle bytes. Hand-authored ggui.json refs omit the
   * field; the loader falls back to integrity-less dynamic `import()`
   * (the same posture as in-tree wrappers).
   *
   * Only meaningful alongside `bundleUrl`. When `bundleSri` is set
   * but `bundleUrl` is absent the field is ignored — `package`
   * resolution doesn't flow through `<script>` injection.
   */
  bundleSri?: string;
  /**
   * URL of an optional stylesheet the wrapper requires (e.g.,
   * `leaflet.css`). Same origin posture as `bundleUrl` — preferred
   * to be ggui-hosted and same-origin so CSP `style-src 'self'`
   * covers it. Wrappers MAY inline CSS inside their `bind` function
   * instead of declaring a styleUrl — when they do, this field is
   * omitted.
   */
  styleUrl?: string;
  /**
   * API-call origins the wrapper makes runtime fetches against (e.g.,
   * `['https://api.stripe.com', 'https://api.doordash.com']`). The
   * renderer's CSP derives the `connect-src` allowlist from these
   * URLs' origins. UNAVOIDABLE — ggui can't proxy 3rd-party API
   * calls without breaking observability and auth/licensing
   * constraints.
   *
   * Wrappers around browser-native APIs (stdlib hooks) omit this —
   * they have no remote fetches.
   */
  connect?: readonly string[];
  /**
   * Names of public-env keys the wrapper requires at runtime (e.g.,
   * `['GGUI_PUBLIC_APP_MAPBOX_TOKEN']`). The registration-time
   * validator rejects wrappers whose `requires` are unsatisfied by
   * the app's declared public-env keys.
   */
  requires?: readonly string[];
  /**
   * HTTPS URL of the wrapper's TypeScript declaration
   * file (`.d.ts`). The publish flow runs `tsc --declaration` (or
   * `tsup --dts`) over the wrapper source and uploads the emitted
   * `.d.ts` alongside the bundle; the registry stamps the URL here.
   *
   * The handler parallel-fetches every `typesUrl` at push time
   * (`fetchGadgetTypes`), verifies the SHA-384 SRI against
   * {@link typesSri}, and loads the `.d.ts` content into the code-gen
   * sandbox's virtual file system at
   * `node_modules/<package>/index.d.ts`. A generated direct import
   * `import { useLeafletMap } from '<package>'` resolves through the
   * loaded `.d.ts` with the wrapper's NAMED types (`LeafletMapOptions`,
   * …) preserved, not collapsed to structural soup.
   *
   * REQUIRED for non-stdlib registrations — the
   * `strictGadgetDescriptorSchema` refinement enforces it when
   * `package !== '@ggui-ai/gadgets'`. Stdlib gadgets omit it: the
   * sandbox already loads `@ggui-ai/gadgets`'s own types directly.
   *
   * The bare name `signature` is reserved for a future
   * descriptor-level cryptographic field (Ed25519 / Sigstore) and
   * MUST NOT be reused for type metadata.
   */
  typesUrl?: string;
  /**
   * SHA-384 SRI of the `.d.ts` at {@link typesUrl},
   * formatted `sha384-<base64>`. The handler verifies the fetched
   * `.d.ts` bytes against this before loading them into the sandbox
   * VFS — a CDN-compromise defense symmetric with {@link bundleSri}
   * for the bundle.
   *
   * Registry-emitted (computed over the immutable `.d.ts` bytes at
   * publish time). Only meaningful alongside `typesUrl`.
   */
  typesSri?: string;
}

/**
 * Gadgets catalog — declares browser-capability gadget hooks
 * the UI uses. Pure declaration (no RPC contract). See
 * {@link GadgetHook} for the runtime hook contract.
 *
 * Shape mirrors {@link AgentCapabilitiesSpec} — both are capability
 * catalogs grouped under a `*Capabilities` parent so the protocol's
 * capability namespace reads symmetrically (agent-side tools vs.
 * client-side gadgets).
 *
 * Non-generic — the wire surface carries package-keyed
 * {@link GadgetPackageUse} values. The post-resolution view (full
 * descriptors for hygiene + transport metadata derivation) lives on
 * `SessionStackEntry.gadgetDescriptors` as a sidecar, NOT as an
 * enrichment overlay on this type.
 */
export interface ClientCapabilitiesSpec {
  /** Per-package gadget use, keyed by npm package name. */
  gadgets: Record<string, GadgetPackageUse>;
}

// =============================================================================
// Context Contract
// =============================================================================
//
// ── contextSpec design-lock ──────────────────────────────────────────────────
//
// `ContextSpec` declares typed slots the iframe surfaces to the
// agent's LLM context — drafts, wizard steps, hover state, selection,
// any client-driven observable state the LLM should see. Symmetric
// counterpart to `propsSpec` (agent→client one-shot via `ggui_update`)
// and `streamSpec` (agent→client live via live-channel): together with
// `actionSpec`, the four-spec model gives a complete bidirectional
// state-movement protocol.
//
// Direction: **client → agent only** in v1. Each slot's value flows
// from a React Context Provider (component owns the value) to the
// iframe-runtime's observer (which posts `ui/update-model-context`
// after debouncing). Servers MUST NOT push values back to contextSpec
// — agent-driven state changes use propsSpec or streamSpec instead.
//
// Persistence: ephemeral. The server does NOT persist contextSpec
// values across iframe reconnects. On WS reattach the iframe re-emits
// its current values; the LLM context catches up after at most one
// debounce window.
//
// Validation: every slot declares a `schema` (required). The runtime
// validates Provider values against the schema before posting; type
// mismatches log a dev-only warning and drop silently in production.
// Same posture as `actionSpec[name].schema`.
//
// Naming: slot keys are camelCase JS identifiers. The boilerplate
// generates one PascalCase `Context` per slot at generation time
// (e.g., `currentStep` → `CurrentStepContext`).

/**
 * Per-slot metadata in a {@link ContextSpec}. Declares one named
 * slot's value contract plus its observation timing.
 *
 * The `schema` is the authoritative shape guard — every value the
 * runtime observes through this slot's React Context Provider gets
 * validated against the schema before posting to the LLM context.
 * Type mismatches drop silently in production with a dev-only warning;
 * mirrors `ActionEntry.schema`'s enforcement posture.
 *
 * `default` is for boilerplate-generation only — the LLM uses it as
 * the initial value for its `useState(default)` call. The runtime
 * doesn't seed context slots from defaults; the Provider's `value`
 * is the authoritative source.
 */
export interface ContextEntry {
  /** Human-readable description of this slot. Used by docs + LLM
   * context to explain what the slot represents. */
  description?: string;
  /**
   * JSON Schema for the slot value. Authoritative shape guard.
   * Every Provider value the observer sees gets validated against
   * this before being posted to the LLM context. Mismatches log
   * a dev-only warning and drop silently in production.
   */
  schema: JsonSchema;
  /**
   * Optional initial value the boilerplate uses when generating the
   * component's `useState(default)` call. The runtime does NOT seed
   * context slots from this — it's authoring scaffold only. Typed as
   * {@link JsonValue} (any JSON-safe value).
   */
  default?: JsonValue;
  /**
   * Debounce window in milliseconds for posting value changes to the
   * LLM context. `0` posts immediately on every change. Omitted →
   * runtime applies the locked default {@link DEFAULT_CONTEXT_DEBOUNCE_MS}
   * (`300`).
   *
   * Use cases:
   *   - Text drafts (typing input): leave default 300ms — coalesces
   *     keystrokes
   *   - Step / tab switches: set `0` — immediate, no value to coalesce
   *   - High-frequency UI state (hover, scroll): set higher, e.g. `500`,
   *     to reduce LLM context churn
   */
  debounceMs?: number;
  /**
   * Example value (for documentation + sample rendering). Typed as
   * {@link JsonValue}.
   */
  example?: JsonValue;
}

/** Locked default applied when {@link ContextEntry.debounceMs}
 * is omitted. */
export const DEFAULT_CONTEXT_DEBOUNCE_MS = 300;

/**
 * Context contract — declares typed slots the iframe surfaces to the
 * agent's LLM context via React Context Providers. Together with
 * {@link PropsSpec}, {@link StreamSpec}, and {@link ActionSpec},
 * forms the four-spec bidirectional state-movement protocol:
 *
 *   - {@link PropsSpec}    — agent → client (one-shot via `ggui_update`)
 *   - {@link StreamSpec}   — agent → client (live via live-channel)
 *   - {@link ActionSpec}   — client → agent (user gesture/tool intent)
 *   - {@link ContextSpec}  — client → agent (observable state, this)
 *
 * Shape: flat map keyed by slot name → entry. Slot keys MUST be
 * camelCase JS identifiers (`/^[a-zA-Z_][a-zA-Z0-9_]*$/`); the
 * boilerplate generates one PascalCase `Context` per slot at
 * generation time.
 *
 * Direction: **client → agent only**. Servers MUST NOT push values
 * back to context slots — agent-driven state changes use propsSpec or
 * streamSpec instead.
 *
 * Persistence: ephemeral. The server does NOT persist context values
 * across iframe reconnects. On WS reattach the iframe re-emits its
 * current values.
 */
export type ContextSpec = Record<string, ContextEntry>;

/**
 * Derive a JSON-safe default value for a {@link ContextEntry}.
 *
 * Resolution order:
 *   1. `entry.default` (if author provided)
 *   2. Schema-typed fallback:
 *      - `string` → `''`
 *      - `number` / `integer` → `0`
 *      - `boolean` → `false`
 *      - `array` → `[]`
 *      - `object` → `{}`
 *      - `null` → `null`
 *   3. `undefined` (caller validates / rejects)
 *
 * Push-time validators MUST reject contextSpec entries that resolve
 * to `undefined` here (e.g., schema is `oneOf` with no clear primitive
 * type — author MUST provide an explicit `default` for such schemas).
 *
 * Consumed by the boilerplate generator's useState emission and by
 * the push-time validator's default-derivability rule.
 *
 * @public
 */
export function deriveContextDefault(entry: ContextEntry): JsonValue | undefined {
  if (entry.default !== undefined) return entry.default;
  const t = entry.schema?.type;
  switch (t) {
    case 'string': return '';
    case 'number': return 0;
    case 'integer': return 0;
    case 'boolean': return false;
    case 'array': return [];
    case 'object': return {};
    case 'null': return null;
    default: return undefined;
  }
}

// =============================================================================
// Unified Data Contracts
// =============================================================================

/**
 * Data contract that bind a generated component to its consumers.
 *
 * Seven parts:
 * - **intent**: WHY this UI exists — concise purpose capturing user goal, data shown, and interaction pattern (NOT a contract field; threaded externally on `ggui_handshake({renderId, intent})`)
 * - **propsSpec**: WHAT data the UI renders initially (set on render, mutated via ggui_update) — agent → client one-shot
 * - **streamSpec**: WHAT live data the UI accepts — flat map keyed by channel name (agent → client live)
 * - **contextSpec**: WHAT observable client state the LLM sees — flat map keyed by slot name (client → agent live, last-write-wins state)
 * - **actionSpec**: WHAT user interactions the UI emits — flat map keyed by action name (client → agent, discrete events that drive turns)
 * - **agentCapabilities**: WHAT MCP tools the contract references — declarative catalog keyed by tool name
 * - **clientCapabilities**: WHAT gadget exports the UI declares — declarative catalog keyed by npm package name
 *
 * The two inbound specs (actionSpec + contextSpec) split on the placement test:
 * "does this thing need the agent's next-turn reasoning?" Yes → actionSpec, No → contextSpec.
 * Actions drive turns; context observes state. There is no third category.
 *
 * Together, the four typed surfaces — `propsSpec` / `streamSpec` /
 * `actionSpec` / `contextSpec` — form a complete bidirectional
 * state-movement protocol:
 *
 *   - agent → client one-shot   = `propsSpec`    (initial render, mutate via `ggui_update`)
 *   - agent → client live       = `streamSpec`   (live-channel emits via `ggui_emit`)
 *   - client → agent gesture    = `actionSpec`   (discrete event; agent reacts on next turn via `ggui_consume`)
 *   - client → agent observable = `contextSpec`  (last-write-wins state snapshot read on consume)
 *
 * The intent is the semantic identity of the contract — same intent = same UI pattern.
 * Used for RAG search (embedding) and included in the contract hash.
 *
 * Field-shape note: `actionSpec` / `streamSpec` / `contextSpec` are flat
 * `Record<name, Entry>` maps. `propsSpec` is a wrapper
 * `{description?, properties: Record<name, PropEntry>}`.
 *
 * Every entry under `propsSpec.properties` / `actionSpec` /
 * `streamSpec` / `contextSpec` is a WRAPPER carrying a JSON Schema in
 * its `schema:` field; the JSON Schema does NOT sit flat at the entry
 * level. The cross-ref invariant pairs `actionSpec[*].nextStep` and
 * `streamSpec[*].source.tool` against `agentCapabilities.tools[*]`.
 *
 * Worked example (todo-list contract):
 *
 *     {
 *       propsSpec: {
 *         properties: {
 *           todos: {
 *             schema: { type: 'array', items: { type: 'object',
 *               properties: { id: {type:'string'}, text: {type:'string'},
 *                 completed: {type:'boolean'} },
 *               required: ['id', 'text', 'completed'] } },
 *             required: true,
 *           },
 *         },
 *       },
 *       actionSpec: {
 *         toggleTodo: {
 *           label: 'Toggle todo',
 *           schema: { type: 'object', properties: { id: {type:'string'} },
 *             required: ['id'] },
 *           nextStep: 'todo_toggle',   // ← hints the next tool to the agent
 *         },
 *       },
 *       agentCapabilities: {
 *         tools: {
 *           todo_toggle: { toolInfo: { description: 'Flip a todo done/undone',
 *             inputSchema: { type: 'object', properties: { id: {type:'string'} },
 *               required: ['id'] } } },
 *         },
 *       },
 *     }
 */
export interface DataContract {
  /**
   * `intent` is NOT a contract field. The canonical intent (RAG
   * embedding search, contract hash key, prompt rendering, cache
   * scope) comes from the outer pipeline (the flat `intent` field on
   * `ggui_handshake`, the operator prompt for harness benchmarks),
   * which is the single source of truth for "the purpose of this UI".
   * `hashContract` takes `(contract, intent)`;
   * `buildContractsContext` takes `(contract, intent)`.
   *
   * No `interaction` mode field — the four specs
   * (props/action/context/stream) describe the wire surface
   * exhaustively, so a categorical mode label would be redundant.
   */
  /**
   * Props spec — declaration of the initial-render props shape. Values
   * arrive on the wire via `ggui_render.input.props` / `ggui_update.input.props`
   * (those wire fields stay named `props` — they carry values, not the
   * spec). Naming aligns with the other three typed surfaces
   * (`actionSpec` / `streamSpec` / `contextSpec`).
   */
  propsSpec?: PropsSpec;
  /**
   * Action contract — discrete user gestures (clicks, submits) the
   * agent reacts to on its NEXT TURN via `ggui_consume`. Flat map keyed
   * by action name (e.g., `actionSpec.createTask`).
   *
   * Every action drives a turn — there is no synchronous server-side
   * dispatch in agent-mediated deployments. Each entry carries a
   * `label`, optional payload `schema`, and optional `nextStep` hint
   * naming the tool the agent SHOULD call next. When `nextStep` is
   * present it MUST resolve in `agentCapabilities.tools` (cross-ref
   * invariant); OMIT `nextStep` entirely when the agent should decide
   * freely from broader context (open-ended form submits).
   *
   * Placement rule (`actions-vs-context.md`): use `actionSpec` for
   * events that NEED next-turn reasoning; use {@link contextSpec} for
   * observable state the agent reads without reacting per-change.
   */
  actionSpec?: ActionSpec;
  /**
   * Stream contract — live update payloads via ggui_emit. Flat map
   * keyed by channel name (e.g., `streamSpec.tasks`).
   */
  streamSpec?: StreamSpec;
  /**
   * Context contract — observable client state the LLM context
   * consumes. Flat map keyed by slot name (e.g.,
   * `contextSpec.currentStep`). Client → agent only; runtime
   * observes Provider values and posts debounced
   * `ui/update-model-context` envelopes. See {@link ContextSpec}
   * for the full contract.
   */
  contextSpec?: ContextSpec;
  /** Agent-capabilities catalog — MCP tools the contract references. */
  agentCapabilities?: AgentCapabilitiesSpec;
  /**
   * Client-capabilities catalog — declares browser-capability gadget
   * hooks the UI calls. Pure declaration: no RPC, no input/output
   * schemas. The agent observes gadget values only when the UI threads
   * them into a `contextSpec` slot or an `actionSpec` payload. See
   * {@link ClientCapabilitiesSpec} + {@link GadgetHook}.
   *
   * Wire-side only. Package-keyed — values are {@link GadgetPackageUse}
   * (per-package export-use maps keyed by export name). The
   * post-resolution descriptor view lives on
   * `SessionStackEntry.gadgetDescriptors` as a sidecar.
   */
  clientCapabilities?: ClientCapabilitiesSpec;
}

// =============================================================================
// Contract error envelope
// =============================================================================

/**
 * Canonical error codes emitted on the reserved
 * `_ggui:contract-error` channel when a declared
 * `streamSpec[name].source.tool` (continuous feed),
 * `streamSpec[name].tool` (refresh-after-action hint, agent-less
 * deployments only), or a session-level boot failure happens. Emitted
 * as the body of a stream envelope.
 *
 * v1 codes emitted by `@ggui-ai/mcp-server`'s session-channel router:
 *
 * - `TOOL_NOT_FOUND` — declared tool not registered on the wired
 *   action router. Author wiring bug.
 * - `TOOL_THREW` — the tool handler threw (sync or async rejection).
 *   Handler failure captured verbatim in `message`; original stack (if
 *   any) lives on `causedBy`.
 * - `TOOL_TIMEOUT` — invocation exceeded the router's configured
 *   timeout (default 30s). Handler may still complete in the
 *   background; caller must treat as failure either way.
 * - `SCHEMA_VIOLATION` — the tool returned a shape that violates the
 *   declared `streamSpec[name].schema`. Router rejected
 *   BEFORE emitting on the channel, so subscribers do NOT see the
 *   malformed payload.
 *
 * Extensibility — typed as `'TOOL_NOT_FOUND' | 'TOOL_THREW' |
 * 'TOOL_TIMEOUT' | 'SCHEMA_VIOLATION' | 'SCHEMA_MISMATCH_ERROR' |
 * (string & {})` rather than a closed union. Consumers MUST handle
 * unknown codes gracefully — render as raw string, not switch-case
 * without default. Future failure modes that may populate this field
 * include `'SANITIZER_FAILED'` (the `causedBy` sanitizer itself
 * threw), `'MCP_TRANSPORT_ERROR'` (the MCP transport rejected the
 * tool invocation before the handler ran), `'RATE_LIMIT_EXCEEDED'`
 * (the tool was refused by an upstream rate limiter), and
 * `'BOOTSTRAP_FAILED'` (C8 — initial contract bootstrap failed on
 * attach). Adding such codes does NOT bump the protocol version,
 * because the type was extensible from day one.
 *
 * `'SCHEMA_MISMATCH_ERROR'` — F4 schema compat checker. Emitted when
 * `actionSpec[name].schema` and its declared `tool`'s inputSchema
 * disagree, or when a `streamSpec[channel].schema` and its declared
 * `tool`'s return schema disagree. Fires at push-time (before the
 * stack item commits) and at blueprint-registration time. See
 * {@link ActionEntry.schema} and {@link StreamChannelEntry.schema}
 * for the author invariant, and `@ggui-ai/protocol/validation/
 * schema-subset` for the subset algorithm that produces the named
 * failure. Provides a named, actionable signal before a malformed
 * envelope reaches the agentic loop — instead of a silent `TOOL_THREW`
 * at runtime.
 *
 * `'RENDER_NOT_FOUND'` + `'AUTH_REJECTED'` — fire on post-WS-open
 * boot failures where the live channel is already alive (so the envelope-
 * emittable invariant is satisfied). The renderer bundle surfaces
 * them BOTH on the live-channel `_ggui:contract-error` envelope (with
 * `sourceAction.type === 'bootstrap-load'`) AND as a
 * `postMessage({type:'ggui:bootstrap-failed', reason, message})` to
 * the embedding host — the former for in-session observability, the
 * latter for host-level UX response. Pre-WS bootstrap failures
 * (`BUNDLE_FETCH_FAILED`, `CSP_VIOLATION`, `BOOTSTRAP_META_MISSING`)
 * are postMessage-only: they can't reach the live channel because the WS
 * doesn't exist yet, so they remain OUT of `ContractErrorCode`'s
 * named set to preserve the "live-channel-emittable" invariant. The
 * renderer's `BootstrapFailureReason` union (in `@ggui-ai/iframe-runtime`)
 * carries ALL bootstrap codes — `ContractErrorCode` is the strict
 * subset that's observable on the contract-error envelope.
 */
export type ContractErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'TOOL_THREW'
  | 'TOOL_TIMEOUT'
  | 'SCHEMA_VIOLATION'
  | 'SCHEMA_MISMATCH_ERROR'
  | 'RENDER_NOT_FOUND'
  | 'AUTH_REJECTED'
  /**
   * `'INVALID_ACTION_KIND'` — emitted when the
   * `ggui_runtime_submit_action` handler receives an envelope whose `kind`
   * discriminator OR per-kind payload shape is malformed. Source of
   * truth for the envelope contract is `SubmitActionEnvelope` /
   * `GguiSubmitActionInput` in `@ggui-ai/protocol/integrations/mcp-apps`.
   * Fail-soft at the client: the primary host effect (the `ui/message`
   * / `ui/open-link` / 3-message-bridge call alongside the audit) MUST
   * still succeed; this code surfaces only on the server-side
   * `_ggui:contract-error` channel for operator observability.
   */
  | 'INVALID_ACTION_KIND'
  /**
   * `'PIPE_NOT_FOUND'` — surfaced when `ggui_runtime_submit_action`
   * receives a `kind:"dispatch"` envelope referencing a `renderId`
   * whose pending-events pipe is closed/missing (drained, render
   * closed, or never opened). The handler returns `{ok:false, code:
   * 'PIPE_NOT_FOUND'}` in structuredContent; the iframe-runtime
   * inspects the response (via the host's postMessage relay) and
   * falls through to the `ui/message` chat-shortcut postMessage so
   * the gesture still reaches the agent (via the next chat turn)
   * instead of vanishing silently.
   */
  | 'PIPE_NOT_FOUND'
  /**
   * `'CONTEXT_TOO_LARGE'` — emitted when `ggui_runtime_sync_context`
   * receives a snapshot that exceeds the contextSpec size limits:
   * per-slot value > {@link CONTEXT_SLOT_VALUE_MAX_BYTES} (16 KB),
   * total snapshot > {@link CONTEXT_SNAPSHOT_MAX_BYTES} (64 KB), or
   * slot count > {@link CONTEXT_SNAPSHOT_MAX_SLOTS} (50). Reject
   * instead of truncate so authors notice and route the data through
   * the right surface (propsSpec / streamSpec / a tool call).
   */
  | 'CONTEXT_TOO_LARGE'
  | (string & {});

/**
 * Maximum byte size (UTF-8) of a single contextSpec slot's value
 * accepted by `ggui_runtime_sync_context`. Values larger than this
 * reject with `CONTEXT_TOO_LARGE`. contextSpec is observable state for
 * the agent — content storage belongs on propsSpec / streamSpec / a
 * tool call.
 */
export const CONTEXT_SLOT_VALUE_MAX_BYTES = 16 * 1024;

/**
 * Maximum byte size (UTF-8) of the full contextSpec snapshot (sum of
 * all slot values) accepted by `ggui_runtime_sync_context`. Snapshots
 * larger than this reject with `CONTEXT_TOO_LARGE`.
 */
export const CONTEXT_SNAPSHOT_MAX_BYTES = 64 * 1024;

/**
 * Maximum number of slots in a contextSpec snapshot. Snapshots with
 * more slots reject with `CONTEXT_TOO_LARGE`.
 */
export const CONTEXT_SNAPSHOT_MAX_SLOTS = 50;

/**
 * The body of a stream envelope the server emits on the reserved
 * `_ggui:contract-error` channel when a wired-action or refresh-stream
 * invocation fails. Carries enough shape to surface the failure in
 * operator-facing activity panels AND to correlate back to the
 * originating dispatch.
 *
 * Design notes:
 *
 *   - This is a PLATFORM-EMITTED envelope. Agents MUST NOT author
 *     deliveries on `_ggui:contract-error` — the reserved-channel
 *     validator rejects them.
 *   - The payload is a leaf-level contract: it does NOT wrap a
 *     semantic payload for the author to interpret. Consumers render
 *     it as an error activity row, NOT as a declared channel's data.
 *   - The shape intentionally omits retry / recovery metadata. Retries
 *     are an explicit non-goal of the v1 contract.
 */
export interface ContractErrorPayload {
  /** The tool that failed — wired-action tool OR refresh-stream tool. */
  readonly toolName: string;
  /** The originating action name when the error came from a wired
   * action. Absent when the failure occurred on a refresh-stream path
   * that fired after a successful wired action. */
  readonly actionName?: string;
  /** Provenance on the router side — whether this error came from the
   * wired-action invocation (directly in response to a dispatch) or
   * from the refresh-stream tool that followed a successful action.
   *
   * v1 values emitted by `@ggui-ai/mcp-server`'s session-channel
   * router:
   *
   *   - `'wired-action'` — failure surfaced on the wired-action dispatch
   *     path (the originating tool threw, was not found, or timed out).
   *   - `'refresh-stream'` — failure surfaced on the refresh tool that
   *     fires after a successful wired action (declared via
   *     {@link StreamChannelEntry.tool}).
   *
   * Extensibility — typed as `(string & {}) | 'wired-action' |
   * 'refresh-stream'` rather than a closed union. Consumers MUST handle
   * unknown values gracefully (render as the raw string, not a hard
   * switch-case that throws). Future router sources that may populate
   * this field include `'bootstrap-refresh'` (initial attach-time
   * refresh before the first wired action), `'scheduled-refresh'` (a
   * timer-driven refresh independent of any action), and
   * `'session-restore'` (a refresh fired after a session-resume
   * hydration). Adding such values does NOT bump the protocol version,
   * because the type was extensible from day one. */
  readonly sourceAction?: {
    readonly type: 'wired-action' | 'refresh-stream' | (string & {});
    /** ISO 8601 timestamp when the originating dispatch hit the router. */
    readonly dispatchedAt: string;
  };
  readonly error: {
    readonly code: ContractErrorCode;
    /** Short, author-readable failure summary. Safe to log/display. */
    readonly message: string;
    /** Optional stringified original error (typically `error.stack`) for
     * debugging. Producers MUST pipe the raw string through
     * {@link sanitizeCausedBy} (or an operator-supplied stricter
     * sanitizer) before populating this field — the envelope rides
     * `_ggui:contract-error` which is `replay: 'all'`, so anything
     * landed here persists in the session ring buffer and surfaces in
     * operator tools. The default sanitizer redacts
     * Bearer tokens, query-param secrets, and common env-var dumps, and
     * truncates at 2KB. `@ggui-ai/mcp-server`'s session-channel router
     * applies it by default; alternative producers MUST match that
     * posture. */
    readonly causedBy?: string;
  };
  /** ISO 8601 timestamp of the error envelope itself. */
  readonly timestamp: string;
  /**
   * Protocol schema version stamped by the producer. Pre-launch:
   * advisory — consumers MUST NOT reject on mismatch. At launch
   * cutover, policy tightens so operators can surface an
   * UPGRADE_REQUIRED state when the received major diverges from the
   * client's known major.
   *
   * See `PROTOCOL_SCHEMA_VERSION` for the current value.
   */
  readonly schemaVersion?: string;
}
