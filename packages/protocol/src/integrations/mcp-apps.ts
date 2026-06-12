/**
 * MCP Apps integration — outbound delivery types for ggui.
 *
 * This module is the **boundary** for MCP Apps outbound delivery. Anything
 * MCP-Apps-specific that ggui exposes to the rest of the codebase lives
 * here — never in `types/live-channel.ts`, `types/mcp.ts`, `types/render.ts`,
 * or any other core module. Consumers opt in via the subpath import:
 *
 * ```ts
 * import {
 *   MCP_APPS_UI_CAPABILITY,
 *   GGUI_RENDER_RESOURCE_URI,
 *   parseMcpAppAiGguiRenderMeta,
 *   type McpAppAiGguiRenderMeta,
 * } from '@ggui-ai/protocol/integrations/mcp-apps';
 * ```
 *
 * The root `@ggui-ai/protocol` barrel does NOT re-export this module.
 * That's the isolation rule: core protocol consumers that don't integrate
 * with MCP Apps pay none of its weight, and the blast radius of any spec
 * drift is bounded to callers that explicitly import from here.
 *
 * Core still carries two fields that make the bootstrap flow work —
 * `SubscribePayload.wsToken?: string` and `AckPayload.sessionToken?:
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
import { appThemeSchema, type AppTheme } from '../schemas/app-theme.js';
import { isRecord } from '../validation/is-record.js';

/**
 * MCP capability name ggui servers advertise in their MCP `initialize`
 * response capabilities when they implement the MCP Apps outbound path.
 * Spec-canonical; MUST match the string the MCP Apps protocol publishes.
 */
export const MCP_APPS_UI_CAPABILITY = 'io.modelcontextprotocol/ui' as const;

/**
 * The single MCP Apps resource URI ggui exposes for outbound delivery.
 * `ggui_render` is the sole tool declaration that carries this in its
 * `_meta.ui.resourceUri`. No other ggui tool gets a resource URI —
 * `ggui_render` is the single outbound entry point.
 */
export const GGUI_RENDER_RESOURCE_URI = 'ui://ggui/render' as const;

/**
 * MIME type for the `ui://ggui/render` resource. Per MCP Apps spec, UI
 * resources carry the `text/html` base type with a `profile=mcp-app`
 * parameter so hosts that don't support MCP Apps don't accidentally
 * render them as plain HTML.
 */
export const GGUI_RENDER_RESOURCE_MIME = 'text/html;profile=mcp-app' as const;

/**
 * The single `_meta.ui.resourceUri` value ggui uses across every MCP Apps
 * host surface. Exposed as a named constant so tool-declaration code,
 * resource-serving code, and tests all agree on one spelling.
 */
