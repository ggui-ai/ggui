/**
 * MCP Apps integration — outbound delivery types for ggui.
 *
 * This module is the **boundary** for MCP Apps outbound delivery. Anything
 * MCP-Apps-specific that ggui exposes to the rest of the codebase lives
 * here — never in `types/live-channel.ts`, `types/mcp.ts`, `types/session.ts`,
 * or any other core module. Consumers opt in via the subpath import:
 *
 * ```ts
 * import {
 *   MCP_APPS_UI_CAPABILITY,
 *   GGUI_SESSION_RESOURCE_URI,
 *   type McpAppAiGguiMountView,
 * } from '@ggui-ai/protocol/integrations/mcp-apps';
 * ```
 *
 * The root `@ggui-ai/protocol` barrel does NOT re-export this module.
 * That's the isolation rule: core protocol consumers that don't integrate
 * with MCP Apps pay none of its weight, and the blast radius of any spec
 * drift is bounded to callers that explicitly import from here.
 *
 * Core still carries two fields that make the bootstrap flow work —
 * `SubscribePayload.bootstrap?: string` and `AckPayload.sessionToken?:
 * string`. Those are deliberately framed as **general transport bootstrap
 * credentials** (opaque strings), not MCP-Apps-specific. Any future
 * bootstrap mechanism (short-code auto-login, signed-URL bootstrap, etc.)
 * reuses the same slots.
 */

import type {
  JsonObject,
  JsonSchema,
  JsonValue,
} from '../types/data-contract.js';

/**
 * MCP capability name ggui servers advertise in their MCP `initialize`
 * response capabilities when they implement the MCP Apps outbound path.
 * Spec-canonical; MUST match the string the MCP Apps protocol publishes.
 */
export const MCP_APPS_UI_CAPABILITY = 'io.modelcontextprotocol/ui' as const;

/**
 * The single MCP Apps resource URI ggui exposes for outbound delivery.
 * `ggui_push` is the sole tool declaration that carries this in its
 * `_meta.ui.resourceUri`. No other ggui tool gets a resource URI —
 * `ggui_push` is the single outbound entry point.
 */
export const GGUI_SESSION_RESOURCE_URI = 'ui://ggui/session' as const;

/**
 * MIME type for the `ui://ggui/session` resource. Per MCP Apps spec, UI
 * resources carry the `text/html` base type with a `profile=mcp-app`
 * parameter so hosts that don't support MCP Apps don't accidentally
 * render them as plain HTML.
 */
export const GGUI_SESSION_RESOURCE_MIME = 'text/html;profile=mcp-app' as const;

/**
 * The single `_meta.ui.resourceUri` value ggui uses across every MCP Apps
 * host surface. Exposed as a named constant so tool-declaration code,
 * resource-serving code, and tests all agree on one spelling.
 */
export const GGUI_PUSH_UI_META = {
  /** Resource URI hosts fetch via `resources/read` on a `ggui_push` tool call. */
  resourceUri: GGUI_SESSION_RESOURCE_URI,
  /** Only `"model"` — outer agent can call, iframe views cannot. */
  visibility: ['model'] as const,
} as const;

/**
 * Visibility tag carried in `_meta.ui.visibility` on a tool declaration.
 * Per MCP Apps spec, controls who can invoke the tool:
 *   - `"model"` — outer agent can call (default in practice)
 *   - `"app"`   — only an MCP Apps view (iframe) can call, hidden from agent
 */
export type McpAppsToolVisibility = 'model' | 'app';

/**
 * The bootstrap material an MCP Apps view (iframe) needs to mount a
 * ggui-rendered UI. Lives under `_meta.ggui.bootstrap` on the
 * `ggui_push` tool result — **not** on `structuredContent`.
 *
 * **Not model-visible.** Agents SHOULD NOT consume these fields. They are
 * scoped to the view lifecycle and carry credentials the model has no
 * legitimate use for. The split between `structuredContent` (model-facing)
 * and `_meta.ggui.bootstrap` (view-facing) is the protocol-level isolation
 * that keeps WebSocket credentials out of conversation transcripts.
 *
 * **Three boot modes share this single shape**, distinguished by which
 * of the three optional discriminator fields is populated:
 *
 * | Mode             | Discriminator     | What the view does                                  |
 * | ---------------- | ----------------- | --------------------------------------------------- |
 * | live             | `wsUrl` + `token` | Open live-channel WS, subscribe, render agent frames |
 * | static-component | `codeUrl`         | Fetch + mount compiled React component, no WS       |
 * | system-card      | `kind`            | Mount built-in system card by registry id, no WS    |
 *
 * **Mutual-exclusion contract.** A consumer-acceptable bootstrap MUST
 * carry at least one of `{wsUrl-with-token, codeUrl, kind}`.
 * Multiple may coexist (e.g. a server emitting both `codeUrl`
 * AND `wsUrl+token` lets the runtime pick — current iframe-runtime
 * priority is code-then-system-then-live), but at least one MUST
 * be present. A bootstrap with none is MALFORMED.
 *
 * **Live-mode auth semantics** (only relevant when `wsUrl` + `token`
 * are present):
 *   - `token` is session-scoped, short-TTL, single-use on initial
 *     `subscribe`. Consumed at the first bootstrap-auth'd subscribe and
 *     cannot be reused.
 *   - `expiresAt` lets the view skip an obviously-stale bootstrap without
 *     a round-trip. Servers reject expired tokens anyway; this is UX
 *     sugar, not a security control.
 *   - For reconnects, the view should use the longer-lived `sessionToken`
 *     the server issues on the successful bootstrap-auth ack — see
 *     {@link AckPayload.sessionToken}.
 *
 * **Live-mode example:**
 * ```json
 * {
 *   "sessionId": "sess_001", "appId": "app_001",
 *   "runtimeUrl": "/_ggui/iframe-runtime.js",
 *   "wsUrl": "wss://server.example/ws",
 *   "token": "tok_abc", "expiresAt": "2099-01-01T00:00:00.000Z"
 * }
 * ```
 *
 * **Static-component example:**
 * ```json
 * {
 *   "sessionId": "sess_001", "appId": "app_001",
 *   "runtimeUrl": "/_ggui/iframe-runtime.js",
 *   "codeUrl": "https://server.example/code/sha256:abc.js",
 *   "codeHash": "sha256:abc...",
 *   "themeId": "indigo", "propsJson": "{\"name\":\"Ada\"}"
 * }
 * ```
 *
 * **System-card example:**
 * ```json
 * {
 *   "sessionId": "sess_001", "appId": "app_001",
 *   "runtimeUrl": "/_ggui/iframe-runtime.js",
 *   "kind": "loading"
 * }
 * ```
 */
