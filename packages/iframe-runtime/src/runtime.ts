/**
 * `@ggui-ai/iframe-runtime` iframe runtime entry.
 *
 * This is the file esbuild bundles into `dist/iframe-runtime.js`. The
 * thin-shell HTML loads it via `<script type="module" src=".../iframe-runtime.js">`;
 * on import the side-effects below take over: build a status DOM,
 * postMessage `ui/initialize` to the parent, parse the bootstrap, open
 * the WebSocket, run the version handshake, and mount the render
 * placeholder.
 *
 * Boot sequence:
 *   - Boot from the `_meta["ai.ggui/render"]` slice received via
 *     `ui/initialize`.
 *   - Open the WebSocket, run the subscribe handshake.
 *   - Mount the render — either a structural placeholder or, when
 *     the renderer hooks are wired, a React mount of `componentCode`.
 *
 * The runtime advertises its build version via a post-`ui/initialize`
 * notification (`ggui:renderer-ready`).
 *
 * Failure surfacing: every parse / handshake failure goes to two
 * places — (1) the in-iframe status line (operator-visible) and
 * (2) a parent-bound `postMessage({type:'ggui:bootstrap-failed', ...})`.
 * The post-message envelope is consumed by the `<McpAppIframe>` host
 * wrapper, which routes it to the host's `onError` callback.
 */
// FIRST import on purpose — declares zod jitless before any
// schema-defining dependency initializes (see zod-jitless.ts).
import './zod-jitless.js';

import type { ReactNode } from 'react';
import type {
  DrainAckPayload,
  JsonValue,
  JsonObject,
  GguiSession,
} from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import {
  MCP_APP_BOOTSTRAP_FAILED_TYPE,
  MCP_APP_RENDERER_READY_TYPE,
  parseMcpAppAiGguiRenderMeta,
  readGguiShellEnvelope,
  type McpAppAiGguiRenderMeta,
  type McpAppBootstrapFailedMessage,
  type McpAppRendererReadyMessage,
  type GguiUserActionMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { GguiSessionSeedInput } from './types.js';
import {
  extractLocatorFromToolResult,
  parseMetaFromGlobal,
  parseMetaFromToolResult,
  validateMeta,
} from './meta-parse.js';
import type {
  McpAppAiGguiMetaParseFailureReason,
  McpAppAiGguiMetaParseResult,
} from './types.js';
import { projectHostContext } from '@ggui-ai/protocol';
import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';
// Type-only contract on `@modelcontextprotocol/sdk` — no runtime
// import (the esbuild bundle carries no sdk code). Declared as a
// peerDependency (+ devDependency for local typecheck) because the
// `Transport` reference survives into the shipped `dist/runtime.d.ts`,
// which the main "." entry re-exports — TS consumers need the sdk
// types resolvable. Matches `@ggui-ai/mcp-apps-react`'s declaration posture.
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ModuleNamespace, GadgetPackageRegistry } from './globals.js';
import {
  applyHostContextStyling,
  attachListener as attachHostContextListener,
  seed as seedHostContext,
} from './host-context-emitter.js';
import { mapHostPaletteToGguiVars } from './host-palette-bridge.js';
import {
  buildRootWireConfig,
  StreamBus,
} from './wire-config.js';
import {
  createChannelTransportRouter,
  type ChannelTransportRouter,
} from './channel-transport.js';
import { RelayIncapableError } from './relay-incapability.js';
import { ChannelRegistry } from '@ggui-ai/live-channel';
import type { WsTransportHandle } from '@ggui-ai/live-channel';
import {
  createTelemetrySink,
  type TelemetrySink,
} from './runtime-telemetry.js';
import {
  createChannelErrorHandler,
  createChannelPayloadHandler,
  createDataHandler,
  createDrainAckHandler,
  createPropsUpdateHandler,
  createRenderHandler,
} from './channels/index.js';
import {
  connectViaRegistry,
  type ConnectFn,
  type RegistrySubscribeHandle,
} from './registry-subscribe.js';
import {
  buildBridgePolling,
  buildEventsPolling,
  createSequenceCursor,
} from './events-polling.js';
import { unwrapCallToolResult } from './call-tool-unwrap.js';
import {
  ensureStatusDom,
  setStatus,
  setConnectedStatus,
  type StatusRefs,
} from './status-dom.js';
import {
  mergeReservedValidators,
  setActiveValidatorSet,
  type RendererValidatorContext,
} from './validation.js';
import { loadCompiledValidatorsFromUrl } from './compiled-validators.js';
import {
  mountRender,
  type RenderItemHandle,
  type RenderItemOptions,
} from './render-item.js';
import type { WireConfig } from '@ggui-ai/wire';
import {
  fromBootstrapFailure,
  type BootstrapFailureReason,
  type ProtocolErrorEmitter,
} from './protocol-error.js';
import {
  postObservabilityToParent,
  type ObservabilityEmitter,
} from './observability.js';
import { mountUiFeedbackChrome } from './ui-feedback-chrome.js';
import {
  hostCanReceiveMessages,
  hostCanRelayToolCalls,
  hostCapabilitiesCaptured,
  setHostCapabilities,
} from './host-capabilities.js';
import {
  makeLifecycleEvent,
  postLifecycleToParent,
  type LifecycleEmitter,
} from './lifecycle.js';
import {
  contextSlotLastValues,
  createContextStateHost,
  installContextRegistry,
  reemitLastContextValues,
  type ContextSnapshotPoster,
  type ResolvedContextSlot,
} from './context-observer.js';

// =============================================================================
// Build-time-stamped renderer version. Surfaced to the parent in the
// `ggui:renderer-ready` notification (and the `ui/initialize` appInfo
// via APP_INFO) so hosts (and console views) can correlate runtime
// behavior with a specific bundle.
//
// Injected by esbuild `define` from package.json's version at bundle
// time (see esbuild.config.mjs) — never a hand-maintained literal, so
// the advertised version cannot drift from the published package.
// `typeof` guards the non-bundled contexts (vitest imports this module
// directly, no define pass) which fall back to `'dev'`.
// =============================================================================

declare const __GGUI_RUNTIME_VERSION__: string;
const RENDERER_VERSION =
  typeof __GGUI_RUNTIME_VERSION__ === 'string' ? __GGUI_RUNTIME_VERSION__ : 'dev';

/**
 * How long the spec-canonical postMessage tier (Tier 3 in
 * `bootSequence`'s resolver chain + the autostart resolver's race
 * against `bootProduction`) waits for an inbound
 * `ui/notifications/tool-result` notification before falling through.
 *
 * 30 seconds chosen to span the slowest spec-compliant hosts that
 * post the tool result LATE (after their `ui/initialize` response
 * resolves + after the tool call round-trips through the LLM
 * provider). Faster hosts return immediately on arrival; the timeout
 * only fires when the host never posts at all.
 */
const POSTMESSAGE_BOOT_TIMEOUT_MS = 30_000;

/**
 * Drain-ack listener registry. Module-scoped so the dispatch path can
 * register a frame-listener without threading it through the renderer.
 * Listeners are called in registration order on every inbound
 * `{type:'drain_ack'}` WS frame; a listener returning `true` claims
 * the frame (no further listeners fire). The active listener dismisses
 * the matching per-action toast keyed on `eventId`.
 *
 * Listener faults are absorbed so a buggy subscriber can't take down
 * the WS dispatch loop.
 */
type DrainAckListener = (payload: DrainAckPayload) => boolean | void;
const drainAckListeners = new Set<DrainAckListener>();

export function subscribeDrainAck(listener: DrainAckListener): () => void {
  drainAckListeners.add(listener);
  return () => {
    drainAckListeners.delete(listener);
  };
}

function dispatchDrainAck(payload: DrainAckPayload): void {
  for (const listener of drainAckListeners) {
    try {
      if (listener(payload) === true) return;
    } catch {
      // Absorb — a faulty subscriber can't break the dispatch loop.
    }
  }
}

// =============================================================================
// App-class plumbing (Phase 1.19b.3). The renderer used to roll its own
// JSON-RPC pump (a closure-scoped `makeJsonRpcCaller` for the single
// `ui/initialize` request + a module-level `ensurePostRpcToParentListener`
// for `tools/call` and a `installPostMountListener` for inbound
// `ui/notifications/tool-result`). Every one of those was a hand-rolled
// reimplementation of a primitive `@modelcontextprotocol/ext-apps`'s
// `App` class already ships — drift across them produced the Reading-B
// vs spec-canonical schism we spent the postMessage tier-3 resolver
// patching around. Post-1.19b.3 every host-iframe message hops through
// one `App` instance.
//
// Two-piece construction:
//   - `createDefaultApp` builds an `App` + `PostMessageTransport` against
//     `window.parent`. Production wires this; tests inject their own.
//   - `connectApp` runs `App.connect(transport)` and surfaces failures
//     as the typed `ConnectAppResult` discriminated union (since App
//     throws and we want bootSequence's `UI_INITIALIZE_FAILED` envelope
//     to surface a string `message` without `instanceof` gymnastics).
// =============================================================================

const APP_INFO = { name: 'ggui-iframe-runtime', version: RENDERER_VERSION } as const;

/**
 * Available display modes the iframe-runtime supports — declared on
 * `ui/initialize` so spec-compliant hosts know `ui/request-display-mode`
 * requests for these values are honored. The runtime emits
 * `ui/request-display-mode` from the `Element.requestFullscreen`
 * interceptor + the display-mode escalation policy; both
 * target this enum.
 */
const APP_CAPABILITIES: { availableDisplayModes: ('inline' | 'fullscreen' | 'pip')[] } = {
  availableDisplayModes: ['inline', 'fullscreen', 'pip'],
};

export type ConnectAppResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

/**
 * JSON-RPC response envelope returned by `callServerToolSpec` (the
 * App-handle `tools/call` path). Success wraps the parsed
 * `CallToolResult` in `{jsonrpc:'2.0', result}`; failure (no App
 * bound, or the SDK call throwing) surfaces as `{error:{message}}` so
 * dispatch callsites can branch on `error` without `instanceof`
 * gymnastics.
 *
 * @internal — DO NOT export; consumers live in this module only.
 */
interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Build the default production `App` + `PostMessageTransport` pair
 * targeting `window.parent`. Tests inject their own; production calls
 * this lazily so test files that import this module without running
 * the autostart side-effect don't construct an iframe-bound App.
 */
function createDefaultApp(): { app: App; transport: Transport } {
  const app = new App(APP_INFO, APP_CAPABILITIES, { autoResize: true });
  const transport = new PostMessageTransport(window.parent, window.parent);
  return { app, transport };
}

/**
 * Module-level connected App handle. Set by `bootSequence` once
 * `app.connect()` resolves; consumed by the
 * outbound dispatch path (`tools/call` via `app.callServerTool`) so
 * spec-compliant frame routing is used in place of the legacy
 * hand-rolled JSON-RPC pump.
 *
 * `null` between the moment the module loads and the moment one of
 * the boot paths assigns it — `dispatchSubmitAction`'s callsites are
 * gated on this, so calls fired pre-boot drop with a console warning.
 */
let currentApp: App | null = null;

/**
 * Assign the module-level App handle. Replaces any previous handle —
 * production runs bootSequence exactly once per iframe lifecycle, so
 * a replace only happens in tests that reuse the module across
 * scenarios (and want each spec to bind its own App).
 *
 * @internal — the production caller is `bootSequence` (reached via
 *   `bootProduction`); tests inject directly to
 *   drive outbound `tools/call` through a `MockTransport`-bound App
 *   without invoking the full boot pipeline.
 */
export function setCurrentApp(app: App): void {
  currentApp = app;
}

/**
 * Read the connected App handle. Returns `null` when neither boot
 * path has run yet. Outbound dispatch sites that depend on it MUST
 * handle the null case (typically by logging + dropping the call).
 */
function getCurrentApp(): App | null {
  return currentApp;
}

/**
 * The host's announced color mode, read from the connected App's
 * pre-merged hostContext (`ui/initialize` result, kept current by the
 * App across `host-context-changed`). `undefined` when no App is
 * connected, the host sent no `theme`, or it sent something outside
 * the spec's `'light' | 'dark'` literals (dropped, never guessed —
 * the same tolerant posture as `projectHostContext`).
 *
 * This is the INPUT leg of host-theme adaptation
 * (rnd/gen-ui/beauty/experiments/002-host-theme-adaptation.md, ggui#551):
 * `hostContext.theme` alone reaches only `data-theme` +
 * `color-scheme` via `applyDocumentTheme` — nothing in the token
 * pipeline keys off it, so a dark host painted the light ladder
 * (host-fit 46.0 vs 87.7 with the dark ladder, probe `cc728a8eb`).
 * `buildOpts` consumes this ONLY when the slice stamps no `themeMode`:
 * every operator layer (live provider > per-render override > app
 * default > server default) still wins by being stamped; the host
 * fills the gap where no operator had an opinion.
 *
 * @internal — exported for unit tests (`setCurrentApp` injects the
 *   App); production caller is `buildOpts` inside `bootSequence`.
 */
export function hostAnnouncedThemeMode(): 'light' | 'dark' | undefined {
  const theme = currentApp?.getHostContext()?.theme;
  return theme === 'light' || theme === 'dark' ? theme : undefined;
}

/**
 * Resolve the mount's base-stylesheet color mode from the slice, with
 * the host as the final fallback (ggui#589, completing the ggui#551
 * precedence ruling — "slice wins, host is the fallback, absent ≠
 * light"):
 *
 *   stamped `themeMode`  >  `theme.mode` (the slice theme OBJECT)  >
 *   host-announced theme  >  undefined
 *
 * The middle leg is the ggui#589 fix: a render envelope carrying a
 * per-app theme (`theme: {mode, cssVariables}`) but no top-level
 * `themeMode` is still a slice-stamped mode opinion — before this,
 * the base token ladder ignored it and painted the LIGHT token set
 * under a dark overlay whenever the host (correctly, per the
 * adapter-boundary doctrine in the native host helpers) announced no
 * `hostContext.theme`: a light skeleton in a dark skin. The theme
 * object's own `mode` already drove `color-scheme`; now it also
 * selects the ladder.
 *
 * `undefined` still means "no opinion anywhere" — the renderer's
 * default applies; never coerced to `'light'`.
 *
 * @internal — exported for unit tests; production caller is
 *   `buildOpts` inside `bootSequence`.
 */
export function resolveMountThemeMode(meta: {
  readonly themeMode?: 'light' | 'dark';
  readonly theme?: {
    readonly mode: 'light' | 'dark';
    readonly cssVariables?: Record<string, string>;
  };
}): 'light' | 'dark' | undefined {
  return meta.themeMode ?? meta.theme?.mode ?? hostAnnouncedThemeMode();
}

/**
 * Resolve the mount's base-theme id from the slice (ggui#589 ask 3):
 *
 *   stamped `themeId`  >  `theme.name` (the slice theme OBJECT's name)
 *   >  undefined (renderer default ladder)
 *
 * The name leg makes a slice theme whose `name` matches a REGISTERED
 * theme id select that theme as the BASE token ladder — the overlay's
 * cssVariables still apply above it, so the base carries the full
 * brand ramp coverage a sparse overlay cannot (the "only the mapped
 * vars carry brand" store-frame class). An unregistered name is
 * harmless by construction: `getScopedThemeCss` falls back to the
 * default theme, which is byte-identical to the no-themeId path
 * (`getScopedCssTokens` ≡ `getScopedThemeCss(default)`), so a slice
 * naming its theme "My Custom" renders exactly as before.
 *
 * @internal — exported for unit tests; production caller is
 *   `buildOpts` inside `bootSequence`.
 */
export function resolveMountThemeId(meta: {
  readonly themeId?: string;
  readonly theme?: {
    readonly name?: string;
    readonly mode?: 'light' | 'dark';
    readonly cssVariables?: Record<string, string>;
  };
}): string | undefined {
  return meta.themeId ?? meta.theme?.name;
}

/**
 * The host's announced palette, read from the connected App's
 * pre-merged hostContext and translated onto `--ggui-*` tokens by the
 * host-palette bridge. `undefined` when no App is connected, the host
 * sent no `styles.variables`, or nothing in it maps/survives
 * sanitization — callers spread-skip the option, exactly like
 * {@link hostAnnouncedThemeMode}.
 *
 * This is the palette input leg of host-theme adaptation (ggui#572,
 * the color analog of #551's mode leg above): the spec `--color-*`
 * variables land as inline custom properties on `<html>` via the
 * canonical ext-apps helper, but nothing ggui renders consumes that
 * vocabulary, and the scoped token block shadows root inheritance
 * anyway — so without this mapping a host palette repaints nothing.
 * `buildOpts` threads it onto the mount options; the renderer merges
 * it as the fallback layer BENEATH the slice's own theme (ggui#573
 * ruling: slice wins, host fallback).
 *
 * @internal — exported for unit tests (`setCurrentApp` injects the
 *   App); production caller is `buildOpts` inside `bootSequence`.
 */
export function hostAnnouncedPalette(): Readonly<Record<string, string>> | undefined {
  return mapHostPaletteToGguiVars(currentApp?.getHostContext()?.styles?.variables);
}

/**
 * @internal — exported for unit tests to reset module state between
 * scenarios.
 */
export function __resetAppForTest(): void {
  currentApp = null;
}

/**
 * Connect an App over its transport; map any thrown error to the
 * `ConnectAppResult` shape so callers don't need an `instanceof Error`
 * dance to fill `UI_INITIALIZE_FAILED`.
 */
