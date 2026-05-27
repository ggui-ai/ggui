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
 *   parseMcpAppAiGguiMeta,
 *   type McpAppAiGguiSessionMeta,
 *   type McpAppAiGguiStackItemMeta,
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
 * #109 — `McpAppAiGguiMountView` (and its `GguiBootstrapMeta` predecessor)
 * was deleted in R3. The wire is now decomposed into two slices on
 * `_meta`:
 *
 *   - `ai.ggui/session`    → {@link McpAppAiGguiSessionMeta}
 *   - `ai.ggui/stack-item` → {@link McpAppAiGguiStackItemMeta}
 *
 * Consumers parse with {@link parseMcpAppAiGguiMeta} and read the
 * slices directly off the {@link McpAppAiGguiMeta} pair
 * (e.g. `meta.session.sessionId`, `meta.stackItem?.propsJson`). There
 * is no longer a flat "mount view" aggregate — that was a workaround
 * that preserved the pre-decomposition mental model.
 */

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
//   - {@link parseMcpAppAiGguiMeta}(_meta) → {ok, meta: {session?, stackItem?}}
//     parses the wire into a typed pair. No required-fields gate at
//     the parser; missing slices come through as undefined. The
//     "is session required" gate lives in the consumer (iframe-runtime
//     mounts iff session is present; future per-session cache will let
//     render-only deltas without a session slice mount via cached state).
//   - {@link toMcpAppEnvelope}(meta) → `_meta` envelope. Emitter
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
/**
 * Single entry in the {@link McpAppAiGguiSessionMeta.gadgets} catalog.
 * One per registered gadget package — the iframe-runtime
 * dynamic-imports each at boot and stores the loaded namespace under
 * `globalThis.__ggui__.gadgets[package]`.
 *
 * @public
 */
export interface McpAppGadgetRef {
  /** Bare npm package name (e.g. `@my-org/leaflet`). REQUIRED — it
   * is the registry key the iframe-runtime stores the loaded module
   * namespace under at `globalThis.__ggui__.gadgets[package]`, and
   * the bare-specifier load source when `bundleUrl` is absent. */
  readonly package: string;
  /** ggui-hosted ESM bundle URL — preferred load source when present
   * (same-origin posture, CSP-friendly). The iframe `await import(this)`;
   * absent → the iframe imports the bare `package` specifier. */
  readonly bundleUrl?: string;
  /** SHA-384 SRI hash of the bundle (`sha384-<base64>`).
   * When present alongside `bundleUrl`, iframe-runtime routes the
   * load through a `<link rel="modulepreload" integrity>` gate so
   * the browser refuses execution on hash mismatch. */
  readonly bundleSri?: string;
}

/**
 * Single entry in {@link McpAppAiGguiStackItemMeta.contextSlots}.
 * One per `contextSpec` slot — the iframe-runtime synthesizes one
 * `React.createContext(default)` per entry at boot.
 *
 * @public
 */
export interface McpAppContextSlot {
  /** Slot key — camelCase JS identifier from `contextSpec`. */
  readonly name: string;
  /** PascalCase Context name auto-derived from `name`. Used as the
   * registry key in `globalThis.__ggui__.contexts`. */
  readonly contextName: string;
  /** JsonSchema for the slot value — used by the runtime observer to
   * validate Provider values before posting `ui/update-model-context`. */
  readonly schema: JsonSchema;
  /** Initial Provider value. Always populated by the server. */
  readonly default: JsonValue;
  /** Per-slot debounce override in milliseconds. Omitted → runtime
   * applies `DEFAULT_CONTEXT_DEBOUNCE_MS` (300). `0` = immediate. */
  readonly debounceMs?: number;
}

export interface McpAppAiGguiSessionMeta {
  // Identity
  readonly sessionId: string;
  readonly appId: string;
  readonly runtimeUrl: string;

  // Live-channel auth (paired) — `wsToken` is the opaque WS auth
  // credential the iframe threads on the WebSocket upgrade as
  // `?wsToken=<encoded>` and inside `SubscribePayload.wsToken`.
  readonly wsUrl?: string;
  readonly wsToken?: string;
  readonly expiresAt?: string;