export interface McpAppAiGguiMountView {
  /**
   * WebSocket URL the view opens for live mode (e.g.
   * `wss://server.example/ws`). REQUIRED in live mode; absent in
   * static-component and system-card modes. When present, MUST be
   * paired with a non-empty `token` — half-live (one without the
   * other) is MALFORMED.
   */
  readonly wsUrl?: string;
  /**
   * Short-TTL single-use bootstrap token, passed as
   * `SubscribePayload.bootstrap`. REQUIRED in live mode; absent in
   * the other modes.
   */
  readonly token?: string;
  /**
   * ISO 8601 UTC timestamp after which the token is no longer accepted.
   * Optional; meaningful only in live mode (the token it pairs with
   * may be unbounded TTL when this is absent).
   */
  readonly expiresAt?: string;
  /**
   * Session id the token binds to. Repeated here (also present on
   * `structuredContent.sessionId`) so the view has everything it needs
   * to subscribe from `_meta.ggui.bootstrap` alone — no need to cross-
   * reference structuredContent. Keeps the view-side boot code small.
   */
  readonly sessionId: string;
  /**
   * App (tenant) id the token binds to. Required in the subscribe
   * payload; not necessarily appropriate for structuredContent
   * (tenant identity is app-facing bootstrap metadata, not typically
   * part of an agent's typed output surface).
   */
  readonly appId: string;
  /**
   * URL of the iframe-runtime bundle the iframe should fetch. The
   * thin-shell HTML's inline JS dynamically appends
   * `<script src={runtimeUrl}>` to load the runtime. Server controls
   * this per-session so the shell works in `srcdoc` iframes (which
   * have no origin of their own) and across local / cloud
   * deployments.
   *
   * OSS `ggui serve` resolves this to `/_ggui/iframe-runtime.js` —
   * same-origin as the MCP server's HTTP listener. Hosted cloud
   * serves from a dedicated CDN route. Either way, the server OWNS
   * the string; the shell does not guess, concatenate, or fall back
   * to a bundled default.
   *
   * Named parties: **server** produces; **thin shell** consumes;
   * **iframe runtime bundle** is what the URL resolves to. Failure
   * mode on fetch error: runtime surfaces a `BUNDLE_FETCH_FAILED`
   * bootstrap failure via `postMessage({type:'ggui:bootstrap-failed',
   * reason, message})` to the parent (C8 commit 3). Absent or empty
   * at parse-time is `BOOTSTRAP_META_MISSING` — the shell rejects
   * the bootstrap without attempting a script load.
   *
   * C8 (2026-04-23) made this required. Pre-C8 servers that emit
   * bootstraps without `runtimeUrl` are incompatible with the
   * post-C8 thin-shell HTML — the shell pivot (`~175` → `~30` LOC
   * wrapper) moved all rendering logic out of the shell into the
   * separately-served iframe-runtime bundle, so the URL is now
   * load-bearing.
   * @public
   */
  readonly runtimeUrl: string;
  /**
   * Optional polling fallback URL the iframe-runtime fetches when its
   * WebSocket transport is unavailable or fails. Points at the same
   * `/api/bootstrap/<shortCode>` endpoint the iframe used to initially
   * load the bootstrap envelope — polling re-fetches it and the
   * iframe-runtime diffs the `propsJson` field to synthesize
   * `props_update` frames for live re-render.
   *
   * Empirically required for MCP-Apps hosts whose iframe sandbox
   * blocks `wss://` at the CSP layer regardless of our
   * `_meta.ui.csp.connectDomains` declaration (Claude Desktop is the
   * known case; claude.ai Connector honors WS). Without this field,
   * polling has no URL to hit and live updates silently no-op when
   * WS is unavailable.
   *
   * Producer: server's `/api/bootstrap/<shortCode>` endpoint stamps
   * this on the response body — same origin as the request, same
   * shortCode in the path. Consumer: iframe-runtime threads this
   * through `createPropsUpdateHandler({pollingUrl})` so
   * `PollingTransport` has a URL to fetch.
   *
   * Absent → no polling fallback. WS-only mode is fine for hosts
   * whose CSP permits `wss://`.
   *
   * @public
   */
  readonly pollingUrl?: string;
  /**
   * Names of same-server tools whose `_meta.ui.visibility` includes
   * `"app"` and are therefore directly callable from this iframe via
   * `tools/call` (per MCP-Apps spec §2026-01-26 Visibility rules:
   * "app" = callable by the app from the same server connection only;
   * cross-server tool calls are always blocked).
   *
   * Used by the iframe-runtime as a capability fingerprint — telemetry
   * and debug surfaces consult it to know which tool names are reachable
   * over the host's same-server `tools/call` path (e.g. the iframe-
   * internal `ggui_runtime_submit_action` and `ggui_runtime_sync_context`
   * relays). It is NOT consulted to choose a dispatch routing strategy:
   * every user gesture flows through `ggui_runtime_submit_action`, lands
   * on the per-stack-item pending-events pipe, and is drained by the
   * agent's `ggui_consume` long-poll on the next turn. Actions ALWAYS
   * drive turns through consume — there is no synchronous server-side
   * dispatch in agent-mediated deployments.
   *
   * Producers SHOULD include every same-server-app-visible tool;
   * consumers MUST treat an absent field as an empty list (legacy
   * bootstrap envelopes predating this addition).
   *
   * @public
   */
  readonly appCallableTools?: readonly string[];
  /**
   * Per-action `nextStep` hint mapping for the active stack item's
   * `actionSpec`. Maps `actionName → toolName` where `toolName` is the
   * value of `actionSpec[name].nextStep` — the optional hint naming the
   * tool the agent SHOULD call next when the action fires. Only entries
   * whose `actionSpec[name].nextStep` is declared are projected; actions
   * without a hint are omitted from the map.
   *
   * Producer: server's push handler at push time, sourced from the
   * resolved stack item's `actionSpec`. Consumer: iframe-runtime, which
   * mirrors the hint onto outbound `_meta.ggui.userAction` fall-through
   * envelopes (the inline variant in {@link InlineUserActionMeta.nextStep})
   * so the agent gets a strong tool-choice steer when chat-shortcut
   * fallback fires.
   *
   * Absent / empty mapping ⇒ no per-action hints; the iframe omits
   * `nextStep` from the fall-through envelope and the agent picks the
   * next tool freely.
   *
   * @public
   */
  readonly actionNextSteps?: Readonly<Record<string, string>>;
  /**
   * Per-slot data for the active stack item's `contextSpec`. Each entry
   * carries the slot name + the JsonSchema for runtime validation +
   * optional debounceMs override + optional default value.
   *
   * Producer: server's push handler at push time, derived from
   * `activeStackItem.contextSpec`. Consumer: iframe-runtime, which (at
   * boot) synthesizes one `React.createContext(default)` per entry and
   * registers it under `globalThis.__ggui__.contexts[contextName]`. The
   * boilerplate destructures the registered Contexts so the LLM has
   * them in scope without any import line.
   *
   * Absent → empty list; the runtime synthesizes no Contexts; the
   * `globalThis.__ggui__.contexts` registry is `{}`.
   *
   * @public
   */
  readonly contextSlots?: ReadonlyArray<{
    /** Slot key — camelCase JS identifier from `contextSpec`. */
    readonly name: string;
    /** PascalCase Context name auto-derived from `name`. The runtime
     * uses this as the key in `globalThis.__ggui__.contexts`. The
     * boilerplate uses it in destructuring lines. */
    readonly contextName: string;
    /** JsonSchema for the slot value — used by the runtime observer
     * to validate Provider values before posting `ui/update-model-context`. */
    readonly schema: JsonSchema;
    /** Initial value for the slot's React Context Provider. Always
     * populated by the server via {@link deriveContextDefault}: the
     * authored `entry.default` if present, otherwise a schema-typed
     * fallback (`''` / `0` / `false` / `[]` / `{}` / `null`). The
     * runtime owns useState per slot, so the Provider seed is load-
     * bearing — `undefined` here would mean
     * the iframe boots with an indeterminate Provider value. */
    readonly default: JsonValue;
    /** Per-slot debounce override in milliseconds. Omitted → runtime
     * applies `DEFAULT_CONTEXT_DEBOUNCE_MS` (300). `0` = immediate. */
    readonly debounceMs?: number;
  }>;
  /**
   * Optional stack-item pin. When present, the renderer binds to a
   * single `StackItem` (identified by `id`) instead of the full session
   * stack — enables per-card iframes (per-item session-resource
   * endpoint + renderer single-item mode).
   *
   * Absent → renderer renders the whole session stack (default).
   * Present → renderer filters to `session.stack.find(i => i.id === stackItemId)`
   * and ignores the rest. Subsequent live-channel updates for other stack
   * ids are delivered but not rendered.
   *
   * Resource URI convention: per-item shells are served at
   * `ggui://session/<sessionId>/item/<stackItemId>`; whole-session
   * shells remain at `ggui://session/<sessionId>`.
   *
   * The `stackItemId` is the opaque string MCP hosts receive on a
   * `ggui_push` tool result's `stackItemId` field (or equivalently the
   * `StackItem.id` in session state). Renderers that don't recognize
   * the field SHOULD ignore it (falls back to whole-session rendering)
   * — shape-preserving extensibility is the contract.
   *
   * @public
   */
  readonly stackItemId?: string;
  /**
   * Content-addressable URL the runtime fetches the compiled ES module
   * from. The discriminator for **static-component** boot mode (2026-05-13
   * — the inline base64 `componentCode` channel was retired in favor of
   * always-by-URL delivery).
   *
   * Producer: server. Computes `sha256(componentCode)`, writes the bytes
   * to its `CodeStore`, then emits the URL here. URL shape is
   * `<publicBaseUrl>/code/<hash>.js` for OSS or `<cdn>/code/<hash>.js`
   * for hosted cloud — the renderer doesn't care which origin,
   * `fetch(codeUrl)` works the same.
   *
   * Consumer: iframe runtime. Fetches + dynamic-imports the URL. The
   * response is `Cache-Control: immutable`, so subsequent pushes with
   * identical code hit the browser cache (and any CDN edge).
   *
   * Mutually exclusive at the discriminator level with `wsUrl+token`
   * (live mode) and `kind` (system-card mode). When `codeStore` isn't
   * wired, push falls back to live-mode (wsUrl+token) for delivery via
   * the live-channel stack update.
   *
   * @public
   */
  readonly codeUrl?: string;
  /**
   * Hex-encoded sha256 of the code bytes the URL serves.
   * Surfaced separately from `codeUrl` so consumers can verify
   * content integrity (the URL already encodes it, but parsing the
   * URL is fragile across CDN configurations) and so the agent can
   * inspect deduplication signals across pushes without parsing the
   * URL.
   *
   * Always paired with `codeUrl`: present together or absent together.
   *
   * @public
   */
  readonly codeHash?: string;
  /**
   * Discriminator for **system-card** boot mode. Stable identifier the
   * runtime maps via the system-card registry to a built-in component
   * (no ESM source on the wire). When present, the view does NOT open
   * a WebSocket — mounting is purely registry-lookup.
   *
   * Mutually exclusive at the discriminator level with `codeUrl`
   * (static-component mode) and `wsUrl+token` (live mode).
   *
   * @public
   */
  readonly kind?: string;
  /**
   * Theme preset id forwarded to the renderer (`getTheme(id)`).
   * Optional; absent → renderer uses its baked default theme. Used
   * by the self-contained shell so `ggui.json#theme` takes effect
   * across both the WS-driven and self-contained paths.
   *
   * @public
   */
  readonly themeId?: string;
  /**
   * Theme color mode (`'light'` | `'dark'`) forwarded to the renderer.
   * The runtime resolves the dark variant of {@link themeId} via
   * `getTheme(id, 'dark')` when set; absent / unknown value falls
   * back to `'light'`.
   *
   * @public
   */
  readonly themeMode?: 'light' | 'dark';
  /**
   * Pre-serialized props for the rendered component (JSON string).
   * Optional; absent → renderer falls back to empty props. Carried
   * as a string to sidestep XSS-defensive escape concerns when the
   * bootstrap is inlined as a JS literal in the self-contained shell.
   *
   * @public
   */
  readonly propsJson?: string;
  /**
   * Permissions-Policy directive list derived from the active stack item's
   * `DataContract.clientCapabilities.gadgets[*].permission` field.
   * Browser-capability names (`'camera'`, `'microphone'`,
   * `'geolocation'`, `'clipboard-write'`, `'clipboard-read'`,
   * `'notifications'`, …) or arbitrary identifiers for custom
   * platforms; the host union-deduplicates and emits these as the
   * iframe's `Permissions-Policy` HTTP header (public-render path)
   * or `_meta.ui.permissions` (MCP-Apps embedded path).
   *
   * The bootstrap MIRRORS the same list inline so the iframe-runtime
   * can surface the requested set to in-iframe debug overlays /
   * permission-aware UI. The BROWSER-enforced gate, however, comes
   * from the parent-page transport (HTTP header or iframe attribute)
   * — the iframe-runtime itself cannot change Permissions-Policy
   * post-load; it can only react to what the parent already granted.
   *
   * Absent / empty → no permissions requested (default-deny posture).
   *
   * @public
   */
  readonly permissionsPolicy?: readonly string[];
  /**
   * Mirror of
   * `handshakeOutput.serverCapabilities.streamWebSocketLocalTools` on
   * the bootstrap envelope, so the iframe-runtime's per-channel
   * transport router can decide WS-subscribe vs iframe-polling for
   * each `streamSpec[ch].source.tool` without re-querying the
   * handshake.
   *
   * Producer: the server's push handler at push time, sourced from
   * `GguiPushHandlerDeps.streamWebSocketLocalTools` (which mirrors the
   * resolver on the handshake handler). Consumer: iframe-runtime's
   * channel-transport module, which:
   *
   *   - For each `streamSpec[ch]` with `source.tool` declared AND that
   *     tool name is in this list → fire a `channel_subscribe` WS
   *     frame; wait for `channel_payload` deliveries.
   *   - Otherwise → start a per-channel iframe polling loop (default
   *     10s cadence) that invokes `tools/call` directly through the
   *     MCP host proxy.
   *
   * Absent ⇒ universal iframe-polling fallback (no channel uses the
   * WS-subscribe path). Present + empty array ⇒ same behavior; the
   * empty list still says "the WS-subscribe path is supported but no
   * tool is local".
   *
   * @public
   */
  readonly streamWebSocketLocalTools?: readonly string[];
  /**
   * When `true`, this bootstrap describes a
   * SESSION-SCOPED canvas iframe (one per session) rather than a
   * per-stack-item iframe. The canvas:
   *
   *   - Subscribes session-wide on the live channel (no `stackItemId` filter).
   *   - Renders a navigable stack of items, not a single pinned entry.
   *   - Owns its own chrome — the ggui animator pill + navbar.
   *   - Requests `pip` / `fullscreen` display modes from the host based
   *     on stack state.
   *
   * Mutually exclusive with `stackItemId`: a canvas iframe never pins
   * to a single item. Defensive parsers SHOULD reject bootstraps with
   * both fields set, but the protocol does not require them to.
   *
   * Absent / false ⇒ existing inline iframe behavior. Required to be
   * explicit (rather than overloading absent-`stackItemId`) because
   * legacy multi-item mode (Studio/Portal/console) ALSO uses
   * absent-`stackItemId`; the explicit flag disambiguates.
   */
  readonly canvasMode?: boolean;
  /**
   * Resolved gadget catalog the iframe-runtime dynamically
   * imports at boot to populate `globalThis.__ggui__.gadgets`.
   *
   * One entry per registered gadget **package** (GG.8.2 — the channel
   * is per-package, not per-hook: a package's whole module namespace
   * is loaded once and stored under `__ggui__.gadgets[package]`, so
   * every hook AND component export the package ships is reachable).
   * STDLIB exports (the 7 first-party browser-capability hooks shipped
   * by `@ggui-ai/gadgets`) are seeded unconditionally and need NOT
   * appear here — only operator-registered 3rd-party packages (Leaflet,
   * Mapbox, …) do. This list is what makes registered packages
   * reachable inside the iframe.
   *
   * Producer: server's bootstrap builder, sourced from
   * `App.gadgets`. Consumer: iframe-runtime's
   * `loadGadgetRegistry()` which `await import(target)`s each
   * package once and stores the module namespace under the
   * package-name slot.
   *
   * Absent or empty → only STDLIB exports are reachable. Generated
   * components that import an unregistered gadget package fail at the
   * iframe's ESM module-eval (the rewriter has no shim for it).
   *
   * @public
   */
  readonly gadgets?: ReadonlyArray<{
    /** Bare npm package name (e.g. `@my-org/leaflet`). REQUIRED — it
     * is the registry key the iframe-runtime stores the loaded module
     * namespace under at `globalThis.__ggui__.gadgets[package]`, and
     * the bare-specifier load source when `bundleUrl` is absent. */
    readonly package: string;
    /** ggui-hosted ESM bundle URL — preferred load source when present
     * (same-origin posture, CSP-friendly). The iframe
     * `await import(this)`; absent → the iframe imports the bare
     * `package` specifier. */
    readonly bundleUrl?: string;
    /** SHA-384 SRI hash of the bundle (`sha384-<base64>`).
     * When present alongside `bundleUrl`, iframe-runtime routes the
     * load through a `<link rel="modulepreload" integrity>` gate so
     * the browser refuses execution on hash mismatch. Absent → fall
     * back to integrity-less dynamic `import()` (back-compat for
     * in-tree packages and hand-authored ggui.json refs). */
    readonly bundleSri?: string;
  }>;
  /**
   * Public env values the iframe-runtime installs at
   * `globalThis.__ggui__.publicEnv` for wrapper hooks to read via
   * `getPublicEnv(key)`. Keys MUST match
   * `PUBLIC_ENV_APP_KEY_RE` (`^GGUI_PUBLIC_APP_[A-Z0-9_]+$` — exported
   * from `@ggui-ai/protocol`). The prefix is the security boundary:
   * "public" means visible to anyone with iframe-source access.
   *
   * Filtered by the producer (push handler) to the **union of
   * `wrapper.requires` across declared wrappers** — minimum-disclosure
   * principle. Keys an iframe's wrappers don't ask for never reach
   * the iframe.
   *
   * Producer: server's bootstrap builder, sourced from
   * `App.publicEnv` cross-referenced against the declared wrappers'
   * `requires`. Consumer: iframe-runtime's `installGlobalRegistry`
   * which plants the map verbatim at `__ggui__.publicEnv`.
   *
   * Defensive parse: `parseBootstrap` re-validates every key against
   * the regex; one bad key collapses the whole field to `undefined`
   * (matches the `gadgets` / `contextSlots` parser posture).
   *
   * Absent or empty → no wrapper-readable env values; only wrappers
   * with no `requires` declarations can mount.
   *
   * @public
   */
  readonly publicEnv?: Readonly<Record<string, string>>;
  /**
   * Content-addressable hash for the active stack item's compiled
   * contract validators. Stable across pushes — same contract definition
   * always hashes to the same value via `computeContractBundle`'s
   * canonical-JSON-of-specs serializer. Paired with {@link validatorsUrl}.
   *
   * Producer: server push handler, via
   * `@ggui-ai/protocol`'s `computeContractBundle`. Consumer:
   * iframe-runtime's `loadCompiledValidatorsFromUrl`, which fetches
   * the URL + dynamic-imports the validator bundle.
   *
   * Absent → no precompiled validators shipped (contract declares no
   * runtime-validated specs, OR the server has no CodeStore wired for
   * the bundle write). The server-side `assertActionContract` gate
   * remains the authoritative validation surface; client-side fast-fail
   * degrades to no-op.
   *
   * @public
   */
  readonly contractHash?: string;
  /**
   * URL serving the content-addressable contract-validator bundle —
   * `<publicBaseUrl>/contract/<contractHash>.js`. Response is an ES
   * module whose `default` export is a {@link CompiledContractValidators}.
   * `Cache-Control: immutable` so repeat pushes with the same contract
   * hit browser cache without a round-trip.
   *
   * Always paired with {@link contractHash}: present together or absent
   * together.
   *
   * @public
   */
  readonly validatorsUrl?: string;
}