async function connectApp(app: App, transport: Transport): Promise<ConnectAppResult> {
  try {
    await app.connect(transport);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// =============================================================================
// In-iframe status DOM lives in `./status-dom.ts` — imported above so
// the live-channel handlers (which run on the registry-bound
// transport) can update the same status surface without a circular
// dep on this module.
// =============================================================================

// =============================================================================
// Failure surfacing. Two channels — the in-iframe status line + a
// parent-bound `postMessage`.
// =============================================================================

/**
 * Closed union of failure reasons surfaceable from the boot path.
 * Maps the parse reasons (`McpAppAiGguiMetaParseFailureReason`) plus
 * three boot-orchestration reasons that don't have a canonical wire
 * code. The broader `BootstrapFailureReason` extensibly-closed union
 * in `protocol-error.ts` folds these together with transport-observable
 * codes.
 */
export type RendererBootFailureReason =
  | McpAppAiGguiMetaParseFailureReason
  | 'UI_INITIALIZE_FAILED'
  | 'WS_HANDSHAKE_FAILED'
  | 'UPGRADE_REQUIRED';

/**
 * The renderer's emission-side narrowing of the protocol-owned
 * {@link McpAppBootstrapFailedMessage} envelope: same wire shape, but
 * `reason` is pinned to the closed {@link RendererBootFailureReason}
 * union so every emission site stays exhaustive-checkable.
 */
export interface RendererBootFailedMessage extends McpAppBootstrapFailedMessage {
  readonly reason: RendererBootFailureReason;
}

/**
 * Notify the parent that the renderer is alive + ready to receive
 * post-handshake messages. Sent immediately after the status DOM
 * mounts, BEFORE `ui/initialize` fires — gives hosts an early signal
 * that the iframe loaded its bundle successfully.
 */
function postRendererReady(): void {
  try {
    const envelope: McpAppRendererReadyMessage = {
      type: MCP_APP_RENDERER_READY_TYPE,
      version: RENDERER_VERSION,
    };
    window.parent.postMessage(envelope, '*');
  } catch {
    // postMessage failure here means the parent is unreachable; the
    // boot sequence will fail downstream when `ui/initialize` doesn't
    // resolve. Swallowing keeps the renderer from crashing on a
    // benign host close.
  }
}

function postBootFailure(reason: RendererBootFailureReason, message: string): void {
  try {
    const envelope: RendererBootFailedMessage = {
      type: MCP_APP_BOOTSTRAP_FAILED_TYPE,
      reason,
      message,
    };
    window.parent.postMessage(envelope, '*');
  } catch {
    // Same posture as postRendererReady — best-effort.
  }
}

// =============================================================================
// Boot orchestration. Single function so the test surface is one
// arrow: `bootSequence({...mocks})` runs the entire flow against
// caller-injected mocks without needing the iframe runtime to mutate
// global state.
// =============================================================================

export interface BootSequenceOptions {
  /**
   * Document the boot path mounts into — the render root, and the
   * toast announcer's live regions.
   *
   * MUST be the global `document` in any real deployment. The toast +
   * cue surface reads the global directly, and production passes the
   * global here (see `runBootProduction`), so the two are one object.
   * A caller handing a DIFFERENT document pre-registers the live
   * regions somewhere no announcement will ever reach; the surface then
   * falls back to creating them in the global document at the moment of
   * the first message, which is precisely the same-tick creation that
   * loses that first announcement.
   */
  readonly doc: Document;
  /**
   * Spec-canonical {@link App} instance + its {@link Transport}.
   * `bootSequence` calls `app.connect(transport)` synchronously after
   * the toolresult listener is installed (one-shot semantics: see
   * App's `_assertHandlerTiming` warning — handlers registered AFTER
   * connect risk missing the host's notification).
   *
   * Production passes the default (constructed against `window.parent`);
   * tests inject `MockTransport` + a fresh App so the orchestration
   * can be driven deterministically without `window.postMessage`.
   *
   * `App.connect` throws on initialize failure — bootSequence catches
   * + surfaces the rejection's `message` on the `UI_INITIALIZE_FAILED`
   * bootstrap envelope.
   */
  readonly app: App;
  readonly transport: Transport;
  /**
   * Stand-in for the package's own `connectViaRegistry()`. Tests inject
   * a mock so the boot smoke spec doesn't need a mock-WebSocket layer
   * — the WS lifecycle is already covered by `registry-subscribe.test.ts`
   * and `@ggui-ai/live-channel`'s transport tests.
   *
   * Default: `connectViaRegistry` from `./registry-subscribe.js`.
   */
  readonly connectFn?: ConnectFn;
  /**
   * Notify-parent hook. Default posts to `window.parent`; tests
   * inject a recorder.
   */
  readonly notifyParent: (msg: RendererBootFailedMessage | McpAppRendererReadyMessage) => void;
  /**
   * Optional typed {@link import('./protocol-error.js').ProtocolError}
   * sink. Every bootstrap-failure path fires this in parallel with
   * `notifyParent` so the `<McpAppIframe>` host wrapper's `onError`
   * prop receives typed errors. Absent = typed emission is skipped
   * (the narrow `RendererBootFailedMessage` path is unchanged).
   */
  readonly onProtocolError?: ProtocolErrorEmitter;
  /**
   * Optional {@link ObservabilityEmitter} sink. Fires for every
   * renderer-observed event flow the host inspector cares about:
   *
   *   - `schema-version-mismatch` — forwarded from subscribe's own
   *     emission on UPGRADE_REQUIRED.
   *   - `subscribe-failed` — forwarded from subscribe's emission on
   *     transient reconnect transitions.
   *   - `channel-transport-*` — fired by the channel-transport router
   *     on per-channel transport picks / fallbacks / resubscribes.
   *
   * Absent = observability emission for the events above is skipped
   * entirely (matches the ProtocolError posture; the `<McpAppIframe>`
   * host wrapper decides whether to bind this via its `onObserve`
   * prop). Exception: `relay-incapability` events do NOT flow through
   * this seam — they originate in module-level gesture-dispatch code
   * outside the boot graph (it runs independently of any given boot
   * call) and always ride the postMessage-to-parent default, whether
   * or not this option is bound.
   */
  readonly onObserve?: ObservabilityEmitter;
  /**
   * Optional {@link LifecycleEmitter} sink. Fires on every renderer
   * mount-state transition (`mounting` → `code-ready` | `error`,
   * later `disconnected`). Production binds the postMessage-to-parent
   * default {@link postLifecycleToParent}; tests inject a recorder.
   *
   * Absent = lifecycle emission skipped entirely. The legacy
   * postMessage envelopes (`ggui:renderer-ready`,
   * `ggui:bootstrap-failed`) STAY emitted regardless — lifecycle is
   * an additive surface, not a replacement.
   *
   * Sequence the renderer guarantees when this is bound:
   *   1. `mounting` — before any IO, paired with `ggui:renderer-ready`.
   *   2a. `code-ready` — after first ack folds the initial render.
   *   2b. `error` — paired with every `ggui:bootstrap-failed` emission;
   *       `error.code` mirrors the legacy envelope's `reason`.
   *
   * @public
   */
  readonly onLifecycle?: LifecycleEmitter;
  /**
   * Optional renderer hook. When present, the boot sequence:
   * (1) calls `renderer.setup()` after bootstrap parse;
   * (2) mounts the single render into the renderer's slot on
   * first ack + re-applies on every subsequent render; (3) routes
   * inbound `data` / `props_update` frames through the
   * supplied wire config + StreamBus.
   *
   * When absent (default), the boot sequence runs the placeholder
   * path — used by `boot.test.ts` to exercise the orchestration
   * without pulling React + design + wire into the spec's import
   * graph.
   */
  readonly renderer?: RendererHooks;
  /**
   * Slice meta resolved BEFORE bootSequence — the autostart layer
   * (in `runtime.ts`'s autostart resolver) catches an inline
   * `__GGUI_META__` global or a buffered `ui/notifications/tool-result`
   * postMessage early, parses it, and threads the result here so
   * bootSequence doesn't re-await the same postMessage (the autostart
   * has already drained it).
   *
   * When present, both internal resolver tiers (inline global, spec-
   * canonical async toolresult) are skipped. The App handshake still
   * runs — spec mandates `ui/initialize` regardless of how slice meta
   * arrives, and `hostContext` is captured from `app.getHostContext()`.
   */
  readonly preResolvedMeta?: McpAppAiGguiRenderMeta;
  /**
   * Autostart-layer pre-resolution of the read-plane door (ggui#537):
   * a tool result that arrived before `bootSequence` ran carried the
   * view's LOCATOR (`ui://ggui/render/…`) but no bootstrap material —
   * the read-plane-only posture. The runtime cannot read the resource
   * before the App is connected, so the locator is threaded here and
   * resolved via {@link resolveMetaViaReadDoor} right after the
   * handshake, ahead of the Tier 2 tool-result wait. Ignored when
   * `preResolvedMeta` is set.
   */
  readonly preResolvedLocator?: string;
  /**
   * How long to wait for the spec-canonical `ui/notifications/tool-result`
   * notification (Tier 2 of the resolver chain) before failing with
   * the synchronous tier's parse reason. Defaults to
   * {@link POSTMESSAGE_BOOT_TIMEOUT_MS}; tests override to a short
   * timeout so the spec doesn't hang.
   */
  readonly toolResultTimeoutMs?: number;
}

/**
 * Renderer hooks. The real iframe boot plumbs these via
 * `autoBootSequence` below; tests may pass their own fakes when
 * exercising the full flow.
 */
export interface RendererHooks {
  /**
   * Called after bootstrap parse succeeds. Return value threads the
   * root `WireConfig` + the single-render mount surface back into the
   * runtime so the channel handlers can route frames through them.
   *
   * `renderInto` — a DOM element the renderer owns. Post-stack-removal
   * (2026-05-27) the iframe-runtime mounts exactly one React tree
   * directly into `renderInto`; the earlier per-render
   * `<div data-ggui-stack-item-root>` containers were retired along
   * with `StackRenderer`.
   *
   * `onObserve` — optional observability emitter threaded down to
   * the channel-transport router (`channel-transport-*`). Absent =
   * those sites run silent (the connect-time emission sites —
   * `connectViaRegistry`'s version + subscribe events — still fire
   * via their own emitters).
   */
  setup(params: {
    readonly meta: McpAppAiGguiRenderMeta;
    readonly renderInto: HTMLElement;
    readonly statusRefs: StatusRefs;
    readonly onObserve?: ObservabilityEmitter;
  }): RendererHandle;
  /**
   * Bind the real WS manager into the renderer AFTER `connectFn` resolves.
   * The `setup()` step supplies a buffering shim — this hook flushes
   * the buffer + swaps in the real send surface. Optional: a renderer
   * that doesn't emit outbound frames can skip.
   */
  attachManager?(
    handle: RendererHandle,
    realManager: { send: (msg: WebSocketMessage) => void },
  ): void;
  /** Optional cleanup — called on boot failure paths. */
  teardown?(handle: RendererHandle): void;
}

export interface RendererHandle {
  readonly rootWireConfig: WireConfig;
  readonly streamBus: StreamBus;
  /**
   * Apply (mount-or-update) a render to the single mount slot.
   * First call mounts the React tree into `renderInto`; subsequent
   * calls re-apply through {@link RenderItemHandle.update} (same kind ⇒
   * in-place; kind transition ⇒ tear-down + remount).
   *
   * Shared by the `render` and `props_update` channel handlers so React
   * updates flow through one path.
   */
  applyRender(render: GguiSession | GguiSessionSeedInput): Promise<void>;
  /**
   * Read the currently-mounted render. `null` until the first
   * render frame lands. Read by the `props_update` + `data` channel
   * handlers to validate inbound payloads against the active render's
   * `propsSpec` / `streamSpec`.
   */
  getCurrentGguiSession(): GguiSession | GguiSessionSeedInput | null;
  readonly validatorCtx: RendererValidatorContext;
  /**
   * Send surface for outbound frames. Wired by `setup()` to the WS
   * manager obtained AFTER subscribe; initial setup supplies a
   * buffering shim that flushes on the first `send()`-ready moment.
   */
  readonly manager: { send: (msg: WebSocketMessage) => void };
  /**
   * Per-channel transport router. When the bootstrap carries
   * `streamWebSocketLocalTools` and the active render declares
   * `streamSpec[ch].source.tool`, the router decides per-channel
   * between WS subscribe + iframe-polling fallback. Updated on every
   * render frame via the render handler.
   *
   * Always present — the router gracefully no-ops when no channel
   * declares `source.tool` (legacy data-frame path is unaffected).
   */
  readonly channelTransport: ChannelTransportRouter;
  /**
   * Channel-client registry holding handlers for every WS frame type
   * the iframe routes (`render`, `data`, `props_update`, `drain_ack`,
   * `channel_payload`, `channel_error`). The
   * registry-bound transport is the sole dispatch surface — frames
   * arrive directly through registered handlers, no longer through a
   * separate `onMessage` callback.
   *
   * `bootSequence` calls `registry.bind(...)` indirectly through the
   * `connectFn` seam after `setup()` returns. Post-bind, registration
   * of new handlers is frozen (the registry guards against it); the
   * `subscribe-handshake` handlers (`ack`, `error`) are added by
   * `connectViaRegistry` and consumed during handshake resolution.
   */
  readonly channelRegistry: ChannelRegistry;
  /**
   * 3rd-party gadget-package merge promise. `installGlobalRegistry`
   * seeds `__ggui__.gadgets` synchronously with the STDLIB namespace;
   * operator-registered packages merge in asynchronously. A static seed
   * mount MUST `await` this (when the bootstrap declares `gadgets`)
   * before the first `applyRender`, so a generated component importing a
   * 3rd-party gadget sees a fully-populated catalog on first paint
   * (otherwise the per-package data-URL shim resolves to `undefined` and
   * crashes). Resolves to the STDLIB-only registry when no 3rd-party
   * packages were declared.
   */
  readonly composedGadgets: Promise<GadgetPackageRegistry>;
}

export interface BootSequenceResult {
  readonly ok: boolean;
  /**
   * The render that ended up mounted in this iframe, or `null` if
   * the boot path bailed before the first ack landed. Post-render-
   * identity-collapse (2026-05-27) every iframe holds at most one
   * render; this replaces the earlier `StackModel` return that wrapped
   * a multi-item model.
   */
  readonly mountedRender: GguiSession | GguiSessionSeedInput | null;
}

export async function bootSequence(opts: BootSequenceOptions): Promise<BootSequenceResult> {
  const { doc, app, transport, notifyParent, renderer: rendererHooks, onProtocolError, onObserve, onLifecycle } = opts;
  const connectFn: ConnectFn = opts.connectFn ?? connectViaRegistry;
  const toolResultTimeoutMs = opts.toolResultTimeoutMs ?? POSTMESSAGE_BOOT_TIMEOUT_MS;

  // Emit typed {@link ProtocolError} for every bootstrap-failure site
  // that surfaces a `RendererBootFailedMessage`. The narrow
  // postMessage envelope stays (parent compatibility); the typed
  // emission runs in parallel for host-wrapper consumption. Both
  // paths fire in the SAME order so tests pin the coupling.
  //
  // Lifecycle `error` mirrors the same emission timing — `onLifecycle`
  // (when bound) fires synchronously alongside `notifyParent`. Hosts
  // observing the outer-DOM `data-ggui-mcp-app-iframe-lifecycle`
  // attribute see the transition concurrent with the legacy envelope's
  // `onError` callback.
  const emitBootFailure = (reason: BootstrapFailureReason, message: string): void => {
    notifyParent({
      type: MCP_APP_BOOTSTRAP_FAILED_TYPE,
      // The legacy envelope's reason type is `RendererBootFailureReason`
      // (a subset of `BootstrapFailureReason`). Every value we emit here
      // is a member of that subset; the cast is a narrow-to-narrow
      // projection, not a widening.
      reason: reason as RendererBootFailureReason,
      message,
    });
    onProtocolError?.(fromBootstrapFailure(reason, message));
    onLifecycle?.(
      makeLifecycleEvent('error', { error: { code: reason, message } }),
    );
  };

  const refs = ensureStatusDom(doc);
  // Live regions up BEFORE anything can announce through them
  // (ggui#447). A region created in the same tick as its first message
  // is a region no screen reader was watching yet, and that first
  // message — the one telling the user their very first gesture was
  // received — is the one that gets lost. Mounted here, alongside the
  // render root, because every toast is at minimum a user gesture away
  // from this point.
  ensureToastAnnouncer(doc);
  // The mounted render is established after the first ack lands —
  // populated by `applyAck` below + read back by every channel handler
  // that needs `propsSpec` / `streamSpec`. Tracked as a closure-scoped
  // ref so the failure-path returns can carry the same value through
  // `BootSequenceResult`.
  let mountedRender: GguiSession | GguiSessionSeedInput | null = null;
  setStatus(refs, 'Negotiating with host…', 'connecting');

  notifyParent({ type: MCP_APP_RENDERER_READY_TYPE, version: RENDERER_VERSION });
  // Lifecycle `mounting` — the renderer is alive + status DOM is up,
  // but no IO has run yet. Hosts mirroring lifecycle to outer DOM see
  // this transition concurrent with `ggui:renderer-ready`. Idempotent
  // re-emission is the host's concern (per protocol, host treats
  // duplicate same-state envelopes as a no-op).
  onLifecycle?.(makeLifecycleEvent('mounting'));

  // Install the spec-canonical toolresult listener on App BEFORE
  // calling `app.connect(transport)`. App's `_assertHandlerTiming`
  // warns if the first handler for a one-shot event registers AFTER
  // the `ui/initialize`→`ui/notifications/initialized` handshake
  // completes (the host may have already fired the notification by
  // then). Registering early is the spec-canonical answer.
  //
  // The Promise resolves on the FIRST inbound `ui/notifications/tool-result`
  // notification carrying valid `_meta["ai.ggui/render"]`. The race
  // versus the synchronous `__GGUI_META__` tier is resolved AFTER the
  // App handshake settles — whichever yields first wins; the listener
  // is removed on resolve.
  //
  // Skipped entirely when `preResolvedMeta` is set (autostart caught
  // the toolresult or read the global early) — no listener installed,
  // no race to run.
  const toolResultPromise: Promise<McpAppAiGguiRenderMeta | null> =
    opts.preResolvedMeta !== undefined
      ? Promise.resolve(null)
      : awaitToolResultMetaFromApp(app, toolResultTimeoutMs);

  const initResult = await connectApp(app, transport);
  if (!initResult.ok) {
    setStatus(refs, `ui/initialize failed: ${initResult.message}`, 'error');
    emitBootFailure('UI_INITIALIZE_FAILED', initResult.message);
    return { ok: false, mountedRender };
  }

  // Record what this host said it can do (ggui#440). Earliest valid
  // read: `getHostCapabilities()` is undefined until `connect()`
  // resolves. Used to EXPLAIN failures (gesture relay, doorbell), never
  // to pre-empt an attempt — see `./host-capabilities.ts`.
  setHostCapabilities(app.getHostCapabilities());

  // Connected — expose the App on the module-level slot so outbound
  // `tools/call` (dispatchSubmitAction, channel-transport router)
  // routes through `app.callServerTool` instead of the legacy raw
  // postMessage pump. Idempotent: re-boot with the same App is a
  // no-op; a different App throws (the iframe is single-tenant).
  setCurrentApp(app);

  // Slice-meta resolution — spec-canonical primary, no in-house
  // Reading-B (retired Phase 1.19b.3 with the App-class swap; the
  // McpUiInitializeResult schema doesn't define `toolOutput`).
  //
  //   Tier 0  preResolvedMeta — autostart-layer pre-resolution. When
  //           the autostart's own toolresult race or inline `__GGUI_META__`
  //           parse caught the meta before bootSequence ran, it threads
  //           the parsed slice meta here so we don't re-await the same
  //           delivery. Skips every tier below.
  //
  //   Tier 1  parseMetaFromGlobal — synchronous `__GGUI_META__` inline
  //           global. Self-contained shells (`buildSelfContainedHtml`,
  //           per-render resource shells) populate this before this
  //           bundle's `<script type="module">` evaluates.
  //           Opportunistic — its absence (the common case for
  //           postMessage-delivered hosts) never surfaces as a parse
  //           failure to the caller.
  //
  //   Tier 2  spec-canonical `ui/notifications/tool-result` — observed
  //           by App via `addEventListener('toolresult', …)`. The ONLY
  //           remaining post-handshake path, used by every spec-strict
  //           host (`<AppRenderer>`, ChatGPT MCP-Apps connector,
  //           claude.ai post-spec, and any future host that issues
  //           `ui/initialize` without echoing `toolOutput`).
  //
  // When both tiers fail, we surface the Tier 2 timeout/failure reason
  // (`MISSING_META_GGUI_BOOTSTRAP`) — it's the spec-canonical channel
  // and its absence is the diagnostic worth showing.
  let parsed: McpAppAiGguiMetaParseResult;
  if (opts.preResolvedMeta !== undefined) {
    parsed = { ok: true, meta: opts.preResolvedMeta };
  } else {
    const inline = parseMetaFromGlobal();
    if (inline.ok) {
      parsed = inline;
    } else {
      // Tier 1.5 — the read-plane door (ggui#537). A pre-boot tool
      // result named the view but carried no material; now that the
      // App is connected, resolve the locator through the host's
      // `resources/read` proxy. One round trip, ahead of the Tier 2
      // wait; a miss falls through to Tier 2 unchanged (its listener
      // is already armed and resolves locator-only arrivals too).
      const viaDoor =
        opts.preResolvedLocator !== undefined
          ? await resolveMetaViaReadDoor(app, opts.preResolvedLocator)
          : null;
      const fromToolResult = viaDoor ?? (await toolResultPromise);
      if (fromToolResult !== null) {
        parsed = { ok: true, meta: fromToolResult };
      } else {
        parsed = {
          ok: false,
          reason: 'MISSING_META_GGUI_BOOTSTRAP',
        };
      }
    }
  }

  // hostContext is captured opportunistically from
  // `app.getHostContext()` — populated by App's `ui/initialize`
  // response capture + kept fresh by the `hostcontextchanged`
  // notification handler App ships internally. Apply the RAW context
  // to the iframe DOM via the spec-canonical ext-apps helpers (theme
  // + style variables + fonts) regardless of whether projection
  // picked up new fields. Projection drops theme / styles (they live
  // in ggui's own theming pipeline); the DOM-apply path is what
  // surfaces them to LLM-generated UI so host-native primitives
  // render consistently with the rest of chat.
  const rawHostContext = app.getHostContext();
  if (rawHostContext !== undefined) {
    applyHostContextStyling(rawHostContext);
  }
  if (parsed.ok && parsed.hostContext === undefined) {
    const hostContext = projectHostContext(rawHostContext);
    if (hostContext !== undefined) {
      parsed = { ...parsed, hostContext };
    }
  }

  if (!parsed.ok) {
    const message = `slice-meta parse failed: ${parsed.reason}`;
    setStatus(refs, message, 'error');
    emitBootFailure(parsed.reason, message);
    return { ok: false, mountedRender };
  }

  // Single render slice — post-Phase-B the wire merged the
  // `ai.ggui/session` + `ai.ggui/stack-item` pair into one
  // `ai.ggui/render` slice. The parser surfaces it directly on
  // `parsed.meta`.
  const meta = parsed.meta;

  // Install the precompiled, eval-free contract validators shipped on
  // the bootstrap BEFORE any wire traffic is validated. Self-contained
  // ESM modules — no `__ggui__` dependency, so this need not wait for
  // `installGlobalRegistry`. A failed load leaves the validation seam
  // to fall back to in-iframe compilation (CSP-blocked, but no worse
  // than pre-A4).
  setActiveValidatorSet(
    await loadCompiledValidatorsFromUrl(meta.validatorsUrl),
  );

  // Pin — this iframe binds to exactly one render id for its lifetime
  // (post-render-identity-collapse each iframe = one mounted render,
  // per [[kill-displaymode-divergence]]). The bootstrap's `sessionId`
  // is the pin; the render handler drops any frame addressed
  // elsewhere.
  const pinnedSessionId: string = meta.sessionId;

  // Renderer wiring — when supplied, the handler routes frames through
  // the single-render mount surface + WireConfig + StreamBus. When
  // absent, the placeholder path runs (boot.test.ts relies on the
  // latter to keep its import graph tiny). The renderer's
  // channelRegistry is the dispatch surface for every WS frame;
  // `connectFn` registers handshake handlers on top of the existing
  // registry then binds the transport.
  const renderer =
    rendererHooks !== undefined
      ? rendererHooks.setup({
          meta,
          renderInto: refs.renderRoot,
          statusRefs: refs,
          ...(onObserve !== undefined ? { onObserve } : {}),
        })
      : null;

  // In-iframe UI-feedback affordance (ggui#244) — mounted adjacent to
  // the session root, gated inside the helper on `window.parent !==
  // window` (top-level `/r/<shortCode>` tabs have no `ggui:observe`
  // egress, so they get NO affordance) AND here on a LIVE SINK: an
  // injected `onObserve` emitter, or a first-party embed host — the
  // only parent that consumes the `ggui:observe` envelope
  // (mcp-app-iframe-host answers `ui/initialize` with exactly this
  // hostInfo name). Third-party MCP-Apps hosts (claude.ai, ChatGPT,
  // Claude Desktop) drop the envelope on the floor, so rendering the
  // affordance there is a dead control — the first #471 claude.ai
  // retest surfaced it as unstyled clutter that could never deliver
  // feedback anywhere. Fire-and-forget: chrome never blocks or fails
  // the boot.
  const feedbackSinkLive =
    onObserve !== undefined ||
    app.getHostVersion()?.name === 'ggui-iframe-runtime-embed-host';
  if (feedbackSinkLive) {
    void mountUiFeedbackChrome(doc, {
      emit: onObserve ?? postObservabilityToParent,
      sessionId: meta.sessionId,
    });
  }

  setStatus(refs, `Connecting to ${meta.sessionId}…`, 'connecting');

  // Boot-without-renderer path: we still need a ChannelRegistry to
  // receive frames, because the registry is the only dispatch
  // surface. Build a minimal one with just the `render` placeholder
  // handler so non-renderer consumers (boot.test.ts) can observe
  // bootstrap-orchestration outcomes without paying React import
  // cost. The handler logs status but does not mount React.
  const placeholderRegistry =
    renderer === null
      ? createPlaceholderRegistry({
          meta,
          statusRefs: refs,
          pinnedSessionId,
        })
      : null;
  const activeRegistry = renderer?.channelRegistry ?? placeholderRegistry!;

  /**
   * Apply an ack's render snapshot to the runtime — when the ack
   * carries a render matching `pinnedSessionId`, mount it through the
   * renderer. Used by:
   *
   *   - The initial bootSequence path (first ack after subscribe).
   *   - The WS reconnect-with-rebootstrap path (every subsequent ack
   *     when the underlying WSTransport reconnects + re-fires
   *     subscribe). A render or update that landed during the
   *     dropout window flows back through here.
   *
   * Idempotent on identical inputs — `applyRender` patches in place
   * via {@link RenderItemHandle.update} when called with the same
   * render id; `channelTransport.applyRender` is server-side
   * idempotent on the (sessionId, channelName) tuple.
   */
  const applyAck = async (ackPayload: {
    readonly session?: GguiSession;
  }): Promise<void> => {
    const target = ackPayload.session;
    if (target === undefined) return;
    if (target.id !== pinnedSessionId) {
      // Server's snapshot is for a different render — likely a stale
      // re-subscribe after the server pruned ours. Nothing to mount.
      return;
    }
    mountedRender = target;
    if (renderer !== null) {
      await renderer.applyRender(target);
      if (target.type !== 'mcpApps' && target.type !== 'system') {
        renderer.channelTransport.applyRender({
          sessionId: target.id,
          ...(target.streamSpec !== undefined
            ? { streamSpec: target.streamSpec }
            : {}),
        });
      }
    }
  };

  // `code-ready` is emitted exactly once per boot. The static seed mount
  // emits it; the WS-ack reconcile path then becomes a silent repaint.
  // Without this guard a static+live meta would fire `code-ready` twice
  // (seed + ack), double-triggering host selectors / accessibility scanners.
  let codeReadyEmitted = false;
  const emitCodeReadyOnce = (): void => {
    if (codeReadyEmitted) return;
    codeReadyEmitted = true;
    onLifecycle?.(makeLifecycleEvent('code-ready', { sessionId: meta.sessionId }));
  };

  // Mode discriminators. The mount surface is DECOUPLED from the live
  // channel: static content (codeUrl/codeB64/kind) paints immediately
  // with no WS; the live trio (wsUrl+wsToken) is an OPTIONAL
  // enhancement that delivers props_update / data / re-render frames.
  // A bootstrap with NEITHER has nothing to show and nowhere to
  // subscribe.
  const hasStaticContent = hasStaticContentMeta(meta);
  const hasLiveTrio =
    typeof meta.wsUrl === 'string' &&
    meta.wsUrl.length > 0 &&
    typeof meta.wsToken === 'string' &&
    meta.wsToken.length > 0;

  // Transport-telemetry sink — the iframe's self-report channel (see
  // runtime-telemetry.ts). Created for EVERY boot with an App bridge;
  // the first batch carries the boot-path decision so operators can
  // see which ladder (if any) this mount composed, even on hosts
  // whose console and network are unreachable.
  const telemetryApp = getCurrentApp();
  const telemetry: TelemetrySink | null =
    telemetryApp !== null
      ? createTelemetrySink({
          sessionId: meta.sessionId,
          callTool: (args) => telemetryApp.callServerTool(args),
        })
      : null;
  currentTelemetrySink = telemetry;
  // Fresh boot ⇒ not superseded (matters only for test re-runs that
  // reuse the module; a real iframe boots once).
  mountSuperseded = false;
  telemetry?.record(
    'boot.path',
    JSON.stringify({
      hasStaticContent,
      hasLiveTrio,
      bridgeCapable: telemetryApp !== null,
    }),
  );

  // ── Static seed mount — zero-round-trip paint, no WS required. ──────
  // The ONLY mount path for spec-compliant MCP-Apps hosts that expose no
  // ggui live channel (claude.ai / ChatGPT / Claude Desktop), AND the
  // instant first paint for first-party hosts that ALSO open a WS (the
  // WS ack then reconciles in place — `applyRender` is idempotent on the
  // pinned sessionId, and the ack's componentCode is byte-identical to the
  // seed's `codeUrl` bytes, so it's a props-only update, no remount).
  if (renderer !== null && hasStaticContent) {
    // Await the 3rd-party gadget merge before first paint when the
    // bootstrap declares operator-registered packages — otherwise a
    // component importing a non-STDLIB gadget hits an undefined shim and
    // crashes. STDLIB-only bootstraps resolve this promise synchronously.
    if (meta.gadgets !== undefined && meta.gadgets.length > 0) {
      await renderer.composedGadgets;
    }
    let seed: GguiSessionSeedInput | null = null;
    try {
      seed = await buildGguiSessionSeedInput(meta);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!hasLiveTrio) {
        // No WS fallback — a failed static fetch is terminal.
        setStatus(refs, `static mount failed: ${message}`, 'error');
        emitBootFailure('UI_INITIALIZE_FAILED', message);
        return { ok: false, mountedRender };
      }
      // A live trio is present — the WS ack will deliver the render.
      // The seed was best-effort; fall through to subscribe. Warn so a
      // degraded boot (slower first paint, ack-only delivery) is visible
      // in host consoles instead of indistinguishable from the fast path.
      console.warn(
        `[ggui] static seed fetch failed (${message}); falling back to the live channel for render delivery`
      );
      seed = null;
    }
    if (seed !== null) {
      await renderer.applyRender(seed);
      mountedRender = seed;
      emitCodeReadyOnce();
    }
  }

  // ── No live channel → static-only host (unless bridge-capable). ─────
  // The static seed already painted (or there was nothing to paint).
  // A bootstrap with neither static content nor a live trio is a
  // misconfiguration — surface a typed boot failure.
  //
  // #471 round-6 live finding: when the host exposes an App bridge
  // (tools/call postMessage — claude.ai, every MCP Apps host), a
  // trio-less static mount must NOT stop here — the bridge-pull
  // terminal rung is exactly its subscription. Fall through to the
  // subscribe below, which binds trio-less (the registry starts the
  // ladder at its tail). Gating the terminal rung behind the WS
  // trio's presence disabled it on precisely the host class it was
  // built for.
  const staticOnlyNoBridge = !hasLiveTrio && getCurrentApp() === null;
  if (!hasLiveTrio && mountedRender === null) {
    const message =
      'bootstrap carries neither static content (codeUrl/codeB64/kind) nor a live trio (wsUrl/wsToken)';
    setStatus(refs, message, 'error');
    emitBootFailure('MISSING_META_GGUI_BOOTSTRAP', message);
    return { ok: false, mountedRender };
  }
  if (staticOnlyNoBridge) {
    telemetry?.record('boot.static_only_no_bridge');
    // Host-context wiring for the no-WS static mount (claude.ai / ChatGPT
    // / Claude Desktop). The INITIAL host theme/style/fonts were already
    // applied at boot (applyHostContextStyling, above); attach the
    // spec-canonical `hostcontextchanged` listener so a post-boot host
    // theme toggle still re-paints the iframe. There is no WS to echo
    // context back to a server, so the emitter's `send` is a no-op —
    // `seed()` needs it only to initialize emitter state, and
    // `handleHostContextChangedParams` applies the DOM styling BEFORE the
    // (no-op) echo. WS hosts get the real echo on the live-trio path below.
    if (parsed.hostContext !== undefined) {
      seedHostContext({
        sessionId: meta.sessionId,
        send: () => {},
        initial: parsed.hostContext,
      });
      attachHostContextListener({ app });
    }
    setConnectedStatus(refs);
    return { ok: true, mountedRender };
  }

  // ── Live-channel subscribe (conditional enhancement). ──────────────
  // Failover-ladder rung URLs (WS → SSE → polling → bridge-pull),
  // hoisted so the spreads below stay exact-optional-clean without
  // non-null assertions. `sseUrl` is the server-stamped wsToken-gated
  // `/api/sessions/<id>/stream` URL; SSE `id:` = ledger sequence = the
  // SAME cursor model as the WS `sinceSequence` replay and polling
  // ticks — switching rungs does not lose events.
  const sseUrl =
    typeof meta.sseUrl === 'string' && meta.sseUrl.length > 0
      ? meta.sseUrl
      : undefined;
  const pollingBaseUrl =
    typeof meta.pollingUrl === 'string' && meta.pollingUrl.length > 0
      ? meta.pollingUrl
      : undefined;
  // One shared cursor for the whole ladder — SSE deliveries advance it
  // (via onSequence), the polling + bridge descriptors read it per
  // tick, so a demotion down the ladder resumes from the last
  // delivered event instead of re-replaying from the boot snapshot.
  // Created when ANY fallback rung exists — including the bridge-pull
  // rung, whose only precondition is a connected App handle (the
  // universal floor: a CSP-jailed host stamps no sseUrl/pollingUrl,
  // yet its `tools/call` postMessage bridge still reaches the ledger).
  const bridgeApp = getCurrentApp();
  const ladderCursor =
    sseUrl !== undefined || pollingBaseUrl !== undefined || bridgeApp !== null
      ? createSequenceCursor(meta.lastSequence ?? 0)
      : undefined;
  let handle: RegistrySubscribeHandle;
  try {
    handle = await connectFn({
      meta,
      registry: activeRegistry,
      // Live-channel diagnostics tap — every channel_* event the
      // transports emit (failover swaps, polling budget exhaustion,
      // SSE lifecycle) lands in the telemetry buffer. Without this the
      // ladder's story on sandboxed hosts is unobservable.
      ...(telemetry !== null ? { logger: telemetry.channelLogger } : {}),
      onStatusChange: (status) => {
        telemetry?.record(`status.${status}`);
        setStatus(
          refs,
          status === 'connected' ? 'Connected.' : `Connection ${status}…`,
          status,
        );
        // Propagate WS status to the per-channel transport router so
        // it can flip WS-bound channels into polling
        // fallback (on disconnect) and re-send `channel_subscribe`
        // on reconnect. No-op when renderer wiring is absent.
        if (renderer !== null) {
          renderer.channelTransport.onWsStatusChange(status);
        }
      },
      // Forward typed errors from subscribe through the runtime's
      // own emitter — connectViaRegistry classifies transport + auth
      // + version + protocol errors on its own, we just plumb them
      // along.
      ...(onProtocolError !== undefined ? { onProtocolError } : {}),
      // Forward observability emissions — connectFn owns the
      // schema-version-mismatch + subscribe-failed kinds.
      ...(onObserve !== undefined ? { onObserve } : {}),
      // Reconnect-with-rebootstrap — on every ack received AFTER the
      // initial handshake settled, reapply the server's authoritative
      // `render` snapshot. A render or update that landed during a WS
      // dropout window restores here without an agent re-prompt.
      onResubscribeAck: (ack) => {
        void applyAck(ack);
      },
      // Failover-ladder fallback rungs (WS → SSE → polling →
      // bridge-pull), composed once at bind time from the
      // server-stamped wsToken-gated URLs + `meta.lastSequence`
      // (shared cursor seed). FailoverHandle descends a rung on each
      // 'failed'; the bridge rung is terminal (never emits 'failed').
      //
      // Same cursor model as the WS subscribe `sinceSequence` replay
      // path — switching transports does not lose events.
      ...(sseUrl !== undefined && ladderCursor !== undefined
        ? {
            sse: {
              url: sseUrl,
              initialSinceSequence: ladderCursor.get(),
              onSequence: (seq: number) => {
                ladderCursor.advance(seq);
              },
            },
          }
        : {}),
      ...(pollingBaseUrl !== undefined && ladderCursor !== undefined
        ? {
            polling: buildEventsPolling({
              baseUrl: pollingBaseUrl,
              cursor: ladderCursor,
            }),
          }
        : {}),
      // Bridge-pull terminal rung — composed whenever the App handle
      // is bound (it always is by this point in the boot: connectApp
      // succeeded and setCurrentApp ran above), INDEPENDENT of
      // sseUrl/pollingUrl presence. This is the universal floor for
      // CSP-jailed hosts (claude.ai) where the iframe has no network
      // path at all: the ledger is pulled via `ggui_runtime_pull`
      // `tools/call`s over the host's postMessage bridge. Shares the
      // SAME ladder cursor — a demotion into the bridge resumes from
      // whatever the rungs above already delivered.
      ...(bridgeApp !== null && ladderCursor !== undefined
        ? {
            bridge: buildBridgePolling({
              callTool: (name, args) =>
                bridgeApp.callServerTool({ name, arguments: args }),
              sessionId: meta.sessionId,
              cursor: ladderCursor,
            }),
          }
        : {}),
    });
  } catch (err) {
    // UPGRADE_REQUIRED is TERMINAL even when static content already
    // painted — the mounted code may be wire-incompatible with this
    // runtime, so surfacing the upgrade prompt wins over a stale mount.
    if (isUpgradeRequiredErrorLike(err)) {
      if (renderer !== null) rendererHooks?.teardown?.(renderer);
      const message = err.message;
      setStatus(refs, message, 'upgrade-required');
      // `UPGRADE_REQUIRED` already emits a typed `version` error via
      // connectFn's onProtocolError path; the bootstrap-failure emit
      // here carries the coarse-grained reason for hosts that only
      // pattern-match `kind: 'bootstrap'`.
      emitBootFailure('UPGRADE_REQUIRED', message);
      return { ok: false, mountedRender };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (mountedRender !== null) {
      // DEGRADE — a transport/auth failure AFTER a static seed already
      // painted. Keep the mounted content, skip live updates (props_update
      // simply stops arriving), and do NOT tear down or surface a
      // bootstrap failure. connectFn already emitted the typed
      // `subscribe-failed` observability event on its own onObserve path.
      setStatus(refs, `live updates unavailable: ${message}`, 'connecting');
      emitCodeReadyOnce();
      return { ok: true, mountedRender };
    }
    if (renderer !== null) rendererHooks?.teardown?.(renderer);
    setStatus(refs, `WS handshake failed: ${message}`, 'error');
    emitBootFailure('WS_HANDSHAKE_FAILED', message);
    return { ok: false, mountedRender };
  }

  telemetry?.record(
    'subscribe.resolved',
    JSON.stringify({ kind: handle.handle.kind, hasAck: handle.ack !== undefined }),
  );
  // Attach the live transport handle to the renderer — flushes any
  // buffered outbound `action` frames that were queued while the
  // subscribe handshake completed. `send` narrows to the ws surface:
  // a trio-less bridge-only bind has NO outbound channel (gestures
  // ride app.callServerTool, not the transport), so its sends drop —
  // the same posture a post-swap FailoverHandle already has.
  const transportSend = (msg: Parameters<WsTransportHandle['send']>[0]): void => {
    if (handle.handle.kind === 'ws') handle.handle.send(msg);
  };
  if (renderer !== null && rendererHooks?.attachManager !== undefined) {
    rendererHooks.attachManager(renderer, { send: transportSend });
  }

  // seed the host-context emitter with the projection captured from
  // `app.getHostContext()` (the App class's spec-canonical
  // `ui/initialize` capture), and install the `hostcontextchanged`
  // notification listener so subsequent live updates also echo to
  // the server. Both calls are idempotent and no-op when the host
  // didn't emit a HostContext (parsed.hostContext === undefined).
  if (parsed.hostContext !== undefined) {
    seedHostContext({
      sessionId: meta.sessionId,
      send: transportSend,
      initial: parsed.hostContext,
    });
    // Bind via App's spec-canonical `hostcontextchanged` event surface.
    // App's onEventDispatch pre-merges the params into its internal
    // `_hostContext` before our handler runs, so `app.getHostContext()`
    // is always fresh by the time we project + WS-echo.
    attachHostContextListener({ app });
  }

  // First ack — apply the server's render snapshot (when matching
  // `pinnedSessionId`) and mount it. Reuses the same `applyAck` helper
  // the reconnect-rebootstrap path uses — so a server-restart-driven
  // snapshot replay and the first-boot snapshot apply flow through
  // one implementation. Trio-less bridge-only binds have no handshake
  // and therefore no ack — the static seed already painted, and the
  // bridge delivers deltas from the boot cursor.
  if (handle.ack !== undefined) {
    await applyAck(handle.ack);
  }
  setConnectedStatus(refs);
  // Lifecycle `code-ready` — terminal happy state. Emitted ONCE per boot
  // (a static+live meta already fired it from the seed mount, so this is
  // a no-op there); for a live-only meta this is the first + only emit.
  // Hosts pinning selectors on `code-ready` (E2E specs, accessibility
  // scanners) re-resolve here.
  emitCodeReadyOnce();

  return { ok: true, mountedRender };
}

/**
 * Build a minimal `ChannelRegistry` for boot paths without renderer
 * wiring (boot.test.ts + the C7a placeholder-only spec). The registry
 * carries just the `render` handler — which logs status but does not
 * mount React — so consumers can observe bootstrap-orchestration
 * outcomes without paying React import cost. Every other frame type
 * silently drops. Production boots through `bootProduction` which
 * supplies a fully-populated renderer with the rich handler set.
 */
function createPlaceholderRegistry(params: {
  readonly meta: McpAppAiGguiRenderMeta;
  readonly statusRefs: StatusRefs;
  /** Pin — render frames with a different sessionId drop with a warning. */
  readonly pinnedSessionId: string;
}): ChannelRegistry {
  const registry = new ChannelRegistry({
    subscribeFrameBuilder: () => ({
      type: 'subscribe',
      payload: {
        sessionId: params.meta.sessionId,
        appId: params.meta.appId,
        ...(params.meta.wsToken !== undefined
          ? { wsToken: params.meta.wsToken }
          : {}),
      },
    }),
  });
  registry.register(
    createRenderHandler({
      statusRefs: params.statusRefs,
      pinnedSessionId: params.pinnedSessionId,
    }),
  );
  return registry;
}

/**
 * Frame dispatch lives inside `@ggui-ai/live-channel`'s
 * `ChannelRegistry`. Every WS frame type (`render`, `data`,
 * `props_update`, `drain_ack`, `channel_payload`,
 * `channel_error`) has a registered handler in `channels/*.ts`; the
 * registry's bound transport routes inbound frames directly to them.
 *
 * The pre-B3b helpers (`handleServerMessage`, `handleRendererMessage`,
 * `handleObservableMessage`, `BufferedManagerShim`) lived here and
 * have been retired — see commit message + plan B3b for the full
 * retirement notes.
 */

/**
 * Type guard for the `UpgradeRequiredError` class without importing
 * the `instanceof` constructor here — the runtime catches via duck-
 * typing because it doesn't want to retain the class reference (which
 * would inflate the bundle). The class itself is checked inside
 * `connectViaRegistry`; this guard is just for the post-throw branch.
 */
function isUpgradeRequiredErrorLike(value: unknown): value is { name: 'UpgradeRequiredError'; code: 'UPGRADE_REQUIRED'; message: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { name?: unknown }).name === 'UpgradeRequiredError' &&
    (value as { code?: unknown }).code === 'UPGRADE_REQUIRED' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

// =============================================================================
// Top-level boot. Runs on module load — the bundle is the entry
// point loaded by `<script type="module">`, so import-time side
// effects ARE the runtime startup.
//
// Skipped under `process.env.GGUI_RENDERER_AUTOSTART === 'false'` so
// the boot smoke test can import this module to exercise
// `bootSequence` directly without the side effect kicking in. Set via
// the esbuild `define` config in the bundle build; for tests it's
// the runtime environment.
// =============================================================================

declare const process: { env?: { GGUI_RENDERER_AUTOSTART?: string } } | undefined;

function shouldAutostart(): boolean {
  if (typeof process === 'undefined') return true;
  return process.env?.GGUI_RENDERER_AUTOSTART !== 'false';
}

// =============================================================================
// Self-contained bootstrap (`window.__GGUI_META__`).
//
// The default boot path (postMessage `ui/initialize` → parse the
// `_meta["ai.ggui/render"]` slice → open WebSocket → subscribe →
// render from frames) is strictly first-party: it requires the host to
// speak ggui's custom postMessage protocol AND a reachable live-channel
// WebSocket the renderer can subscribe against. MCP Apps hosts in the
// wild (Claude Desktop, claude.ai web) speak only the canonical MCP
// Apps lifecycle and have no commitment to forward the slice key back
// through `ui/initialize`. The full first-party path stays intact for
// callers that own both ends; this self-contained path is what makes
// the same runtime bundle work in third-party MCP Apps hosts.
//
// Contract: when the embedding HTML inlines a global of shape
//   { sessionId: string, appId: string, componentCode: string }
// (where `componentCode` is base64-encoded compiled ES module source
// of a React component) BEFORE this bundle's `<script type="module">`
// executes, the runtime takes over synchronously, mounts the compiled
// component, and never speaks postMessage / opens a WebSocket. The
// global is read at module load — a global set later (via deferred
// scripts, async imports) is too late and the runtime falls through
// to the legacy postMessage path.
//
// `componentCode` carries base64 because the embedding HTML inlines
// it as a JS string literal next to other `<script>` content; raw
// JS source contains every character that breaks string-literal
// embedding (quotes, backticks, `</script>`, newlines, backslash
// escapes). Base64 sidesteps every escape concern with a 4/3 size
// overhead that's negligible compared to the network/round-trip
// savings of skipping postMessage + WS bootstrap.
// =============================================================================

/**
 * Read `globalThis.__GGUI_META__` synchronously, validate against
 * the unified slice-meta shape, and return the typed meta (or null
 * on absence / malformation).
 *
 * Thin wrapper around {@link parseMetaFromGlobal}; preserved for
 * back-compat (downstream consumers + tests). Returns `null` instead
 * of {@link McpAppAiGguiMetaParseResult} to match the historical
 * reader contract — the autostart resolver only needs the "valid
 * meta or fall through" signal.
 */
export function readSelfContainedMeta(): McpAppAiGguiRenderMeta | null {
  const result = parseMetaFromGlobal();
  return result.ok ? result.meta : null;
}

/**
 * Parse the bootstrap meta's `propsJson` string into a {@link JsonObject}.
 * Malformed JSON or a non-object payload is a shape-preserving skip
 * (returns `undefined`) — a bad `propsJson` must never block the mount.
 * `JsonValue` narrows to `JsonObject` via the object/non-null/non-array
 * guard, so no cast is needed.
 */
function parseSeedProps(propsJson: string | undefined): JsonObject | undefined {
  if (propsJson === undefined) return undefined;
  try {
    const parsed: JsonValue = JSON.parse(propsJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    // Malformed propsJson is a shape-preserving skip — mount with no props.
    return undefined;
  }
}

/**
 * Project the inline `__GGUI_META__` bootstrap into a
 * {@link GguiSessionSeedInput} the mount surface can paint immediately,
 * BEFORE the authoritative wire `GguiSession` arrives over the WS — and with
 * no WS at all for spec-compliant MCP-Apps hosts that expose no ggui
 * live channel (claude.ai / ChatGPT / Claude Desktop).
 *
 * Three static-content shapes (the autostart discriminator), in
 * priority order:
 *   - `kind`    → a system-card seed (`type:'system'`); no fetch.
 *   - `codeB64` → a compiled-component seed carried inline; DECODED,
 *     never fetched. Preferred over `codeUrl` when both are present —
 *     the inline bytes exist precisely for hosts whose iframe CSP
 *     blocks the fetch.
 *   - `codeUrl` → a compiled-component seed; fetches the
 *     content-addressable component bytes.
 *
 * Returns `null` when the meta carries NONE (a live-only meta has
 * nothing to seed — the first WS ack mounts it). Throws when a `codeUrl`
 * fetch fails or `codeB64` is not valid base64 so the caller can
 * surface a typed boot failure. The four server-assigned ledger fields
 * are intentionally absent — the first ack reconciles the seed to a
 * full `GguiSession` (no fabrication).
 */
export async function buildGguiSessionSeedInput(
  meta: McpAppAiGguiRenderMeta,
): Promise<GguiSessionSeedInput | null> {
  const props = parseSeedProps(meta.propsJson);

  // System-card mode — `kind` keyed against the built-in registry.
  if (meta.kind !== undefined) {
    return {
      id: meta.sessionId,
      appId: meta.appId,
      type: 'system',
      kind: meta.kind,
      ...(props !== undefined ? { props } : {}),
    };
  }

  // Inline compiled-component mode — decode, no network.
  if (meta.codeB64 !== undefined) {
    return {
      id: meta.sessionId,
      appId: meta.appId,
      componentCode: decodeCodeB64(meta.codeB64),
      ...(props !== undefined ? { props } : {}),
    };
  }

  // Compiled-component mode — fetch the content-addressable bytes.
  if (meta.codeUrl === undefined) return null;
  const res = await fetch(meta.codeUrl);
  if (!res.ok) {
    throw new Error(
      `buildGguiSessionSeedInput: codeUrl fetch failed (${res.status}): ${meta.codeUrl}`,
    );
  }
  const componentCode = await res.text();
  return {
    id: meta.sessionId,
    appId: meta.appId,
    componentCode,
    ...(props !== undefined ? { props } : {}),
  };
}

/**
 * Does this slice carry STATIC content the mount surface can paint
 * without any network round-trip authorization — `codeUrl` (fetched),
 * `codeB64` (decoded inline), or `kind` (built-in registry)?
 *
 * The ONE discriminator `bootSequence` consults when deciding whether
 * the static seed-mount path runs. `codeB64` counting here is
 * load-bearing for fetch-blocked hosts: their meta carries codeB64
 * PLUS a live trio the iframe can never connect, and missing the
 * inline arm would skip the only paint path and die on the dead WS.
 * Mirrors `validateMeta`'s static-content arm (meta-parse.ts) and the
 * protocol host-helper's `hasMountModeDiscriminator` — drift among
 * the three IS the historical bug class, hence the named export.
 */
export function hasStaticContentMeta(meta: McpAppAiGguiRenderMeta): boolean {
  return (
    (typeof meta.codeUrl === 'string' && meta.codeUrl.length > 0) ||
    (typeof meta.codeB64 === 'string' && meta.codeB64.length > 0) ||
    (typeof meta.kind === 'string' && meta.kind.length > 0)
  );
}

/**
 * Decode a `codeB64` slice field to UTF-8 component source. `atob`
 * yields a byte string; routing through `TextDecoder` restores
 * multi-byte characters (component source is UTF-8 — string literals
 * carry emoji, quotes, non-Latin text). Throws a labeled error on
 * malformed base64 so the boot-failure surface names the field.
 */
function decodeCodeB64(codeB64: string): string {
  try {
    const byteString = atob(codeB64);
    const bytes = new Uint8Array(byteString.length);
    for (let i = 0; i < byteString.length; i++) {
      bytes[i] = byteString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (cause) {
    throw new Error(
      'buildGguiSessionSeedInput: codeB64 is not valid base64',
      { cause },
    );
  }
}

/**
 * Extract a {@link McpAppAiGguiRenderMeta} from a
 * `ui/notifications/tool-result` JSON-RPC params payload — the
 * postMessage delivery shape MCP Apps hosts (Claude Desktop, claude.ai
 * web) use to push the active tool's `_meta` to the iframe.
 *
 * Thin wrapper around {@link parseMetaFromToolResult}; same
 * back-compat motivation as {@link readSelfContainedMeta}.
 *
 * Owning this extraction inside the runtime (instead of in the shell
 * HTML) is the architectural cure for the "shell-side validator
 * lagged the protocol" bug class: shell + runtime drift becomes
 * impossible because the shell never inspects the slice-meta shape.
 */
export function extractMetaFromToolResult(
  params: unknown,
): McpAppAiGguiRenderMeta | null {
  const result = parseMetaFromToolResult(params);
  return result.ok ? result.meta : null;
}

/**
 * Drain `window.__GGUI_PENDING_TOOL_RESULTS__` — the buffer the
 * minimal shell populates while messages arrive between
 * shell-load and runtime-load. Returns the NEWEST valid slice meta
 * (each new tool-result supersedes the previous — every emission
 * carries complete state, so last-wins loses nothing). Newest-first
 * matters on the inline-runtime shell: its preflight completes the
 * handshake BEFORE the large bundle parses, so a render AND a
 * follow-up update can both land in the buffer during parse — booting
 * the oldest would paint stale props and drop the update forever
 * (buffered entries never reach the post-mount listener; it hears
 * only post-App arrivals).
 *
 * The shell-side buffer contract: an array whose ELEMENTS are the raw
 * JSON-RPC `params` values of `ui/notifications/tool-result`
 * notifications, in arrival order (shells cap it newest-biased). The
 * runtime reads it once at autostart.
 */
export function readPendingToolResults(): McpAppAiGguiRenderMeta | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as {
    __GGUI_PENDING_TOOL_RESULTS__?: unknown;
  }).__GGUI_PENDING_TOOL_RESULTS__;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const meta = extractMetaFromToolResult(raw[i]);
    if (meta !== null) return meta;
  }
  return null;
}

/**
 * Sibling of {@link readPendingToolResults} for the read-plane-only
 * posture (ggui#537): the NEWEST buffered tool result that carries a
 * `ui://ggui/render/…` locator but no bootstrap material. Consulted only
 * when the buffer yielded no inline slice; the autostart threads it to
 * `bootSequence` as `preResolvedLocator`, resolved after the handshake.
 */
export function readPendingToolResultLocator(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as {
    __GGUI_PENDING_TOOL_RESULTS__?: unknown;
  }).__GGUI_PENDING_TOOL_RESULTS__;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const locator = extractLocatorFromToolResult(raw[i]);
    if (locator !== null) return locator;
  }
  return null;
}