  // Polling-fallback URL when WS blocked at the host CSP layer.
  // R7: points to `/api/sessions/<sessionId>/events?wsToken=<token>`
  // (cursor-replay endpoint). The iframe-runtime composes per-tick
  // `&sinceSequence=<cursor>&limit=<N>` against this base. Companion
  // to `session.lastSequence` which seeds the initial cursor.
  readonly pollingUrl?: string;

  // Theme (resolved at mount; rarely changes mid-session)
  readonly themeId?: string;
  readonly themeMode?: 'light' | 'dark';

  // Capability accumulators (union across all stack items in the session)
  readonly gadgets?: ReadonlyArray<McpAppGadgetRef>;
  readonly publicEnv?: Readonly<Record<string, string>>;
  readonly streamWebSocketLocalTools?: readonly string[];
  readonly appCallableTools?: readonly string[];
  readonly permissionsPolicy?: readonly string[];

  /**
   * Monotonic sequence number of the most-recent SessionEvent applied
   * to this session. Stamped on every emission (push, update,
   * `GET /api/sessions/:id/state` read, MCP `resources/read` of
   * `ui://ggui/session/<id>`). Consumers use it to initialize polling
   * cursors aligned with the SessionEvent ledger — see the R7
   * `/api/sessions/:id/events?sinceSequence=N` endpoint that reads
   * from a cursor.
   *
   * Absent on legacy sessions or in pre-ledger code paths (back-compat
   * during R6 rollout). Post-R7 it MUST be present.
   */
  readonly lastSequence?: number;
}

/**
 * Stack-item slice — what's being rendered RIGHT NOW. Activated per
 * push; combines what were formerly three separate slices (render +
 * contract + component) because they all describe a single stack item
 * and always activate together.
 *
 * Mode discriminator (cross-cutting validation in
 * consumer-side mount check): at least one of
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
  readonly contextSlots?: ReadonlyArray<McpAppContextSlot>;

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
 * Parsed ai.ggui meta — the structured pair {@link parseMcpAppAiGguiMeta}
 * returns. Both keys are optional; an absent slice means "the host
 * cache (or earlier mount) already has it." First-mount pushes
 * typically carry both; render-only deltas carry just `stackItem`.
 *
 * "Meta" reads as "the ai.ggui parts of the host's `_meta` wire field"
 * — the typed pair you get after partitioning `_meta` by the two
 * canonical keys ({@link MCP_APP_AI_GGUI_SESSION_META_KEY} +
 * {@link MCP_APP_AI_GGUI_STACK_ITEM_META_KEY}).
 *
 * @public
 */
export interface McpAppAiGguiMeta {
  readonly session?: McpAppAiGguiSessionMeta;
  readonly stackItem?: McpAppAiGguiStackItemMeta;
}

/**
 * Discriminated result of {@link parseMcpAppAiGguiMeta}. The combiner
 * does structural slice-shape validation only — `MALFORMED_*` reasons
 * surface structurally-invalid slice contents (wrong type, paired
 * fields half-present). Missing slices are NOT failures here; the
 * "is session present" gate lives in consumer-side mount check.
 *
 * @public
 */
export type CombineMcpAppAiGguiMetaResult =
  | { readonly ok: true; readonly meta: McpAppAiGguiMeta }
  | { readonly ok: false; readonly reason: 'MALFORMED_SESSION' | 'MALFORMED_STACK_ITEM' };

/**
 * Read the two per-window `_meta` keys off a parsed JSON-RPC `_meta`
 * object and partition them into a {@link McpAppAiGguiMeta} struct.
 *
 * The combiner does STRUCTURAL slice-shape validation only. Missing
 * slices come through as `undefined` (not failures) — first-mount
 * pushes typically carry both `session` + `stackItem`; render-only
 * delta pushes carry just `stackItem`; auth-only refresh pushes carry
 * just `session`. The "is the session required for THIS consumer"
 * gate lives in consumer-side mount check.
 *
 * Field-level optional-field defensive parsing (e.g. context-slot
 * schema narrowing, expiresAt date parse) lives downstream in the
 * iframe-runtime's `validateMeta`.
 *
 * @public
 */