/**
 * Precompiled, eval-free validators for a contract's runtime-validated
 * specs — served at `_meta["ai.ggui/contract"].validatorsUrl` as the
 * `default` export of a content-addressable ES module.
 *
 * Each value is the SOURCE TEXT of an ES module whose `default` export
 * is an Ajv validator function (`(data) => boolean`, carrying
 * `.errors` after a run) — the output of `compileValidatorModule`.
 * The iframe-runtime loads each via a `blob:` dynamic import.
 *
 * @public
 */
export interface CompiledContractValidators {
  /** Validator for inbound runtime props (`DataContract.propsSpec`). */
  readonly props?: string;
  /**
   * Validators for outbound action envelopes, keyed by action name
   * (`DataContract.actionSpec`).
   */
  readonly actions?: Readonly<Record<string, string>>;
  /**
   * Validators for inbound stream payloads, keyed by channel name
   * (`DataContract.streamSpec`).
   */
  readonly streams?: Readonly<Record<string, string>>;
  /**
   * Validators for inbound context-slot values, keyed by slot name
   * (`DataContract.contextSpec`).
   */
  readonly context?: Readonly<Record<string, string>>;
}

/**
 * Derives the PascalCase Context name from a contextSpec slot key.
 * E.g., `currentStep` → `CurrentStepContext`. Consumed by the server
 * (when populating bootstrap.contextSlots) and the iframe-runtime
 * boilerplate (when generating destructuring lines).
 *
 * Edge cases:
 *   - Empty input → `'Context'` (caller-fault path; documented for
 *     determinism).
 *   - Single-character input → `<UPPER>Context` (e.g. `'a'` → `'AContext'`).
 *
 * @public
 */
export function deriveContextName(slotKey: string): string {
  if (slotKey.length === 0) return 'Context';
  return slotKey.charAt(0).toUpperCase() + slotKey.slice(1) + 'Context';
}

// =============================================================================
// #109 — per-stability-window `_meta` keys. Two slices that map 1:1 to
// the actual update cadence:
//
//   - `ai.ggui/session`    — mount-time + session-scoped: identity,
//                            boot wiring, live-channel auth, capability
//                            advertisements. Host caches per session.
//   - `ai.ggui/stack-item` — what's being rendered NOW: the active
//                            stack item's id, props, action hints,
//                            contract pointer, component discriminator.
//                            Replaced per push that activates a new
//                            stack item.
//
// Wire shape (both keys optional; presence is signal):
//
// ```jsonc
// "_meta": {
//   "ai.ggui/session":    { sessionId, appId, runtimeUrl, wsUrl, token, ... },
//   "ai.ggui/stack-item": { stackItemId, propsJson, contractHash, validatorsUrl, ... }
// }
// ```
//
// Hosts that don't recognize either key MUST treat them as opaque
// and forward verbatim — same posture as the spec-defined `_meta`
// extension surface.
//
// Consumers:
//   - {@link combineMcpAppAiGguiMeta}(_meta) → {session?, stackItem?}
//     parses the wire into a slice struct. No required-fields gate;
//     missing slices come through as undefined.
//   - {@link mergeSlicesIntoMountView}(slices) → {ok, view}|MISSING_SESSION
//     flattens slices into a unified {@link McpAppAiGguiMountView} the
//     iframe-runtime mounts from. Future work: layer over a per-session
//     cache so render-only updates can omit the session slice.
//   - {@link slicesToMcpAppMeta}(slices) → `_meta` envelope: emitter
//     helper that builds the wire shape from server-built slices.
// =============================================================================