/**
 * Listen for a `ui/notifications/tool-result` notification via the
 * App's spec-canonical event surface and resolve to the extracted
 * slice meta. Times out after `timeoutMs`; resolves `null` on timeout
 * so the caller can fall through to a legacy boot path.
 *
 * Used by `bootSequence` for the spec-canonical Tier 2 fallback when
 * the synchronous `__GGUI_META__` inline global yields nothing. Must
 * be called BEFORE `app.connect(transport)` — App's
 * `_assertHandlerTiming` warns when the first handler for a one-shot
 * event registers after the handshake.
 */
function awaitToolResultMetaFromApp(
  app: App,
  timeoutMs: number,
): Promise<McpAppAiGguiRenderMeta | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: McpAppAiGguiRenderMeta | null): void => {
      if (settled) return;
      settled = true;
      app.removeEventListener('toolresult', handler);
      clearTimeout(timer);
      resolve(value);
    };
    const handler = (params: CallToolResult): void => {
      if (settled) return;
      const meta = extractMetaFromToolResult(params);
      if (meta !== null) {
        settle(meta);
        return;
      }
      // Read-plane door (ggui#537): identity-only result → resolve the
      // locator through the host's `resources/read` proxy. Async, and
      // it never settles `null` — a later result carrying the slice
      // inline (or the timeout) still decides.
      const locator = extractLocatorFromToolResult(params);
      if (locator === null) return;
      void resolveMetaViaReadDoor(app, locator).then((resolved) => {
        if (resolved !== null) settle(resolved);
      });
    };
    app.addEventListener('toolresult', handler);
    const timer = setTimeout(() => settle(null), timeoutMs);
  });
}