export function parseMcpAppAiGguiMeta(meta: unknown): CombineMcpAppAiGguiMetaResult {
  if (meta === null || typeof meta !== 'object') {
    return { ok: true, meta: {} };
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
    // Auth pairing — both wsUrl + wsToken present or both absent.
    const aw = s.wsUrl;
    const at = s.wsToken;
    const ae = s.expiresAt;
    const hasW = typeof aw === 'string' && aw.length > 0;
    const hasT = typeof at === 'string' && at.length > 0;
    if (hasW !== hasT) return { ok: false, reason: 'MALFORMED_SESSION' };
    if (ae !== undefined && typeof ae !== 'string') {
      return { ok: false, reason: 'MALFORMED_SESSION' };
    }
    // `lastSequence` MUST be a non-negative finite integer when present
    // — it's a monotonic ledger cursor. NaN / negative / float / string
    // are protocol violations.
    const ls = s.lastSequence;
    if (
      ls !== undefined &&
      (typeof ls !== 'number' || !Number.isInteger(ls) || ls < 0)
    ) {
      return { ok: false, reason: 'MALFORMED_SESSION' };
    }
    session = {
      sessionId: s.sessionId,
      appId: s.appId,
      runtimeUrl: s.runtimeUrl,
      ...(hasW && hasT ? { wsUrl: aw as string, wsToken: at as string } : {}),
      ...(ae !== undefined ? { expiresAt: ae as string } : {}),
      ...(s.pollingUrl !== undefined ? { pollingUrl: s.pollingUrl as string } : {}),
      ...(s.themeId !== undefined ? { themeId: s.themeId as string } : {}),
      ...(s.themeMode !== undefined
        ? { themeMode: s.themeMode as 'light' | 'dark' }
        : {}),
      ...(s.gadgets !== undefined
        ? { gadgets: s.gadgets as ReadonlyArray<McpAppGadgetRef> }
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
      ...(ls !== undefined ? { lastSequence: ls as number } : {}),
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
              si.contextSlots as ReadonlyArray<McpAppContextSlot>,
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
    meta: {
      ...(session !== undefined ? { session } : {}),
      ...(stackItem !== undefined ? { stackItem } : {}),
    },
  };
}



/**
 * Emitter convenience — wrap a server-built {@link McpAppAiGguiMeta}
 * struct as the wire `_meta` envelope under the canonical key
 * constants. Drops empty slices.
 *
 * @public
 */
export function toMcpAppEnvelope(
  meta: McpAppAiGguiMeta,
): Record<string, unknown> {
  return {
    ...(meta.session
      ? { [MCP_APP_AI_GGUI_SESSION_META_KEY]: meta.session }
      : {}),
    ...(meta.stackItem
      ? { [MCP_APP_AI_GGUI_STACK_ITEM_META_KEY]: meta.stackItem }
      : {}),
  };
}


// =============================================================================
// Request-side `_meta` — host-supplied metadata on inbound `tools/call`.
//
// Set BY the MCP host (claude.ai, ChatGPT, sample-agent), READ BY the ggui
// server when the agent inside the host invokes a `ggui_*` tool. Distinct
// from the outbound session/stack-item slices above (server → host on tool
// results) — different direction, different parser, different lifecycle.
// =============================================================================

/**
 * `_meta` key carrying host-supplied session-grouping metadata on every
 * inbound `tools/call` request. Captured ONCE on the first call that
 * materializes a ggui session row (today: `ggui_new_session`) and
 * persisted on the session as opt-in identity for later rehydration.
 *
 * Hosts that don't set this key produce one-shot sessions — they work
 * fine for a single chat turn but cannot be re-listed or restored
 * after the host closes the conversation surface. Opt-in is the whole
 * design: hosts that want resume thread their conversation id here;
 * hosts that don't get the simple write-only path.
 *
 * @public
 */
export const MCP_APP_AI_GGUI_HOST_SESSION_META_KEY = 'ai.ggui/host-session' as const;

/**
 * Host-supplied session-grouping slice. Sent on the request `_meta` of
 * the first `ggui_*` tool call that creates a ggui session (today:
 * `ggui_new_session`; subsequent calls naming the same session ignore
 * the field — set-at-creation, immutable).
 *
 * Opaque grouping key, NOT a credential. Auth still comes from the
 * caller's identity (API key, OAuth bearer, cookie). `hostSessionId`
 * scopes which sessions the authenticated caller can rehydrate; it
 * does NOT itself authorize access.
 *
 * Both fields are required when the slice is present. A slice with a
 * missing/empty field is treated as absent (degrades to one-shot).
 *
 * @public
 */
export interface McpAppAiGguiHostSessionMeta {
  /**
   * Stable host identifier — e.g. `'sample'`, `'claude.ai'`, `'chatgpt'`.
   * Used to partition `hostSessionId` namespace so the same chat-id
   * across two different hosts cannot alias.
   */
  readonly hostName: string;
  /**
   * Host's grouping key for "this conversation" — opaque to ggui.
   * Typically: claude.ai thread id, ChatGPT chat id, sample-agent
   * chatSessionId. The server treats it as an opaque string.
   */
  readonly hostSessionId: string;
}

/**
 * Discriminated result of {@link parseMcpAppAiGguiHostSessionMeta}.
 *
 * Three outcomes:
 *   - `ok: true, hostSession: <slice>` — slice present + well-formed.
 *   - `ok: true, hostSession: undefined` — slice absent (host opted out
 *     of rehydration). Caller proceeds without it; the session it
 *     creates is one-shot.
 *   - `ok: false` — slice present but structurally invalid. Caller's
 *     choice whether to reject the request or proceed as "absent".
 *     The handler MAY log + proceed; this is host implementor error,
 *     not a security boundary.
 *
 * @public
 */
export type ParseMcpAppAiGguiHostSessionMetaResult =
  | { readonly ok: true; readonly hostSession?: McpAppAiGguiHostSessionMeta }
  | { readonly ok: false; readonly reason: 'MALFORMED_HOST_SESSION' };

/**
 * Read the `ai.ggui/host-session` slice off a parsed inbound `_meta`
 * object. Structural validation only — `hostName` + `hostSessionId`
 * both required and non-empty. Both missing entirely returns
 * `{ok: true, hostSession: undefined}` (the documented opt-out path).
 *
 * @public
 */
export function parseMcpAppAiGguiHostSessionMeta(
  meta: unknown,
): ParseMcpAppAiGguiHostSessionMetaResult {
  if (meta === null || typeof meta !== 'object') {
    return { ok: true };
  }
  const m = meta as Record<string, unknown>;
  const raw = m[MCP_APP_AI_GGUI_HOST_SESSION_META_KEY];
  if (raw === undefined) {
    return { ok: true };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'MALFORMED_HOST_SESSION' };
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.hostName !== 'string' ||
    r.hostName.length === 0 ||
    typeof r.hostSessionId !== 'string' ||
    r.hostSessionId.length === 0
  ) {
    return { ok: false, reason: 'MALFORMED_HOST_SESSION' };
  }
  return {
    ok: true,
    hostSession: {
      hostName: r.hostName,
      hostSessionId: r.hostSessionId,
    },
  };
}

/**
 * Wire shape of one row in `ggui_list_sessions` output. Mirrors the
 * handler's Zod-described `sessions[*]`. Surfaced at the protocol
 * level so non-handler consumers (sample-agent's `/chat/restore`
 * server, future host SDK helpers) can import a single typed shape
 * instead of redeclaring it — preventing drift if the handler ever
 * grows fields.
 *
 * `wsToken` + `wsTokenExpiresAt` are populated when the deployment
 * wired a `mintWsToken` seam on the handler — otherwise the lean
 * summary path returns them absent.
 *
 * @public
 */
export interface SessionSummaryWire {
  readonly sessionId: string;
  readonly hostName?: string;
  readonly hostSessionId?: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly status: string;
  readonly stackItemCount: number;
  readonly wsToken?: string;
  readonly wsTokenExpiresAt?: string;
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
// key. Use {@link parseMcpAppAiGguiMeta} for structural validation
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