/**
 * `_meta` key carrying mount-time identity + boot wiring + live-channel
 * auth. Stable across the session lifetime (token, wsUrl, runtimeUrl,
 * gadgets, theme, ...). Hosts MAY cache this slice keyed by sessionId
 * and forward subsequent pushes without re-validating.
 *
 * @public
 */
export const MCP_APP_AI_GGUI_SESSION_META_KEY = 'ai.ggui/session' as const;

/**
 * `_meta` key carrying the active stack item — what's being rendered
 * NOW. Replaced per push that activates a different stack item; absent
 * on pushes that only refresh session-level state (auth rotation, theme
 * change). Includes the rendered item's id, props, action hints,
 * content-addressable contract pointer, and component-mode
 * discriminator (codeUrl / codeHash / kind).
 *
 * @public
 */
export const MCP_APP_AI_GGUI_STACK_ITEM_META_KEY = 'ai.ggui/stack-item' as const;

/**
 * Session slice — mount-time identity, boot wiring, live-channel auth,
 * and host-cacheable capability advertisements.
 *
 * Required when present (first emission per session): `sessionId`,
 * `appId`, `runtimeUrl`. Live-channel auth (`wsUrl` + `token`) is
 * paired — both present or both absent; `expiresAt` informational.
 * Other fields are optional capabilities + config.
 *
 * @public
 */
export interface McpAppAiGguiSessionMeta {
  // Identity
  readonly sessionId: string;
  readonly appId: string;
  readonly runtimeUrl: string;

  // Live-channel auth (paired)
  readonly wsUrl?: string;
  readonly token?: string;
  readonly expiresAt?: string;

  // Polling-fallback URL when WS blocked at the host CSP layer
  readonly pollingUrl?: string;

  // Theme (resolved at mount; rarely changes mid-session)
  readonly themeId?: string;
  readonly themeMode?: 'light' | 'dark';

  // Architectural discriminator: canvas-scoped vs per-stack-item iframe
  readonly canvasMode?: boolean;

  // Capability accumulators (union across all stack items in the session)
  readonly gadgets?: McpAppAiGguiMountView['gadgets'];
  readonly publicEnv?: Readonly<Record<string, string>>;
  readonly streamWebSocketLocalTools?: readonly string[];
  readonly appCallableTools?: readonly string[];
  readonly permissionsPolicy?: readonly string[];
}

/**
 * Stack-item slice — what's being rendered RIGHT NOW. Activated per
 * push; combines what were formerly three separate slices (render +
 * contract + component) because they all describe a single stack item
 * and always activate together.
 *
 * Mode discriminator (cross-cutting validation in
 * {@link mergeSlicesIntoMountView}): at least one of
 * `{ codeUrl, kind, session.wsUrl-with-token }` MUST be present for
 * the iframe to mount. `kind` and `codeUrl` are mutually exclusive.
 *
 * @public
 */
export interface McpAppAiGguiStackItemMeta {
  // Identity of the active stack item
  readonly stackItemId?: string;

  // Render state — what the iframe re-renders on update
  readonly propsJson?: string;
  readonly actionNextSteps?: Readonly<Record<string, string>>;
  readonly contextSlots?: McpAppAiGguiMountView['contextSlots'];

  // Contract pointer (content-addressable). When present, the iframe
  // fetches the validators bundle from `validatorsUrl`; same contract
  // on repeat activations ⇒ browser HTTP cache hit (no round-trip).
  // Both fields paired — hash without URL has nowhere to fetch from.
  readonly contractHash?: string;
  readonly validatorsUrl?: string;

  // Component mode discriminator
  // - codeUrl + codeHash → static-component mode
  // - kind → system-card mode (mutually exclusive with codeUrl)
  // - absent (in live mode) → mount via live-channel
  readonly codeUrl?: string;
  readonly codeHash?: string;
  readonly kind?: string;
}

/**
 * Parsed wire slices — the structured pair {@link combineMcpAppAiGguiMeta}
 * returns. Both keys are optional; an absent slice means "the host
 * cache (or earlier mount) already has it." First-mount pushes
 * typically carry both; render-only deltas carry just `stackItem`.
 *
 * @public
 */
export interface McpAppAiGguiSlices {
  readonly session?: McpAppAiGguiSessionMeta;
  readonly stackItem?: McpAppAiGguiStackItemMeta;
}

/**
 * Discriminated result of {@link combineMcpAppAiGguiMeta}. The combiner
 * does structural slice-shape validation only — `MALFORMED_*` reasons
 * surface structurally-invalid slice contents (wrong type, paired
 * fields half-present). Missing slices are NOT failures here; the
 * "is session present" gate lives in {@link mergeSlicesIntoMountView}.
 *
 * @public
 */
export type CombineMcpAppAiGguiMetaResult =
  | { readonly ok: true; readonly slices: McpAppAiGguiSlices }
  | { readonly ok: false; readonly reason: 'MALFORMED_SESSION' | 'MALFORMED_STACK_ITEM' };

/**
 * Discriminated result of {@link mergeSlicesIntoMountView}. The merger
 * flattens slices into a {@link McpAppAiGguiMountView} and enforces
 * that the session slice is present (required for any mount). Once
 * the per-session cache lands (future slice), this gate accepts a
 * cached session in lieu of an incoming slice.
 *
 * @public
 */
export type MergeSlicesResult =
  | { readonly ok: true; readonly view: McpAppAiGguiMountView }
  | { readonly ok: false; readonly reason: 'MISSING_SESSION' };

/**
 * Read the two per-window `_meta` keys off a parsed JSON-RPC `_meta`
 * object and partition them into a {@link McpAppAiGguiSlices} struct.
 *
 * The combiner does STRUCTURAL slice-shape validation only. Missing
 * slices come through as `undefined` (not failures) — first-mount
 * pushes typically carry both `session` + `stackItem`; render-only
 * delta pushes carry just `stackItem`; auth-only refresh pushes carry
 * just `session`. The "is the session required for THIS consumer"
 * gate lives in {@link mergeSlicesIntoMountView}.
 *
 * Field-level optional-field defensive parsing (e.g. context-slot
 * schema narrowing, expiresAt date parse) lives in
 * {@link validateMountView} after the merge.
 *
 * @public
 */
export function combineMcpAppAiGguiMeta(meta: unknown): CombineMcpAppAiGguiMetaResult {
  if (meta === null || typeof meta !== 'object') {
    return { ok: true, slices: {} };
  }
  const m = meta as Record<string, unknown>;

  // Session slice — identity, boot wiring, live-channel auth.
  let session: McpAppAiGguiSessionMeta | undefined;
  const sessionRaw = m[MCP_APP_AI_GGUI_SESSION_META_KEY];
  if (sessionRaw !== undefined) {
    if (sessionRaw === null || typeof sessionRaw !== 'object' || Array.isArray(sessionRaw)) {
      return { ok: false, reason: 'MALFORMED_SESSION' };
    }
    const s = sessionRaw as Record<string, unknown>;
    if (
      typeof s.sessionId !== 'string' ||
      s.sessionId.length === 0 ||
      typeof s.appId !== 'string' ||
      s.appId.length === 0 ||
      typeof s.runtimeUrl !== 'string' ||
      s.runtimeUrl.length === 0
    ) {
      return { ok: false, reason: 'MALFORMED_SESSION' };
    }
    // Auth pairing — both wsUrl + token present or both absent.
    const aw = s.wsUrl;
    const at = s.token;
    const ae = s.expiresAt;
    const hasW = typeof aw === 'string' && aw.length > 0;
    const hasT = typeof at === 'string' && at.length > 0;
    if (hasW !== hasT) return { ok: false, reason: 'MALFORMED_SESSION' };
    if (ae !== undefined && typeof ae !== 'string') {
      return { ok: false, reason: 'MALFORMED_SESSION' };
    }
    session = {
      sessionId: s.sessionId,
      appId: s.appId,
      runtimeUrl: s.runtimeUrl,
      ...(hasW && hasT ? { wsUrl: aw as string, token: at as string } : {}),
      ...(ae !== undefined ? { expiresAt: ae as string } : {}),
      ...(s.pollingUrl !== undefined ? { pollingUrl: s.pollingUrl as string } : {}),
      ...(s.themeId !== undefined ? { themeId: s.themeId as string } : {}),
      ...(s.themeMode !== undefined
        ? { themeMode: s.themeMode as 'light' | 'dark' }
        : {}),
      ...(s.canvasMode !== undefined
        ? { canvasMode: s.canvasMode as boolean }
        : {}),
      ...(s.gadgets !== undefined
        ? { gadgets: s.gadgets as McpAppAiGguiMountView['gadgets'] }
        : {}),
      ...(s.publicEnv !== undefined
        ? { publicEnv: s.publicEnv as Readonly<Record<string, string>> }
        : {}),
      ...(s.streamWebSocketLocalTools !== undefined
        ? {
            streamWebSocketLocalTools:
              s.streamWebSocketLocalTools as readonly string[],
          }
        : {}),
      ...(s.appCallableTools !== undefined
        ? { appCallableTools: s.appCallableTools as readonly string[] }
        : {}),
      ...(s.permissionsPolicy !== undefined
        ? { permissionsPolicy: s.permissionsPolicy as readonly string[] }
        : {}),
    };
  }

  // Stack-item slice — render state + contract pointer + component mode.
  let stackItem: McpAppAiGguiStackItemMeta | undefined;
  const stackItemRaw = m[MCP_APP_AI_GGUI_STACK_ITEM_META_KEY];
  if (stackItemRaw !== undefined) {
    if (stackItemRaw === null || typeof stackItemRaw !== 'object' || Array.isArray(stackItemRaw)) {
      return { ok: false, reason: 'MALFORMED_STACK_ITEM' };
    }
    const si = stackItemRaw as Record<string, unknown>;

    // Component-mode discriminator: codeUrl + kind mutually exclusive.
    const cu = si.codeUrl;
    const ck = si.kind;
    const ch = si.codeHash;
    if (cu !== undefined && (typeof cu !== 'string' || cu.length === 0)) {
      return { ok: false, reason: 'MALFORMED_STACK_ITEM' };
    }
    if (ck !== undefined && (typeof ck !== 'string' || ck.length === 0)) {
      return { ok: false, reason: 'MALFORMED_STACK_ITEM' };
    }
    if (ch !== undefined && (typeof ch !== 'string' || ch.length === 0)) {
      return { ok: false, reason: 'MALFORMED_STACK_ITEM' };
    }
    if (typeof cu === 'string' && cu.length > 0 && typeof ck === 'string' && ck.length > 0) {
      return { ok: false, reason: 'MALFORMED_STACK_ITEM' };
    }

    // Contract pair — both present or both absent (or both effectively
    // absent via empty/wrong type → drop both, degrade to no validators).
    const cHash = si.contractHash;
    const vUrl = si.validatorsUrl;
    const validContractPair =
      typeof cHash === 'string' &&
      cHash.length > 0 &&
      typeof vUrl === 'string' &&
      vUrl.length > 0;

    stackItem = {
      ...(si.stackItemId !== undefined
        ? { stackItemId: si.stackItemId as string }
        : {}),
      ...(si.propsJson !== undefined
        ? { propsJson: si.propsJson as string }
        : {}),
      ...(si.actionNextSteps !== undefined
        ? {
            actionNextSteps: si.actionNextSteps as Readonly<
              Record<string, string>
            >,
          }
        : {}),
      ...(si.contextSlots !== undefined
        ? {
            contextSlots:
              si.contextSlots as McpAppAiGguiMountView['contextSlots'],
          }
        : {}),
      ...(validContractPair
        ? {
            contractHash: cHash as string,
            validatorsUrl: vUrl as string,
          }
        : {}),
      ...(typeof cu === 'string' && cu.length > 0 ? { codeUrl: cu } : {}),
      ...(typeof ch === 'string' && ch.length > 0 ? { codeHash: ch } : {}),
      ...(typeof ck === 'string' && ck.length > 0 ? { kind: ck } : {}),
    };
  }

  return {
    ok: true,
    slices: {
      ...(session !== undefined ? { session } : {}),
      ...(stackItem !== undefined ? { stackItem } : {}),
    },
  };
}