/**
 * The read-plane door (ggui#537). A server running the read-plane-only
 * posture publishes only the view's identity on the tool result — the
 * `ui://ggui/render/…` locator — and no bootstrap material; the
 * per-render resource that locator names is the self-contained shell,
 * whose document inlines the very envelope this runtime boots from.
 * Ask the HOST to read it (`app.readServerResource` → `resources/read`,
 * proxied by the host's own MCP client — no fetch from this sandbox, so
 * a host CSP without `connect-src` to the server is not in the way),
 * recover the envelope with the protocol's writer/reader pair
 * ({@link readGguiShellEnvelope}), and validate it exactly as an inline
 * slice would be. `null` on any miss (host cannot proxy reads, resource
 * gone, no envelope) — the caller's other tiers still decide.
 */
export async function resolveMetaViaReadDoor(
  app: App,
  locator: string,
): Promise<McpAppAiGguiRenderMeta | null> {
  let text: string | undefined;
  try {
    const res = await app.readServerResource({ uri: locator });
    const first = res.contents[0];
    text = first !== undefined && 'text' in first && typeof first.text === 'string' ? first.text : undefined;
  } catch (err) {
    // eslint-disable-next-line no-console -- operator-visible: the door is a boot tier, its miss must be legible
    console.warn(
      `[ggui-runtime] read-plane door: host could not read ${locator} — ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
  if (text === undefined) return null;
  const envelope = readGguiShellEnvelope(text);
  if (envelope === undefined) return null;
  const parsed = parseMcpAppAiGguiRenderMeta(envelope);
  if (!parsed.ok || parsed.meta === undefined) return null;
  const validated = validateMeta(parsed.meta);
  return validated.ok ? validated.meta : null;
}

/**
 * Pre-handshake variant — listens to raw `window.message` for the
 * autostart layer. Used BEFORE the App is constructed, so this can't
 * route through `app.addEventListener`. Pairs with the minimal-shell
 * pattern: the shell buffers any tool-results that arrived BEFORE
 * runtime load (read via {@link readPendingToolResults}); this
 * listener catches the ones that arrive AFTER the bundle parses but
 * BEFORE bootSequence runs.
 */
/**
 * What the pre-handshake wait resolves to: an inline slice (boot from
 * it directly), or — read-plane-only posture — the view's locator, to
 * be resolved through the door once the App is connected. `null` on
 * timeout.
 */
type PreBootToolResult =
  | { readonly kind: 'meta'; readonly meta: McpAppAiGguiRenderMeta }
  | { readonly kind: 'locator'; readonly locator: string };

function awaitToolResultMeta(
  timeoutMs: number,
): Promise<PreBootToolResult | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: PreBootToolResult | null) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (ev: MessageEvent) => {
      const m = ev.data as
        | { jsonrpc?: string; method?: string; params?: unknown }
        | null
        | undefined;
      if (
        m === null ||
        m === undefined ||
        m.jsonrpc !== '2.0' ||
        m.method !== 'ui/notifications/tool-result'
      ) {
        return;
      }
      const meta = extractMetaFromToolResult(m.params);
      if (meta !== null) {
        settle({ kind: 'meta', meta });
        return;
      }
      // Identity-only result (ggui#537): settle NOW with the locator so
      // boot starts immediately and the door runs after the handshake —
      // waiting the full timeout for a slice this posture never sends
      // would cost every spec-host view 30 s for nothing.
      const locator = extractLocatorFromToolResult(m.params);
      if (locator !== null) settle({ kind: 'locator', locator });
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => settle(null), timeoutMs);
  });
}

/**
 * Module-level guard for the App-mediated post-mount toolresult
 * re-listener. Ensures exactly one persistent
 * `app.addEventListener('toolresult', …)` registration even across
 * re-mounts (e.g. an agent fires a second `ggui_render` and the
 * listener re-applies through the published `applyRender`).
 */
let postMountListenerInstalled = false;

/**
 * Module-level handle to the active renderer's `applyRender`, published
 * by `bootProduction`'s `setup()` once the renderer is built. The
 * module-level {@link installPostMountListener} resolves this to re-mount
 * on a host-re-emitted tool-result WITHOUT a fresh boot — no second mount,
 * no second WS. This is the no-WS live-re-render channel for
 * spec-compliant MCP-Apps hosts (claude.ai / ChatGPT / Claude Desktop)
 * that re-broadcast the tool-result instead of sending a WS render frame.
 *
 * `null` until a renderer is published (e.g. unit tests that drive
 * `bootSequence` with no renderer never set it → the listener no-ops).
 */
let activeApplyRender:
  | ((render: GguiSession | GguiSessionSeedInput) => Promise<void>)
  | null = null;

/**
 * Module-level guard for {@link installAnchorClickInterceptor}. Same
 * rationale as {@link postMountListenerInstalled}: re-mounts are
 * triggered by `installPostMountListener`, and stacking capture-phase
 * click listeners across re-mounts would multiply the audit envelopes
 * that fire on a single click.
 */
let anchorClickInterceptInstalled = false;

/**
 * Module-level guard for {@link installFullscreenInterceptors}. The
 * fullscreen interceptors REPLACE prototype methods on `Element` and
 * `Document`; re-overriding on every re-mount would chain wrappers
 * and (if the captured `args` differ) leak stale `sessionId`/`appId`.
 * The guard ensures exactly one prototype patch.
 */
let fullscreenInterceptInstalled = false;

/**
 * Compute a short deterministic action-id from a submit-action
 * payload. FNV-1a 32-bit, 8 hex chars — not cryptographically
 * strong, just collision-resistant enough for in-flight
 * correlation between the silent context-update and the loud
 * consent message that bridge a click to the host's LLM.
 */
function fnv1aHex(payload: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < payload.length; i += 1) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Render a submit-action's `data` payload as a short inline string
 * for embedding in a `ui/message` consent prompt. Goal: human-
 * readable, not a JSON dump. Falls back to truncated JSON for
 * nested values so the prompt doesn't drop information silently.
 *
 * Exported for unit-testing — an earlier implementation returned `''`
 * for primitive payloads (strings/numbers/booleans), which silently
 * vaporised the chip's actual text from the consent prompt and made
 * the LLM think every dispatch was a contentless "Please proceed
 * with **<intent>**" request.
 */
export function formatSubmitActionDataInline(data: unknown): string {
  if (data === null || data === undefined) return '';
  // Bare primitives: render verbatim. Strings unquoted (most legible
  // in a "Please proceed with X (foo)" sentence). Numbers / booleans
  // stringified.
  if (typeof data === 'string') return data;
  if (typeof data === 'number' || typeof data === 'boolean') return String(data);
  // Arrays: short JSON, truncated. Length cap mirrors the per-entry
  // cap below so the consent line stays a single human-readable phrase.
  if (Array.isArray(data)) {
    const json = JSON.stringify(data);
    return json.length > 60 ? `${json.slice(0, 57)}…` : json;
  }
  if (typeof data !== 'object') return '';
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return '';
  const parts = entries.map(([k, v]) => {
    if (v === null) return `${k}: null`;
    if (v === undefined) return `${k}: undefined`;
    if (typeof v === 'string') return `${k}: ${v}`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${k}: ${v}`;
    // `JSON.stringify` returns `undefined` for unrepresentable values
    // (e.g. a `function` field on a form payload object) — guard so
    // the subsequent `.length` access doesn't crash the dispatch path.
    const json = JSON.stringify(v) ?? String(v);
    return `${k}: ${json.length > 40 ? `${json.slice(0, 37)}…` : json}`;
  });
  return parts.join(', ');
}

/**
 * Post an arbitrary JSON-RPC envelope to the iframe's parent
 * window. Internal helper shared across {@link emitAudit} (the
 * fire-and-forget `tools/call` audit envelope) and any other
 * non-spec-canonical `ggui:*` outbound envelope that doesn't have an
 * App method equivalent. Detached parent → silent drop (non-fatal).
 *
 * Spec-canonical MCP-Apps notifications whose params are FULLY
 * described by the spec schema (`ui/update-model-context`,
 * `ui/open-link`, `ui/request-display-mode`) flow through the App
 * method helpers below — they round-trip via the bound `Transport`
 * and follow the spec's request/response shape.
 *
 * `ui/message` is the exception: its doorbell carries a content-block
 * `_meta` extension that the host's closed `McpUiMessageRequestSchema`
 * parse would strip (and empty the text). It posts its `ui/message`
 * frame through this raw helper instead — see {@link
 * emitUserActionDoorbell} for the full rationale.
 */
function postToParent(envelope: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.parent.postMessage(envelope, '*');
  } catch {
    // Detached parent — non-fatal, drop silently.
  }
}

/**
 * Outbound MCP-Apps notification shims — fire the spec-canonical App
 * method when the module-level App handle is set, otherwise drop
 * silently. Each method is a fire-and-forget request from the
 * iframe-runtime's perspective: production never awaits the host's
 * ack, so we use `void` + `.catch(noop)` to suppress unhandled
 * rejections.
 *
 * Pre-connect call site safety: every production caller fires after
 * the boot pipeline has installed an App (anchor clicks, fullscreen
 * gestures, context-observer ticks, dispatch fan-outs all gate on
 * post-mount lifecycle). The no-op fallback exists for unit tests
 * that exercise these helpers without invoking `bootSequence` —
 * the absence of side effects there is the test's signal that the
 * caller did its part.
 */
function callAppUpdateModelContext(
  params: Parameters<App['updateModelContext']>[0],
): void {
  const app = getCurrentApp();
  if (app === null) return;
  void app.updateModelContext(params).catch(() => {
    // Detached / host-rejected — drop silently per the helper contract.
  });
}

function callAppOpenLink(params: Parameters<App['openLink']>[0]): void {
  const app = getCurrentApp();
  if (app === null) return;
  void app.openLink(params).catch(() => {
    // Detached / host-rejected — drop silently per the helper contract.
  });
}

function callAppRequestDisplayMode(
  params: Parameters<App['requestDisplayMode']>[0],
): void {
  const app = getCurrentApp();
  if (app === null) return;
  void app.requestDisplayMode(params).catch(() => {
    // Detached / host-rejected — drop silently per the helper contract.
  });
}

/**
 * Production {@link ContextSnapshotPoster} — the seam the
 * context-observer factories consume. Splits the two destinations:
 *
 *   - `postUpdateModelContext` → spec-canonical
 *     `app.updateModelContext(...)` (via {@link callAppUpdateModelContext}).
 *   - `postContextMirror` → raw `tools/call ggui_runtime_sync_context`
 *     via {@link postToParent} (the host-relay mirror path; not yet
 *     migrated to `app.callServerTool` — see emitAudit for the same
 *     posture).
 */
const productionContextSnapshotPoster: ContextSnapshotPoster = {
  postUpdateModelContext: (params) => {
    callAppUpdateModelContext(params);
  },
  postContextMirror: (params) => {
    postToParent({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'tools/call',
      params: {
        name: 'ggui_runtime_sync_context',
        arguments: {
          sessionId: params.sessionId,
          appId: params.appId,
          snapshot: params.snapshot,
        },
      },
    });
  },
};

/**
 * Outbound `tools/call` shim. Routes through the spec-canonical
 * `app.callServerTool` API on the module-level App handle. Production
 * always has the handle set (`bootSequence` calls
 * `setCurrentApp(app)` after handshake); tests that exercise dispatch
 * routing install one explicitly via {@link setCurrentApp} bound to
 * a `MockTransport`.
 *
 * Returns a `JsonRpcResponse`-shaped object for source-compatibility
 * with the previous direct postMessage path: callers parse
 * `resp.result.structuredContent` to read submit_action's `{ok, code,
 * consumerPresent}` envelope. The App branch wraps the parsed
 * `CallToolResult` in `{result: ...}`.
 *
 * Drops with an error envelope when no App is bound — the dispatch
 * pipeline classifies that as a transport error and routes to the
 * `ui/message` fallback.
 */
async function callServerToolSpec(
  toolName: string,
  args: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const app = getCurrentApp();
  if (app === null) {
    return {
      error: {
        message: 'callServerToolSpec: no App bound — call setCurrentApp() first',
      },
    };
  }
  try {
    const result = await app.callServerTool({
      name: toolName,
      arguments: args,
    });
    return { jsonrpc: '2.0', result: result as unknown };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fire a single canonical action envelope (`tools/call
 * ggui_runtime_submit_action`) carrying the typed `{kind, payload, …}` shape
 * defined in `@ggui-ai/protocol/integrations/mcp-apps`. Every
 * user-driven gesture (submit-action dispatch, native-idiom anchor
 * click, native-idiom fullscreen request) calls this alongside its
 * primary host effect, so operators get **uniform server-side
 * observability** across every gesture kind.
 *
 * Fail-soft: a rejected audit fire MUST NOT block the primary host
 * effect. Detached-parent / host-rejected audit envelopes are
 * dropped silently here; the primary effect proceeds via its own
 * `postToParent` call from the caller.
 */
/** @internal — exported for unit tests. */
export function emitAudit(args: {
  readonly toolName: string;
  readonly kind: 'dispatch' | 'openLink' | 'requestDisplayMode';
  readonly payload: Record<string, unknown>;
  readonly sessionId: string;
  readonly appId: string;
  readonly actionId: string;
  readonly firedAt: string;
}): void {
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'tools/call',
    params: {
      name: args.toolName,
      arguments: {
        kind: args.kind,
        payload: args.payload,
        sessionId: args.sessionId,
        appId: args.appId,
        actionId: args.actionId,
        firedAt: args.firedAt,
      },
    },
  });
}

/**
 * PIPE-2 response shape inspector. The host relays `tools/call` via
 * postMessage; spec-compliant MCP relays return the tool's response
 * either as `{result: {structuredContent: {...}}}` or `{result: {...}}`
 * depending on how the host shapes the envelope. We accept both and
 * read the `ok` / `code` fields the submit_action handler returns.
 *
 * Returns `'success'` when the handler said `ok:true`. Returns
 * `'fallback'` for any other outcome — pipe missing
 * (`PIPE_NOT_FOUND`), envelope rejected (`INVALID_ACTION_KIND`),
 * relay error, no host relay wired, or any unexpected shape. The
 * iframe-runtime then falls through to `ui/message` so the gesture
 * still reaches the agent on its next turn.
 */
/**
 * Unwrap the payload record of a relayed submit-action tool result.
 * Envelope-level shim over the shared 3-tier unwrap
 * ({@link unwrapCallToolResult}: `structuredContent` →
 * `content[0].text` parsed as JSON → bare result) — this wrapper only
 * peels the JSON-RPC `result` field first. The tiers themselves are
 * shared with the bridge-pull rung's `fetchBody` carrier
 * (`events-polling.ts`) so both reads agree on which envelope tier
 * carries the payload for a given host shape.
 * Returns `null` when no tier yields an object — the caller treats
 * that as fallback/unknown.
 */
function submitActionPayload(
  resp: JsonRpcResponse,
): Record<string, unknown> | null {
  if (resp === null || typeof resp !== 'object') return null;
  return unwrapCallToolResult((resp as { result?: unknown }).result);
}

function classifySubmitActionResponse(
  resp: JsonRpcResponse,
): 'success' | 'fallback' {
  if (resp === null || typeof resp !== 'object') return 'fallback';
  if (
    'error' in resp &&
    resp.error !== undefined &&
    resp.error !== null
  ) {
    return 'fallback';
  }
  const inner = submitActionPayload(resp);
  if (inner === null) return 'fallback';
  return inner.ok === true ? 'success' : 'fallback';
}

/**
 * Did the relay itself fail — as opposed to relaying successfully to a
 * well-formed `{ok:false}` result (ggui#440)? `classifySubmitActionResponse`
 * collapses BOTH into `'fallback'`, which is the right call for the
 * generic "enqueue failed" toast (either way the gesture isn't on the
 * pipe) but the WRONG call for the relay-incapability latch: a result
 * envelope arriving at all — `{ok:false, code:'PIPE_NOT_FOUND'}` is the
 * common case (an otherwise-healthy relay, expired pipe) — is proof the
 * host DID relay the call to the server and back. Latching "cannot
 * relay" on that evidence would be false: a host that plainly can relay
 * would get permanently mislabeled from one stale-pipe response.
 *
 * `resp === null` covers the transport-throw / no-App-bound paths (the
 * outer `catch` above resets `resp` to `null`); `resp.error !== undefined
 * && resp.error !== null` covers the JSON-RPC error envelope. Neither
 * carries a result envelope, so neither is evidence the relay worked.
 */
function isRelayShapedFailure(resp: JsonRpcResponse | null): boolean {
  // Null-tolerant on `error`, matching `classifySubmitActionResponse`'s
  // own check: an `{error:null, result:{...}}` envelope classifies as
  // success there, so it must also read as NOT relay-shaped-failure
  // here — otherwise the two predicates disagree on that shape and the
  // response-arrival clear guard above would refuse to release a
  // standing latch on an unambiguous success.
  return resp === null || (resp.error !== undefined && resp.error !== null);
}

/**
 * Extract `consumerPresent` from a successful submit_action response.
 * Returns the boolean if present + well-typed; `undefined` otherwise
 * (agnostic host stripped the field, or any non-`ok:true` shape).
 * `undefined` is treated by the dispatch gate as "no confirmed
 * consumer" — the doorbell rings. Shares {@link submitActionPayload}
 * with {@link classifySubmitActionResponse} so both reads agree on
 * which envelope tier carries the payload.
 */