export const GGUI_RENDER_UI_META = {
  /** Resource URI hosts fetch via `resources/read` on a `ggui_render` tool call. */
  resourceUri: GGUI_RENDER_RESOURCE_URI,
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
 * Phase B render-identity collapse — the previously two-slice wire
 * (`ai.ggui/session` + `ai.ggui/stack-item`) is merged into ONE slice
 * (`ai.ggui/render`). Consumers parse with {@link parseMcpAppAiGguiRenderMeta}
 * and read fields directly off the {@link McpAppAiGguiRenderMeta} struct.
 *
 * Why the merge: every "session" wrapped exactly one stack item post-
 * Phase-A, so the two slices were always activated in lock-step. The
 * pair-holder added ceremony with no signal. Flat is the honest shape.
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
// Single `_meta` key carrying everything a render needs — identity, boot
// wiring, live-channel auth, capability advertisements, render state,
// contract pointer, and component-mode discriminator.
//
// Phase B replaced the pair (`ai.ggui/session` + `ai.ggui/stack-item`)
// with this single key. The pair existed because pre-Phase-A multiple
// stack items could share session-scoped state; post-Phase-A every
// render is its own thing, so the two slices were always emitted
// together.
//
// Wire shape:
//
// ```jsonc
// "_meta": {
//   "ai.ggui/render": {
//     sessionId, appId, runtimeUrl,
//     wsUrl?, wsToken?, expiresAt?,
//     pollingUrl?,
//     themeId?, themeMode?, theme?,
//     gadgets?, publicEnv?, streamWebSocketLocalTools?,
//     permissionsPolicy?,
//     lastSequence?,
//     propsJson?, contextSlots?,
//     contractHash?, validatorsUrl?,
//     codeUrl?, codeHash?, kind?
//   }
// }
// ```
//
// Hosts that don't recognize the key MUST treat it as opaque and forward
// verbatim — same posture as the spec-defined `_meta` extension surface.
//
// Consumers:
//   - {@link parseMcpAppAiGguiRenderMeta}(_meta) → {ok, meta?: <slice>}
//     structural validation only. Missing key returns {ok:true, meta: undefined}.
//   - {@link toMcpAppEnvelope}(slice) → `_meta` envelope. Emitter helper
//     that builds the wire shape from a server-built slice.
// =============================================================================

/**
 * `_meta` key carrying the full render slice. Single source of truth
 * post-Phase-B: identity, boot wiring, live-channel auth, capability
 * advertisements, current render state, contract pointer, and component-
 * mode discriminator.
 *
 * @public
 */
export const MCP_APP_AI_GGUI_RENDER_META_KEY = 'ai.ggui/render' as const;

/**
 * Single entry in the {@link McpAppAiGguiRenderMeta.gadgets} catalog.
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
 * Single entry in {@link McpAppAiGguiRenderMeta.contextSlots}.
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

/**
 * The full render slice — flat post-Phase-B. Identity + boot wiring +
 * live-channel auth + capability advertisements + render state +
 * contract pointer + component-mode discriminator.
 *
 * **Identity.** `sessionId` is the value an iframe's bootstrap meta and
 * every wire reference (props_update, consume, update) keys by. The
 * value is the same one stack items carried as `stackItemId` pre-Phase-B;
 * the rename reflects the conceptual collapse (no enclosing vessel).
 *
 * **Live-channel auth.** `wsUrl` + `wsToken` are paired — both present
 * or both absent; `expiresAt` is informational. `wsToken` is the opaque
 * WS auth credential the iframe threads on the WebSocket upgrade as
 * `?wsToken=<encoded>` and inside `SubscribePayload.wsToken`.
 *
 * **Polling-fallback URL.** When WS is blocked at the host CSP layer
 * the iframe polls `pollingUrl` (server-stamped post-Phase-B as
 * `/api/sessions/<sessionId>/events?wsToken=<token>`). The iframe-runtime
 * composes per-tick `&sinceSequence=<cursor>&limit=<N>` against this
 * base; companion to `lastSequence` which seeds the initial cursor.
 *
 * **Mode discriminator.** At least one of `{ codeUrl, kind, wsUrl-with-token }`
 * MUST be present for the iframe to mount. `kind` and `codeUrl` are
 * mutually exclusive (kind = system-card mode; codeUrl = static-component
 * mode; live-channel = absent both).
 *
 * @public
 */
export interface McpAppAiGguiRenderMeta {
  // Identity (was sessionId on the session slice; now sessionId; value =
  // old stackItemId).
  readonly sessionId: string;
  readonly appId: string;
  readonly runtimeUrl: string;

  // Live-channel auth (paired)
  readonly wsUrl?: string;
  readonly wsToken?: string;
  readonly expiresAt?: string;

  // Polling fallback (server-stamped URL post-rename:
  // `/api/sessions/<sessionId>/events`)
  readonly pollingUrl?: string;

  // Theme
  readonly themeId?: string;
  readonly themeMode?: 'light' | 'dark';
  /**
   * Resolved per-app theme overlay — mode + the `--ggui-*` CSS-variable
   * map snapshotted from `App.theme` and projected by `deriveRenderMeta`.
   * Distinct from `themeId` (a registry preset reference) and `themeMode`
   * (the bare light/dark discriminator): this carries the concrete
   * variable values the iframe applies as a `:root` declaration block.
   * Absent ⇒ no per-app overlay; the renderer applies its default theme.
   */
  readonly theme?: AppTheme;

  // Capability accumulators
  readonly gadgets?: ReadonlyArray<McpAppGadgetRef>;
  readonly publicEnv?: Readonly<Record<string, string>>;
  readonly streamWebSocketLocalTools?: readonly string[];
  readonly permissionsPolicy?: readonly string[];

  /**
   * Monotonic sequence number of the most-recent event applied to
   * this render's event ledger. Stamped on every emission (render,
   * update, `GET /api/sessions/:id/state` read, MCP `resources/read`
   * of `ui://ggui/render/<id>`). Consumers use it to initialize
   * polling cursors aligned with the event ledger — see the
   * `/api/sessions/:id/events?sinceSequence=N` endpoint that reads
   * from a cursor.
   */
  readonly lastSequence?: number;

  // GguiSession state — what the iframe re-renders on update
  readonly propsJson?: string;
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
 * Discriminated result of {@link parseMcpAppAiGguiRenderMeta}. The parser
 * does structural slice-shape validation only — `MALFORMED_RENDER`
 * surfaces a structurally-invalid slice (wrong type, missing required
 * identity, paired fields half-present, mutually-exclusive fields both
 * present). Missing key entirely is NOT a failure; the "is the slice
 * required for THIS consumer" gate lives in consumer-side mount check.
 *
 * @public
 */
export type ParseMcpAppAiGguiRenderMetaResult =
  | { readonly ok: true; readonly meta?: McpAppAiGguiRenderMeta }
  | { readonly ok: false; readonly reason: 'MALFORMED_RENDER' };

/**
 * Read the `ai.ggui/render` slice off a parsed JSON-RPC `_meta` object.
 *
 * Structural validation only. Missing key returns `{ok: true, meta: undefined}`
 * — not a failure. Required-fields gate (sessionId / appId / runtimeUrl)
 * fires only when the key is present. Field-level optional-field
 * defensive parsing (e.g. context-slot schema narrowing, expiresAt date
 * parse) lives downstream in the iframe-runtime's `validateMeta`.
 *
 * @public
 */
export function parseMcpAppAiGguiRenderMeta(
  meta: unknown,
): ParseMcpAppAiGguiRenderMetaResult {
  if (!isRecord(meta)) {
    return { ok: true };
  }
  const raw = meta[MCP_APP_AI_GGUI_RENDER_META_KEY];
  if (raw === undefined) {
    return { ok: true };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }
  const s = raw;

  // Identity — required when slice is present.
  if (
    typeof s.sessionId !== 'string' ||
    s.sessionId.length === 0 ||
    typeof s.appId !== 'string' ||
    s.appId.length === 0 ||
    typeof s.runtimeUrl !== 'string' ||
    s.runtimeUrl.length === 0
  ) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }

  // Auth pairing — both wsUrl + wsToken present or both absent.
  const aw = s.wsUrl;
  const at = s.wsToken;
  const ae = s.expiresAt;
  const hasW = typeof aw === 'string' && aw.length > 0;
  const hasT = typeof at === 'string' && at.length > 0;
  if (hasW !== hasT) return { ok: false, reason: 'MALFORMED_RENDER' };
  if (ae !== undefined && typeof ae !== 'string') {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }

  // `lastSequence` MUST be a non-negative finite integer when present
  // — it's a monotonic ledger cursor. NaN / negative / float / string
  // are protocol violations.
  const ls = s.lastSequence;
  if (
    ls !== undefined &&
    (typeof ls !== 'number' || !Number.isInteger(ls) || ls < 0)
  ) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }

  // Component-mode discriminator: codeUrl + kind mutually exclusive.
  const cu = s.codeUrl;
  const ck = s.kind;
  const ch = s.codeHash;
  if (cu !== undefined && (typeof cu !== 'string' || cu.length === 0)) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }
  if (ck !== undefined && (typeof ck !== 'string' || ck.length === 0)) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }
  if (ch !== undefined && (typeof ch !== 'string' || ch.length === 0)) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }
  if (typeof cu === 'string' && cu.length > 0 && typeof ck === 'string' && ck.length > 0) {
    return { ok: false, reason: 'MALFORMED_RENDER' };
  }

  // Contract pair — both present or both absent (or both effectively
  // absent via empty/wrong type → drop both, degrade to no validators).
  const cHash = s.contractHash;
  const vUrl = s.validatorsUrl;
  const validContractPair =
    typeof cHash === 'string' &&
    cHash.length > 0 &&
    typeof vUrl === 'string' &&
    vUrl.length > 0;

  // Theme overlay — validated via the complete `appThemeSchema` so the
  // parsed value is typed `AppTheme` without an unguarded cast. A
  // malformed/absent overlay yields `undefined` and is dropped from the
  // slice (tolerant degrade, consistent with the other optional fields).
  const themeParse =
    s.theme !== undefined ? appThemeSchema.safeParse(s.theme) : undefined;
  const parsedTheme: AppTheme | undefined =
    themeParse?.success === true ? themeParse.data : undefined;

  const slice: McpAppAiGguiRenderMeta = {
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
    // `theme` is the only structured optional field on the slice, so
    // it gets the schema as its parser (the rest are scalar/array
    // casts). `appThemeSchema` is the complete validator — a malformed
    // overlay degrades to "no overlay" rather than failing the whole
    // slice, matching the tolerant posture of the other optional fields.
    ...(parsedTheme !== undefined ? { theme: parsedTheme } : {}),
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
    ...(s.permissionsPolicy !== undefined
      ? { permissionsPolicy: s.permissionsPolicy as readonly string[] }
      : {}),
    ...(ls !== undefined ? { lastSequence: ls as number } : {}),
    ...(s.propsJson !== undefined ? { propsJson: s.propsJson as string } : {}),
    ...(s.contextSlots !== undefined
      ? {
          contextSlots:
            s.contextSlots as ReadonlyArray<McpAppContextSlot>,
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

  return { ok: true, meta: slice };
}

/**
 * Emitter convenience — wrap a server-built {@link McpAppAiGguiRenderMeta}
 * slice as the wire `_meta` envelope under the canonical key constant.
 *
 * @public
 */
export function toMcpAppEnvelope(
  render: McpAppAiGguiRenderMeta,
): Record<string, unknown> {
  return {
    [MCP_APP_AI_GGUI_RENDER_META_KEY]: render,
  };
}


// =============================================================================
// Request-side `_meta` — host-supplied metadata on inbound `tools/call`.
//
// Set BY the MCP host (claude.ai, ChatGPT, sample-agent), READ BY the ggui
// server when the agent inside the host invokes a `ggui_*` tool. Distinct
// from the outbound render slice above (server → host on tool results) —
// different direction, different parser, different lifecycle.
// =============================================================================

/**
 * `_meta` key carrying host-supplied conversation-grouping metadata on
 * every inbound `tools/call` request. Captured ONCE on the first call
 * that materializes a ggui render row and persisted as opt-in identity
 * for later rehydration.
 *
 * Hosts that don't set this key produce one-shot renders — they work
 * fine for a single chat turn but cannot be re-listed or restored after
 * the host closes the conversation surface. Opt-in is the whole design:
 * hosts that want resume thread their conversation id here; hosts that
 * don't get the simple write-only path.
 *
 * @public
 */
export const MCP_APP_AI_GGUI_HOST_SESSION_META_KEY = 'ai.ggui/host-session' as const;

/**
 * Host-supplied conversation-grouping slice. Sent on the request `_meta`
 * of the first `ggui_*` tool call that creates a ggui render; subsequent
 * calls naming the same render ignore the field — set-at-creation,
 * immutable.
 *
 * Opaque grouping key, NOT a credential. Auth still comes from the
 * caller's identity (API key, OAuth bearer, cookie). `hostSessionId`
 * scopes which renders the authenticated caller can rehydrate; it
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
 *     of rehydration). Caller proceeds without it; the render it
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
  if (!isRecord(meta)) {
    return { ok: true };
  }
  const raw = meta[MCP_APP_AI_GGUI_HOST_SESSION_META_KEY];
  if (raw === undefined) {
    return { ok: true };
  }
  if (!isRecord(raw)) {
    return { ok: false, reason: 'MALFORMED_HOST_SESSION' };
  }
  const r = raw;
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
 * handler's Zod-described `sessions[*]`. Surfaced at the protocol level
 * so non-handler consumers (sample-agent's `/chat/restore` server, future
 * host SDK helpers) can import a single typed shape instead of
 * redeclaring it — preventing drift if the handler ever grows fields.
 *
 * `wsToken` + `wsTokenExpiresAt` are populated when the deployment
 * wired a `mintWsToken` seam on the handler — otherwise the lean
 * summary path returns them absent.
 *
 * Post-Phase-B: `stackItemId` → `sessionId`; the old `stackItemCount` is
 * dropped (every render is exactly one item — Phase B collapsed the
 * vessel).
 *
 * @public
 */
export interface GguiSessionSummaryWire {
  readonly sessionId: string;
  readonly hostName?: string;
  readonly hostSessionId?: string;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly status: string;
  readonly wsToken?: string;
  readonly wsTokenExpiresAt?: string;
}

// =============================================================================
// Inbound — third-party MCP Apps hosted inside a ggui render.
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
 * Persists STABLE identity (not a raw URL) so render state survives
 * source-server endpoint changes. The hosting runtime resolves
 * `connectorId` to the actual endpoint at render time.
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
 * GguiSession variant: an embedded third-party MCP App iframe.
 *
 * **Locator-oriented, not content-oriented.** Persisted state carries
 * `source` (connector identity) + declared CSP/permissions/dimensions
 * metadata; resource BYTES are not stored in render state by default.
 * The `@ggui-ai/mcp-server` resource-proxy route fetches the bytes
 * on-demand via `resources/read` against the source server.
 *
 * **Union safety.** Fields that exist on the {@link ComponentGguiSession}
 * variant are declared here as `?: never` so consumers that access them
 * via optional chaining on `GguiSession` still typecheck cleanly. Those
 * fields semantically DO NOT exist on McpAppsGguiSession — the `?: never`
 * typing encodes the "structurally absent" guarantee.
 */
export interface McpAppsGguiSession {
  /** Discriminator — required on this variant. */
  readonly type: 'mcpApps';

  // Shared base.
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
   * render time. The resource-proxy route verifies the re-fetched
   * content against this hash; a mismatch breaks the render LOUDLY
   * rather than silently serving mutated content.
   */
  readonly resourceHash?: string;

  /**
   * Bounded dev/cache optimization. When present, the proxy route MAY
   * serve this inline instead of re-fetching via `resources/read`. NOT
   * the canonical carrier — metadata persists, bytes don't. Use only
   * for dev harnesses / offline replay.
   */
  readonly resourceContent?: string;

  // ComponentGguiSession-specific fields — ALWAYS absent on this variant.
  // Typed as `?: never` so `GguiSession` readers that optional-chain these
  // fields (`item.componentCode?.trim()`) still typecheck. If you find
  // yourself wanting to populate one of these, reconsider the design —
  // they belong to the OTHER variant.
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
 * Type guard: narrows a `GguiSession` (or unknown) to {@link McpAppsGguiSession}.
 * Uses the discriminator.
 */
export function isMcpAppsGguiSession(entry: unknown): entry is McpAppsGguiSession {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    (entry as { type?: unknown }).type === 'mcpApps'
  );
}

/**
 * Structural validator for an `McpAppsGguiSession` — not a Zod schema
 * so we don't force a Zod dependency here. Returns null on failure
 * (caller maps to an appropriate error code). Required when accepting
 * one over the wire from an agent: the discriminator alone isn't
 * enough.
 */
export function validateMcpAppsGguiSession(
  input: unknown,
): McpAppsGguiSession | null {
  return hasMcpAppsGguiSessionShape(input) ? input : null;
}

/** Structural predicate behind {@link validateMcpAppsGguiSession}. */
function hasMcpAppsGguiSessionShape(
  input: unknown,
): input is McpAppsGguiSession {
  if (!isRecord(input)) return false;
  if (input.type !== 'mcpApps') return false;
  if (typeof input.id !== 'string' || input.id.length === 0) return false;
  if (typeof input.createdAt !== 'string') return false;
  const source = input.source;
  if (!isRecord(source)) return false;
  if (typeof source.connectorId !== 'string' || source.connectorId.length === 0) return false;
  if (typeof source.toolName !== 'string' || source.toolName.length === 0) return false;
  if (typeof source.resourceUri !== 'string' || !source.resourceUri.startsWith('ui://')) return false;
  return true;
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
 *   tree mounted, WS connected, first render ack folded. Equivalent of
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
 *   - `sessionId` — optional. When present, the lifecycle pertains to a
 *     specific render (per-card iframes via single-item mode).
 *     Absent → whole-renderer lifecycle.
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
  readonly sessionId?: string;
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
 *   - If `sessionId` is present, it is a non-empty string.
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
    sessionId?: unknown;
    error?: unknown;
  };
  if (typeof e.state !== 'string') return false;
  if (!MCP_APP_LIFECYCLE_STATES.includes(e.state as McpAppLifecycleState)) {
    return false;
  }
  if (e.sessionId !== undefined) {
    if (typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
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

// =============================================================================
// Renderer → host postMessage envelope vocabulary
//
// The renderer (inside the MCP Apps iframe) speaks to its parent via a
// small closed family of `{type: 'ggui:…'}` postMessage envelopes. The
// DISCRIMINATOR vocabulary is protocol-owned and lives HERE, in one
// place — hosts on every platform (web iframe hosts, React Native
// WebView hosts) and the renderer itself import these constants rather
// than re-encoding the strings, so a tag rename is a single-point
// change and recognizer drift (a host classifying a tag no renderer
// emits) is structurally impossible.
//
// Payload OWNERSHIP follows the vocabulary's semantics:
//   - `ggui:lifecycle` — protocol-owned end to end (see
//     {@link McpAppLifecycleMessage} above): the payload is a wire
//     contract with host obligations.
//   - `ggui:renderer-ready` / `ggui:bootstrap-failed` — envelope shape
//     is protocol-owned ({@link McpAppRendererReadyMessage} /
//     {@link McpAppBootstrapFailedMessage}); the renderer narrows
//     `reason` to its own closed reason union at the emission site.
//   - `ggui:observe` — only the TAG is protocol-owned. The event union
//     it carries is renderer-internal telemetry vocabulary
//     (`ObservabilityEvent` in the renderer package); hosts treat it
//     as extensibly-closed.
// =============================================================================

/** Envelope tag: renderer alive + bundle evaluated (pre-`ui/initialize`). */
export const MCP_APP_RENDERER_READY_TYPE = 'ggui:renderer-ready';

/** Envelope tag: a boot-path failure (parse / initialize / handshake). */
export const MCP_APP_BOOTSTRAP_FAILED_TYPE = 'ggui:bootstrap-failed';

/** Envelope tag: renderer-internal observability event (telemetry). */
export const MCP_APP_OBSERVE_TYPE = 'ggui:observe';

/**
 * Envelope tag: mount-lifecycle transition. Constant twin of the
 * literal on {@link McpAppLifecycleMessage} — the annotation ties the
 * two so they cannot drift.
 */
export const MCP_APP_LIFECYCLE_TYPE: McpAppLifecycleMessage['type'] =
  'ggui:lifecycle';

/**
 * `ggui:renderer-ready` — posted by the renderer immediately after its
 * status DOM mounts, BEFORE `ui/initialize` fires. Optional
 * informational signal; hosts MAY surface a "renderer alive"
 * indicator. `version` is the renderer bundle's package version.
 */
export interface McpAppRendererReadyMessage {
  readonly type: typeof MCP_APP_RENDERER_READY_TYPE;
  readonly version: string;
}

/**
 * `ggui:bootstrap-failed` — posted by the renderer (or a pre-renderer
 * shell) on any boot-path failure. Hosts surface it on their error
 * callback. `reason` is extensibly-closed at the protocol layer
 * (emitters narrow it to their own closed reason unions, e.g. the
 * renderer's boot-failure reasons); hosts MUST tolerate reason codes
 * they don't recognise.
 */
export interface McpAppBootstrapFailedMessage {
  readonly type: typeof MCP_APP_BOOTSTRAP_FAILED_TYPE;
  readonly reason: string;
  readonly message: string;
}

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
 * diagnostic on the operator side (gap in the RenderInspector activity
 * row), not as a user-facing failure. This mirrors today's `dispatch`
 * audit-fire posture so semantics stay uniform.
 *
 * Failure-mode note: a malformed envelope (unknown `kind` AND malformed
 * `payload`) is rejected by the `ggui_runtime_submit_action` handler
 * with `{ok: false, code: 'INVALID_ACTION_KIND'}` in
 * `structuredContent` — the iframe observes the rejection through the
 * host's `tools/call` relay response.
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
 *     render-keyed pending-events pipe (`{type:'action', sessionId,
 *     intent, actionData, uiContext, actionId, firedAt}`) so the agent's
 *     `ggui_consume` long-poll unblocks in the same chat turn. The
 *     handler's response carries `consumerPresent` — whether a
 *     `ggui_consume` long-poll is currently listening on this render's
 *     pipe. When `consumerPresent === false` (no loop is listening —
 *     e.g. the agent's persistent consume loop ended after a page
 *     reload), the iframe-runtime ALSO emits a `ui/message` doorbell
 *     carrying `content[0]._meta["ai.ggui/userAction"]` (see
 *     {@link GguiUserActionMeta}) so a fresh agent turn calls
 *     `ggui_consume({sessionId})` to drain the just-enqueued gesture.
 *     The doorbell is a PURE POINTER — the gesture stays solely on the
 *     pipe, making the action exactly-once.
 *   - `kind ∈ {'openLink','requestDisplayMode'}`: pure audit — the
 *     user-visible host effect already fired iframe-side via
 *     `ui/open-link` / `ui/request-display-mode`. The server records
 *     the gesture for the RenderInspector feed.
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
  if (!isRecord(value)) return false;
  const v = value;
  if (typeof v.kind !== 'string' || v.kind.length === 0) return false;
  if (typeof v.sessionId !== 'string' || v.sessionId.length === 0) return false;
  if (typeof v.appId !== 'string' || v.appId.length === 0) return false;
  if (typeof v.actionId !== 'string' || v.actionId.length === 0) return false;
  if (typeof v.firedAt !== 'string' || v.firedAt.length === 0) return false;
  // Payload-object presence is the invariant: a JSON OBJECT, never an
  // array — array payloads reject even for unknown extension kinds.
  if (!isRecord(v.payload)) return false;
  // Per-kind payload narrowing for the closed primary set. Unknown
  // kinds pass through with whatever payload-object the caller supplied
  // — extension handlers own the validation.
  const p = v.payload;
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
 * `content[0]._meta["ai.ggui/userAction"]` — a PURE DOORBELL.
 *
 * Spec-canonical extension point: MCP Apps closes `params._meta` via
 * `additionalProperties: false`, but each content block has its own
 * open `_meta` record (per the base MCP spec). The `ai.ggui/*` key
 * prefix matches our other protocol extensions
 * (`ai.ggui/render`, `ai.ggui/bootstrap`, etc.).
 *
 * Stamped by the iframe-runtime on a `ui/message` envelope when a user
 * gesture needs to wake the agent because no `ggui_consume` long-poll is
 * currently listening (the agent's persistent consume loop has ended —
 * e.g. after a page reload). The gesture itself was ALREADY enqueued onto
 * the render's server-side pending-event pipe by the iframe's
 * `ggui_runtime_submit_action` call (relayed by the host) BEFORE this
 * notification fired; this slice's only job is to make a fresh agent turn
 * call `ggui_consume({sessionId})` to drain it.
 *
 * SINGLE SOURCE OF TRUTH: the pending-event queue. This slice carries ONLY
 * a pointer to the render whose queue holds the gesture — never the action
 * payload. The agent retrieves the action EXCLUSIVELY via `ggui_consume`.
 * Carrying the payload here would let the agent both act on it AND drain
 * the queue = a double-trigger; the pointer-only shape makes the action
 * exactly-once.
 *
 * `intent` is metadata (which `actionSpec[*]` entry fired) — NOT the
 * actionable data. The agent can't react meaningfully on `intent` alone
 * (it lacks the `actionData` payload), so its presence doesn't tempt a
 * pre-consume action.
 *
 * **The directive lives in the `ui/message` TEXT, not here.** The
 * iframe-runtime authors a `ui/message` whose human-readable text
 * carries the full "call `ggui_consume`" directive — that text is what
 * EVERY host (claude.ai, chatgpt.com, ggui-aware SDKs) forwards to the
 * model. This `_meta` slice is the OPTIONAL structured mirror for
 * ggui-aware programmatic consumers; an `_meta`-agnostic host ignores
 * it and acts on the text alone. No part of the loop depends on a
 * server-side parse of this slice.
 *
 * @public
 */
export interface GguiUserActionMeta {
  readonly kind: 'user-action';
  readonly description: string;
  readonly sessionId: string;
  readonly actionId: string;
  readonly submittedAt: string;
  readonly intent: string;
  readonly nextStep: {
    readonly tool: 'ggui_consume';
    readonly args: { readonly sessionId: string };
  };
}