/**
 * Flatten {@link McpAppAiGguiSlices} into a single
 * {@link McpAppAiGguiMountView} the iframe-runtime mounts from. Enforces
 * that the `session` slice is present (required for any mount).
 *
 * Future work (separate slice): layer a per-session cache so the
 * caller can pass `cachedSession` and accept incoming slices that
 * omit `session`. Until then, every meta destined for an unmounted
 * iframe MUST carry the session slice.
 *
 * @public
 */
export function mergeSlicesIntoMountView(
  slices: McpAppAiGguiSlices,
): MergeSlicesResult {
  const { session, stackItem } = slices;
  if (session === undefined) {
    return { ok: false, reason: 'MISSING_SESSION' };
  }
  const view: McpAppAiGguiMountView = {
    sessionId: session.sessionId,
    appId: session.appId,
    runtimeUrl: session.runtimeUrl,
    ...(session.wsUrl !== undefined && session.token !== undefined
      ? { wsUrl: session.wsUrl, token: session.token }
      : {}),
    ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
    ...(session.pollingUrl !== undefined ? { pollingUrl: session.pollingUrl } : {}),
    ...(session.themeId !== undefined ? { themeId: session.themeId } : {}),
    ...(session.themeMode !== undefined ? { themeMode: session.themeMode } : {}),
    ...(session.canvasMode !== undefined ? { canvasMode: session.canvasMode } : {}),
    ...(session.gadgets !== undefined ? { gadgets: session.gadgets } : {}),
    ...(session.publicEnv !== undefined ? { publicEnv: session.publicEnv } : {}),
    ...(session.streamWebSocketLocalTools !== undefined
      ? { streamWebSocketLocalTools: session.streamWebSocketLocalTools }
      : {}),
    ...(session.appCallableTools !== undefined
      ? { appCallableTools: session.appCallableTools }
      : {}),
    ...(session.permissionsPolicy !== undefined
      ? { permissionsPolicy: session.permissionsPolicy }
      : {}),
    ...(stackItem?.stackItemId !== undefined
      ? { stackItemId: stackItem.stackItemId }
      : {}),
    ...(stackItem?.propsJson !== undefined
      ? { propsJson: stackItem.propsJson }
      : {}),
    ...(stackItem?.actionNextSteps !== undefined
      ? { actionNextSteps: stackItem.actionNextSteps }
      : {}),
    ...(stackItem?.contextSlots !== undefined
      ? { contextSlots: stackItem.contextSlots }
      : {}),
    ...(stackItem?.contractHash !== undefined && stackItem?.validatorsUrl !== undefined
      ? {
          contractHash: stackItem.contractHash,
          validatorsUrl: stackItem.validatorsUrl,
        }
      : {}),
    ...(stackItem?.codeUrl !== undefined ? { codeUrl: stackItem.codeUrl } : {}),
    ...(stackItem?.codeHash !== undefined ? { codeHash: stackItem.codeHash } : {}),
    ...(stackItem?.kind !== undefined ? { kind: stackItem.kind } : {}),
  };
  return { ok: true, view };
}

/**
 * Inverse of {@link mergeSlicesIntoMountView} — partition a flat
 * {@link McpAppAiGguiMountView} into its two per-window slices, for
 * emission as two top-level `_meta` keys.
 *
 * Defensive against hand-built mount views with null/wrong-type
 * optional fields: malformed shapes are dropped from the slice (the
 * field appears absent) rather than crashing the splitter.
 *
 * @public
 */
export function splitMountViewIntoSlices(
  view: McpAppAiGguiMountView,
): McpAppAiGguiSlices {
  const isObjectNonNull = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

  const session: McpAppAiGguiSessionMeta = {
    sessionId: view.sessionId,
    appId: view.appId,
    runtimeUrl: view.runtimeUrl,
    ...(view.wsUrl !== undefined && view.token !== undefined
      ? { wsUrl: view.wsUrl, token: view.token }
      : {}),
    ...(view.expiresAt !== undefined ? { expiresAt: view.expiresAt } : {}),
    ...(view.pollingUrl !== undefined ? { pollingUrl: view.pollingUrl } : {}),
    ...(view.themeId !== undefined ? { themeId: view.themeId } : {}),
    ...(view.themeMode !== undefined ? { themeMode: view.themeMode } : {}),
    ...(view.canvasMode !== undefined ? { canvasMode: view.canvasMode } : {}),
    ...(Array.isArray(view.gadgets) && view.gadgets.length > 0
      ? { gadgets: view.gadgets }
      : {}),
    ...(isObjectNonNull(view.publicEnv) &&
    Object.keys(view.publicEnv).length > 0
      ? { publicEnv: view.publicEnv }
      : {}),
    ...(view.streamWebSocketLocalTools !== undefined
      ? { streamWebSocketLocalTools: view.streamWebSocketLocalTools }
      : {}),
    ...(Array.isArray(view.appCallableTools) && view.appCallableTools.length > 0
      ? { appCallableTools: view.appCallableTools }
      : {}),
    ...(view.permissionsPolicy !== undefined
      ? { permissionsPolicy: view.permissionsPolicy }
      : {}),
  };

  const stackItemCandidate: McpAppAiGguiStackItemMeta = {
    ...(view.stackItemId !== undefined ? { stackItemId: view.stackItemId } : {}),
    ...(view.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
    ...(isObjectNonNull(view.actionNextSteps) &&
    Object.keys(view.actionNextSteps).length > 0
      ? { actionNextSteps: view.actionNextSteps }
      : {}),
    ...(Array.isArray(view.contextSlots) && view.contextSlots.length > 0
      ? { contextSlots: view.contextSlots }
      : {}),
    ...(view.contractHash !== undefined && view.validatorsUrl !== undefined
      ? { contractHash: view.contractHash, validatorsUrl: view.validatorsUrl }
      : {}),
    ...(view.codeUrl !== undefined ? { codeUrl: view.codeUrl } : {}),
    ...(view.codeHash !== undefined ? { codeHash: view.codeHash } : {}),
    ...(view.kind !== undefined ? { kind: view.kind } : {}),
  };
  const stackItem: McpAppAiGguiStackItemMeta | undefined =
    Object.keys(stackItemCandidate).length > 0 ? stackItemCandidate : undefined;

  return {
    session,
    ...(stackItem !== undefined ? { stackItem } : {}),
  };
}

/**
 * Emitter convenience — wrap a server-built {@link McpAppAiGguiSlices}
 * struct as the wire `_meta` envelope under the canonical key
 * constants. Drops empty slices.
 *
 * @public
 */
export function slicesToMcpAppMeta(
  slices: McpAppAiGguiSlices,
): Record<string, unknown> {
  return {
    ...(slices.session
      ? { [MCP_APP_AI_GGUI_SESSION_META_KEY]: slices.session }
      : {}),
    ...(slices.stackItem
      ? { [MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]: slices.stackItem }
      : {}),
  };
}

/**
 * Test + legacy-emitter convenience — take a flat
 * {@link McpAppAiGguiMountView} and produce the wire `_meta` envelope.
 * Equivalent to `slicesToMcpAppMeta(splitMountViewIntoSlices(view))`.
 *
 * @public
 */
export function mountViewToMcpAppMeta(
  view: McpAppAiGguiMountView,
): Record<string, unknown> {
  return slicesToMcpAppMeta(splitMountViewIntoSlices(view));
}

// =============================================================================
// Inbound — third-party MCP Apps hosted inside a ggui session.
// =============================================================================

/**
 * CSP metadata copied from an MCP Apps resource declaration.
 * Spec-canonical field names — do NOT rename.
 */
export interface McpAppsCsp {
  readonly connectDomains?: string[];
  readonly resourceDomains?: string[];
  readonly frameDomains?: string[];
}

/**
 * Permissions Policy metadata copied from an MCP Apps resource
 * declaration. Spec-canonical field names — do NOT rename.
 */
export interface McpAppsPermissions {
  readonly camera?: boolean;
  readonly microphone?: boolean;
  readonly geolocation?: boolean;
  readonly clipboardWrite?: boolean;
}

/**
 * Container dimensions hint passed to the embedded iframe via the
 * MCP Apps `ui/initialize` response.
 */
export interface McpAppsContainerDimensions {
  readonly height?: number;
  readonly width?: number;
  readonly maxHeight?: number;
  readonly maxWidth?: number;
}

/**
 * Locator for the source of an embedded MCP App.
 *
 * Persists STABLE identity (not a raw URL) so session state survives
 * source-server endpoint changes. The runtime `ConnectorRegistry`
 * resolves `connectorId` to the actual endpoint at render time.
 */
export interface McpAppsSource {
  /** Stable connector id declared in the app's connector registry. */
  readonly connectorId: string;
  /** Source-server tool whose call produced this UI; scope for
   * `tools/call` proxying. */
  readonly toolName: string;
  /** `ui://` resource URI declared on the source tool's
   * `_meta.ui.resourceUri`. */
  readonly resourceUri: string;
}

/**
 * Stack-item variant: an embedded third-party MCP App iframe.
 *
 * **Locator-oriented, not content-oriented.** Persisted state carries
 * `source` (connector identity) + declared CSP/permissions/dimensions
 * metadata; resource BYTES are not stored in session state by default.
 * The `@ggui-ai/mcp-server` resource-proxy route fetches the bytes
 * on-demand via `resources/read` against the source server.
 *
 * **Union safety.** Fields that exist on the {@link StackItem}
 * (generated / native component) variant are declared here as
 * `?: never` so consumers that access them via optional chaining on
 * `SessionStackEntry` still typecheck cleanly. Those fields semantically
 * DO NOT exist on McpAppsStackItem — the `?: never` typing encodes the
 * "structurally absent" guarantee.
 */
export interface McpAppsStackItem {
  /** Discriminator — required on this variant. */
  readonly type: 'mcpApps';

  // Shared stack-item base.
  readonly id: string;
  readonly createdAt: string;
  readonly prompt?: string;
  readonly description?: string;
  readonly message?: string;

  // Locator + declared metadata.
  readonly source: McpAppsSource;
  readonly csp?: McpAppsCsp;
  readonly permissions?: McpAppsPermissions;
  readonly containerDimensions?: McpAppsContainerDimensions;

  /**
   * Optional integrity pin — sha256 of the resource bytes computed at
   * push time. The resource-proxy route verifies the re-fetched
   * content against this hash; a mismatch breaks the stack item
   * LOUDLY rather than silently serving mutated content.
   */
  readonly resourceHash?: string;

  /**
   * Bounded dev/cache optimization. When present, the proxy route MAY
   * serve this inline instead of re-fetching via `resources/read`. NOT
   * the canonical carrier — metadata persists, bytes don't. Use only
   * for dev harnesses / offline replay.
   */
  readonly resourceContent?: string;

  // ComponentStackItem-specific fields — ALWAYS absent on this variant.
  // Typed as `?: never` so `SessionStackEntry` readers that optional-
  // chain these fields (`item.componentCode?.trim()`) still typecheck.
  // If you find yourself wanting to populate one of these, reconsider
  // the design — they belong to the OTHER variant.
  readonly componentCode?: never;
  readonly props?: never;
  readonly contentType?: never;
  readonly schema?: never;
  readonly subscription?: never;
  readonly capabilities?: never;
  readonly actions?: never;
  readonly quality?: never;
  readonly error?: never;
  readonly streamSpec?: never;
  readonly propsSpec?: never;
  readonly actionSpec?: never;
  readonly contextSpec?: never;
  readonly clientCapabilities?: never;
}

/**
 * Type guard: narrows a `SessionStackEntry` (or unknown) to
 * {@link McpAppsStackItem}. Uses the discriminator.
 */
export function isMcpAppsStackItem(entry: unknown): entry is McpAppsStackItem {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    (entry as { type?: unknown }).type === 'mcpApps'
  );
}