function extractConsumerPresent(
  resp: JsonRpcResponse,
): boolean | undefined {
  const inner = submitActionPayload(resp);
  if (inner === null) return undefined;
  const flag = inner.consumerPresent;
  return typeof flag === 'boolean' ? flag : undefined;
}

/**
 * Freeze-cue overlay (#483). A superseded (history) card gets a
 * subtle, theme-aware "superseded" veil + a labelled pill, and its
 * content is made non-interactive so a stale-view click can't even
 * reach a control. Idempotent — the overlay id guards a second call.
 * A polite live-region announcement (reusing the #447 announcer)
 * tells a screen-reader user the card is now history.
 */
const FREEZE_CUE_ID = '__ggui-superseded-cue__';

function applyFreezeCue(root: HTMLElement): void {
  if (typeof document === 'undefined') return;
  if (root.querySelector(`#${FREEZE_CUE_ID}`) !== null) return;

  // Non-interactive + visually receded — inherits the mount's own
  // colors, so it reads correctly in any theme.
  root.style.pointerEvents = 'none';
  root.style.opacity = '0.55';
  root.style.filter = 'grayscale(0.4)';
  root.style.transition = 'opacity 160ms ease, filter 160ms ease';
  if (getComputedStyle(root).position === 'static') {
    root.style.position = 'relative';
  }

  const pill = document.createElement('div');
  pill.id = FREEZE_CUE_ID;
  pill.setAttribute('role', 'note');
  pill.textContent = 'Superseded — a newer version continues below';
  Object.assign(pill.style, {
    position: 'absolute',
    top: '8px',
    right: '8px',
    padding: '4px 10px',
    borderRadius: '9999px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontSize: '11px',
    fontWeight: '600',
    color: 'var(--ggui-color-onSurface, inherit)',
    background: 'rgba(128,128,128,0.16)',
    border: '1px solid currentColor',
    opacity: '0.85',
    pointerEvents: 'none',
    zIndex: '2',
  } satisfies Partial<CSSStyleDeclaration>);
  root.appendChild(pill);

  announceToast('This card was superseded by a newer version below', 'fallback');
}

/** Container id for the announcer holding both live regions. */
const TOAST_ANNOUNCER_ID = '__ggui-toast-announcer__';

/**
 * The announcer's two live regions, keyed by politeness (ggui#447).
 *
 * Two regions rather than one with a swapped `aria-live`: politeness is
 * read when a region is REGISTERED, so a screen reader that already
 * mapped a node as polite is not guaranteed to notice it turning
 * assertive in the same mutation that delivers the text. Fixed
 * politeness per node removes the question.
 */
interface ToastLiveRegions {
  /** `role="status"` — queued behind whatever is being read. */
  readonly polite: HTMLElement;
  /** `role="alert"` — interrupts. Failure + action-required classes. */
  readonly assertive: HTMLElement;
}

/**
 * Ensure the pair of live regions the toast surface announces through.
 *
 * MUST be called before the first message can land — a live region
 * created in the same tick as its first content is a region the screen
 * reader was never watching, and that first announcement is lost. The
 * boot path calls this at the same point it mounts the render root, so
 * every toast (at minimum a user gesture away) lands in a region that
 * has been registered for many frames. The toast + cue paths call it
 * again defensively; it is idempotent per document.
 *
 * Visually hidden rather than `display:none`: a region that is not
 * rendered is not in the accessibility tree, and content added to it is
 * never announced. The clip rectangle keeps it out of the visual layout
 * while leaving it live.
 *
 * Returns `null` when the document has no body yet — nothing to attach
 * to, and no announcement is possible.
 *
 * @internal — exported for unit tests.
 */
export function ensureToastAnnouncer(doc: Document): ToastLiveRegions | null {
  if (doc.body === null) return null;
  const existing = doc.getElementById(TOAST_ANNOUNCER_ID);
  if (existing !== null) {
    const polite = existing.querySelector<HTMLElement>(
      '[data-ggui-toast-announce="polite"]',
    );
    const assertive = existing.querySelector<HTMLElement>(
      '[data-ggui-toast-announce="assertive"]',
    );
    if (polite !== null && assertive !== null) return { polite, assertive };
    // Half a container is worse than none — it looks mounted to the
    // idempotence check while announcing nothing. Rebuild whole.
    existing.remove();
  }
  const host = doc.createElement('div');
  host.id = TOAST_ANNOUNCER_ID;
  host.style.cssText = [
    'position:absolute',
    'width:1px',
    'height:1px',
    'margin:-1px',
    'padding:0',
    'border:0',
    'overflow:hidden',
    'clip:rect(0 0 0 0)',
    'clip-path:inset(50%)',
    'white-space:nowrap',
  ].join(';');
  const makeRegion = (politeness: 'polite' | 'assertive'): HTMLElement => {
    const region = doc.createElement('div');
    region.setAttribute('data-ggui-toast-announce', politeness);
    // Role and `aria-live` together: the role is the semantic, the
    // explicit `aria-live` is the belt for assistive technology that
    // does not map `role="status"` to a politeness on its own.
    region.setAttribute('role', politeness === 'polite' ? 'status' : 'alert');
    region.setAttribute('aria-live', politeness);
    // Toast text is one sentence that only makes sense whole — read the
    // region, not the diff.
    region.setAttribute('aria-atomic', 'true');
    host.appendChild(region);
    return region;
  };
  const polite = makeRegion('polite');
  const assertive = makeRegion('assertive');
  doc.body.appendChild(host);
  return { polite, assertive };
}

/**
 * Speak a toast message. `error` + `action_required` interrupt (a
 * gesture failed, or needs the user to act); everything else queues.
 *
 * Exactly one region carries text at a time — the other is cleared, so
 * a user who navigates to the announcer afterwards finds the current
 * message and not a transcript. Clearing is silent: assistive
 * technology announces content arriving in a live region, not content
 * leaving one.
 */
function announceToast(text: string, kind: ToastKind): void {
  if (typeof document === 'undefined') return;
  const regions = ensureToastAnnouncer(document);
  if (regions === null) return;
  // Whatever speaks last owns the region. A retraction scheduled for an
  // earlier relay cue would otherwise come due in the middle of THIS
  // message and take it down instead — and it could not be filtered out
  // by comparing text, because a cue and the fallback cue toast for the
  // same intent are character-identical. (Declared below; this only
  // ever runs long after module init.)
  cancelRelayCueRetraction();
  const interrupts = kind === 'error' || kind === 'action_required';
  const target = interrupts ? regions.assertive : regions.polite;
  const idle = interrupts ? regions.polite : regions.assertive;
  idle.textContent = '';
  target.textContent = text;
}

/**
 * Empty both live regions. Paired with every route that takes the
 * visible toast away, so the spoken surface and the visual one carry
 * the same message at the same time — including "nothing".
 */
function clearToastAnnouncement(): void {
  if (typeof document === 'undefined') return;
  const host = document.getElementById(TOAST_ANNOUNCER_ID);
  if (host === null) return;
  for (const region of Array.from(host.children)) {
    region.textContent = '';
  }
}

/**
 * Take the visible toast away, on every route that does so (auto-
 * dismiss timer, user dismissal, `drain_ack` resolution).
 *
 * A hidden toast must be inert to pointer, keyboard AND assistive
 * technology alike: the element keeps its fixed position over the top
 * of the render for the rest of the session, so anything left behind —
 * a live click target, a tab stop, an announced sentence — outlives the
 * message it belonged to.
 */
function hideToast(el: HTMLElement): void {
  el.style.opacity = '0';
  el.style.transform = 'translateX(-50%) translateY(8px)';
  el.style.pointerEvents = 'none';
  el.onclick = null;
  el.onkeydown = null;
  // Blur BEFORE `aria-hidden` lands: hiding the focused element from
  // the accessibility tree strands the screen reader's cursor on a node
  // it can no longer describe.
  if (el.ownerDocument.activeElement === el) el.blur();
  el.removeAttribute('role');
  el.removeAttribute('tabindex');
  el.removeAttribute('aria-label');
  el.setAttribute('aria-hidden', 'true');
  clearToastAnnouncement();
}

/**
 * Lightweight toast UX surface for dispatched actions. Renders a
 * fixed-position element at the bottom of the iframe so the user
 * gets immediate visual feedback that their gesture was registered
 * — "→ Sending action: archive" → "✓ Queued — agent will react"
 * (or "💬 Sent to chat" on ui/message fallback).
 *
 * Without this, the iframe is silent during dispatch. User clicks
 * and waits, with no way to distinguish "click was received but the
 * agent is busy" from "click was lost". Especially load-bearing in
 * the consume-pipe vs ui/message dual-path era — the toast tells
 * the user which path the gesture actually took.
 *
 * Direct DOM (not React-managed) because:
 *  - Works during boot before React mounts.
 *  - Doesn't interfere with the component tree the generator owns.
 *  - Survives React mount transitions inside the iframe.
 *
 * Single global toast (per iframe). Auto-dismisses after 2.5s on
 * `success` / `fallback` outcomes; the `pending` state holds
 * indefinitely until a follow-up call updates it.
 *
 * The visible element is only half the surface (ggui#447). Every
 * message is also spoken through {@link ensureToastAnnouncer}'s live
 * regions, and the element itself is hidden from the accessibility
 * tree so the sentence is not read twice. The one exception is
 * `action_required`, the only toast the user must OPERATE: it re-enters
 * the tree as a named button with a tab stop, because a dismissal that
 * needs a mouse is a dismissal some users cannot perform.
 *
 * Operator override: set `window.__GGUI_TOAST_DISABLED__ = true`
 * before the runtime boots to suppress (e.g., for first-party hosts
 * that want their own toast UI). Suppression covers both halves —
 * announcements mirror the visual feedback that actually happened, so
 * a host rendering its own toast chrome does not get a second, spoken
 * copy of ours.
 *
 * @internal — runtime-layer concern.
 */
type ToastKind =
  | 'pending'
  | 'success'
  | 'fallback' // legacy auto-dismissing fallback toast
  | 'action_required' // A8 — persistent "press send in chat to forward"
  | 'error';
function showActionToast(
  text: string,
  kind: ToastKind,
  onDismiss?: () => void,
): void {
  if (typeof document === 'undefined') return;
  const w = window as unknown as { __GGUI_TOAST_DISABLED__?: boolean };
  if (w.__GGUI_TOAST_DISABLED__) return;
  const id = '__ggui-action-toast__';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'pointer-events:auto',
      'max-width:90%',
      'padding:8px 14px',
      'border-radius:8px',
      'font:13px/1.4 system-ui,sans-serif',
      'color:#fff',
      'box-shadow:0 4px 12px rgba(0,0,0,.18)',
      'transition:opacity 180ms ease,transform 180ms ease',
      'opacity:0',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'cursor:pointer',
    ].join(';');
    document.body.appendChild(el);
  }
  const bg =
    kind === 'pending'
      ? 'rgba(60,60,68,.92)'
      : kind === 'success'
        ? 'rgba(34,139,84,.94)'
        : kind === 'fallback' || kind === 'action_required'
          ? 'rgba(110,89,165,.94)'
          : 'rgba(178,54,54,.94)';
  el.style.background = bg;
  el.textContent = text;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
  // Reset to the non-interactive posture every time, so a toast that
  // follows an `action_required` notice does not inherit its tab stop
  // and name. The `action_required` branch below re-applies them.
  el.setAttribute('aria-hidden', 'true');
  el.removeAttribute('role');
  el.removeAttribute('tabindex');
  el.removeAttribute('aria-label');
  el.style.pointerEvents = 'none';
  el.onkeydown = null;
  announceToast(text, kind);
  // Clear any prior auto-dismiss timer so a fresh pending toast
  // doesn't get hidden mid-flight.
  const elWithTimer = el as HTMLElement & { __toastTimer?: number };
  if (elWithTimer.__toastTimer) clearTimeout(elWithTimer.__toastTimer);
  // `action_required` PERSISTS until the user dismisses the toast
  // (click, Enter or Space). Per MCP Apps spec, `ui/message` is a
  // PREPARED user prompt — the host renders it into the chat input
  // but the user must press send for it to reach the agent. So the
  // toast can't auto-dismiss; doing so would imply the gesture went
  // through when it actually requires a user follow-up.
  //
  // `onDismiss` fires on that click — the only signal a caller gets
  // that the user has read and closed a persistent notice. The relay
  // notice uses it to arm the post-dismissal cue (ggui#442).
  if (kind === 'action_required') {
    // The dismissal is a real control, so it carries real control
    // semantics: a role, an accessible name that says what activating
    // it does, a tab stop, and the two keys a button responds to. The
    // announcement already carried the message; this carries the way
    // out of it.
    const target = el;
    target.removeAttribute('aria-hidden');
    target.setAttribute('role', 'button');
    target.setAttribute('tabindex', '0');
    target.setAttribute('aria-label', `${text} Activate to dismiss.`);
    target.style.pointerEvents = 'auto';
    const dismiss = (): void => {
      hideToast(target);
      onDismiss?.();
    };
    target.onclick = dismiss;
    target.onkeydown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      // Space scrolls the page by default; a button must not.
      ev.preventDefault();
      dismiss();
    };
  } else {
    el.onclick = null;
    if (kind === 'success' || kind === 'fallback' || kind === 'error') {
      const target = el;
      elWithTimer.__toastTimer = window.setTimeout(() => {
        hideToast(target);
      }, 2500);
    }
  }
}

/**
 * Dismiss the global action toast immediately. Used by the per-action
 * state machine when a `drain_ack` frame resolves the action as
 * `consumed`.
 */
function dismissActionToast(): void {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('__ggui-action-toast__');
  if (!el) return;
  hideToast(el);
  const elWithTimer = el as HTMLElement & { __toastTimer?: number };
  if (elWithTimer.__toastTimer) {
    clearTimeout(elWithTimer.__toastTimer);
    elWithTimer.__toastTimer = undefined;
  }
}

// Drain-ack listener: the server's `drain_ack` frame carries the
// `eventId` (= the iframe-computed `actionId`). We match on it and
// dismiss the toast. Returning `true` short-circuits other listeners
// (eventId is a primary key) — the pipe is the canonical data path,
// drain_ack is the optional UI-resolution signal.
subscribeDrainAck((payload) => {
  if (typeof payload.eventId !== 'string' || payload.eventId.length === 0) {
    return false;
  }
  dismissActionToast();
  return true;
});

/**
 * Build the iframe-local snapshot of every contextSpec slot value as
 * of right now. Captured atomically with the gesture so the agent
 * sees WHAT the user did AND WHAT THEY WERE LOOKING AT in one pipe
 * entry. Empty object when no slots have been registered.
 */
function readLocalUiContext(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [slotName, value] of contextSlotLastValues) {
    out[slotName] = value;
  }
  return out;
}

/**
 * Emit the `ai.ggui/userAction` PURE DOORBELL on a `ui/message`
 * envelope. Fires when `submit_action` succeeded BUT the server
 * reported `consumerPresent: false` — no `ggui_consume` long-poll is
 * currently listening on this render's pipe (the agent's persistent
 * consume loop has ended, e.g. after a page reload). The gesture is
 * ALREADY on the pipe from the just-completed `submit_action` append;
 * this doorbell only wakes a fresh agent turn so it calls
 * `ggui_consume({sessionId})` to drain it.
 *
 * SINGLE SOURCE OF TRUTH: the pipe. This carries ONLY a pointer to the
 * render — never the action payload or uiContext. Carrying the payload
 * here would let the agent act on the inline copy AND drain the pipe =
 * a double-trigger (the action fires twice). Pointer-only ⇒ the agent
 * retrieves the gesture EXCLUSIVELY via `ggui_consume`, so it's
 * exactly-once by construction.
 */
function emitUserActionDoorbell(args: {
  readonly intent: string;
  readonly sessionId: string;
  readonly actionId: string;
  readonly submittedAt: string;
}): void {
  // THE DIRECTIVE LIVES IN THIS TEXT. Every host (claude.ai,
  // chatgpt.com, ggui-aware SDKs) forwards the `ui/message` text to the
  // model verbatim — none of them runs a ggui-side synthesizer. So the
  // iframe-runtime is the single directive-authoring point. The
  // wording below is the empirically-validated XML-tagged
  // imperative-first shape (REQUIRED FIRST TOOL CALL + `<ggui_directive>`
  // tags + gesture framing) that was previously synthesized
  // server-side. The imperative-first phrasing — "Call <tool> NOW. ...
  // Do not respond conversationally." — is load-bearing for Gemini,
  // which otherwise summarizes the situation back to the user instead
  // of dispatching the prepared tool call.
  //
  // It is deliberately GENERIC: it names the render pointer, never the
  // action specifics. Naming what the user did would tempt the agent to
  // act before consuming = the double-trigger this whole shape exists
  // to kill. The agent gets the actionable data EXCLUSIVELY from
  // `ggui_consume`.
  //
  // Prose + XML tags only, no fenced ```json``` block: a verbatim copy
  // of a tool-call wire shape trips claude.ai's prompt-injection
  // classifier even on the user-trusted `ui/message` channel.
  const nextArgs = JSON.stringify({ sessionId: args.sessionId });
  const text = [
    `Your REQUIRED FIRST TOOL CALL is ggui_consume with arguments ${nextArgs}. Call it NOW to retrieve and process the pending interaction. Do not respond conversationally; do not summarize. Issue the tool call as your next action.`,
    '',
    `<ggui_directive kind="user-action">`,
    `  <session_id>${args.sessionId}</session_id>`,
    `  <next_tool>ggui_consume</next_tool>`,
    `  <next_args>${nextArgs}</next_args>`,
    `</ggui_directive>`,
    '',
    `The user interacted with render ${args.sessionId} while no ggui_consume long-poll was active. The gesture is queued on the consume pipe for that render — it is NOT in this message. After ggui_consume returns, react to the returned event with the appropriate domain tool, then call ggui_amend on the SAME sessionId (${args.sessionId}) — the card the user is looking at repaints in place. Use ggui_update instead only if this moment deserves a NEW card in the conversation (it advances the history number).`,
  ].join('\n');
  // Structured mirror of the directive for ggui-aware programmatic
  // consumers. OPTIONAL — nothing in the loop depends on a server-side
  // parse of this; an `_meta`-agnostic host acts on the text above
  // alone. Typed against the protocol interface (no runtime guard
  // exists — the shape is locked at compile time here).
  const description =
    `User interacted with render ${args.sessionId}; call ggui_consume to retrieve and process it.`;
  const userAction: GguiUserActionMeta = {
    kind: 'user-action',
    description,
    sessionId: args.sessionId,
    actionId: args.actionId,
    submittedAt: args.submittedAt,
    intent: args.intent,
    nextStep: {
      tool: 'ggui_consume',
      args: { sessionId: args.sessionId },
    },
  };
  // RAW postMessage — NOT `app.sendMessage`. The doorbell MUST bypass
  // the App's `ui/message` request path because the host validates the
  // incoming request through the spec's CLOSED `McpUiMessageRequestSchema`
  // (`Protocol.setRequestHandler` → `parseWithCompat`). That schema's
  // `content` array is the spec `ContentBlockSchema`, which has no place
  // for our content-block `_meta` extension — the parse strips the
  // extension AND (as observed on the first live post-reload doorbell)
  // can leave the host's `handleAppMessage` with an empty
  // `content[0].text`, so it rejects the doorbell with `isError` and no
  // fresh agent turn fires.
  //
  // `postToParent` posts the JSON-RPC frame verbatim to the parent, so
  // BOTH `content[0].text` (the load-bearing directive every host
  // forwards to the model) AND `content[0]._meta["ai.ggui/userAction"]`
  // (the optional structured mirror) survive intact. This is the same
  // deliberate raw-postMessage decision `ui/message` carried in #275 —
  // the userAction-collapse refactor regressed it onto `app.sendMessage`.
  //
  // Spec-canonical shape: `_meta` lives on the CONTENT BLOCK (the spec
  // closes `params._meta` via `additionalProperties: false`, but each
  // content block has its own `_meta: { [key: string]: unknown }` open
  // record — the proper extension point). Namespaced under
  // `ai.ggui/userAction` to match our other protocol extensions
  // (`ai.ggui/render`, `ai.ggui/bootstrap`, etc.).
  currentTelemetrySink?.record('doorbell.ring', args.sessionId);
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/message',
    params: {
      role: 'user',
      content: [
        {
          type: 'text',
          text,
          _meta: {
            'ai.ggui/userAction': userAction,
          },
        },
      ],
    },
  });
}

/**
 * Latch for the relay-incapability notice (ggui#440). A host that
 * cannot relay fails EVERY gesture, so the explanation is stated once
 * and left standing; without the latch the user gets one identical
 * toast per click, which is the #426 failure mode this closes.
 *
 * Cleared by ANY well-formed result envelope — `{ok:true}` and
 * `{ok:false}` alike, either proves the host can relay (see the
 * response-arrival guard in {@link dispatchSubmitAction}). Both
 * transition edges emit a `relay-incapability` observability event;
 * nothing else about the latch is observable to the host.
 */
let relayIncapabilityAnnounced = false;

/**
 * Module-level handle to the CURRENT boot's telemetry sink so
 * module-scope paths (the doorbell emitter below) can report without
 * threading the sink through every call chain. Per-iframe
 * single-tenancy makes a single slot correct — same justification as
 * `getCurrentApp()`.
 */
let currentTelemetrySink: TelemetrySink | null = null;

/**
 * Freeze latch (#483): set true once a higher-epoch `ggui_update`
 * supersedes this mount. A frozen mount is HISTORY — its gestures no
 * longer target the live session, so `dispatchSubmitAction` drops them
 * (a stale-view submit against the live head is a prevented bug class).
 * Module-level for the same single-mount-per-iframe reason as
 * `currentTelemetrySink`.
 */
let mountSuperseded = false;

/**
 * Whether the user has manually dismissed the CURRENTLY-STANDING relay
 * notice (ggui#442).
 *
 * "Dismissed the one explanation" is not "wants zero feedback forever",
 * but it IS consent that the explanation itself has been read. So the
 * dead zone this opens is filled with a per-gesture CUE, never with the
 * notice again.
 *
 * Scoped to the notice, not to toasts in general: the doorbell's
 * `action_required` toast is a different message with a different
 * dismissal meaning, so the flag is set from the relay notice's own
 * `onDismiss` callback rather than from `showActionToast` at large.
 *
 * Reset on BOTH latch edges — a re-latch shows a fresh notice nobody
 * has dismissed yet, and a self-heal must leave no residue behind.
 */
let relayNoticeDismissed = false;

/**
 * Timestamp of the last fallback cue toast, for the throttle below.
 * Reset alongside the latch so a new dead zone never inherits an old
 * one's quiet period.
 */
let lastRelayCueToastAt = 0;

/**
 * Timestamp of the last SPOKEN cue (ggui#447), on its own clock.
 *
 * Separate from the toast clock because the two cue shapes are
 * mutually exclusive per gesture — a gesture either pulses a focused
 * control or falls back to the toast — and each needs its own quiet
 * period to be the one it advertises.
 */
let lastRelayCueAnnouncedAt = 0;

/**
 * Intent named by the standing spoken cue, or `null` when none is.
 *
 * The throttle is keyed on this as well as the clock. A quiet period
 * that ignores WHICH action was attempted does not merely withhold the
 * second cue — it leaves the region still naming the FIRST one, so a
 * screen reader asked to re-read it reports the wrong action as the
 * thing that just failed. Silence is a defensible answer to a repeat;
 * it is never a defensible answer to a different gesture.
 */
let lastRelayCueAnnouncedIntent: string | null = null;

/**
 * Expiry timer for the standing spoken cue, held so a repeat can cancel
 * its predecessor instead of racing it.
 */
let relayCueAnnounceTimer: number | undefined;

/** Class carrying the pulse animation; also the `@keyframes` name. */
const RELAY_CUE_CLASS = 'ggui-relay-cue-pulse';
/** Stable id for the injected `<style>` — idempotent per document. */
const RELAY_CUE_STYLE_ID = 'ggui-relay-cue-style';
/** Pulse duration (ms). Brief enough to read as acknowledgement. */
const RELAY_CUE_DURATION_MS = 400;
/** At most one fallback cue toast, and one spoken cue, per window (ms). */
const RELAY_CUE_THROTTLE_MS = 5_000;
/**
 * How long a spoken cue stands before it is retracted (ms).
 *
 * Matches the toast's own auto-dismiss cadence, and deliberately
 * outlasts the 400ms pulse by a wide margin: content pulled out of a
 * live region too soon after it lands can be dropped before the screen
 * reader gets to it, so retracting at pulse-end would trade a stale
 * announcement for a missing one.
 */
const RELAY_CUE_ANNOUNCE_TTL_MS = 2_500;

/**
 * Drop the retraction a standing spoken cue has pending, because
 * something newer is about to own the region — another cue, a toast, or
 * a latch edge that ends the dead zone entirely. Left armed, it comes
 * due mid-message and clears whatever is in the region then.
 */
function cancelRelayCueRetraction(): void {
  if (relayCueAnnounceTimer === undefined) return;
  clearTimeout(relayCueAnnounceTimer);
  relayCueAnnounceTimer = undefined;
}

/**
 * Give the dead zone a fresh quiet period. Called on both latch edges
 * and from the test reset — every throttle belongs to the notice that
 * is standing NOW, so a new one never inherits an old one's silence.
 */
function resetRelayCueThrottles(): void {
  lastRelayCueToastAt = 0;
  lastRelayCueAnnouncedAt = 0;
  lastRelayCueAnnouncedIntent = null;
  cancelRelayCueRetraction();
}

/** @internal — exported for unit tests to reset module state. */
export function __resetRelayNoticeForTest(): void {
  relayIncapabilityAnnounced = false;
  relayNoticeDismissed = false;
  resetRelayCueThrottles();
}

/**
 * Inject the pulse keyframes once per document. Mirrors how
 * `react-renderer.ts` injects its theme CSS — `<style>` with a stable
 * id on `<head>`, idempotent on repeat calls.
 *
 * Lazy rather than at boot: a session that never enters the dead zone
 * never pays for the rule.
 */
function ensureRelayCueStyle(): void {
  if (document.getElementById(RELAY_CUE_STYLE_ID) !== null) return;
  const style = document.createElement('style');
  style.id = RELAY_CUE_STYLE_ID;
  // Opacity only. Anything touching geometry (scale, translate, outline
  // width) would have to make assumptions about the generated markup it
  // lands on — this cue is applied to whatever the user happened to
  // focus, so it must be incapable of disturbing any layout.
  style.textContent =
    `@keyframes ${RELAY_CUE_CLASS}{0%,100%{opacity:1}50%{opacity:.45}}` +
    `.${RELAY_CUE_CLASS}{animation:${RELAY_CUE_CLASS} ` +
    `${RELAY_CUE_DURATION_MS}ms ease-in-out}`;
  document.head.appendChild(style);
}

/**
 * The element to pulse, or `null` when there isn't a usable one.
 *
 * Usable means: a real focused element that belongs to the render. A
 * document with nothing focused reports `document.body`, which is not a
 * control the user just pressed; and anything outside
 * `[data-ggui-session-root]` (host chrome, the toast itself) is not
 * ours to animate. Both fall through to the toast.
 *
 * The root ITSELF is excluded too. `contains` is reflexive, so a
 * focused session root would otherwise pulse the whole render — the
 * opposite of a cue pointing at one control. That is reachable: the
 * root is reused if one already exists in the document (see
 * `ensureStatusDom`), so a host or a generated tree can hand it a
 * `tabindex` and focus it.
 */
function resolveRelayCueTarget(): Element | null {
  const active = document.activeElement;
  if (active === null || active === document.body) return null;
  const root = document.querySelector('[data-ggui-session-root]');
  if (root === null || active === root || !root.contains(active)) return null;
  return active;
}

/**
 * Speak the pulse (ggui#447).
 *
 * The pulse animates opacity on a control the runtime does not own, so
 * it carries nothing to assistive technology and nothing may be added
 * to that control — a role or label written onto generated markup would
 * be a lie about someone else's element. The honest counterpart is a
 * message in the announcer's own region, saying what the pulse means.
 *
 * NOT gated on `__GGUI_TOAST_DISABLED__`: that flag suppresses our
 * toast chrome, and the pulse is not toast chrome — it fires either
 * way. Announcing on the same condition as the visual keeps the two
 * cues telling the same story.
 *
 * Throttled on its own clock, unlike the pulse — but only against
 * IDENTICAL repeats. A flash repeating on every gesture costs a sighted
 * user nothing to ignore, while the same sentence read aloud each time
 * buries whatever else the screen reader was saying and carries no new
 * information. A DIFFERENT action is new information: withholding it
 * would leave the region naming the previous gesture, which reads as a
 * confident answer about the wrong thing. The two cues share a meaning,
 * not a rate.
 *
 * The cue also expires. A live region is a description of what is
 * happening now, and a 400ms pulse that leaves a sentence standing for
 * the rest of the session is the same stale-announcement defect the
 * toast half avoids by clearing on hide.
 */
function announceRelayCue(intent: string): void {
  const now = Date.now();
  if (
    intent === lastRelayCueAnnouncedIntent &&
    now - lastRelayCueAnnouncedAt < RELAY_CUE_THROTTLE_MS
  ) {
    return;
  }
  lastRelayCueAnnouncedAt = now;
  lastRelayCueAnnouncedIntent = intent;
  // `announceToast` cancels any retraction still pending, so the timer
  // armed here is always the only one in flight.
  announceToast(`⚠ ${intent} — not delivered`, 'error');
  relayCueAnnounceTimer = window.setTimeout(() => {
    relayCueAnnounceTimer = undefined;
    retractRelayCueAnnouncement();
  }, RELAY_CUE_ANNOUNCE_TTL_MS);
}

/**
 * Take a spoken cue back down once it has been heard.
 *
 * Unconditional, because by the time it runs the region can only hold
 * this cue's own sentence or nothing at all: every other write to the
 * region goes through {@link announceToast}, which cancels this
 * retraction before it speaks.
 *
 * That cancellation is the whole mechanism — comparing text here could
 * not substitute for it. The pulse cue and the fallback cue toast build
 * their sentences from the SAME template, so for one intent the two are
 * character-identical and no comparison can tell a dead cue from a live
 * toast.
 */
function retractRelayCueAnnouncement(): void {
  if (typeof document === 'undefined') return;
  const regions = ensureToastAnnouncer(document);
  if (regions === null) return;
  regions.assertive.textContent = '';
}

/**
 * The dead-zone cue (ggui#442): the smallest honest "that did nothing"
 * signal, for a gesture on a host already known — and already
 * explained — to be relay-incapable.
 *
 * Component-agnostic by construction. It pulses whatever the user
 * focused without knowing what that is, and falls back to the toast
 * primitive when there is nothing to pulse. Either shape also SPEAKS
 * (ggui#447) — the pulse via {@link announceRelayCue}, the fallback via
 * the toast primitive's own announcement.
 */
function showPostDismissalCue(intent: string): void {
  if (typeof document === 'undefined') return;
  const target = resolveRelayCueTarget();
  if (target !== null) {
    // A pulse already running on this element IS the acknowledgement
    // for this gesture too. Re-adding a present class would not restart
    // the animation anyway (that needs a reflow), and racing two
    // removal timers on one element is how a class gets stranded.
    if (target.classList.contains(RELAY_CUE_CLASS)) return;
    ensureRelayCueStyle();
    target.classList.add(RELAY_CUE_CLASS);
    announceRelayCue(intent);
    // Both cleanup routes cancel the other. Without the `clearTimeout`,
    // a pulse ended early by `animationend` leaves its timer armed, and
    // that timer later strips whatever class is on the element THEN —
    // truncating the next pulse partway through. The window is the gap
    // between the two, which widens on any host that ends the
    // animation early.
    const clear = (): void => {
      target.classList.remove(RELAY_CUE_CLASS);
      target.removeEventListener('animationend', clear);
      // `timer` is declared below; `clear` only ever RUNS after that
      // line, so it always reads an initialized id.
      clearTimeout(timer);
    };
    target.addEventListener('animationend', clear, { once: true });
    // Belt for real browsers, braces for everything that never fires
    // `animationend`: jsdom, a display:none subtree, and any host whose
    // reduced-motion policy skips the animation outright.
    const timer = window.setTimeout(clear, RELAY_CUE_DURATION_MS + 100);
    return;
  }
  const now = Date.now();
  if (now - lastRelayCueToastAt < RELAY_CUE_THROTTLE_MS) return;
  lastRelayCueToastAt = now;
  // The toast primitive's auto-dismissing variant — this is a cue, not
  // a second explanation, so it must clear itself. Throttled because a
  // per-click toast on a host that fails every click is the #426
  // failure mode the latch exists to prevent.
  showActionToast(`⚠ ${intent} — not delivered`, 'error');
}

/**
 * Dispatch a submit-action via the empirically-validated bridge
 * chain (validated against claude.ai): a `tools/call` to
 * {@link toolName} (the `ggui_runtime_submit_action` receiver)
 * appends the gesture to the render's consume pipe, paired with a
 * silent `ui/update-model-context` prime and — only when the server
 * reports no active `ggui_consume` long-poll — a `ui/message`
 * doorbell so a fresh agent turn drains the pipe. Hosts MUST honor
 * `_meta.ui.visibility:['app']` per spec §401, otherwise the
 * `tools/call` is silently rejected (probe found this empirically).
 *
 * @internal — exported for unit tests.
 */
export function dispatchSubmitAction(args: {
  readonly toolName: string;
  readonly intent: string;
  readonly data: unknown;
  readonly sessionId: string;
  readonly appId: string;
}): void {
  if (typeof window === 'undefined') return;
  // Freeze latch (#483): a superseded (history) mount does not drive
  // the live session — drop the gesture rather than submit a stale
  // view's action against the current head.
  if (mountSuperseded) {
    currentTelemetrySink?.record('gesture.dropped_superseded', args.intent);
    return;
  }
  const { toolName, intent, data, sessionId, appId } = args;
  // Gesture-path telemetry — the click's own autopsy trail. #471
  // round 12 hit a frame whose channels + beacons were fully healthy
  // while clicks produced NOTHING observable; without a record at the
  // dispatch entry there is no way to tell "handler never fired" from
  // "dispatch swallowed it" on a console-less host.
  currentTelemetrySink?.record('gesture.dispatch', JSON.stringify({ intent, toolName }));
  const firedAt = new Date().toISOString();
  const actionId = fnv1aHex(
    `${intent}|${JSON.stringify(data ?? null)}|${firedAt}`,
  );
  const inlineData = formatSubmitActionDataInline(data);
  const dataPart = inlineData === '' ? '' : ` (${inlineData})`;
  const uiContext = readLocalUiContext();

  // (1) Silent context update — fires FIRST and ALWAYS. Primes the
  // LLM's widget-context surface regardless of which downstream path
  // catches the event (pipe or ui/message). Fire-and-forget; no
  // response needed.
  callAppUpdateModelContext({
    content: [
      {
        type: 'text',
        text: `[ggui:pending-action] ${JSON.stringify({
          actionId,
          intent,
          data: data ?? null,
          firedAt,
          sessionId,
          appId,
        })}`,
      },
    ],
  });

  // (1.5) Toast — pending state. User sees "→ Sending: archive"
  // immediately so they know the click was registered, even when
  // submit_action's HTTP round-trip takes a moment. State updates
  // when the response (or fallback) lands.
  //
  // Skipped once the relay-incapability notice has latched (ggui#440):
  // we already know this host can't relay, so a fresh "sending…" flash
  // would clobber the persistent explanation with a transient state
  // that nothing downstream ever restores — the opposite of "left
  // standing" (see the latch declaration + terminal branch below).
  //
  // Once that explanation has been DISMISSED, though, skipping leaves
  // the gesture with no feedback at all — the dead zone ggui#442
  // names. The cue fills it here, at dispatch time, because the
  // element it pulses is the one the user has focused NOW; by the time
  // the relay response settles, focus may have moved on.
  if (!relayIncapabilityAnnounced) {
    showActionToast(`→ ${intent}${dataPart}`, 'pending');
  } else if (relayNoticeDismissed) {
    showPostDismissalCue(intent);
  }

  // (2) Try submit_action via host relay. Spec-compliant hosts
  // forward the tools/call to the MCP server's submit_action handler;
  // the pipe entry lands with `id: actionId`. On success, branch on
  // `consumerPresent`:
  //   - true (or undefined): toast stays `pending`; drain_ack will
  //     dismiss it when the agent's ggui_consume drains the event.
  //   - false: no `ggui_consume` long-poll is currently listening
  //     (the agent's persistent consume loop has ended — e.g. after a
  //     page reload). Emit the `ai.ggui/userAction` PURE DOORBELL on a
  //     `ui/message` so a fresh agent turn calls `ggui_consume` to
  //     drain the gesture we just enqueued. No timer, no rescue, no
  //     payload — the pipe is the single source of truth.
  //
  // On any non-success outcome (PIPE_NOT_FOUND, transport error, host
  // has no relay) the gesture could NOT be enqueued; there is nothing
  // to point a doorbell at, so we surface a toast and stop. Post-reload
  // recovery for the abort-aware long-poll is a separate server-side
  // concern (#292); this client never inlines the action payload.
  void (async () => {
    let resp: JsonRpcResponse | null = null;
    try {
      resp = await callServerToolSpec(toolName, {
        kind: 'dispatch',
        payload: {
          intent,
          actionData: data ?? null,
          uiContext,
        },
        sessionId,
        appId,
        actionId,
        firedAt,
      });
    } catch {
      showActionToast(`⚠ ${intent} — transport error`, 'error');
      resp = null;
    }
    // Final hop of the gesture autopsy trail — what the relay
    // answered (or that it didn't).
    currentTelemetrySink?.record(
      'gesture.result',
      JSON.stringify({
        intent,
        ok: resp !== null && resp.error === undefined,
        ...(resp?.error?.message !== undefined
          ? { error: resp.error.message.slice(0, 120) }
          : {}),
      }),
    );
    // Self-healing (ggui#440): a result envelope arriving at all is
    // proof this host CAN relay — `{ok:false, code:'PIPE_NOT_FOUND'}`
    // (an otherwise-healthy relay, expired pipe) proves it exactly as
    // much as `{ok:true}` — so any earlier (possibly false — see
    // `isRelayShapedFailure`) "cannot relay" latch no longer holds.
    // Cleared HERE, at response arrival, so the success path and the
    // `{ok:false}` path below both release it; clearing also
    // un-freezes `channelToolsCall`'s guard, which reads this same
    // latch. Transition-edged: acts (and emits the observability
    // edge) only when a latch was actually standing. No oscillation
    // within one dispatch — the latch-set branch below requires
    // `isRelayShapedFailure(resp)`, which this guard excludes.
    if (
      relayIncapabilityAnnounced &&
      resp !== null &&
      !isRelayShapedFailure(resp)
    ) {
      relayIncapabilityAnnounced = false;
      // Self-heal leaves NO cue residue (ggui#442): the dead zone is
      // gone, so the state that armed the cue goes with it. A later
      // re-latch starts from a clean slate.
      relayNoticeDismissed = false;
      resetRelayCueThrottles();
      postObservabilityToParent({
        kind: 'relay-incapability',
        state: 'cleared',
      });
      // The (1.5) pending toast above was SKIPPED for this gesture —
      // the latch was still standing at dispatch time — so a bare
      // clear leaves the now-false "cannot relay" notice standing with
      // no successor until a `drain_ack` frame that may never arrive
      // in MCP-Apps relay contexts. On the success sub-case, replace
      // it with the ordinary pending toast so the drain_ack dismissal
      // chain below has a predecessor to dismiss. No equivalent is
      // needed on the {ok:false} sub-case: that path always falls
      // through to the terminal "could not reach the agent" toast a
      // few lines down, which already replaces the stale notice.
      if (classifySubmitActionResponse(resp) === 'success') {
        showActionToast(`→ ${intent}${dataPart}`, 'pending');
      }
    }
    if (resp !== null && classifySubmitActionResponse(resp) === 'success') {
      const consumerPresent = extractConsumerPresent(resp);
      if (consumerPresent !== true) {
        // No `ggui_consume` long-poll is POSITIVELY confirmed to be
        // draining this render's pipe, so the gesture needs a fresh
        // agent turn. `ui/message` is the ONLY view→host method that
        // can start one — a host that does not accept it cannot be
        // woken by us at all, and the user has to send a message
        // themselves (ggui#440).
        //
        // `!== true` (not `=== false`) is load-bearing: a relay host
        // that normalizes the tool result and strips the
        // `consumerPresent` field (claude.ai's live behavior — the
        // first #471 retest click died exactly here) must ring the
        // doorbell, not wait forever for a drain_ack that cannot
        // arrive without a live channel. The doorbell is pointer-only
        // and the pipe pop is exactly-once, so a redundant ring on a
        // field-stripping host with a live consumer costs one empty
        // `ggui_consume`; servers that CAN answer always send an
        // explicit `true` (the factory wires the registry
        // unconditionally), so confirmed-consumer hosts stay quiet.
        showActionToast(
          hostCanReceiveMessages()
            ? `💬 ${intent}${dataPart} — agent not listening, sent to chat`
            : `💬 ${intent}${dataPart} — agent not listening. Send a message to continue.`,
          'action_required',
        );
        emitUserActionDoorbell({
          intent,
          sessionId,
          actionId,
          submittedAt: firedAt,
        });
        return;
      }
      // consumerPresent === true — a live long-poll is confirmed
      // draining the pipe. Toast stays `pending`; the drain_ack
      // listener dismisses it when ggui_consume drains the event.
      return;
    }

    // Enqueue failed (pipe gone / transport error / host has no relay).
    // The gesture is not on any pipe, so a doorbell would point at an
    // empty queue; no `ui/message` is emitted either way.
    //
    // Separate the STRUCTURAL case from the transient one (ggui#440):
    // when the host never advertised `serverTools`, every gesture will
    // fail identically, so explain it once, persistently, instead of
    // one identical error toast per click. Latching requires ALL of:
    //
    //   - `hostCapabilitiesCaptured()` — the handshake has actually
    //     resolved. Before that, capability absence is "not asked
    //     yet", not "advertised nothing"; a gesture that fails in the
    //     mount-to-handshake window would otherwise falsely latch a
    //     fully-capable host that just hasn't finished connecting.
    //   - `!hostCanRelayToolCalls()` — the host never advertised
    //     `serverTools`.
    //   - `isRelayShapedFailure(resp)` — NO well-formed result
    //     envelope arrived. A `{ok:false, code:'PIPE_NOT_FOUND'}`
    //     result (the common expired-pipe case) is proof the host DID
    //     relay the call there and back; latching on that would falsely
    //     brand a working relay as incapable and freeze the channel
    //     router pre-attempt. That case has already CLEARED any
    //     standing latch at the response-arrival guard above, and
    //     keeps routing to the ordinary per-gesture transient toast
    //     below instead.
    if (
      hostCapabilitiesCaptured() &&
      !hostCanRelayToolCalls() &&
      isRelayShapedFailure(resp)
    ) {
      if (!relayIncapabilityAnnounced) {
        relayIncapabilityAnnounced = true;
        // Transition edge — the paired 'cleared' edge lives at the
        // response-arrival guard above. NEVER emit off-edge (e.g. per
        // channel poll tick): the router ticks on an interval and
        // would spam; the two edges carry the full information.
        postObservabilityToParent({
          kind: 'relay-incapability',
          state: 'latched',
        });
        // Establish the flag's invariant where the notice it describes
        // is created: a freshly-shown notice is undismissed, and its
        // dead zone starts with an unspent throttle. Today every
        // re-latch already passes through the clear edge above (which
        // resets both), so this is the same value arriving by a second
        // route — kept because the state belongs to THIS notice, and a
        // future second latch-set path shouldn't have to know that.
        relayNoticeDismissed = false;
        resetRelayCueThrottles();
        showActionToast(
          'This host cannot relay actions to the agent — interactive controls will not work here.',
          'action_required',
          () => {
            relayNoticeDismissed = true;
          },
        );
      }
      return;
    }
    showActionToast(`⚠ ${intent} — could not reach the agent`, 'error');
  })();
}

/**
 * Channel-transport router's `tools/call` invoker (ggui#440) —
 * iframe-polling transport, `tools/call` against the parent MCP host
 * via `app.callServerTool` (spec-canonical) when the App handle is
 * set; falls back to raw postMessage pre-handshake or in tests.
 * Direct call (no LLM consent loop). Returns the tool's
 * structuredContent (or `content[0]` if that's where the payload
 * landed) as a `JsonValue`. On RPC error we throw — the router
 * catches and silently retries on the next tick.
 *
 * Once a REAL gesture has confirmed this host can't relay (the latch
 * above — set only after {@link dispatchSubmitAction} actually tried
 * and failed on a host with no `serverTools` advertised, with
 * capabilities already captured, AND the failure was relay-shaped —
 * not a well-formed `{ok:false}` result; see `isRelayShapedFailure`),
 * every subsequent poll will fail identically.
 *
 * This guard does NOT stop the router's poll loop, and nothing here
 * should ever be written so that it could (ggui#443). It does two
 * things. It makes each doomed tick CHEAP — the poll throws before
 * the `callServerToolSpec` round-trip. And, by throwing the typed
 * {@link RelayIncapableError} rather than a bare `Error`, it tells
 * the router WHICH KIND of failure this is: `channel-transport.ts`'s
 * tick classifies structural rejections apart from transient ones and
 * drops the channel to a slow probe cadence, emitting one
 * `channel-poll-degraded` event per transition. The first poll that
 * succeeds after the latch clears restores the normal cadence and
 * emits `channel-poll-recovered`.
 *
 * The channel keeps probing throughout, which is what makes that
 * recovery possible: the latch clears only when a call succeeds, and
 * only an attempt can discover that. A channel stopped on structural
 * failure could never come back.
 *
 * Keyed on the LATCH, not on `hostCanRelayToolCalls()` directly: raw
 * advertisement absence never changes after boot, so gating on it
 * here would throw pre-attempt for the LIFE OF THE SESSION on any
 * host that under-advertises but genuinely proxies `tools/call`
 * (ggui's own embed host pre-Task-2 is exactly this case) — silently
 * killing working channel polls forever. That is "absence of a
 * capability blocks an attempt", which the fail-safe constraint
 * forbids. The latch implies `!hostCanRelayToolCalls()` (it only
 * ever sets inside that guard), so testing it alone is sufficient —
 * a host that never fails a real gesture never latches, and its
 * channels keep working.
 *
 * Extracted to a named export (rather than an inline closure inside
 * `bootProduction`) so unit tests can drive it directly through the
 * lightweight `MockTransport` harness — `bootProduction` dynamic-
 * imports the full react/design/wire module graph, which is too
 * heavy to exercise from a spec file (see
 * `boot-production-context.test.ts`'s docstring for precedent).
 *
 * @internal — exported for unit tests + production reuse.
 */