/**
 * Structural validator for an `McpAppsStackItem` — not a Zod schema
 * so we don't force a Zod dependency here. Returns null on failure
 * (caller maps to an appropriate error code). Required when accepting
 * one over the wire from an agent: the discriminator alone isn't
 * enough.
 */
export function validateMcpAppsStackItem(
  input: unknown,
): McpAppsStackItem | null {
  if (input === null || typeof input !== 'object') return null;
  const item = input as Record<string, unknown>;
  if (item.type !== 'mcpApps') return null;
  if (typeof item.id !== 'string' || item.id.length === 0) return null;
  if (typeof item.createdAt !== 'string') return null;
  const source = item.source as
    | { connectorId?: unknown; toolName?: unknown; resourceUri?: unknown }
    | undefined;
  if (!source || typeof source !== 'object') return null;
  if (typeof source.connectorId !== 'string' || source.connectorId.length === 0) return null;
  if (typeof source.toolName !== 'string' || source.toolName.length === 0) return null;
  if (typeof source.resourceUri !== 'string' || !source.resourceUri.startsWith('ui://')) return null;
  return input as McpAppsStackItem;
}

// =============================================================================
// Mount lifecycle — renderer ↔ host postMessage protocol.
//
// The renderer (inside the iframe) emits {@link McpAppLifecycleMessage}
// envelopes to its parent at well-defined transitions in its mount
// lifecycle. The MCP Apps host (e.g., `<McpAppIframe>`) listens on
// `window.message`, validates the envelope shape, and mirrors the
// resulting `state` onto the OUTER iframe element so observers — tests,
// accessibility scanners, third-party hosts, console inspectors — can
// read mount state without reaching into the iframe's own DOM.
//
// **Why this lives on the protocol surface, not on `observability.ts`:**
// observability events are a renderer-internal sink (telemetry the host
// MAY surface). Lifecycle states are wire-observable contract guarantees
// the host MUST respect — they appear on the outer element regardless of
// host opt-in, and the obligations are bidirectional (renderer MUST
// emit `code-ready` before considering itself ready; host MUST mirror
// the latest received state). Per the protocol-and-contract bar's named-
// parties + obligations + failure-mode + observable-violation criteria,
// this is a protocol surface, not an implementation seam.
// =============================================================================

/**
 * Lifecycle states the renderer transitions through inside an MCP Apps
 * iframe. Closed union — adding a new state is a protocol-version-
 * eligible change. Hosts that don't recognise a state MUST treat it as
 * a no-op (don't mirror it, don't crash).
 *
 * State machine:
 *
 * ```
 *                ┌────────────┐
 *  (iframe boot) │  mounting  │
 *                └─────┬──────┘
 *                      │  bundle evaluated +
 *                      │  React tree mounted +
 *                      │  WS handshake completed
 *                      ▼
 *                ┌─────────────┐
 *                │ code-ready  │◀────── (terminal happy state)
 *                └──┬─────┬────┘
 *                   │     │
 *      (WS close)   │     │   (eval / mount / handshake throw)
 *                   ▼     ▼
 *           ┌──────────┐ ┌───────┐
 *           │disconnected│ │ error │
 *           └────────────┘ └───────┘
 * ```
 *
 * - `mounting` — emitted ASAP after iframe boot (before bundle eval).
 *   A host that observes only `mounting` and never a follow-up state
 *   has a renderer that crashed before posting code-ready/error.
 * - `code-ready` — happy-path terminal state. Bundle evaluated, React
 *   tree mounted, WS connected, first stack ack folded. Equivalent of
 *   the in-iframe `data-ggui-status="connected"`.
 * - `error` — terminal failure. Pairs with the existing
 *   `ggui:bootstrap-failed` postMessage envelope which carries the
 *   typed reason; this lifecycle state is the COARSE outer-DOM signal
 *   ("renderer is not going to come up — give up waiting").
 * - `disconnected` — non-terminal. WebSocket closed after a successful
 *   `code-ready`. The renderer MAY transition back to `code-ready` if
 *   reconnection succeeds (subscribe.ts owns the reconnect ladder);
 *   hosts that pin selectors on `code-ready` will re-resolve when it
 *   does.
 *
 * @public
 */
export type McpAppLifecycleState =
  | 'mounting'
  | 'code-ready'
  | 'error'
  | 'disconnected';

/**
 * Lifecycle event payload shape. Carried inside an
 * {@link McpAppLifecycleMessage} envelope (`type: 'ggui:lifecycle'`).
 *
 * Fields:
 *   - `state` — required. The lifecycle state being entered.
 *   - `stackItemId` — optional. When present, the lifecycle pertains
 *     to a specific stack item (per-card iframes via single-item
 *     mode). Absent → whole-renderer lifecycle.
 *   - `error` — optional, only meaningful when `state === 'error'`.
 *     Mirrors the `ggui:bootstrap-failed` postMessage envelope's
 *     `reason` + `message` so a single `ggui:lifecycle` listener can
 *     surface both the coarse signal AND the typed cause without
 *     subscribing to two envelopes. Producers SHOULD set this when
 *     `state === 'error'`; it is OPTIONAL because legacy producers
 *     emitted no lifecycle event at all and we don't want to require
 *     a code change for the coarse signal alone.
 *
 * Producers MUST NOT add fields not enumerated here in this shape;
 * additive evolution requires a new optional key + a doc revision so
 * hosts know what they may observe. Consumers MUST ignore unknown
 * fields (shape-preserving extensibility).
 *
 * @public
 */