export async function channelToolsCall(args: {
  readonly toolName: string;
  readonly args: JsonObject;
}): Promise<JsonValue> {
  if (relayIncapabilityAnnounced) {
    throw new RelayIncapableError();
  }
  const resp = await callServerToolSpec(args.toolName, args.args);
  if (resp.error !== undefined) {
    throw new Error(resp.error.message ?? 'tools/call failed');
  }
  const result = resp.result;
  if (result === null || typeof result !== 'object') {
    return null;
  }
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (structured !== undefined) return structured as JsonValue;
  return result as JsonValue;
}

/**
 * Resolve the name of the spec-canonical submit-action receiver tool
 * the dispatch path targets with `tools/call`.
 *
 * @internal — exported for unit tests + production reuse.
 */
export function resolveDispatchToolName(): string {
  // Operator escape hatch — `window.__GGUI_DISPATCH_TOOL__` lets a
  // host override the receiver tool name when running ggui under a
  // server that publishes the spec-canonical receiver under a
  // different name (the agent SDK extension surface). Default:
  // `ggui_runtime_submit_action` per the OSS handler at
  // `@ggui-ai/mcp-server-handlers::createGguiSubmitActionHandler`.
  if (typeof window === 'undefined') return 'ggui_runtime_submit_action';
  const override = (
    window as unknown as { __GGUI_DISPATCH_TOOL__?: unknown }
  ).__GGUI_DISPATCH_TOOL__;
  return typeof override === 'string' && override.length > 0
    ? override
    : 'ggui_runtime_submit_action';
}

/**
 * Routing helper for `WireConfig.dispatch` — every user action takes
 * the same path: enqueue the gesture onto the render's pending-event
 * pipe via `submit_action`. The agent retrieves it EXCLUSIVELY via
 * `ggui_consume` — the gesture never travels inline, so there is no
 * `nextStep` hint to forward client-side (the server derives the
 * agent-facing hint from the render's `actionSpec[name].nextStep`
 * when it builds the consume event).
 *
 * Lives as a named export (rather than a closure body inside the
 * boot path) so production + tests exercise the same code path.
 *
 * @internal — exported for unit tests + production reuse.
 */
export function routeDispatch(args: {
  readonly actionName: string;
  readonly data: unknown;
  readonly meta: {
    readonly sessionId: string;
    readonly appId: string;
  };
  readonly dispatchToolName: string;
}): void {
  const { actionName, data, meta, dispatchToolName } = args;
  dispatchSubmitAction({
    toolName: dispatchToolName,
    intent: actionName,
    data,
    sessionId: meta.sessionId,
    appId: meta.appId,
  });
}

/**
 * `ui/open-link` direct dispatch helper — used by the anchor-click
 * interceptor. Fires a parallel `kind:'openLink'` audit so operators
 * retain uniform observability across every gesture kind.
 */
/** @internal — exported for unit tests. */
export function openLinkInParent(args: {
  readonly toolName: string;
  readonly url: string;
  readonly sessionId: string;
  readonly appId: string;
}): void {
  if (typeof window === 'undefined') return;
  const { toolName, url, sessionId, appId } = args;
  if (typeof url !== 'string' || url.length === 0) {
    throw new RangeError(
      'wire.openLink(url): `url` must be a non-empty string.',
    );
  }
  const firedAt = new Date().toISOString();
  const actionId = fnv1aHex(`openLink|${url}|${firedAt}`);
  emitAudit({
    toolName,
    kind: 'openLink',
    payload: { url },
    sessionId,
    appId,
    actionId,
    firedAt,
  });
  callAppOpenLink({ url });
}

/**
 * `ui/request-display-mode` direct dispatch helper — used by the
 * `Element.requestFullscreen` / `Document.exitFullscreen`
 * interceptors. Fires a parallel `kind:'requestDisplayMode'` audit so
 * operators retain uniform observability across every gesture kind.
 */
/** @internal — exported for unit tests. */
export function requestDisplayModeInParent(args: {
  readonly toolName: string;
  readonly mode: 'fullscreen' | 'pip' | 'inline';
  readonly sessionId: string;
  readonly appId: string;
}): void {
  if (typeof window === 'undefined') return;
  const { toolName, mode, sessionId, appId } = args;
  const firedAt = new Date().toISOString();
  const actionId = fnv1aHex(`requestDisplayMode|${mode}|${firedAt}`);
  emitAudit({
    toolName,
    kind: 'requestDisplayMode',
    payload: { mode },
    sessionId,
    appId,
    actionId,
    firedAt,
  });
  callAppRequestDisplayMode({ mode });
}

/**
 * Native-idiom interceptor for anchor clicks.
 *
 * Install a capture-phase `click` listener on `document` that traps
 * clicks targeting an `<a href>` whose href is an external (cross-
 * origin OR `target="_blank"`) http(s) URL. Intercepted clicks are
 * routed through {@link openLinkInParent} — full audit envelope +
 * `ui/open-link` postMessage. Generated components use plain
 * `<a href="https://example.com" target="_blank">`; the runtime
 * intercepts the click and routes it to the host.
 *
 * Decision rules (DOM event → routing):
 *   - No anchor in ancestor chain → skip (nothing to do).
 *   - `event.defaultPrevented` → skip (component handler already
 *     consumed the click; respect its choice).
 *   - href starts with `#` → skip (same-document fragment; preserve
 *     bookmark / scroll-into-view behavior).
 *   - href scheme is not `http(s):` → skip (`mailto:`, `tel:`,
 *     `javascript:`, `data:` are out of the spec's domain).
 *   - href origin === `window.location.origin` AND `target !== '_blank'`
 *     → skip (in-frame navigation; preserve SPA links).
 *   - Otherwise → preventDefault + fire {@link openLinkInParent}.
 *
 * Capture phase is load-bearing: component-defined `onClick` handlers
 * may call `preventDefault()`, which would mask the native intercept
 * if the listener were on the bubble phase. By running first, we
 * either intercept (then component handlers see `defaultPrevented`)
 * or honor an upstream `defaultPrevented` from a higher-priority
 * handler.
 *
 * Idempotent: re-mounts (via `installPostMountListener`) call this
 * helper again; the {@link anchorClickInterceptInstalled} guard makes
 * subsequent calls a no-op.
 */
/** @internal — exported for unit tests. */
export function installAnchorClickInterceptor(args: {
  readonly dispatchToolName: string;
  readonly sessionId: string;
  readonly appId: string;
}): void {
  if (anchorClickInterceptInstalled) return;
  if (typeof window === 'undefined') return;
  if (typeof document === 'undefined') return;
  anchorClickInterceptInstalled = true;

  const { dispatchToolName, sessionId, appId } = args;

  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented) return;
    const target = event.target;
    if (target === null || !(target instanceof Element)) return;
    const link = target.closest('a[href]');
    if (link === null || !(link instanceof HTMLAnchorElement)) return;

    // `link.href` is the BROWSER-RESOLVED absolute URL — relative
    // hrefs become absolute against the document base, scheme-only
    // hrefs (`mailto:`, `tel:`) stay verbatim. The raw `getAttribute`
    // is what matters for fragment detection (resolution would
    // produce a same-document URL with the fragment fused on).
    const rawHref = link.getAttribute('href');
    if (rawHref === null) return;
    if (rawHref.startsWith('#')) return;

    const absoluteHref = link.href;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(absoluteHref);
    } catch {
      // Unparseable href → not our concern.
      return;
    }

    // Only http(s). `mailto:`, `tel:`, `javascript:`, `data:` etc.
    // fall through to the browser's default handling.
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return;
    }

    const targetAttr = link.getAttribute('target');
    const isBlank = targetAttr === '_blank';
    const isCrossOrigin = parsedUrl.origin !== window.location.origin;
    if (!isBlank && !isCrossOrigin) {
      // Same-origin in-frame navigation — preserve SPA-style links.
      return;
    }

    event.preventDefault();
    openLinkInParent({
      toolName: dispatchToolName,
      url: absoluteHref,
      sessionId,
      appId,
    });
  };

  // Capture phase so we run BEFORE component-defined onClicks.
  document.addEventListener('click', onClick, { capture: true });
}

/**
 * Native-idiom interceptor for the Fullscreen API.
 *
 * Override `Element.prototype.requestFullscreen` and
 * `Document.prototype.exitFullscreen` so generated components calling
 * either go through {@link requestDisplayModeInParent} (fires the
 * `ui/request-display-mode` postMessage + paired audit envelope).
 *
 * The native fullscreen API would not work from inside the iframe
 * regardless — sandboxed iframes need an explicit
 * `allow="fullscreen"` permission, and even when granted the host
 * (claude.ai, ggui demo shell) typically owns the chrome. Routing
 * through the parent host lets it decide the actual presentation
 * (true fullscreen, modal, expanded panel).
 *
 * Both overrides return `Promise.resolve()` so callers using the
 * standard `.then()` / `await` form don't break. The native call is
 * NOT delegated — there's no useful behavior to preserve and a real
 * native fullscreen attempt would race with the host's handling.
 *
 * Mode mapping:
 *   - `requestFullscreen()` → `mode: 'fullscreen'`
 *   - `exitFullscreen()`    → `mode: 'inline'` (symmetric inverse
 *     in the existing `requestDisplayModeInParent` mode union).
 *
 * Note: `'pip'` is YAGNI for v1. There's no clean native API for
 * arbitrary-content Picture-in-Picture (Document PiP exists but is
 * Chromium-only and requires an explicit container handoff); we
 * surface the postMessage `mode: 'pip'` only when a future native
 * idiom emerges.
 *
 * Idempotent: the {@link fullscreenInterceptInstalled} guard prevents
 * re-mounts from chaining wrappers (which would also leak the prior
 * mount's `sessionId`/`appId` if they ever differed).
 */
/** @internal — exported for unit tests. */
export function installFullscreenInterceptors(args: {
  readonly dispatchToolName: string;
  readonly sessionId: string;
  readonly appId: string;
}): void {
  if (fullscreenInterceptInstalled) return;
  if (typeof window === 'undefined') return;
  if (typeof Element === 'undefined' || typeof Document === 'undefined') {
    return;
  }
  fullscreenInterceptInstalled = true;

  const { dispatchToolName, sessionId, appId } = args;

  Element.prototype.requestFullscreen = function (
    this: Element,
    _options?: FullscreenOptions,
  ): Promise<void> {
    requestDisplayModeInParent({
      toolName: dispatchToolName,
      mode: 'fullscreen',
      sessionId,
      appId,
    });
    return Promise.resolve();
  };

  Document.prototype.exitFullscreen = function (
    this: Document,
  ): Promise<void> {
    requestDisplayModeInParent({
      toolName: dispatchToolName,
      mode: 'inline',
      sessionId,
      appId,
    });
    return Promise.resolve();
  };
}

/**
 * @internal — exposed for tests to reset module-level interceptor
 * guards between specs. Production code never calls this; resetting
 * during a real iframe lifecycle would cause stacked click listeners
 * (the prior listener is NOT removed by the reset, only forgotten).
 */
export function __resetInterceptorsForTest(): void {
  anchorClickInterceptInstalled = false;
  fullscreenInterceptInstalled = false;
}

/**
 * Install a persistent `app.addEventListener('toolresult', …)` listener
 * that catches `ui/notifications/tool-result` notifications arriving
 * AFTER the initial mount. Each new tool-result that carries a
 * different bootstrap (different sessionId / codeUrl / kind) triggers
 * a re-mount through the published `applyRender`. This closes the boot-only-
 * listener gap that prevented live re-render when an agent issued
 * a second `ggui_render` to the same render-resource.
 *
 * Idempotent: subsequent calls no-op via {@link postMountListenerInstalled}.
 *
 * Why module-level vs scoped to a single mount: re-mounts re-apply
 * through `applyRender` while the listener stays live, and the
 * listener should outlive any single mount cycle. The guard ensures
 * we don't stack listeners across re-mounts.
 *
 * Spec-canonical (post-Phase-1.19b.3): the previous hand-rolled
 * `window.addEventListener('message', …)` is gone; App handles every
 * inbound `ui/notifications/tool-result` envelope and dispatches via
 * its event system. Per-iframe single-tenancy means the App handle
 * comes from `getCurrentApp()` — set by `bootSequence`'s connect
 * path before this helper runs.
 */
function installPostMountListener(): void {
  if (postMountListenerInstalled) return;
  const app = getCurrentApp();
  if (app === null) return; // pre-connect; caller bug, swallow safely
  postMountListenerInstalled = true;
  let lastMetaKey: string | null = null;
  app.addEventListener('toolresult', (params) => {
    const meta = extractMetaFromToolResult(params);
    if (meta === null) return;
    // Cheap dedupe — the host may emit the same tool-result more
    // than once (claude.ai re-broadcasts on iframe re-attach).
    // Re-mounting the same slice meta would flicker without changing
    // anything visible.
    //
    // `liveTrio` is load-bearing in the dedupe key: hosts (sample-agent,
    // claude.ai) often emit the initial meta WITHOUT the wsUrl+token
    // pair (the Anthropic SDK strips `_meta` from tool results), then
    // refetch + re-emit the FULL envelope. The two envelopes share
    // sessionId/kind/codeUrl/propsJson but differ on the live trio —
    // without trio in the key, the second arrival deduped silently and
    // the re-mount never opened the WS, so `ggui_update` props_update
    // frames fanned to zero subscribers.
    const liveTrio =
      typeof meta.wsUrl === 'string' &&
      meta.wsUrl.length > 0 &&
      typeof meta.wsToken === 'string' &&
      meta.wsToken.length > 0
        ? 'live'
        : '-';
    const key = [
      meta.sessionId,
      meta.kind ?? '-',
      meta.codeUrl ?? '-',
      // Inline code participates like codeUrl: an update that ships new
      // component bytes (re-generation) must re-mount even when
      // sessionId + props are unchanged.
      meta.codeB64 ?? '-',
      meta.propsJson ?? '-',
      liveTrio,
    ].join('|');
    if (key === lastMetaKey) return;
    lastMetaKey = key;
    // Re-mount through the EXISTING renderer's `applyRender` (published
    // module-level by bootProduction's setup) — NOT a fresh boot. One
    // mount surface, one WS; the prior stale-closure / second-WS race
    // (the #290 root cause) is structurally impossible. Project the new
    // tool-result meta into a seed and re-apply it.
    const apply = activeApplyRender;
    if (apply === null) return; // no renderer published yet — no-op safely
    void buildGguiSessionSeedInput(meta).then((seed) => {
      if (seed === null) return;
      void apply(seed).then(() => {
        // Re-emit last-known contextSpec values after a successful
        // re-mount — keeps the LLM context fresh after a host-driven
        // reconnect; the new mount's SingleSlotProviders take over via
        // the regular debounced flow once the component mutates values.
        // Filter to slot names declared by the FRESHLY mounted contract.
        const activeSlotNames = new Set(
          (meta.contextSlots ?? []).map((s) => s.name),
        );
        reemitLastContextValues(
          productionContextSnapshotPoster,
          activeSlotNames,
          { sessionId: meta.sessionId, appId: meta.appId },
        );
      });
    });
  });
}


/**
 * Detect a live-channel bootstrap shape inlined onto `__GGUI_META__`.
 * The first-party render shells (`/r/<shortCode>`,
 * `ui://ggui/render/<sessionId>`, the embedded-ui GguiSessionViewer's thin
 * shell) populate this synchronously before the runtime loads.
 *
 * Post-Phase-B the global carries a slice ENVELOPE (same shape as the
 * wire `_meta`): `{ "ai.ggui/render": {...} }`. A live-channel shell
 * omits static content (no codeUrl / kind) and ships wsUrl+token
 * inside the render slice instead.
 *
 * This predicate exists so the autostart path can distinguish
 * "shell-inlined a live bootstrap, run `bootProduction` immediately"
 * from "no bootstrap yet, race the tool-result postMessage with a
 * 30s timeout". Without the distinction, OSS shells that never emit
 * a separate `ui/notifications/tool-result` (because the bootstrap
 * is delivered via the `ui/initialize` Reading-B path) hang at
 * `mounting` for the full 30s before `code-ready`.
 */
function readLiveBootstrapShape(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = (window as unknown as { __GGUI_META__?: unknown })
    .__GGUI_META__;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }
  const bag = raw as Record<string, unknown>;
  const renderRaw = bag['ai.ggui/render'];
  if (renderRaw === null || typeof renderRaw !== 'object' || Array.isArray(renderRaw)) {
    return false;
  }
  const renderBag = renderRaw as Record<string, unknown>;
  return (
    typeof renderBag['wsUrl'] === 'string' &&
    (renderBag['wsUrl'] as string).length > 0 &&
    typeof renderBag['wsToken'] === 'string' &&
    (renderBag['wsToken'] as string).length > 0 &&
    typeof renderBag['sessionId'] === 'string' &&
    (renderBag['sessionId'] as string).length > 0 &&
    typeof renderBag['appId'] === 'string' &&
    (renderBag['appId'] as string).length > 0
  );
}

/**
 * Hand off to `bootProduction` with the standard wiring (postRendererReady
 * + postBootFailure + observability + lifecycle). Extracted so both the
 * live-channel-inlined fast path and the post-tool-result-timeout
 * fallback share one call site — keeps the WS-driven boot semantics
 * single-sourced.
 *
 * `preResolvedMeta` is threaded in from the autostart resolver when
 * it has already discovered slice meta — via inline `__GGUI_META__`
 * global, a buffered `__GGUI_PENDING_TOOL_RESULTS__` entry, or an
 * early `ui/notifications/tool-result` postMessage. Threading skips
 * `bootSequence`'s internal resolver chain (which would otherwise
 * re-await the same postMessage or re-parse the same global), saving
 * up to the 30s postMessage timeout for spec-strict hosts.
 */
function runBootProduction(
  preResolvedMeta?: McpAppAiGguiRenderMeta,
  preResolvedLocator?: string,
): void {
  const { app, transport } = createDefaultApp();
  void bootProduction({
    doc: document,
    app,
    transport,
    notifyParent: (msg) => {
      if (msg.type === MCP_APP_RENDERER_READY_TYPE) {
        postRendererReady();
        return;
      }
      postBootFailure(msg.reason, msg.message);
    },
    onObserve: postObservabilityToParent,
    onLifecycle: postLifecycleToParent,
    ...(preResolvedMeta !== undefined ? { preResolvedMeta } : {}),
    ...(preResolvedLocator !== undefined ? { preResolvedLocator } : {}),
  });
}

if (shouldAutostart() && typeof window !== 'undefined') {
  // Boot-source resolution — collapsed post-consolidation. The
  // static-vs-live FORK is gone: every meta flows through the ONE
  // unified path (`runBootProduction` → `bootProduction` →
  // `bootSequence`), which decides internally whether to seed-mount
  // static content (codeUrl/kind), open a WS subscribe (wsUrl+wsToken),
  // or both. The autostart layer's only job is to RESOLVE the meta from
  // one of three delivery channels:
  //
  //   1. Inline `__GGUI_META__` global — first-party shells populate
  //      this synchronously before this bundle evaluates.
  //   2. Buffered `__GGUI_PENDING_TOOL_RESULTS__` — minimal-shell
  //      pattern (postMessage arrived before the bundle parsed).
  //   3. Live `ui/notifications/tool-result` postMessage — the
  //      spec-canonical channel for spec-strict hosts (`<AppRenderer>`,
  //      ChatGPT, claude.ai). Caught meta threads through as
  //      `preResolvedMeta` so `bootSequence` doesn't re-await it.
  //
  // `readLiveBootstrapShape` still short-circuits the 30s tool-result
  // wait when a live-channel envelope is already inlined — OSS embedded
  // shells that never emit a separate tool-result would otherwise hang
  // at `mounting` for the full timeout.
  const inline = readSelfContainedMeta();
  if (inline !== null) {
    runBootProduction(inline);
  } else {
    const buffered = readPendingToolResults();
    const bufferedLocator = buffered === null ? readPendingToolResultLocator() : null;
    if (buffered !== null) {
      runBootProduction(buffered);
    } else if (bufferedLocator !== null) {
      // Read-plane-only posture (ggui#537): the buffered result named
      // the view; the door resolves it right after the handshake.
      runBootProduction(undefined, bufferedLocator);
    } else if (readLiveBootstrapShape()) {
      runBootProduction();
    } else {
      void awaitToolResultMeta(POSTMESSAGE_BOOT_TIMEOUT_MS).then((pre) => {
        if (pre === null) runBootProduction();
        else if (pre.kind === 'meta') runBootProduction(pre.meta);
        else runBootProduction(undefined, pre.locator);
      });
    }
  }
}

// =============================================================================
// Production boot — renderer-wired entrypoint. Dynamic-imports React +
// ReactDOM + design + wire + preview-a2ui only on the iframe-
// autostart path so `boot.test.ts` (which imports runtime.ts
// directly) doesn't pull the heavy module graph into its test.
//
// The boot pipeline:
//
//   1. Status DOM up.
//   2. App.connect(transport) — spec-canonical ui/initialize handshake.
//   3. Slice-meta resolution via parseMetaFromGlobal (inline) +
//      parseMetaFromToolResult (spec-canonical postMessage).
//   4. installGlobalRegistry (with real React+ReactDOM+design+wire
//      module handles).
//   5. Build StreamBus + root WireConfig.
//   6. Wire `applyRender(render)` closure — first call mounts the
//      React tree into the renderer's slot; later calls re-apply via
//      the `RenderItemHandle.update` lifecycle.
//   7. Populate the channel registry; bootSequence calls connectFn
//      (default `connectViaRegistry`) which binds the WS transport.
//      Frames arrive directly through the registered handlers.
//
// Step 4 is the TOCTOU-critical barrier: MUST run before any render
// mounts (generated code's data-URL shims read the global
// synchronously during `loadModule`).
// =============================================================================
/**
 * Internal shim type — a manager with a hidden `__attachReal` that
 * `attachManager` uses to bind the real WS send surface AFTER the
 * handshake resolves. Pre-bind frames are buffered and flushed on
 * the `__attachReal` call.
 */