export interface McpAppLifecycleEvent {
  readonly state: McpAppLifecycleState;
  readonly stackItemId?: string;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

/**
 * postMessage envelope the renderer posts to its parent on every
 * lifecycle transition. The string `'ggui:lifecycle'` is the protocol-
 * canonical envelope tag — hosts filter `event.data.type` to subscribe.
 *
 * **Named parties:**
 *   - **Renderer** (producer) — running inside the MCP Apps iframe;
 *     emits one envelope per state transition.
 *   - **Host** (consumer) — running in the parent window (e.g.,
 *     `<McpAppIframe>`); listens on `window.message`, narrows
 *     `event.source` to the iframe's `contentWindow`, and mirrors
 *     `event.state` onto the outer iframe element.
 *   - **Observer** (downstream) — tests, accessibility scanners, dev
 *     inspectors; read the host-mirrored attribute on the outer DOM
 *     element. Observers DO NOT subscribe to postMessage directly —
 *     the host is the protocol-defined mirror point.
 *
 * **Obligations:**
 *   - Renderer MUST post `mounting` before evaluating the bundle.
 *   - Renderer MUST post exactly one terminal state (`code-ready`
 *     or `error`) for any successful boot attempt.
 *   - Renderer MAY post `disconnected` after a `code-ready` and MAY
 *     post `code-ready` again after a successful reconnect.
 *   - Host MUST mirror the latest received state onto the outer
 *     element via the `data-ggui-mcp-app-iframe-lifecycle="<state>"`
 *     attribute. Idempotent re-emission of the same state is a no-op.
 *   - Host MUST narrow `event.source` to the iframe's `contentWindow`
 *     before trusting the envelope (cross-frame postMessage is the
 *     attack surface; envelopes from other windows MUST be dropped).
 *
 * **Defined failure modes:**
 *   - Renderer never emits any lifecycle event → host's outer-element
 *     attribute is never set, observers timeout waiting for a state.
 *     This is the UN-INSTRUMENTED legacy case; not a violation.
 *   - Renderer emits `mounting` then no terminal state → host's
 *     attribute pins to `'mounting'`. Observers waiting for
 *     `'code-ready'` see a stuck attribute and fail their own timeout
 *     — the coarse-grained surfacing of "renderer crashed before
 *     declaring ready". Hosts MAY layer a watchdog on top to
 *     transition the attribute to a synthetic `'timeout'` state, but
 *     that is host policy, not protocol obligation.
 *   - Renderer emits `code-ready` and the WS later drops without a
 *     subsequent `disconnected` → host's attribute remains
 *     `'code-ready'`. This is shape-acceptable because reconnect
 *     attempts are still in flight; observers that need finer-
 *     grained connection state subscribe to `ggui:observe`'s
 *     `subscribe-failed` events instead.
 *
 * **Observable violation:**
 *   - The outer-element attribute. A renderer that posts envelopes
 *     the host can't classify (wrong shape, wrong type tag) does NOT
 *     update the attribute; the violation is observable as a stuck
 *     attribute relative to the inferred WS / DOM state of the
 *     iframe child.
 *
 * @public
 */
export interface McpAppLifecycleMessage {
  readonly type: 'ggui:lifecycle';
  readonly event: McpAppLifecycleEvent;
}

/**
 * The closed set of valid lifecycle states. Exposed as a `readonly`
 * tuple so consumers (renderer host filters, conformance tests) can
 * iterate without re-typing the union literally.
 *
 * @public
 */
export const MCP_APP_LIFECYCLE_STATES: readonly McpAppLifecycleState[] = [
  'mounting',
  'code-ready',
  'error',
  'disconnected',
] as const;

/**
 * Type guard for {@link McpAppLifecycleMessage}. Trust-boundary helper
 * — apps consuming raw postMessage data MUST narrow before reading
 * `event.state` to avoid reaching into untyped property bags.
 *
 * Validation rules (all required for `true`):
 *   - Outer envelope is an object with `type === 'ggui:lifecycle'`.
 *   - `event` is an object with `state` matching {@link
 *     MCP_APP_LIFECYCLE_STATES}.
 *   - If `stackItemId` is present, it is a non-empty string.
 *   - If `error` is present, it is an object with string `code` +
 *     `message`.
 *
 * @public
 */
export function isMcpAppLifecycleMessage(
  message: unknown,
): message is McpAppLifecycleMessage {
  if (message === null || typeof message !== 'object') return false;
  const m = message as { type?: unknown; event?: unknown };
  if (m.type !== 'ggui:lifecycle') return false;
  if (m.event === null || typeof m.event !== 'object') return false;
  const e = m.event as {
    state?: unknown;
    stackItemId?: unknown;
    error?: unknown;
  };
  if (typeof e.state !== 'string') return false;
  if (!MCP_APP_LIFECYCLE_STATES.includes(e.state as McpAppLifecycleState)) {
    return false;
  }
  if (e.stackItemId !== undefined) {
    if (typeof e.stackItemId !== 'string' || e.stackItemId.length === 0) {
      return false;
    }
  }
  if (e.error !== undefined) {
    if (e.error === null || typeof e.error !== 'object') return false;
    const err = e.error as { code?: unknown; message?: unknown };
    if (typeof err.code !== 'string' || typeof err.message !== 'string') {
      return false;
    }
  }
  return true;
}

// `hasPushBootstrapMeta` removed in #109 — its role (validate a
// `_meta["ai.ggui/bootstrap"]` envelope) is gone with the aggregated
// key. Use {@link combineMcpAppAiGguiMeta} for structural validation
// of the new five-key `_meta` shape.

// =============================================================================
// Gesture envelope (ggui_runtime_submit_action input contract)
// =============================================================================

/**
 * Discriminator for the user-action envelope delivered via
 * `ggui_runtime_submit_action` over the MCP Apps host-relay path
 * (postMessage `tools/call` → host MCP client → server). Every
 * user-driven `WireConfig` method emits this envelope so operators get
 * **uniform server-side observability** across every gesture kind
 * regardless of which user-visible effect the iframe already fired
 * locally (`ui/open-link` / `ui/request-display-mode`) before the audit.
 *
 * **Closed primary set, extensibly-closed forward-compat.** The three
 * primary kinds correspond 1:1 to the `WireConfig` methods that emit
 * gestures today. Forward additions land via the `(string & {})` slot
 * — handlers MUST treat unknown values gracefully (log under an
 * `'unknown'` bucket, never throw or hard-switch). Adding a new kind
 * is additive and does NOT bump the protocol version.
 *
 * | kind                    | primary host effect              | payload shape                                                          |
 * | ----------------------- | -------------------------------- | ---------------------------------------------------------------------- |
 * | `dispatch`              | pipe append (single source)      | `{ intent: string, actionData: JsonValue \| null, uiContext: JsonObject }` |
 * | `openLink`              | `ui/open-link`                   | `{ url: string }`                                                      |
 * | `requestDisplayMode`    | `ui/request-display-mode`        | `{ mode: 'fullscreen' \| 'pip' \| 'inline' }`                          |
 *
 * Audit is **fail-soft** at the client: if the `tools/call` envelope
 * fails to deliver (host rejects, postMessage on detached parent), the
 * primary host effect MUST still proceed. The audit miss surfaces as a
 * diagnostic on the operator side (gap in the SessionInspector activity
 * row), not as a user-facing failure. This mirrors today's `dispatch`
 * audit-fire posture so semantics stay uniform.
 *
 * Failure-mode note: a malformed envelope (unknown `kind` AND malformed
 * `payload`) lands as `INVALID_ACTION_KIND` on `_ggui:contract-error`.
 * See `ContractErrorCode` for the canonical extensibly-closed code set.
 */
export type SubmitActionKind =
  | 'dispatch'
  | 'openLink'
  | 'requestDisplayMode'
  | (string & {});

/**
 * Per-kind payload schemas for {@link SubmitActionKind}. Keep this discriminated
 * union narrow — adding a new gesture means adding both a kind variant AND
 * its payload shape here, in lockstep, so the `ggui_runtime_submit_action`
 * handler's input parser can validate exhaustively.
 *
 * `payload` for the unknown `(string & {})` extension slot widens to
 * `Record<string, unknown>` — handlers MUST validate shape against their
 * own schema before consuming, since the protocol type can't narrow it.
 */
export type SubmitActionEnvelope =
  | {
      readonly kind: 'dispatch';
      readonly payload: {
        /** `actionSpec[*]` key the iframe dispatched against. */
        readonly intent: string;
        /**
         * Typed payload satisfying `actionSpec[intent].schema`.
         * `null` for no-payload gestures (bare button click).
         */
        readonly actionData: JsonValue | null;
        /**
         * Iframe-local snapshot of the contract's `contextSpec` slot
         * values at the moment the user fired the gesture. Captured at
         * gesture time so the agent can reason about WHAT the user did
         * AND WHAT THEY WERE LOOKING AT atomically — without a second
         * round trip to read state from the rendered UI.
         *
         * Empty object `{}` when the contract has no `contextSpec` or
         * the iframe hasn't yet mirrored any slots.
         */
        readonly uiContext: JsonObject;
      };
    }
  | {
      readonly kind: 'openLink';
      readonly payload: { readonly url: string };
    }
  | {
      readonly kind: 'requestDisplayMode';
      readonly payload: {
        readonly mode: 'fullscreen' | 'pip' | 'inline' | (string & {});
      };
    }
  | {
      readonly kind: string;
      readonly payload: Record<string, unknown>;
    };

/**
 * Canonical input contract for the `ggui_runtime_submit_action` MCP tool.
 * The iframe-runtime delivers this via the MCP Apps host-relay path
 * (postMessage `tools/call` → host MCP client → server) — the iframe
 * has no auth credential of its own, so the host is the protocol-
 * defined relay party (per `_meta.ui.visibility: ['app']` on the
 * tool declaration).
 *
 * Per-kind semantics:
 *
 *   - `kind === 'dispatch'`: server appends a consume-entry onto the
 *     stackItem-keyed pending-events pipe (`{type:'action', stackItemId,
 *     intent, actionData, uiContext, actionId, firedAt}`) so the agent's
 *     `ggui_consume` long-poll unblocks in the same chat turn. When the
 *     pipe is closed/missing (popped/closed/never opened), the handler
 *     returns `{ok:false, code:'PIPE_NOT_FOUND'}` and the iframe-runtime
 *     falls through to a `ui/message` envelope carrying
 *     `_meta.ggui.userAction` (see {@link GguiUserActionMeta}) so the
 *     gesture still reaches the agent on its next turn.
 *   - `kind ∈ {'openLink','requestDisplayMode'}`: pure audit — the
 *     user-visible host effect already fired iframe-side via
 *     `ui/open-link` / `ui/request-display-mode`. The server records
 *     the gesture for the SessionInspector feed.
 *
 * Required fields:
 *   - `sessionId` / `appId`: bootstrap-issued; server cross-checks.
 *   - `actionId`: 8-hex correlation hash (FNV-1a of intent + data + firedAt
 *     for `dispatch`, kind + payload + firedAt for the host-control kinds).
 *     Lets the host LLM cross-verify a `[ggui:pending-action]` context entry
 *     against a `ui/message` consent prompt by id.
 *   - `firedAt`: ISO-8601 client-monotonic timestamp; useful for ordering
 *     and replay diagnostics. Server uses its own clock for authoritative
 *     log ordering.
 *
 * The discriminated `kind` + `payload` pair carries the actual gesture
 * shape — see {@link SubmitActionEnvelope}.
 */
export type GguiSubmitActionInput = SubmitActionEnvelope & {
  readonly sessionId: string;
  /**
   * Active stack item id. Optional because the iframe-runtime boots
   * into a stack-item context only when the host minted one via
   * `ggui_push` — boot scenarios like system-cards or pre-push
   * provisional previews don't carry one. Required when
   * `kind === 'dispatch'` (the kind that needs to land in the
   * stackItem-keyed pending-event pipe); the server-side handler
   * rejects dispatch envelopes missing this field.
   */
  readonly stackItemId?: string;
  readonly appId: string;
  readonly actionId: string;
  readonly firedAt: string;
};

/**
 * The three canonical gesture kinds — useful for exhaustiveness checks
 * in `switch (kind) { ... }` blocks. Frozen so consumers can safely use
 * `as const` against the readonly tuple.
 */
export const SUBMIT_ACTION_KINDS = [
  'dispatch',
  'openLink',
  'requestDisplayMode',
] as const satisfies readonly SubmitActionKind[];

/**
 * Type guard narrowing an unknown value to {@link GguiSubmitActionInput}.
 * Validates the `kind` discriminator + the per-kind `payload` shape.
 * Used by the server-side `ggui_runtime_submit_action` handler to reject
 * malformed envelopes with `INVALID_ACTION_KIND` instead of silently
 * coercing.
 *
 * Unknown extension kinds are accepted at this guard layer (the
 * `(string & {})` slot is part of the type) but the per-kind payload
 * narrowing collapses to `Record<string, unknown>` — extension-handlers
 * MUST validate shape before consuming.
 */
export function isGguiSubmitActionInput(
  value: unknown,
): value is GguiSubmitActionInput {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.kind !== 'string' || v.kind.length === 0) return false;
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) return false;
  if (typeof v.appId !== 'string' || v.appId.length === 0) return false;
  if (typeof v.actionId !== 'string' || v.actionId.length === 0) return false;
  if (typeof v.firedAt !== 'string' || v.firedAt.length === 0) return false;
  if (
    v.stackItemId !== undefined &&
    (typeof v.stackItemId !== 'string' || v.stackItemId.length === 0)
  ) {
    return false;
  }
  if (v.payload === null || typeof v.payload !== 'object') return false;
  // Per-kind payload narrowing for the closed primary set. Unknown
  // kinds pass through with whatever payload-object the caller supplied
  // — extension handlers own the validation.
  const p = v.payload as Record<string, unknown>;
  switch (v.kind) {
    case 'dispatch':
      if (typeof p.intent !== 'string' || p.intent.length === 0) return false;
      // `actionData` MUST be present (key exists). The value MAY be
      // `null` — bare button clicks legitimately have no payload.
      // Discriminate via `in` so an explicit `null` passes while
      // truly-missing fails.
      if (!('actionData' in p)) return false;
      // `uiContext` MUST be a JSON object — `{}` when there's no
      // contextSpec. Arrays and null are rejected.
      if (p.uiContext === null || typeof p.uiContext !== 'object') return false;
      if (Array.isArray(p.uiContext)) return false;
      return true;
    case 'openLink':
      return typeof p.url === 'string' && p.url.length > 0;
    case 'requestDisplayMode':
      return typeof p.mode === 'string' && p.mode.length > 0;
    default:
      // Extension slot — payload-object presence is the only invariant.
      return true;
  }
}