interface BufferedSendShim {
  readonly send: (msg: WebSocketMessage) => void;
  readonly __attachReal: (real: { send: (msg: WebSocketMessage) => void }) => void;
}

async function bootProduction(opts: {
  readonly doc: Document;
  readonly app: App;
  readonly transport: Transport;
  readonly notifyParent: (msg: RendererBootFailedMessage | McpAppRendererReadyMessage) => void;
  readonly onObserve?: ObservabilityEmitter;
  readonly onLifecycle?: LifecycleEmitter;
  /**
   * Pre-resolved slice meta from the autostart layer. When set,
   * threaded through `bootSequence` so the resolver skips the inline
   * + spec-canonical toolresult tiers.
   */
  readonly preResolvedMeta?: McpAppAiGguiRenderMeta;
  /** Pre-resolved LOCATOR from the autostart layer (read-plane door, ggui#537). */
  readonly preResolvedLocator?: string;
}): Promise<void> {
  // Dynamic-import the heavy module graph. Done here rather than at
  // top-level so spec files importing runtime.ts for `bootSequence`
  // don't pay the React + design + wire + preview-a2ui import cost.
  const [reactMod, reactDomClient, designPrimitives, designComponents, designCompositions, designInteract, designTokens, wireMod, gadgetsMod] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('@ggui-ai/design/primitives'),
    import('@ggui-ai/design/components'),
    import('@ggui-ai/design/compositions'),
    import('@ggui-ai/design/interact'),
    import('@ggui-ai/design/tokens'),
    import('@ggui-ai/wire'),
    // STDLIB gadget hooks — seeds `__ggui__.gadgets` synchronously in
    // the registry composition below, so a generated component's
    // gadget data-URL shims resolve at mount time.
    import('@ggui-ai/gadgets'),
  ]);
  const [globalsMod, gadgetLoaderMod] = await Promise.all([
    import('./globals.js'),
    import('./gadget-loader.js'),
  ]);

  // Renderer wiring hook — constructs buses + single-render mount surface
  // + wire config on demand inside bootSequence.
  const renderer: RendererHooks = {
    setup: ({ meta, renderInto, statusRefs, onObserve }) => {
      // Post-Phase-B `meta` is the flat render slice — `sessionId` /
      // `appId` / `runtimeUrl` / `wsUrl` / `wsToken` / `themeId` /
      // `gadgets` / `publicEnv` / `contextSlots` /
      // `streamWebSocketLocalTools` all live directly on `meta`.

      // Compose the gadget registry: STDLIB seed PLUS any
      // operator-registered wrappers carried on the bootstrap.
      // Awaited inside the synchronous `setup` callback via an IIFE
      // because the boot orchestration calls `setup` synchronously and
      // we can't change its contract here; the wrappers dynamic-import
      // is fast (already-resolved bundles hit the module cache).
      //
      // For now we fall back to the STDLIB-only seed if the bootstrap
      // omits `gadgets`. The install happens BEFORE any render mounts
      // so `rewrite-imports.ts` reads a fully-populated registry on
      // the first `loadModule` call.
      const composedGadgets = gadgetLoaderMod
        // Empty registrations → resolves to a Promise of the STDLIB
        // seed only; the boot path doesn't wait on wrapper imports.
        .loadGadgetRegistry(
          gadgetsMod,
          meta.gadgets ?? [],
        );
      // Install with the synchronous STDLIB seed first; the WS-driven
      // boot path doesn't await wrapper loads here (the registry
      // install is TOCTOU-critical and synchronous). The Promise's
      // resolved value replaces `__ggui__.gadgets` in-place
      // once dynamic imports finish.
      globalsMod.installGlobalRegistry({
        react: reactMod,
        reactDom: reactDomClient,
        primitives: designPrimitives,
        components: designComponents,
        compositions: designCompositions,
        interact: designInteract,
        tokens: designTokens,
        wire: wireMod,
        // Per-package gadget registry — the STDLIB namespace under its
        // package key lands synchronously; 3rd-party packages merge in
        // via the Promise below.
        gadgets: { '@ggui-ai/gadgets': gadgetsMod },
        // Public env values from the bootstrap. The WS-driven path
        // receives bootstrap synchronously via
        // setup({meta, ...}) so installing here is correct.
        publicEnv: meta.publicEnv ?? {},
      });
      // Merge 3rd-party package namespaces into the LIVE slot object —
      // not a slot replacement. The per-package data-URL shims read
      // `__ggui__.gadgets[package]` lazily at call/render time, so
      // mutating the live slot's contents (adding package keys)
      // propagates. Replacing the slot reference would NOT.
      void composedGadgets.then((merged) => {
        const reg = globalsMod.getGlobalRegistry();
        if (reg === undefined) return;
        const live = reg.gadgets as Record<string, ModuleNamespace>;
        for (const [key, value] of Object.entries(merged)) {
          if (!(key in live)) live[key] = value;
        }
      });

      // Install the React Context registry + build a ContextStateHost
      // so the WS-driven shells (Studio, Portal, OSS console)
      // participate in contextSpec the same way the static-seed mount
      // does. Without this the WS-driven path installed neither —
      // `globalThis.__ggui__.contexts` stayed empty, the boilerplate's
      // destructure resolved to `undefined`, and any declared
      // `contextSpec` slot was silently dead. The registry entries
      // seed default values; the ContextStateHost (one
      // SingleSlotProvider per declared slot) hoists useState into the
      // runtime so `useGguiContext(slot)` reads the live tuple.
      const registry = globalsMod.getGlobalRegistry();
      const resolvedSlots: ReadonlyArray<ResolvedContextSlot> =
        registry !== undefined && meta.contextSlots !== undefined
          ? installContextRegistry(
              registry.contexts,
              reactMod,
              meta.contextSlots,
            )
          : [];
      const ContextStateHost = createContextStateHost({
        react: reactMod,
        poster: productionContextSnapshotPoster,
        consoleWarn:
          typeof console !== 'undefined' && typeof console.warn === 'function'
            ? console.warn.bind(console)
            : undefined,
        identity: {
          sessionId: meta.sessionId,
          appId: meta.appId,
        },
      });

      const streamBus = new StreamBus();

      // Buffered send shim — the real WS handle isn't available until
      // `connectViaRegistry` resolves. Frames sent pre-ack are
      // buffered and flushed by `attachManager` when the handle
      // lands. Mirrors the pre-B3b BufferedManagerShim posture; the
      // rename clarifies that this is now a pure send-surface, not a
      // full manager class.
      const buffered: WebSocketMessage[] = [];
      let realManager: { send: (msg: WebSocketMessage) => void } | null = null;
      const manager: BufferedSendShim = {
        send: (msg) => {
          if (realManager !== null) {
            realManager.send(msg);
            return;
          }
          buffered.push(msg);
        },
        __attachReal(real) {
          realManager = real;
          while (buffered.length > 0) {
            const msg = buffered.shift();
            if (msg !== undefined) real.send(msg);
          }
        },
      };

      // Spec-canonical outbound dispatch. The WS pipe is for streamSpec
      // subscriptions ONLY (inbound `ggui_emit` fanout + `props_update` +
      // `render` + `data` + `drain_ack` + `channel_payload`).
      // Outbound user actions go through the MCP-Apps host relay per
      // spec §401: postMessage `tools/call:ggui_runtime_submit_action`
      // to the parent → `AppRenderer.onCallTool` → sample agent's
      // `/relay/tools-call` → ggui MCP server →
      // `createGguiSubmitActionHandler.append` → `pendingEventConsumer`
      // → `ggui_consume` wakes the agent. The server's WS
      // `handleInboundAction` writes to the render ledger only — no
      // downstream consumer — so the WS action path silently drops
      // clicks. `routeDispatch` is the shared named-export helper
      // (production + tests exercise the same code path); threading it
      // here keeps LIVE-mode on the canonical dispatch pipeline.
      // Single mounted render — populated by `applyRender` on the first
      // render frame. The wire config + data channel handler read it
      // through `currentRender`-returning thunks so they always see the
      // latest snapshot without holding stale refs.
      let currentRender: GguiSession | GguiSessionSeedInput | null = null;
      let renderHandle: RenderItemHandle | null = null;

      const dispatchToolName = resolveDispatchToolName();

      // Native-idiom interceptors — the replacement for the retired
      // openLink / requestDisplayMode wire primitives. Installed here
      // (module-guarded, idempotent) so EVERY component render mounted
      // through this single surface — the WS-ack render, the inline
      // static seed, and re-mounts — has anchor-click + fullscreen
      // capture live before the first `applyRender`. Pre-consolidation
      // these lived only in the retired self-contained boot path; the
      // WS-driven path installed neither, so anchor clicks + fullscreen
      // requests in a live-rendered component silently no-op'd.
      // Root of the gesture autopsy trail: a capture-phase listener
      // proving pointer events reach this document AT ALL. #471
      // round 12: a healthy frame (beacons + pulls flowing) whose
      // clicks produced nothing observable — without this record,
      // "host swallows pointer events" and "component handler never
      // attached" are indistinguishable from outside a console-less
      // host. Bounded: only the first few clicks record (the sink
      // throttles + caps flushes regardless).
      if (typeof document !== 'undefined') {
        let recordedClicks = 0;
        document.addEventListener(
          'click',
          (ev) => {
            if (recordedClicks >= 5) return;
            recordedClicks += 1;
            const target = ev.target instanceof Element ? ev.target : null;
            currentTelemetrySink?.record(
              'gesture.dom_click',
              JSON.stringify({
                tag: target?.tagName ?? 'unknown',
                role: target?.getAttribute('role') ?? undefined,
                trusted: ev.isTrusted,
              }),
            );
          },
          { capture: true },
        );
      }
      installAnchorClickInterceptor({
        dispatchToolName,
        sessionId: meta.sessionId,
        appId: meta.appId,
      });
      installFullscreenInterceptors({
        dispatchToolName,
        sessionId: meta.sessionId,
        appId: meta.appId,
      });

      const rootConfig = buildRootWireConfig({
        sessionId: meta.sessionId,
        appId: meta.appId,
        getCurrentGguiSession: () => currentRender,
        manager,
        streamBus,
        onDispatchEnvelope: (envelope) => {
          // First hop of the gesture autopsy trail (see
          // `dispatchSubmitAction`'s sibling record): proves the wire
          // layer received the component's action envelope at all.
          currentTelemetrySink?.record(
            'gesture.envelope',
            JSON.stringify({ type: envelope.type }),
          );
          if (envelope.type !== 'data:submit') return;
          const payload = envelope.payload as
            | { action?: unknown; data?: unknown }
            | undefined;
          if (
            payload === undefined
            || typeof payload.action !== 'string'
            || payload.action.length === 0
          ) {
            return;
          }
          routeDispatch({
            actionName: payload.action,
            data: payload.data,
            meta: {
              sessionId: meta.sessionId,
              appId: meta.appId,
            },
            dispatchToolName,
          });
        },
      });

      // Build the wrap factory used by every mount React tree:
      // `<ContextStateHost slots={resolvedSlots}>` so contextSpec
      // values flow through `ui/update-model-context` exactly like the
      // self-contained path. mcpApps + system renders skip the wrap
      // (their renderers don't run user component code that reads
      // contexts). When `resolvedSlots` is empty ContextStateHost
      // short-circuits to a Fragment, so the wrap is free for renders
      // with no contextSpec.
      const buildOuterWrapper = (
        render: GguiSession | GguiSessionSeedInput,
      ): ((mountedTree: ReactNode) => ReactNode) | undefined => {
        if (render.type === 'mcpApps' || render.type === 'system') return undefined;
        return (mountedTree) =>
          reactMod.createElement(ContextStateHost, {
            slots: resolvedSlots,
            children: mountedTree,
          });
      };

      // Build the scoped wire config for the active render. mcpApps +
      // system renders get NO wire config — their iframe / built-in
      // host has its own contract (adapter-boundary rule).
      // Post-render-identity-collapse the WireConfig is bound to the
      // single render at boot, so there's no per-render scope factory
      // — every dispatch resolves through `getCurrentGguiSession`.
      const buildScopedWireFor = (render: GguiSession | GguiSessionSeedInput): WireConfig | null => {
        if (render.type === 'mcpApps' || render.type === 'system') return null;
        return rootConfig;
      };

      // Build the renderer options for the active render. Theme is
      // forwarded from the bootstrap so the mounted React tree injects
      // the configured theme's CSS vars (indigo, claudic, etc).
      // Without this, react-renderer.ts falls back to
      // `getScopedCssTokens` (no preset) and the iframe renders with
      // the default ggui theme even when `_meta["ai.ggui/render"].themeId`
      // is `'indigo'`.
      const buildOpts = (render: GguiSession | GguiSessionSeedInput): RenderItemOptions => {
        const wrapOuter = buildOuterWrapper(render);
        return {
          render,
          scopedWireConfig: buildScopedWireFor(render),
          streamBus,
          sessionId: meta.sessionId,
          // Thread the bootstrap's 3rd-party gadget packages so the import
          // rewriter resolves non-STDLIB gadget imports even for a static
          // seed mount (which carries no gadgetDescriptors). A full
          // WS-delivered GguiSession carries gadgetDescriptors and ignores this.
          ...(meta.gadgets !== undefined
            ? { gadgetPackages: meta.gadgets.map((g) => g.package) }
            : {}),
          // Strict-CSP module variant (ggui#522 slice 2) — attached to
          // the INLINE SEED mount only, detected by the absence of the
          // server-assigned ledger fields (`buildGguiSessionSeedInput`
          // omits them; every wire-delivered GguiSession carries them).
          // The variant URL names the SEEDED bytes: a WS-delivered
          // body may differ, and importing a stale variant would paint
          // the WRONG component rather than fail. A WS redelivery of
          // the SAME bytes loses nothing — same code ⇒ the renderer
          // skips re-evaluation entirely.
          ...(meta.codeModuleUrl !== undefined &&
          render.type !== 'mcpApps' &&
          render.type !== 'system' &&
          !('createdAt' in render)
            ? { codeModuleUrl: meta.codeModuleUrl }
            : {}),
          // Base-theme ladder (ggui#589 ask 3 — see `resolveMountThemeId`):
          // stamped themeId > the slice theme object's NAME (a
          // registered name binds the full brand base; unregistered
          // names fall back to the default ladder, byte-identical to
          // the no-themeId path).
          ...(() => {
            const themeId = resolveMountThemeId(meta);
            return themeId !== undefined ? { themeId } : {};
          })(),
          // Mode ladder (ggui#551 + #589 — see `resolveMountThemeMode`):
          // stamped `themeMode` > the slice theme OBJECT's `mode` >
          // host-announced theme. Absent everywhere means "no opinion",
          // not "light".
          ...(() => {
            const themeMode = resolveMountThemeMode(meta);
            return themeMode !== undefined ? { themeMode } : {};
          })(),
          // Per-app theme overlay (St3 M2.2). Threaded straight from the
          // bootstrap's `_meta["ai.ggui/render"].theme` (typed `AppTheme`,
          // already injection-validated by the wire parser) onto the mount
          // options so the renderer applies the `--ggui-*` overrides +
          // `color-scheme` at `:root`. THEME IS COMPONENT-ONLY — system
          // cards theme via the SystemCardHost/ThemeProvider path.
          ...(meta.theme !== undefined ? { appTheme: meta.theme } : {}),
          // Host palette: always threaded when the host announced one —
          // unlike mode there is no either/or gate here, because the
          // precedence is CSS document order inside the scoped block
          // (base < hostPalette < appTheme, ggui#572/#573: slice wins,
          // host fallback), not a value-level ?? fallback.
          ...(() => {
            const hostPalette = hostAnnouncedPalette();
            return hostPalette !== undefined ? { hostPalette } : {};
          })(),
          ...(wrapOuter !== undefined ? { wrapOuter } : {}),
        };
      };

      /**
       * Mount-or-update the single render slot. First call mounts the
       * React tree into `renderInto`; subsequent calls re-apply via
       * `renderHandle.update` (same kind ⇒ in-place props update; kind
       * transition ⇒ tear-down + remount via `RenderItemHandle`'s own
       * lifecycle).
       *
       * Shared by the render-frame and props_update channel handlers;
       * closes over `currentRender` + `renderHandle` so the channel
       * layer just calls `applyRender(render)` without owning
       * lifecycle state.
       */
      const applyRender = async (render: GguiSession | GguiSessionSeedInput): Promise<void> => {
        currentRender = render;
        if (renderHandle === null) {
          renderHandle = await mountRender(renderInto, buildOpts(render));
          return;
        }
        await renderHandle.update(buildOpts(render));
      };

      // Publish `applyRender` module-level + install the persistent
      // post-mount tool-result listener. On a host-re-emitted tool-result
      // (claude.ai re-broadcast; the Anthropic-SDK-strips-_meta refetch),
      // the listener re-mounts through THIS `applyRender` — no fresh boot,
      // no second WS. The no-WS live-re-render channel; for WS hosts the
      // render-frame handler already covers re-render, so it's a
      // redundant-safe fallback (guarded by the sessionId pin + liveTrio
      // dedupe). Runs only on the production renderer path (tests that
      // drive bootSequence without a renderer never reach setup()).
      activeApplyRender = applyRender;
      installPostMountListener();

      // Validator context — A2UI default for `_ggui:preview`; no
      // bootstrap-supplied overrides today (the
      // `extraReservedValidators` injection slot is reserved for a
      // future extension).
      const validatorCtx: RendererValidatorContext = {
        reservedValidators: mergeReservedValidators(undefined, undefined),
      };

      // Per-channel transport router. Created here so it shares the
      // buffered manager shim (and survives the pre-attachManager send
      // buffering) + the same StreamBus the wire config emits onto.
      // The router consults `bootstrap.streamWebSocketLocalTools` to
      // decide WS-subscribe vs iframe-polling per channel; absent ⇒
      // universal polling fallback. Activated lazily by the render-
      // frame handler (which calls `channelTransport.applyRender` on
      // every render fold).
      const channelTransport = createChannelTransportRouter({
        sessionId: meta.sessionId,
        appId: meta.appId,
        ...(meta.streamWebSocketLocalTools !== undefined
          ? {
              streamWebSocketLocalTools:
                meta.streamWebSocketLocalTools,
            }
          : {}),
        send: (msg) => manager.send(msg),
        // See `channelToolsCall`'s docstring (defined alongside
        // `dispatchSubmitAction`, its sibling consumer of the
        // relay-incapability latch) for the fail-fast + fail-safe
        // rationale (ggui#440).
        toolsCall: channelToolsCall,
        streamBus,
        ...(onObserve !== undefined
          ? {
              // Forward each channel-transport event verbatim — the
              // `ObservabilityEvent` union has dedicated branches for
              // the three channel-transport kinds (picked / fallback
              // / resubscribed), so consumers (host inspector)
              // receive typed events without needing a cast.
              onObserve,
            }
          : {}),
      });

      // B3b — live-channel registry owns dispatch for every routable
      // WS frame type. Each handler closes over the renderer state it
      // needs. `bootSequence` calls `connectFn` (default
      // `connectViaRegistry`) which registers the `ack` + `error`
      // handshake handlers and binds the WS transport — frames then
      // arrive directly through the registered handlers without an
      // intermediate `onMessage` fan-out.
      //
      // CLIENT_SUPPORTED_VERSIONS handshake is enforced inside
      // `connectViaRegistry`'s ack-handler closure (NOT here).
      const channelRegistry = new ChannelRegistry({
        subscribeFrameBuilder: () => ({
          type: 'subscribe',
          payload: {
            sessionId: meta.sessionId,
            appId: meta.appId,
            ...(meta.wsToken !== undefined
              ? { wsToken: meta.wsToken }
              : {}),
          },
        }),
      });
      channelRegistry.register(
        createRenderHandler({
          statusRefs,
          pinnedSessionId: meta.sessionId,
          applyRender,
          getChannelTransport: () => channelTransport,
        }),
      );
      channelRegistry.register(
        createDataHandler({
          getCurrentGguiSession: () => currentRender,
          streamBus,
          validatorCtx,
        }),
      );
      // Freeze latch (#483). This mount's own history epoch, read once
      // from its boot meta: render → 0, an update-minted card → its N,
      // a pinned `#N` read → N. When a `props_update` frame carries a
      // higher epoch, a newer card superseded this one.
      const selfEpoch = typeof meta.epoch === 'number' ? meta.epoch : 0;
      let superseded = false;
      const supersede = (): void => {
        if (superseded) return;
        superseded = true;
        // Module-level dispatch guard: a history card's gestures no
        // longer target the live session.
        mountSuperseded = true;
        currentTelemetrySink?.record('epoch.frozen', String(selfEpoch));
        applyFreezeCue(renderInto);
      };
      channelRegistry.register(
        createPropsUpdateHandler({
          getCurrentGguiSession: () => currentRender,
          applyRender,
          getSelfEpoch: () => selfEpoch,
          onSuperseded: supersede,
          isSuperseded: () => superseded,
        }),
      );
      channelRegistry.register(
        createDrainAckHandler({ dispatch: dispatchDrainAck }),
      );
      channelRegistry.register(
        createChannelPayloadHandler({
          getChannelTransport: () => channelTransport,
        }),
      );
      channelRegistry.register(
        createChannelErrorHandler({
          getChannelTransport: () => channelTransport,
        }),
      );

      return {
        rootWireConfig: rootConfig,
        streamBus,
        applyRender,
        getCurrentGguiSession: () => currentRender,
        validatorCtx,
        manager,
        channelTransport,
        channelRegistry,
        composedGadgets,
      };
    },
    attachManager: (handle, realManager) => {
      // handle.manager is the buffered shim created in setup().
      const shim = handle.manager as BufferedSendShim;
      if (typeof shim.__attachReal === 'function') {
        shim.__attachReal(realManager);
      }
    },
    teardown: (handle) => {
      // The React mount lifecycle is owned by the per-setup
      // `renderHandle` closure; it stays null until the first render
      // frame lands. Today bootSequence's failure paths fire before
      // any render frame (handshake errors arrive before the first
      // ack), so unmounting the React tree from here is unnecessary.
      // The only thing the teardown hook still owns is the per-channel
      // polling timer + transport subscription registry — no-op when
      // no channel was activated.
      handle.channelTransport.dispose();
    },
  };

  await bootSequence({
    doc: opts.doc,
    app: opts.app,
    transport: opts.transport,
    notifyParent: opts.notifyParent,
    renderer,
    ...(opts.onObserve !== undefined ? { onObserve: opts.onObserve } : {}),
    ...(opts.onLifecycle !== undefined ? { onLifecycle: opts.onLifecycle } : {}),
    ...(opts.preResolvedMeta !== undefined
      ? { preResolvedMeta: opts.preResolvedMeta }
      : {}),
    ...(opts.preResolvedLocator !== undefined
      ? { preResolvedLocator: opts.preResolvedLocator }
      : {}),
  });
}