/**
 * Discriminator the iframe-runtime stamps on a `ui/message` envelope's
 * `params._meta.ggui.userAction` when a user gesture inside a ggui-
 * rendered iframe needs to flow to the agent through chat (rather than
 * direct WS drain via `ggui_consume`).
 *
 * Discriminated by `kind`:
 *
 *   - **`'queued'`** — pipe HAS the event; agent should call
 *     `ggui_consume({stackItemId})` to drain. The prepared call lives
 *     in `nextStep` as `{tool: 'ggui_consume', args: {stackItemId}}`
 *     so the SDK can dispatch verbatim without arg-construction.
 *
 *   - **`'inline'`** — pipe is GONE (popped / session closed / never
 *     opened). Action data is carried inline in `payload`. The agent
 *     MUST act on this directly; calling `ggui_consume` for this
 *     `stackItemId` would return empty.
 *
 * The accompanying `ui/message` text mirrors the structure in human-
 * readable form so agnostic LLMs without `_meta` awareness still get
 * the right instruction.
 *
 * **Presence is the fingerprint** — agnostic hosts ignore the field;
 * ggui-aware consumers route via {@link isGguiUserActionMeta}.
 *
 * Unified shape with a `kind` discriminator (`queued` | `inline`)
 * parallels the protocol's other discriminated unions, e.g.
 * {@link SubmitActionEnvelope}'s `kind`.
 *
 * @public
 */
export type GguiUserActionMeta = QueuedUserActionMeta | InlineUserActionMeta;

/**
 * `_meta.ggui.userAction` variant — pipe has the event; agent dispatches
 * the prepared `ggui_consume` call to drain. See {@link GguiUserActionMeta}.
 *
 * @public
 */
export interface QueuedUserActionMeta {
  readonly kind: 'queued';
  /**
   * Human-readable one-liner summary for logs / SDK debug surfaces.
   * Mirrors the chat-visible text but as a structured field so
   * consumers don't need to parse natural language.
   */
  readonly description: string;
  /** Stack item the gesture targeted. */
  readonly stackItemId: string;
  /** 8-hex FNV-1a correlation id of the gesture. */
  readonly actionId: string;
  /** ISO 8601 UTC timestamp of the gesture (iframe local clock). */
  readonly submittedAt: string;
  /** Which `actionSpec[*]` entry the iframe dispatched against. */
  readonly intent: string;
  /**
   * Prepared tool call the agent SHOULD dispatch verbatim. Embeds the
   * `stackItemId` so the SDK doesn't have to thread it manually —
   * reduces "wrong/missing args" failure modes.
   */
  readonly nextStep: {
    readonly tool: 'ggui_consume';
    readonly args: { readonly stackItemId: string };
  };
}

/**
 * `_meta.ggui.userAction` variant — pipe is gone; action + ui context
 * delivered inline. Agent acts on `payload` directly; MUST NOT call
 * `ggui_consume` for `stackItemId` (no pipe to drain).
 *
 * `nextStep` is optional — when the original `actionSpec[intent]` declared
 * a `nextStep` (the bound agent tool), it's surfaced here as a string
 * hint so the LLM has a strong steer toward the right tool. When the
 * contract author left `nextStep` undeclared, the agent is fully free
 * to choose how to react.
 *
 * @public
 */
export interface InlineUserActionMeta {
  readonly kind: 'inline';
  /**
   * Human-readable one-liner summary for logs / SDK debug surfaces.
   */
  readonly description: string;
  /** Stack item the gesture targeted. */
  readonly stackItemId: string;
  /** 8-hex FNV-1a correlation id of the gesture. */
  readonly actionId: string;
  /** ISO 8601 UTC timestamp of the gesture (iframe local clock). */
  readonly submittedAt: string;
  /** Which `actionSpec[*]` entry the iframe dispatched against. */
  readonly intent: string;
  /**
   * Both halves of the gesture, captured atomically at gesture time:
   *
   *   - `actionData` — typed payload satisfying `actionSpec[intent].schema`.
   *                    `null` for no-payload gestures (bare button click).
   *   - `uiContext`  — snapshot of the iframe's contextSpec values at
   *                    the moment the user fired the gesture. Typed by
   *                    the contract's `contextSpec`.
   *
   * The pair is the SEMANTIC UNIT — what the user did AND what they
   * were looking at when they did it. Captured at gesture time (not
   * drain time) for honest history.
   */
  readonly payload: {
    readonly actionData: JsonValue | null;
    readonly uiContext: JsonObject;
  };
  /**
   * Optional hint: the agent tool the original `actionSpec[intent].nextStep`
   * declared. Present when the contract bound this intent to a specific
   * tool; absent when the author left it free. The agent reads this as
   * a strong suggestion, not a binding directive (in the inline case
   * the LLM composes the call, including any context-derived args).
   */
  readonly nextStep?: string;
}

/**
 * Type guard for {@link GguiUserActionMeta}. Validates the
 * discriminated shape on a `ui/message` envelope's
 * `params._meta.ggui.userAction` field.
 *
 * Designed for `_meta.ggui.userAction`-aware consumers (sample agent
 * dispatcher, e2e assertions, future SDKs) to route deterministically
 * without speculative shape coercion.
 *
 * @public
 */
export function isGguiUserActionMeta(
  meta: unknown,
): meta is GguiUserActionMeta {
  if (meta === null || typeof meta !== 'object') return false;
  const m = meta as Record<string, unknown>;
  if (typeof m.description !== 'string' || m.description.length === 0) {
    return false;
  }
  if (typeof m.stackItemId !== 'string' || m.stackItemId.length === 0) {
    return false;
  }
  if (typeof m.actionId !== 'string' || m.actionId.length === 0) {
    return false;
  }
  if (typeof m.submittedAt !== 'string' || m.submittedAt.length === 0) {
    return false;
  }
  if (typeof m.intent !== 'string' || m.intent.length === 0) return false;
  if (m.kind === 'queued') {
    if (m.nextStep === null || typeof m.nextStep !== 'object') return false;
    const ns = m.nextStep as Record<string, unknown>;
    if (ns.tool !== 'ggui_consume') return false;
    if (ns.args === null || typeof ns.args !== 'object') return false;
    const args = ns.args as Record<string, unknown>;
    if (
      typeof args.stackItemId !== 'string' ||
      args.stackItemId.length === 0
    ) {
      return false;
    }
    return true;
  }
  if (m.kind === 'inline') {
    if (m.payload === null || typeof m.payload !== 'object') return false;
    const p = m.payload as Record<string, unknown>;
    if (p.actionData === undefined) return false; // explicit null OK
    if (p.uiContext === null || typeof p.uiContext !== 'object') return false;
    if (Array.isArray(p.uiContext)) return false;
    if (
      m.nextStep !== undefined &&
      (typeof m.nextStep !== 'string' || m.nextStep.length === 0)
    ) {
      return false;
    }
    return true;
  }
  return false;
}
