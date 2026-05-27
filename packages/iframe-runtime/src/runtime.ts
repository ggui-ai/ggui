/**
 * `@ggui-ai/iframe-runtime` iframe runtime entry.
 *
 * This is the file esbuild bundles into `dist/renderer.js`. The
 * thin-shell HTML loads it via `<script type="module" src=".../renderer.js">`;
 * on import the side-effects below take over: build a status DOM,
 * postMessage `ui/initialize` to the parent, parse the bootstrap, open
 * the WebSocket, run the version handshake, and mount the stack
 * placeholder.
 *
 * Boot sequence:
 *   - Boot from `_meta["ai.ggui/session"]` + `_meta["ai.ggui/stack-item"]`
 *     slices received via `ui/initialize`.
 *   - Open the WebSocket, run the subscribe handshake.
 *   - Render each stack item — either a structural placeholder or,
 *     when the renderer hooks are wired, a React mount of `componentCode`.
 *
 * The runtime advertises its build version via a post-`ui/initialize`
 * notification (`ggui:renderer-ready`).
 *
 * Failure surfacing: every parse / handshake failure goes to two
 * places — (1) the in-iframe status line (operator-visible) and
 * (2) a parent-bound `postMessage({type:'ggui:bootstrap-failed', ...})`.
 * The post-message envelope is consumed by the `<McpAppIframe>` host
 * wrapper, which routes it to the host's `onError` callback. The
 * envelope also carries a live-channel contract-error path.
 */
import type { ReactNode } from 'react';
import type {
  DrainAckPayload,
  JsonValue,
  SessionStackEntry,
} from '@ggui-ai/protocol';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type { McpAppAiGguiSessionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ValidatedMcpAppAiGguiMeta } from './types.js';
import {
  parseMetaFromUiInitialize,
  parseMetaFromGlobal,
  parseMetaFromToolResult,
} from './meta-parse.js';
import { StackModel } from './stack.js';
import type {
  McpAppAiGguiMetaParseFailureReason,
  McpAppAiGguiMetaParseResult,
} from './types.js';
import { projectHostContext } from '@ggui-ai/protocol';
import type { ModuleNamespace } from './globals.js';
import {
  attachListener as attachHostContextListener,
  seed as seedHostContext,
} from './host-context-emitter.js';
import {
  buildRootWireConfig,
  StreamBus,
} from './wire-config.js';
import {
  createChannelTransportRouter,
  type ChannelTransportRouter,
} from './channel-transport.js';
import { ChannelRegistry } from '@ggui-ai/live-channel';
import {
  createChannelErrorHandler,
  createChannelPayloadHandler,
  createDataHandler,
  createDrainAckHandler,
  createFeedbackHandler,
  createPropsUpdateHandler,
  createPushHandler,
  createSystemHandler,
} from './channels/index.js';
import {
  connectViaRegistry,
  type ConnectFn,
  type RegistrySubscribeHandle,
} from './registry-subscribe.js';
import { buildEventsPolling } from './events-polling.js';
import {
  ensureStatusDom,
  refreshStackDom,
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
  StackRenderer,
  type StackRenderContext,
} from './stack-item-renderer.js';
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
  type ResolvedContextSlot,
} from './context-observer.js';

// =============================================================================
// Build-time-stamped renderer version. Surfaced to the parent in the
// `ggui:renderer-ready` notification so hosts (and console views)
// can correlate runtime behavior with a specific bundle.
//
// Hard-coded to the package.json version; future build tooling can
// substitute via esbuild `define` if a non-package value is wanted.
// =============================================================================

const RENDERER_VERSION = '0.1.0';

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
// JSON-RPC postMessage scaffolding for `ui/initialize` against the
// MCP Apps host iframe. Mirrors the `mcp-apps-outbound.ts` shell's
// `call()` helper — kept tiny because the renderer only ever issues
// one method (`ui/initialize`) on this channel.
// =============================================================================

interface JsonRpcResponse {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/**
 * Post a JSON-RPC request to `window.parent` and resolve with the
 * matching response. The host MUST echo the request `id` on its
 * response per the MCP Apps lifecycle. Pending requests are tracked
 * by id in a module-private map; responses without a matching id are
 * dropped (per the adapter-boundary rule the shell already enforces).
 *
 * Hosts have no obligation to respond (a misbehaving host can hang the
 * call) — `bootSequence` enforces a timeout at the orchestration layer
 * because the runtime's whole-flow deadline is what matters, not
 * per-call.
 */
function makeJsonRpcCaller(): (method: string, params?: unknown) => Promise<JsonRpcResponse> {
  let nextId = 1;
  const pending = new Map<number, (resp: JsonRpcResponse) => void>();

  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as unknown;
    if (data === null || typeof data !== 'object') return;
    const id = (data as { id?: unknown }).id;
    if (typeof id !== 'number') return;
    // Filter for RESPONSES — must carry `result` or `error`. Bare
    // requests with `method` set are not responses (see the matching
    // filter in `ensurePostRpcToParentListener` for the same reason).
    if (!('result' in data) && !('error' in data)) return;
    const resolver = pending.get(id);
    if (resolver === undefined) return;
    pending.delete(id);
    resolver(data as JsonRpcResponse);
  });

  return (method, params) =>
    new Promise<JsonRpcResponse>((resolve) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, resolve);
      try {
        window.parent.postMessage(
          {
            jsonrpc: '2.0',
            id,
            method,
            params: params ?? {},
          },
          '*',
        );
      } catch (err) {
        pending.delete(id);
        resolve({ error: { message: err instanceof Error ? err.message : String(err) } });
      }
    });
}

// =============================================================================
// In-iframe status DOM lives in `./status-dom.ts` — imported above so
// the live-channel handlers (which run on the registry-bound
// transport) can update the same status surface without a circular
// dep on this module.
// =============================================================================

// =============================================================================
// Failure surfacing. Two channels — the in-iframe status line + a
// parent-bound `postMessage`. The live-channel contract-error
// envelope (`_ggui:contract-error` on the WS) is a third path.
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

export interface RendererBootFailedMessage {
  readonly type: 'ggui:bootstrap-failed';
  readonly reason: RendererBootFailureReason;
  readonly message: string;
}

/**
 * Notify the parent that the renderer is alive + ready to receive
 * post-handshake messages. Sent immediately after the status DOM
 * mounts, BEFORE `ui/initialize` fires — gives hosts an early signal
 * that the iframe loaded its bundle successfully.
 */
function postRendererReady(): void {
  try {
    window.parent.postMessage(
      { type: 'ggui:renderer-ready', version: RENDERER_VERSION },
      '*',
    );
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
      type: 'ggui:bootstrap-failed',
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
  readonly doc: Document;
  /**
   * Issue `ui/initialize` against the parent host and return its
   * response. The default uses `makeJsonRpcCaller()` against
   * `window.parent`; tests inject a mock that returns a canned
   * `JsonRpcResponse`.
   */
  readonly callUiInitialize: () => Promise<JsonRpcResponse>;
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
  readonly notifyParent: (msg: RendererBootFailedMessage | { type: 'ggui:renderer-ready'; version: string }) => void;
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
   *   - `contract-error-emitted` — whenever a `_ggui:contract-error`
   *     envelope arrives on the live channel.
   *   - `schema-version-mismatch` — forwarded from subscribe's own
   *     emission on UPGRADE_REQUIRED.
   *   - `subscribe-failed` — forwarded from subscribe's emission on
   *     transient reconnect transitions.
   *
   * `wired-tool-invoked` is emitted from the wire config's outbound
   * dispatch path (see `buildRootWireConfig`'s `onObserve`), NOT from
   * here — the `data:submit` envelope hasn't passed through this
   * handler when it fires.
   *
   * Absent = observability emission skipped entirely (matches the
   * ProtocolError posture; the `<McpAppIframe>` host wrapper decides
   * whether to bind this via its `onObserve` prop).
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
   *   2a. `code-ready` — after first ack folds the initial stack.
   *   2b. `error` — paired with every `ggui:bootstrap-failed` emission;
   *       `error.code` mirrors the legacy envelope's `reason`.
   *
   * @public
   */
  readonly onLifecycle?: LifecycleEmitter;
  /**
   * Optional renderer hook. When present, the boot sequence:
   * (1) calls `renderer.setup()` after bootstrap parse;
   * (2) replaces the placeholder `renderStackInto` path with the
   * real `StackRenderer` on ack + subsequent pushes; (3) routes
   * inbound `data` / `props_update` / `feedback` frames through the
   * supplied wire config + StreamBus.
   *
   * When absent (default), the boot sequence runs the placeholder
   * path — used by `boot.test.ts` to exercise the orchestration
   * without pulling React + design + wire into the spec's import
   * graph.
   */
  readonly renderer?: RendererHooks;
  /**
   * Spec-canonical async slice-meta source — wraps a listener for the
   * inbound `ui/notifications/tool-result` postMessage defined by
   * MCP Apps (SEP-1865). Called once, BEFORE `callUiInitialize`, so
   * the listener is in place before any host-side race fires. When
   * synchronous tiers (`__GGUI_META__` inline global + the
   * `result.toolOutput._meta` Reading-B convention) yield nothing,
   * the resolver awaits this Promise as the spec-canonical fallback.
   *
   * Resolves to `null` on timeout or absent delivery channel — that
   * surface signals "no postMessage source available", and the
   * resolver surfaces the synchronous tier's parse reason instead.
   *
   * Production wires this to `awaitToolResultMeta(5000)` via
   * `bootProduction`. Tests omit this option (default = immediate
   * `null`) so specs don't hang on the 5s timeout.
   *
   * Spec-strict hosts (`<AppRenderer>`, ChatGPT MCP-Apps connector,
   * any host that issues `ui/initialize` without echoing
   * `toolOutput`) deliver slice meta EXCLUSIVELY through this
   * channel. claude.ai delivers via BOTH this channel and the
   * Reading-B echo (the synchronous tier wins the race); RN's
   * `<McpAppIframe>` delivers Reading-B only.
   */
  readonly awaitPostMessageMeta?: () => Promise<ValidatedMcpAppAiGguiMeta | null>;
  /**
   * Slice meta resolved BEFORE bootSequence — the autostart layer
   * (in `runtime.ts`'s autostart resolver) catches a
   * `ui/notifications/tool-result` postMessage early, parses it, and
   * threads the result here so bootSequence doesn't re-await the
   * same postMessage (the listener has already drained it).
   *
   * When present, all three internal resolver tiers (inline global,
   * Reading-B, async postMessage) are skipped. `callUiInitialize`
   * still runs — spec mandates the lifecycle handshake regardless of
   * how slice meta arrives, and `hostContext` is captured from its
   * result.
   */
  readonly preResolvedMeta?: ValidatedMcpAppAiGguiMeta;
}

/**
 * Renderer hooks. The real iframe boot plumbs these via
 * `autoBootSequence` below; tests may pass their own fakes when
 * exercising the full flow.
 */
export interface RendererHooks {
  /**
   * Called after bootstrap parse succeeds. Return value threads the
   * root `WireConfig` + `StackRenderer` back into the runtime so the
   * server-message handler can route frames through them.
   *
   * `renderInto` — a DOM element the stack renderer owns. The
   * placeholder `<ul data-ggui-stack>` is NOT reused; the renderer
   * mounts React roots per stack item into dedicated
   * containers (see `containerFor` below).
   *
   * `onObserve` — optional observability emitter threaded down to
   * the root wire config so `wired-tool-invoked` events fire on
   * every successful outbound wired-action dispatch. Absent = the
   * wire config runs with a no-op observer (the other emission sites
   * — subscribe.ts, handleObservableMessage — still fire via their
   * own emitters).
   */
  setup(params: {
    readonly meta: ValidatedMcpAppAiGguiMeta;
    readonly stackModel: StackModel;
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
  readonly stackRenderer: StackRenderer;
  readonly validatorCtx: RendererValidatorContext;
  /**
   * Send surface for outbound frames. Wired by `setup()` to the WS
   * manager obtained AFTER subscribe; initial setup supplies a
   * buffering shim that flushes on the first `send()`-ready moment.
   */
  readonly manager: { send: (msg: WebSocketMessage) => void };
  /**
   * Per-channel transport router. When the bootstrap carries
   * `streamWebSocketLocalTools` and the active
   * stack item declares `streamSpec[ch].source.tool`, the router
   * decides per-channel between WS subscribe + iframe-polling
   * fallback. Updated on every push via the stackRenderer's
   * `applyStack` hook.
   *
   * Always present — the router gracefully no-ops when no channel
   * declares `source.tool` (legacy data-frame path is unaffected).
   */
  readonly channelTransport: ChannelTransportRouter;
  /**
   * Channel-client registry holding handlers for every WS frame type
   * the iframe routes (`push`, `data`, `props_update`, `drain_ack`,
   * `channel_payload`, `channel_error`, `system`, `feedback`). The
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
}

export interface BootSequenceResult {
  readonly ok: boolean;
  readonly stack: StackModel;
}

export async function bootSequence(opts: BootSequenceOptions): Promise<BootSequenceResult> {
  const { doc, callUiInitialize, notifyParent, renderer: rendererHooks, onProtocolError, onObserve, onLifecycle } = opts;
  const connectFn: ConnectFn = opts.connectFn ?? connectViaRegistry;

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
      type: 'ggui:bootstrap-failed',
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
  // Construct the model empty + unfiltered so the initial "empty
  // placeholder" render + any early-return-on-failure path uses a
  // consistent instance. If the bootstrap parse below succeeds AND
  // pins a `stackItemId`, we swap to a filtered model before any
  // setAll / upsert runs — the filter is immutable per-instance, so
  // swap-then-reassign is the only way to lock the pin.
  let stackModel = new StackModel();
  // Initial empty-placeholder render is skipped — `refreshStackDom`
  // would write "(no stack items yet)" placeholder text into the
  // `<ul data-ggui-stack>` mount target, which (a) flashes user-
  // visible diagnostic text into every booting iframe and (b) gets
  // wiped a moment later anyway when the renderer's `containerFor`
  // appends its React mount divs. Both placeholder-only consumers
  // (boot.test.ts) and renderer consumers fold the actual stack via
  // `applyAckStack` after the ack lands; no early diagnostic write
  // is required.
  setStatus(refs, 'Negotiating with host…', 'connecting');

  notifyParent({ type: 'ggui:renderer-ready', version: RENDERER_VERSION });
  // Lifecycle `mounting` — the renderer is alive + status DOM is up,
  // but no IO has run yet. Hosts mirroring lifecycle to outer DOM see
  // this transition concurrent with `ggui:renderer-ready`. Idempotent
  // re-emission is the host's concern (per protocol, host treats
  // duplicate same-state envelopes as a no-op).
  onLifecycle?.(makeLifecycleEvent('mounting'));

  // Install the spec-canonical postMessage listener BEFORE issuing
  // `ui/initialize`. A spec-strict host (`<AppRenderer>`, ChatGPT
  // MCP-Apps connector) may post `ui/notifications/tool-result`
  // concurrently with — or immediately after — its
  // `ui/initialize` response. Listening early closes the race; if
  // the synchronous tiers below find slice meta first, the eventual
  // resolution of this Promise is ignored.
  //
  // Skipped entirely when `preResolvedMeta` is set (autostart caught
  // the postMessage already) or when the caller omits
  // `awaitPostMessageMeta` (tests default to a no-op resolver to
  // avoid hanging on the production 5s timeout).
  const postMessageMetaPromise: Promise<ValidatedMcpAppAiGguiMeta | null> =
    opts.preResolvedMeta !== undefined
      ? Promise.resolve(null)
      : opts.awaitPostMessageMeta?.() ?? Promise.resolve(null);

  const initResp = await callUiInitialize();
  if (initResp.error !== undefined || initResp.result === undefined) {
    const message = initResp.error?.message ?? 'ui/initialize returned no result';
    setStatus(refs, `ui/initialize failed: ${message}`, 'error');
    emitBootFailure('UI_INITIALIZE_FAILED', message);
    return { ok: false, stack: stackModel };
  }

  // Slice-meta resolution — spec-canonical primary, in-house Reading-B
  // as back-compat fallback.
  //
  //   Tier 0  preResolvedMeta — autostart-layer pre-resolution. When
  //           the autostart's own `awaitToolResultMeta` race caught a
  //           postMessage before bootSequence ran, it threads the
  //           parsed slice meta here so we don't re-await the same
  //           delivery. Skips every tier below.
  //
  //   Tier 1  parseMetaFromGlobal — synchronous `__GGUI_META__` inline
  //           global. Self-contained shells (`buildSelfContainedHtml`,
  //           per-session resource shells) populate this before this
  //           bundle's `<script type="module">` evaluates.
  //           Opportunistic — its absence (the common case for
  //           postMessage-delivered hosts) never surfaces as a parse
  //           failure to the caller.
  //
  //   Tier 2  parseMetaFromUiInitialize — synchronous Reading-B,
  //           i.e. `result.toolOutput._meta`. This is OUR in-house
  //           convention from the `<McpAppIframe>` (RN) era — the
  //           MCP-Apps spec's `McpUiInitializeResult` does NOT define
  //           `toolOutput`. Kept here as the second tier because the
  //           McpAppIframe (RN) consumer still depends on it AND
  //           claude.ai's host gives it for free as a bonus echo
  //           (faster than waiting for the postMessage).
  //
  //   Tier 3  awaitPostMessageMeta — spec-canonical async fallback.
  //           Listens for `ui/notifications/tool-result` postMessage
  //           per MCP-Apps SEP-1865. The ONLY path that works for
  //           spec-strict hosts (`<AppRenderer>`, ChatGPT MCP-Apps
  //           connector, any host that doesn't echo toolOutput).
  //
  // When all three tiers fail, we surface the Tier 2 failure reason
  // (most diagnostic — it had a concrete payload to parse), not
  // Tier 1's (`MALFORMED_BOOTSTRAP` from "global absent" is noise).
  let parsed: McpAppAiGguiMetaParseResult;
  if (opts.preResolvedMeta !== undefined) {
    parsed = { ok: true, meta: opts.preResolvedMeta };
  } else {
    const inline = parseMetaFromGlobal();
    if (inline.ok) {
      parsed = inline;
    } else {
      parsed = parseMetaFromUiInitialize(initResp.result);
      if (!parsed.ok) {
        const fromPostMessage = await postMessageMetaPromise;
        if (fromPostMessage !== null) {
          parsed = { ok: true, meta: fromPostMessage };
        }
      }
    }
  }

  // hostContext is captured opportunistically from the `ui/initialize`
  // result regardless of which tier resolved slice meta. Reading-B's
  // `parseMetaFromUiInitialize` already lifts it inline; for the other
  // tiers (preResolved / inline global / postMessage) the result
  // payload would otherwise be ignored. Project it independently so
  // canvas-mode display-mode escalation works uniformly across
  // delivery channels.
  if (parsed.ok && parsed.hostContext === undefined) {
    const initResultBag =
      initResp.result !== null
      && typeof initResp.result === 'object'
      && !Array.isArray(initResp.result)
        ? (initResp.result as Record<string, unknown>)
        : undefined;
    const hostContext = projectHostContext(initResultBag?.['hostContext']);
    if (hostContext !== undefined) {
      parsed = { ...parsed, hostContext };
    }
  }

  if (!parsed.ok) {
    const message = `slice-meta parse failed: ${parsed.reason}`;
    setStatus(refs, message, 'error');
    emitBootFailure(parsed.reason, message);
    return { ok: false, stack: stackModel };
  }

  // Destructure the parsed slices once — `session` is guaranteed
  // present on the ok:true arm by `validateSlices`; `stackItem` is
  // optional (session-only refresh envelopes).
  const { session, stackItem } = parsed.meta;

  // Install the precompiled, eval-free contract validators shipped on
  // the bootstrap BEFORE any wire traffic is validated. Self-contained
  // ESM modules — no `__ggui__` dependency, so this need not wait for
  // `installGlobalRegistry`. A failed load leaves the validation seam
  // to fall back to in-iframe compilation (CSP-blocked, but no worse
  // than pre-A4).
  setActiveValidatorSet(
    await loadCompiledValidatorsFromUrl(stackItem?.validatorsUrl),
  );

  // Single-item mode. When a per-item resource route served this
  // resource, the bootstrap carries `stackItemId` and the renderer
  // binds to just that stack entry. Absent (whole-session resource)
  // → multi-item render path. The swap happens BEFORE any setAll /
  // upsert so filter semantics apply to the first-frame stack the
  // ack delivers.
  if (stackItem?.stackItemId !== undefined) {
    stackModel = new StackModel({ filterToItemId: stackItem.stackItemId });
  }

  // Renderer wiring — when supplied, the handler routes frames through
  // StackRenderer + WireConfig + StreamBus. When absent, the placeholder
  // path runs (boot.test.ts relies on the latter to keep its import
  // graph tiny). The renderer's channelRegistry is the dispatch surface
  // for every WS frame; `connectFn` registers handshake handlers on
  // top of the existing registry then binds the transport.
  const renderer =
    rendererHooks !== undefined
      ? rendererHooks.setup({
          meta: parsed.meta,
          stackModel,
          renderInto: refs.stack,
          statusRefs: refs,
          ...(onObserve !== undefined ? { onObserve } : {}),
        })
      : null;

  setStatus(refs, `Connecting to ${session.sessionId}…`, 'connecting');

  // Boot-without-renderer path: we still need a ChannelRegistry to
  // receive frames, because the registry is the only dispatch
  // surface. Build a minimal one with just the `push` placeholder
  // handler so non-renderer consumers (boot.test.ts) see the
  // `data-ggui-stack-item` upserts.
  const placeholderRegistry =
    renderer === null
      ? createPlaceholderRegistry({
          session,
          stackModel,
          statusRefs: refs,
        })
      : null;
  const activeRegistry = renderer?.channelRegistry ?? placeholderRegistry!;

  /**
   * Apply an ack's stack snapshot to the runtime — populates the model,
   * refreshes status DOM, and (when renderer is wired) re-renders the
   * stack + re-activates the top item's channel-transport entry. Used
   * by:
   *
   *   - The initial bootSequence path (first ack after subscribe).
   *   - The WS reconnect-with-rebootstrap path (every subsequent ack
   *     when the underlying WSTransport reconnects + re-fires
   *     subscribe). A push or update that landed during the dropout
   *     window flows back through here.
   *
   * Idempotent on identical inputs — `stackModel.setAll` is a snapshot
   * replace; `applyStack` + `applyStackItem` are server-side idempotent
   * on the (stackItemId, channelName) tuple.
   */
  const applyAckStack = async (ackPayload: {
    readonly stack?: readonly SessionStackEntry[];
  }): Promise<void> => {
    if (ackPayload.stack === undefined) return;
    stackModel.setAll(ackPayload.stack);
    // Placeholder DOM render only when renderer is absent (boot.test.ts).
    // Renderer-mode iframes own the `<ul data-ggui-stack>` for React
    // mounts via `containerFor`; calling `refreshStackDom` here would
    // wipe React's mounts mid-flight.
    if (renderer === null) {
      refreshStackDom(refs, stackModel);
    }
    if (renderer !== null) {
      await renderer.stackRenderer.applyStack(stackModel.snapshot());
      const snapshot = stackModel.snapshot();
      const top = snapshot[snapshot.length - 1];
      if (
        top !== undefined &&
        top.type !== 'mcpApps' &&
        top.type !== 'system'
      ) {
        renderer.channelTransport.applyStackItem({
          stackItemId: top.id,
          ...(top.streamSpec !== undefined
            ? { streamSpec: top.streamSpec }
            : {}),
        });
      }
    }
  };

  let handle: RegistrySubscribeHandle;
  try {
    handle = await connectFn({
      session,
      registry: activeRegistry,
      onStatusChange: (status) => {
        setStatus(
          refs,
          status === 'connected'
            ? `Connected (${stackModel.size()} item${stackModel.size() === 1 ? '' : 's'}).`
            : `Connection ${status}…`,
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
      // Forward observability emissions (schema-version-mismatch,
      // subscribe-failed). The renderer owns `contract-error-emitted`
      // via the data channel handler; connectFn owns the other two.
      ...(onObserve !== undefined ? { onObserve } : {}),
      // Reconnect-with-rebootstrap — on every ack received AFTER the
      // initial handshake settled, reapply the server's authoritative
      // `stack` snapshot. A push or update that landed during a WS
      // dropout window restores here without an agent re-prompt.
      onResubscribeAck: (ack) => {
        void applyAckStack(ack);
      },
      // R7 — registry-level events-polling fallback. Composed once at
      // bind time from `session.pollingUrl` (server-stamped wsToken-
      // gated /api/sessions/<id>/events URL) + `session.lastSequence`
      // (cursor seed). FailoverHandle uses this when WS reaches
      // 'failed'; absent → no polling fallback (WS-only mode).
      //
      // Same cursor model as the WS subscribe `sinceSequence` replay
      // path — switching transports does not lose events.
      ...(typeof session.pollingUrl === 'string' && session.pollingUrl.length > 0
        ? {
            polling: buildEventsPolling({
              baseUrl: session.pollingUrl,
              ...(session.lastSequence !== undefined
                ? { initialSinceSequence: session.lastSequence }
                : {}),
            }),
          }
        : {}),
    });
  } catch (err) {
    if (renderer !== null) rendererHooks?.teardown?.(renderer);
    if (isUpgradeRequiredErrorLike(err)) {
      const message = err.message;
      setStatus(refs, message, 'upgrade-required');
      // `UPGRADE_REQUIRED` already emits a typed `version` error via
      // connectFn's onProtocolError path; the bootstrap-failure emit
      // here carries the coarse-grained reason for hosts that only
      // pattern-match `kind: 'bootstrap'`.
      emitBootFailure('UPGRADE_REQUIRED', message);
      return { ok: false, stack: stackModel };
    }
    const message = err instanceof Error ? err.message : String(err);
    setStatus(refs, `WS handshake failed: ${message}`, 'error');
    emitBootFailure('WS_HANDSHAKE_FAILED', message);
    return { ok: false, stack: stackModel };
  }

  // Attach the live transport handle to the renderer — flushes any
  // buffered outbound frames (feedback / action) that were queued
  // while the subscribe handshake completed. `handle.handle.send` is
  // the canonical send surface for the bound WS transport.
  if (renderer !== null && rendererHooks?.attachManager !== undefined) {
    rendererHooks.attachManager(renderer, { send: (msg) => handle.handle.send(msg) });
  }

  // seed the host-context emitter with the
  // projection `parseMetaFromUiInitialize` captured from `ui/initialize`'s
  // `hostContext` field, and install the `host-context-changed`
  // notification listener so subsequent live updates also echo to
  // the server. Both calls are idempotent and no-op when the host
  // didn't emit a HostContext (parsed.hostContext === undefined).
  if (parsed.hostContext !== undefined) {
    seedHostContext({
      sessionId: session.sessionId,
      send: (msg) => handle.handle.send(msg),
      initial: parsed.hostContext,
    });
    attachHostContextListener();
  }

  // First ack — populate the stack from the snapshot the server
  // returned. Under renderer mode, also hand the initial stack to the
  // renderer so its mounts match the model on first frame.
  //
  // Reuses the same `applyAckStack` helper the reconnect-rebootstrap
  // path uses — so a server-restart-driven full snapshot replay and
  // the first-boot snapshot apply flow through one implementation.
  await applyAckStack(handle.ack);
  setConnectedStatus(refs, stackModel);
  // Lifecycle `code-ready` — terminal happy state. The bundle has
  // evaluated, the WS handshake completed, the first ack folded into
  // the stack. Hosts pinning selectors on `code-ready` (E2E specs,
  // accessibility scanners) re-resolve here. When the bootstrap pinned
  // a `stackItemId` (single-item mode), forward it so the host can
  // mirror per-card lifecycle on the outer element if it's keyed by
  // stack item id.
  onLifecycle?.(
    makeLifecycleEvent('code-ready', {
      ...(stackItem?.stackItemId !== undefined
        ? { stackItemId: stackItem.stackItemId }
        : {}),
    }),
  );

  return { ok: true, stack: stackModel };
}

/**
 * Build a minimal `ChannelRegistry` for boot paths without renderer
 * wiring (boot.test.ts + the C7a placeholder-only spec). The registry
 * carries just the `push` handler (which folds frames into the
 * placeholder DOM) — every other frame type silently drops. Production
 * boots through `bootProduction` which supplies a fully-populated
 * renderer with the rich handler set.
 */
function createPlaceholderRegistry(params: {
  readonly session: McpAppAiGguiSessionMeta;
  readonly stackModel: StackModel;
  readonly statusRefs: StatusRefs;
}): ChannelRegistry {
  const registry = new ChannelRegistry({
    subscribeFrameBuilder: () => ({
      type: 'subscribe',
      payload: {
        sessionId: params.session.sessionId,
        appId: params.session.appId,
        ...(params.session.wsToken !== undefined
          ? { wsToken: params.session.wsToken }
          : {}),
      },
    }),
  });
  registry.register(
    createPushHandler({
      stackModel: params.stackModel,
      statusRefs: params.statusRefs,
    }),
  );
  return registry;
}

/**
 * Frame dispatch lives inside `@ggui-ai/live-channel`'s
 * `ChannelRegistry`. Every WS frame type (`push`, `data`,
 * `props_update`, `drain_ack`, `feedback`, `channel_payload`,
 * `channel_error`, `system`) has a registered handler in
 * `channels/*.ts`; the registry's bound transport routes inbound
 * frames directly to them. Observability emissions
 * (`contract-error-emitted`, `auth-required`) are now inside the
 * data + system handlers respectively.
 *
 * The pre-B3b helpers (`handleServerMessage`, `handleRendererMessage`,
 * `handleObservableMessage`, `emitContractErrorFromDataFrame`,
 * `emitAuthRequiredFromSystemFrame`, `BufferedManagerShim`) lived
 * here and have been retired — see commit message + plan B3b for the
 * full retirement notes.
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
// `_meta["ai.ggui/session"]` + `_meta["ai.ggui/stack-item"]` slices →
// open WebSocket → subscribe → render stack from frames) is strictly
// first-party: it requires the host to speak ggui's custom postMessage
// protocol AND a reachable live-channel WebSocket the renderer can
// subscribe against. MCP Apps hosts in the wild (Claude Desktop,
// claude.ai web) speak only the canonical MCP Apps lifecycle and have
// no commitment to forward those slice keys back through
// `ui/initialize`. The full first-party path stays intact for callers
// that own both ends; this self-contained path is what makes the same
// runtime bundle work in third-party MCP Apps hosts.
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
 * Self-contained slice-meta shape — alias for {@link
 * ValidatedMcpAppAiGguiMeta}. Earlier versions of this module had
 * separate `SelfContainedComponentBootstrap` /
 * `SelfContainedSystemBootstrap` narrowings, then collapsed to a single
 * `McpAppAiGguiMeta`. Post-#109 the aggregated view is gone:
 * consumers read the two per-window slices (`session` + `stackItem`)
 * directly. The same shared parser pipeline produces a {@link
 * McpAppAiGguiMeta} from any of three delivery channels.
 *
 * The export is kept so downstream consumers (`@ggui-ai/iframe-runtime`
 * barrel, dependent test suites) don't break.
 *
 * @public
 */
export type SelfContainedMcpAppAiGguiMeta = ValidatedMcpAppAiGguiMeta;

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
export function readSelfContainedMeta(): SelfContainedMcpAppAiGguiMeta | null {
  const result = parseMetaFromGlobal();
  return result.ok ? result.meta : null;
}

/**
 * Extract a {@link SelfContainedMcpAppAiGguiMeta} from a
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
): SelfContainedMcpAppAiGguiMeta | null {
  const result = parseMetaFromToolResult(params);
  return result.ok ? result.meta : null;
}

/**
 * Drain `window.__GGUI_PENDING_TOOL_RESULTS__` — the buffer the
 * minimal shell populates while messages arrive between
 * shell-load and runtime-load. Returns the first valid slice meta
 * found; later params (if any) are dropped (each new tool-result
 * supersedes the previous).
 *
 * The shell-side buffer contract: an array of
 * `{params: unknown}`-shaped JSON-RPC params from
 * `ui/notifications/tool-result` notifications, populated in
 * arrival order. The runtime drains it on first read.
 */
function readPendingToolResults(): SelfContainedMcpAppAiGguiMeta | null {
  if (typeof window === 'undefined') return null;
  const raw = (window as unknown as {
    __GGUI_PENDING_TOOL_RESULTS__?: unknown;
  }).__GGUI_PENDING_TOOL_RESULTS__;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  for (const params of raw) {
    const meta = extractMetaFromToolResult(params);
    if (meta !== null) return meta;
  }
  return null;
}

/**
 * Listen for a `ui/notifications/tool-result` postMessage from the
 * parent window and resolve to the extracted slice meta. Times out
 * after `timeoutMs`; resolves `null` on timeout so the caller can
 * fall through to a legacy boot path (e.g. {@link bootProduction}).
 *
 * Pairs with the minimal-shell pattern: shell buffers any tool-
 * results that arrived BEFORE runtime load (read via
 * {@link readPendingToolResults}); this listener catches the ones
 * that arrive AFTER. The two cover the full timing race.
 */
function awaitToolResultMeta(
  timeoutMs: number,
): Promise<SelfContainedMcpAppAiGguiMeta | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: SelfContainedMcpAppAiGguiMeta | null) => {
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
      if (meta !== null) settle(meta);
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => settle(null), timeoutMs);
  });
}

/**
 * Post-mount resize plumbing for MCP Apps hosts that size the outer
 * iframe based on the inner content height. claude.ai (web +
 * desktop) honors `ui/notifications/size-changed` notifications;
 * other hosts ignore them harmlessly.
 *
 * Owning this in the runtime (instead of duplicated in every shell
 * builder) is the same architectural fix as
 * {@link extractMetaFromToolResult}: anything that observes
 * mounted-component state belongs alongside the mount, not in the
 * shell.
 */
function installResizeObserver(rootEl: Element): void {
  if (typeof window === 'undefined') return;
  let lastH = 0;
  const emit = () => {
    const docBody = window.document.body;
    const h = Math.max(
      rootEl instanceof HTMLElement ? rootEl.scrollHeight : 0,
      docBody.scrollHeight,
      200,
    );
    if (h === lastH) return;
    lastH = h;
    try {
      window.parent.postMessage(
        {
          jsonrpc: '2.0',
          method: 'ui/notifications/size-changed',
          params: { height: h },
        },
        '*',
      );
    } catch {
      // Detached parent — swallow (matches postBootFailure posture).
    }
  };
  emit();
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(emit);
    ro.observe(rootEl);
    ro.observe(window.document.body);
  } else {
    setInterval(emit, 500);
  }
}

/**
 * Module-level guard for {@link installPostMountListener}. Ensures
 * exactly one persistent `ui/notifications/tool-result` listener is
 * attached even when `bootSelfContained` is called multiple times
 * (e.g. an agent fires a second `ggui_push` and we re-mount).
 */
let postMountListenerInstalled = false;

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
 * Compute a short deterministic action-id from a wired-action
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
 * Render a wired-action's `data` payload as a short inline string
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
export function formatWiredActionDataInline(data: unknown): string {
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
 * Dispatch a wired-action via the empirically-validated bridge
 * chain (validated against claude.ai):
 *
 *   1. `tools/call` to {@link toolName} with the action envelope
 *      — server-side gateway log + audit. Hosts MUST honor
 *      `_meta.ui.visibility:['app']` per spec §401, otherwise the
 *      call is silently rejected (probe found this empirically).
 *   2. `ui/update-model-context` (silent) — drops a structured
 *      `[ggui:pending-action]` payload into the LLM's persistent
 *      context. Carries the exact intent + data + actionId so the
 *      LLM has unambiguous tool args (no natural-language
 *      paraphrase risk).
 *   3. `ui/message` (consent prompt) — natural-language
 *      authorization the user confirms in chat. Spec §1032 + §401
 *      together: this is the prompt-injection firewall — the
 *      iframe can ASK the LLM to act, but the user is the one who
 *      introduces the message into the LLM's context.
 *
 * Why all three: the probe empirically proved that `tools/call`
 * alone never reaches the LLM (host-side scope:['app'] firewall),
 * and `ui/message` alone forces the LLM to parse natural language
 * for tool args (lossy + hallucination-prone). Pairing them with
 * a hash-bound id (#3) gives the LLM both verifiable args AND
 * explicit user authorization.
 *
 * Parts 2+3 fail-soft: if the host rejects either, the user can
 * still observe the click via #1's audit log on the server side,
 * but the LLM won't act on it. Acceptable degraded UX vs. the
 * pre-bridge "silent button click" status quo.
 */
/**
 * Post an arbitrary JSON-RPC envelope to the iframe's parent
 * window. Internal helper shared across {@link dispatchWiredAction},
 * {@link emitAudit}, and the native-idiom interceptors (`openLink` /
 * `requestDisplayMode`). Detached parent → silent drop (non-fatal).
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
 * Request-response JSON-RPC postMessage. Fires the envelope up to
 * `window.parent` and resolves when the parent echoes back a message
 * with the matching `id`. Used by the channel-transport router's
 * iframe-polling fallback to fire `tools/call` directly (Pattern α)
 * without an LLM consent loop.
 *
 * Detached parent → rejects with a synchronous error. Single
 * shared listener per iframe lifecycle (added on first call) so the
 * router doesn't churn `'message'` handlers per poll tick.
 *
 * Distinct from {@link makeJsonRpcCaller} which is a CLOSURE-scoped
 * caller bound to the bootstrap-mode `ui/initialize` flow. This one
 * is a top-level helper the renderer setup uses for every `tools/call`
 * — moving it here keeps the channel-transport router pure (no
 * `window.addEventListener` inside).
 */
let postRpcToParentInited = false;
const postRpcToParentPending = new Map<
  number,
  (resp: JsonRpcResponse) => void
>();
let postRpcToParentNextId = 1_000_000;
function ensurePostRpcToParentListener(): void {
  if (postRpcToParentInited) return;
  if (typeof window === 'undefined') return;
  postRpcToParentInited = true;
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as unknown;
    if (data === null || typeof data !== 'object') return;
    const id = (data as { id?: unknown }).id;
    if (typeof id !== 'number') return;
    // Filter for RESPONSES — must carry `result` or `error`. Bare
    // requests with `method` set are not responses. This matters in
    // `/r/<shortCode>` top-level mode where `window.parent === window`,
    // so the outbound `tools/call` echoes back through this same
    // listener before any relay's response arrives; without the filter
    // the pending promise resolves with the request itself and the
    // real response is dropped.
    if (!('result' in data) && !('error' in data)) return;
    const resolver = postRpcToParentPending.get(id);
    if (resolver === undefined) return;
    postRpcToParentPending.delete(id);
    resolver(data as JsonRpcResponse);
  });
}
function postRpcToParent(
  method: string,
  params: unknown,
): Promise<JsonRpcResponse> {
  if (typeof window === 'undefined') {
    return Promise.resolve({
      error: { message: 'postRpcToParent: no window' },
    });
  }
  ensurePostRpcToParentListener();
  return new Promise<JsonRpcResponse>((resolve) => {
    const id = postRpcToParentNextId;
    postRpcToParentNextId += 1;
    postRpcToParentPending.set(id, resolve);
    try {
      window.parent.postMessage(
        { jsonrpc: '2.0', id, method, params: params ?? {} },
        '*',
      );
    } catch (err) {
      postRpcToParentPending.delete(id);
      resolve({
        error: {
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });
}

/**
 * Fire a single canonical action envelope (`tools/call
 * ggui_runtime_submit_action`) carrying the typed `{kind, payload, …}` shape
 * defined in `@ggui-ai/protocol/integrations/mcp-apps`. Every
 * user-driven gesture (Pattern α/β dispatch, native-idiom anchor click,
 * native-idiom fullscreen request) calls this alongside its primary
 * host effect, so operators get **uniform server-side observability**
 * across every gesture kind.
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
  readonly stackItemId?: string;
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
        ...(args.stackItemId !== undefined
          ? { stackItemId: args.stackItemId }
          : {}),
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
  const result = (resp as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') return 'fallback';
  const r = result as Record<string, unknown>;
  // Spec-canonical hosts wrap tool output under `structuredContent`;
  // looser hosts may surface fields directly on `result`.
  const inner =
    r.structuredContent && typeof r.structuredContent === 'object'
      ? (r.structuredContent as Record<string, unknown>)
      : r;
  return inner.ok === true ? 'success' : 'fallback';
}

/**
 * Extract `consumerPresent` from a successful submit_action response.
 * Returns the boolean if present + well-typed; `undefined` otherwise
 * (server didn't wire the registry, agnostic host stripped the field,
 * or any non-`ok:true` shape — callers fall back to the 10s timer
 * path on `undefined`). Mirrors the structuredContent → result
 * unwrap of {@link classifySubmitActionResponse} so both reads agree
 * on which envelope tier carries the success payload.
 */
function extractConsumerPresent(
  resp: JsonRpcResponse,
): boolean | undefined {
  if (resp === null || typeof resp !== 'object') return undefined;
  const result = (resp as { result?: unknown }).result;
  if (result === null || typeof result !== 'object') return undefined;
  const r = result as Record<string, unknown>;
  const inner =
    r.structuredContent && typeof r.structuredContent === 'object'
      ? (r.structuredContent as Record<string, unknown>)
      : r;
  const flag = inner.consumerPresent;
  return typeof flag === 'boolean' ? flag : undefined;
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
 *  - Survives Hot/StackModel transitions.
 *
 * Single global toast (per iframe). Auto-dismisses after 2.5s on
 * `success` / `fallback` outcomes; the `pending` state holds
 * indefinitely until a follow-up call updates it.
 *
 * Operator override: set `window.__GGUI_TOAST_DISABLED__ = true`
 * before the runtime boots to suppress (e.g., for first-party hosts
 * that want their own toast UI).
 *
 * @internal — runtime-layer concern.
 */
type ToastKind =
  | 'pending'
  | 'success'
  | 'fallback' // legacy auto-dismissing fallback toast
  | 'action_required' // A8 — persistent "press send in chat to forward"
  | 'error';
function showActionToast(text: string, kind: ToastKind): void {
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
  // Clear any prior auto-dismiss timer so a fresh pending toast
  // doesn't get hidden mid-flight.
  const elWithTimer = el as HTMLElement & { __toastTimer?: number };
  if (elWithTimer.__toastTimer) clearTimeout(elWithTimer.__toastTimer);
  // `action_required` PERSISTS until the user clicks the toast
  // (manual dismiss). Per MCP Apps spec, `ui/message` is a
  // PREPARED user prompt — the host renders it into the chat input
  // but the user must press send for it to reach the agent. So the
  // toast can't auto-dismiss; doing so would imply the gesture went
  // through when it actually requires a user follow-up.
  if (kind === 'action_required') {
    el.onclick = () => {
      if (!el) return;
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(8px)';
      el.onclick = null;
    };
  } else {
    el.onclick = null;
    if (kind === 'success' || kind === 'fallback' || kind === 'error') {
      elWithTimer.__toastTimer = window.setTimeout(() => {
        if (!el) return;
        el.style.opacity = '0';
        el.style.transform = 'translateX(-50%) translateY(8px)';
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
  el.style.opacity = '0';
  el.style.transform = 'translateX(-50%) translateY(8px)';
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
 * Emit a `ui/message` envelope tagged with
 * `_meta.ggui.userAction.kind === 'inline'`. Fires when `submit_action`
 * did NOT successfully append to the pipe (PIPE_NOT_FOUND, transport
 * error, or the host has no relay). The full action payload travels
 * inline so the agent can act WITHOUT calling `ggui_consume` for this
 * stack item (the pipe is gone).
 *
 * `nextStep` is optional — when the contract bound `actionSpec[intent]`
 * to a specific agent tool we forward that hint; absent when the
 * author left it free.
 */
function emitUserActionInline(args: {
  readonly intent: string;
  readonly actionData: unknown;
  readonly uiContext: Record<string, unknown>;
  readonly actionId: string;
  readonly stackItemId: string;
  readonly submittedAt: string;
  readonly nextStep?: string;
}): void {
  // Prose-only text. Earlier revisions embedded a fenced ```json``` block
  // with the full payload so hosts that strip `_meta` could still read
  // it. That format mirrored Anthropic's tool-use JSON shape too closely
  // and tripped claude.ai's prompt-injection classifier — even on the
  // user-trusted `ui/message` channel — so the message got flagged
  // before reasoning. The fix is structural: keep structured data
  // ONLY on `_meta.ggui.userAction.payload` (where MCP Apps hosts read
  // it through the spec's trusted path) and let the text carry a
  // natural-language summary that no classifier can mistake for a
  // tool-call injection.
  const description = `User fired ${args.intent} on ${args.stackItemId}`;
  const text =
    `User fired "${args.intent}" on stack item ${args.stackItemId}. ` +
    `The action pipe was unavailable, so the gesture is inlined on this ` +
    `message instead of queued on the consume pipe. Use the userAction ` +
    `payload to handle it directly; do NOT call ggui_consume for this ` +
    `stack item.`;
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text }],
      _meta: {
        ggui: {
          userAction: {
            kind: 'inline',
            description,
            stackItemId: args.stackItemId,
            actionId: args.actionId,
            submittedAt: args.submittedAt,
            intent: args.intent,
            payload: {
              actionData: args.actionData ?? null,
              uiContext: args.uiContext,
            },
            ...(args.nextStep !== undefined ? { nextStep: args.nextStep } : {}),
          },
        },
      },
    },
  });
}

/**
 * Emit a `ui/message` envelope tagged with
 * `_meta.ggui.userAction.kind === 'queued'`. Fires when `submit_action`
 * succeeded BUT the server reported `consumerPresent: false` — the
 * action IS on the pipe; the agent just needs to call `ggui_consume`
 * to drain it. Carries the prepared `{tool, args}` so the SDK can
 * dispatch verbatim.
 */
function emitUserActionQueued(args: {
  readonly intent: string;
  readonly stackItemId: string;
  readonly actionId: string;
  readonly submittedAt: string;
}): void {
  // Prose-only text. Earlier revisions appended a fenced ```json``` block
  // shaped as `{"tool":"ggui_consume","args":{...}}` — a verbatim copy
  // of Anthropic's tool-call wire shape. claude.ai's prompt-injection
  // classifier flagged this even on the user-trusted `ui/message`
  // channel: data that looks like a tool-call injection IS treated as
  // one, regardless of who supplied it. The stackItemId + next-tool
  // hint stay in prose; the canonical machine-readable form lives on
  // `_meta.ggui.userAction.nextStep`.
  const description = `User fired ${args.intent} on ${args.stackItemId}`;
  const text =
    `User fired "${args.intent}" on stack item ${args.stackItemId}. ` +
    `The gesture is queued on the consume pipe but no consumer is active — ` +
    `call ggui_consume with this stackItemId next to drain the canonical payload.`;
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/message',
    params: {
      role: 'user',
      content: [{ type: 'text', text }],
      _meta: {
        ggui: {
          userAction: {
            kind: 'queued',
            description,
            stackItemId: args.stackItemId,
            actionId: args.actionId,
            submittedAt: args.submittedAt,
            intent: args.intent,
            nextStep: {
              tool: 'ggui_consume',
              args: { stackItemId: args.stackItemId },
            },
          },
        },
      },
    },
  });
}

/** @internal — exported for unit tests. */
export function dispatchWiredAction(args: {
  readonly toolName: string;
  readonly intent: string;
  readonly data: unknown;
  readonly sessionId: string;
  readonly stackItemId?: string;
  readonly appId: string;
  /**
   * Optional `actionSpec[intent].nextStep` hint forwarded by the
   * caller. Surfaced on the inline-userAction envelope when the pipe
   * isn't available, so the agent has a strong steer toward the right
   * tool.
   */
  readonly nextStep?: string;
}): void {
  if (typeof window === 'undefined') return;
  const { toolName, intent, data, sessionId, stackItemId, appId, nextStep } = args;
  const firedAt = new Date().toISOString();
  const actionId = fnv1aHex(
    `${intent}|${JSON.stringify(data ?? null)}|${firedAt}`,
  );
  const inlineData = formatWiredActionDataInline(data);
  const dataPart = inlineData === '' ? '' : ` (${inlineData})`;
  const uiContext = readLocalUiContext();

  // (1) Silent context update — fires FIRST and ALWAYS. Primes the
  // LLM's widget-context surface regardless of which downstream path
  // catches the event (pipe or ui/message). Fire-and-forget; no
  // response needed.
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/update-model-context',
    params: {
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
    },
  });

  // (1.5) Toast — pending state. User sees "→ Sending: archive"
  // immediately so they know the click was registered, even when
  // submit_action's HTTP round-trip takes a moment. State updates
  // when the response (or fallback) lands.
  showActionToast(`→ ${intent}${dataPart}`, 'pending');

  // (2) Try submit_action via host relay. Spec-compliant hosts
  // forward the tools/call to the MCP server's submit_action handler;
  // the pipe entry lands with `id: actionId`. On success, branch on
  // `consumerPresent`:
  //   - true (or undefined): toast stays `pending`; drain_ack will
  //     dismiss it when the agent's ggui_consume drains the event.
  //   - false: no consumer is registered; emit a queued userAction
  //     nudge IMMEDIATELY so the agent's next turn drains the pipe.
  //     No timer, no rescue — the pipe holds the data.
  //
  // (3) On any non-success outcome (PIPE_NOT_FOUND, transport error,
  // host has no relay), emit an inline userAction with the full
  // gesture payload + uiContext so the agent can act without calling
  // ggui_consume (the pipe is gone).
  void (async () => {
    let resp: Awaited<ReturnType<typeof postRpcToParent>> | null = null;
    try {
      resp = await postRpcToParent('tools/call', {
        name: toolName,
        arguments: {
          kind: 'dispatch',
          payload: {
            intent,
            actionData: data ?? null,
            uiContext,
          },
          sessionId,
          ...(stackItemId !== undefined ? { stackItemId } : {}),
          appId,
          actionId,
          firedAt,
        },
      });
    } catch {
      showActionToast(`⚠ ${intent} — transport error`, 'error');
      resp = null;
    }
    if (resp !== null && classifySubmitActionResponse(resp) === 'success') {
      const consumerPresent = extractConsumerPresent(resp);
      if (consumerPresent === false && stackItemId !== undefined) {
        showActionToast(
          `💬 ${intent}${dataPart} — agent not listening, sent to chat`,
          'action_required',
        );
        emitUserActionQueued({
          intent,
          stackItemId,
          actionId,
          submittedAt: firedAt,
        });
        return;
      }
      if (stackItemId === undefined) {
        // Bootstrap didn't carry a stackItemId — no specific pipe to
        // drain. Treat as a one-shot success.
        showActionToast(`✓ ${intent} queued for agent`, 'success');
      }
      // Otherwise toast stays `pending`; drain_ack listener dismisses
      // it when ggui_consume drains the event.
      return;
    }

    // Pipe gone or transport failed. Emit inline userAction so the
    // agent can act on the gesture without calling ggui_consume.
    showActionToast(
      `💬 ${intent}${dataPart} — press send in chat to forward`,
      'action_required',
    );
    emitUserActionInline({
      intent,
      actionData: data ?? null,
      uiContext,
      actionId,
      stackItemId: stackItemId ?? '',
      submittedAt: firedAt,
      ...(nextStep !== undefined ? { nextStep } : {}),
    });
  })();
}

/**
 * Fire a wired action via Pattern α — direct `tools/call` against a
 * same-server, app-visible target tool. The iframe is allowed to fire
 * the tool directly from this server connection per MCP-Apps spec
 * §2026-01-26 visibility rules. Skips the submit_action pipe entirely:
 * the tool fires without the agent's involvement (the whole point of
 * Pattern α), chat stays clean.
 *
 * PIPE-2 design note: Pattern α deliberately does NOT fire
 * `submit_action` — a pipe append would queue the gesture for the
 * agent's `ggui_consume` long-poll, causing double-processing
 * (host's tool relay AND agent's reaction). SessionInspector loses
 * Pattern α observability for now; re-add via a dedicated audit-only
 * gesture kind if operators need it.
 *
 * @internal — exported for unit tests.
 */
export function fireDirectToolCall(args: {
  readonly targetToolName: string;
  readonly data: unknown;
}): void {
  if (typeof window === 'undefined') return;
  const { targetToolName, data } = args;

  // Direct tools/call — fires on the same MCP server connection the
  // iframe was bootstrapped against. Spec §2026-01-26: "app"
  // visibility tools are callable by the app from the same server
  // connection only.
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'tools/call',
    params: {
      name: targetToolName,
      arguments: (data ?? {}) as Record<string, unknown>,
    },
  });
}

/**
 * Pure routing helper for `WireConfig.dispatch` — chooses Pattern α
 * (direct `tools/call`) when the action's wired tool is in
 * `appCallableTools`, otherwise falls back to Pattern β (the 3-message
 * bridge).
 *
 * The routing logic was previously inlined as a closure body inside
 * `bootSelfContained`'s `wireConfig.dispatch`, with a verbatim
 * re-creation in `__tests__/dispatch-routing.test.ts`. Tests could
 * pass against stale code if either drifted. Extraction means
 * production + tests now exercise the same code path.
 *
 * Pattern α (same-server, app-visible target tool): chat stays clean,
 * no LLM consent loop. Pattern β (anything else: cross-server tool, no
 * wired tool, or tool not in `appCallableTools`): the canonical
 * 3-message workaround the LLM brokers when the tool isn't directly
 * callable from the iframe.
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
 * @internal — exported for unit tests + production reuse.
 */
export function routeDispatch(args: {
  readonly actionName: string;
  readonly data: unknown;
  readonly meta: {
    readonly sessionId: string;
    readonly stackItemId?: string;
    readonly appId: string;
    readonly appCallableTools?: readonly string[];
    readonly actionNextSteps?: Readonly<Record<string, string>>;
  };
  readonly dispatchToolName: string;
}): void {
  const { actionName, data, meta, dispatchToolName } = args;
  const tool = meta.actionNextSteps?.[actionName];
  const appCallable =
    typeof tool === 'string' &&
    (meta.appCallableTools ?? []).includes(tool);

  if (appCallable && tool !== undefined) {
    fireDirectToolCall({
      targetToolName: tool,
      data,
    });
  } else {
    // `actionNextSteps[actionName]` is the agent-side nextStep hint —
    // when present, surface it on the inline-userAction envelope so
    // the agent has a strong steer toward the right tool if the pipe
    // is unavailable. Pattern β (this branch) is also the path where
    // `actionSpec[*].dispatch.kind === 'agent'` lands — in that case
    // `actionNextSteps[actionName]` is absent and `nextStep` is too.
    dispatchWiredAction({
      toolName: dispatchToolName,
      intent: actionName,
      data,
      sessionId: meta.sessionId,
      stackItemId: meta.stackItemId,
      appId: meta.appId,
      ...(tool !== undefined ? { nextStep: tool } : {}),
    });
  }
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
  readonly stackItemId?: string;
  readonly appId: string;
}): void {
  if (typeof window === 'undefined') return;
  const { toolName, url, sessionId, stackItemId, appId } = args;
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
    stackItemId,
    appId,
    actionId,
    firedAt,
  });
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/open-link',
    params: { url },
  });
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
  readonly stackItemId?: string;
  readonly appId: string;
}): void {
  if (typeof window === 'undefined') return;
  const { toolName, mode, sessionId, stackItemId, appId } = args;
  const firedAt = new Date().toISOString();
  const actionId = fnv1aHex(`requestDisplayMode|${mode}|${firedAt}`);
  emitAudit({
    toolName,
    kind: 'requestDisplayMode',
    payload: { mode },
    sessionId,
    stackItemId,
    appId,
    actionId,
    firedAt,
  });
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/request-display-mode',
    params: { mode },
  });
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
  readonly stackItemId?: string;
  readonly appId: string;
}): void {
  if (anchorClickInterceptInstalled) return;
  if (typeof window === 'undefined') return;
  if (typeof document === 'undefined') return;
  anchorClickInterceptInstalled = true;

  const { dispatchToolName, sessionId, stackItemId, appId } = args;

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
      stackItemId,
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
  readonly stackItemId?: string;
  readonly appId: string;
}): void {
  if (fullscreenInterceptInstalled) return;
  if (typeof window === 'undefined') return;
  if (typeof Element === 'undefined' || typeof Document === 'undefined') {
    return;
  }
  fullscreenInterceptInstalled = true;

  const { dispatchToolName, sessionId, stackItemId, appId } = args;

  Element.prototype.requestFullscreen = function (
    this: Element,
    _options?: FullscreenOptions,
  ): Promise<void> {
    requestDisplayModeInParent({
      toolName: dispatchToolName,
      mode: 'fullscreen',
      sessionId,
      stackItemId,
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
      stackItemId,
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
 * Install a persistent `message` listener that catches
 * `ui/notifications/tool-result` notifications arriving AFTER the
 * initial mount. Each new tool-result that carries a different
 * bootstrap (different stackItemId / codeUrl / kind) triggers a
 * re-mount via {@link bootSelfContained}. This closes the boot-only-
 * listener gap that prevented live re-render when an agent issued
 * a second `ggui_push` to the same session-resource.
 *
 * Idempotent: subsequent calls no-op via {@link postMountListenerInstalled}.
 *
 * Why module-level vs scoped to a single mount: bootSelfContained
 * may itself trigger a re-mount, and the listener should outlive any
 * single mount cycle. The compaction ensures we don't stack listeners
 * across re-mounts.
 */
function installPostMountListener(): void {
  if (postMountListenerInstalled) return;
  if (typeof window === 'undefined') return;
  postMountListenerInstalled = true;
  let lastMetaKey: string | null = null;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as
      | { jsonrpc?: string; method?: string; params?: unknown }
      | null
      | undefined;
    if (
      data === null ||
      data === undefined ||
      data.jsonrpc !== '2.0' ||
      data.method !== 'ui/notifications/tool-result'
    ) {
      return;
    }
    const meta = extractMetaFromToolResult(data.params);
    if (meta === null) return;
    const { session, stackItem } = meta;
    // The parser guarantees session is present when ok:true; defense.
    if (session === undefined) return;
    // Cheap dedupe — the host may emit the same tool-result more
    // than once (claude.ai re-broadcasts on iframe re-attach).
    // Re-mounting the same slice meta would flicker without changing
    // anything visible.
    //
    // `liveTrio` is load-bearing in the dedupe key: hosts (sample-agent,
    // claude.ai) often emit the initial meta WITHOUT the wsUrl+token
    // pair (the Anthropic SDK strips `_meta` from tool results), then
    // refetch + re-emit the FULL envelope. The two envelopes share
    // stackItemId/kind/codeUrl/propsJson but differ on the live trio —
    // without trio in the key, the second arrival deduped silently and
    // bootSelfContained never opened the WS, so `ggui_update` props_update
    // frames fanned to zero subscribers.
    const liveTrio =
      typeof session.wsUrl === 'string' &&
      session.wsUrl.length > 0 &&
      typeof session.wsToken === 'string' &&
      session.wsToken.length > 0
        ? 'live'
        : '-';
    const key = [
      stackItem?.stackItemId ?? '-',
      stackItem?.kind ?? '-',
      stackItem?.codeUrl ?? '-',
      stackItem?.propsJson ?? '-',
      liveTrio,
    ].join('|');
    if (key === lastMetaKey) return;
    lastMetaKey = key;
    void bootSelfContained(window.document, meta).then(() => {
      // Re-emit last-known contextSpec values after a successful
      // re-mount. The host's WS to the agent server is opaque to the
      // iframe, so "WS reopen ≈ re-mount" is the closest available
      // proxy. Re-emitting keeps the LLM context fresh after a
      // host-driven reconnect — the new mount's SingleSlotProviders
      // will then take over via the regular debounced flow once the
      // user's component begins mutating values.
      //
      // Filter to slot names declared by the FRESHLY mounted contract.
      // An earlier version walked the entire `contextSlotLastValues`
      // map, which leaked stale slot values across re-mounts with
      // different contextSpecs. The new mount's SingleSlotProvider
      // re-seeds from `slot.default` regardless, so cross-mount
      // survival of stale entries was never load-bearing — only the
      // active slot names are.
      const activeSlotNames = new Set(
        (stackItem?.contextSlots ?? []).map((s) => s.name),
      );
      const reemitIdentity =
        stackItem?.stackItemId !== undefined
          ? {
              sessionId: session.sessionId,
              appId: session.appId,
              stackItemId: stackItem.stackItemId,
            }
          : undefined;
      reemitLastContextValues(
        postToParent,
        activeSlotNames,
        reemitIdentity,
      );
    });
  };
  window.addEventListener('message', onMessage);
}

/**
 * Self-contained boot path. Mounts the compiled component into
 * `<div id="ggui-root">` (or a fresh container when absent) using the
 * same `mountReactRoot` pipeline the WS-driven path uses. No postMessage,
 * no WebSocket, no subscribe — the runtime is fully self-sufficient
 * once the bootstrap is in hand.
 *
 * Status surface: a parent-bound `ggui:renderer-ready` followed by a
 * `code-ready` lifecycle envelope on success. Failures emit a
 * `ggui:bootstrap-failed` envelope (`SELF_CONTAINED_MOUNT_FAILED`) +
 * an `error` lifecycle event so hosts pinning lifecycle selectors
 * still observe the terminal state.
 *
 * The implementation lives next to `bootProduction` so dynamic-imports
 * for the heavy module graph happen exactly once across both code
 * paths — the postMessage path's `import('react')` etc. resolves
 * against the same module instance.
 */
async function bootSelfContained(
  doc: Document,
  meta: SelfContainedMcpAppAiGguiMeta,
): Promise<void> {
  // Destructure once — session is guaranteed by validateSlices on the
  // ok:true arm; stackItem is optional (session-only refresh envelopes).
  const { session, stackItem } = meta;

  // Lifecycle: `mounting` first, paired with `ggui:renderer-ready` so
  // outer-DOM observers see the same sequence as the postMessage path.
  postRendererReady();
  postLifecycleToParent(makeLifecycleEvent('mounting'));

  // Resolve the mount container. Hosts inline `<div id="ggui-root">`
  // in the self-contained shell; if absent (defensive), append one to
  // the body so the React root has somewhere to mount.
  let container = doc.getElementById('ggui-root');
  if (container === null) {
    container = doc.createElement('div');
    container.id = 'ggui-root';
    doc.body.appendChild(container);
  }

  try {
    // Install precompiled, eval-free contract validators before any
    // wire dispatch can run. Self-contained ESM modules — no bundler /
    // `__ggui__` dependency. System-card bootstraps carry none (the
    // loader returns the empty set); harmless to call unconditionally.
    setActiveValidatorSet(
      await loadCompiledValidatorsFromUrl(stackItem?.validatorsUrl),
    );

    // Parse propsJson up-front — both branches (system card + compiled
    // component) consume props from the same field, just in different
    // shapes downstream.
    let props: Record<string, unknown> | undefined;
    if (stackItem?.propsJson !== undefined) {
      try {
        const parsed: unknown = JSON.parse(stackItem.propsJson);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          props = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed propsJson is shape-preserving-skip.
      }
    }

    // System-card branch — kind keyed against the built-in registry.
    // No componentCode evaluation, no `globalThis.__ggui__` shim install,
    // no GguiWireProvider (system cards are render-only and don't
    // dispatch wire actions). The registry handles unknown kinds via
    // a typed fallback, so a new server emitting a kind this runtime
    // doesn't know still surfaces something visible.
    if (stackItem?.kind !== undefined) {
      const [reactMod, reactDomClient, systemCardsMod] = await Promise.all([
        import('react'),
        import('react-dom/client'),
        import('./system-cards/index.js'),
      ]);
      const root = reactDomClient.createRoot(container);
      root.render(
        reactMod.createElement(
          systemCardsMod.SystemCardHost,
          { kind: stackItem.kind, props: props ?? {}, themeId: session.themeId },
        ),
      );
      postLifecycleToParent(
        makeLifecycleEvent('code-ready', {
          ...(stackItem.stackItemId !== undefined
            ? { stackItemId: stackItem.stackItemId }
            : {}),
        }),
      );
      installResizeObserver(container);
      installPostMountListener();
      return;
    }

    // Compiled-component branch. Fetch the bytes from `codeUrl`
    // (content-addressable, immutable cache). T3-1 (2026-05-13) retired
    // the inline base64 `componentCode` channel — every static-component
    // bootstrap is delivered via the URL.
    if (stackItem?.codeUrl === undefined) {
      throw new Error(
        'bootSelfContained: bootstrap missing codeUrl (static-component mode requires the URL channel)',
      );
    }
    const res = await fetch(stackItem.codeUrl);
    if (!res.ok) {
      throw new Error(
        `bootSelfContained: codeUrl fetch failed (${res.status}): ${stackItem.codeUrl}`,
      );
    }
    const componentCode = await res.text();

    // Dynamic-imports — same set as `bootProduction`, kept here so a
    // postMessage path running in parallel hits the module cache.
    const [
      reactMod,
      reactDomClient,
      designPrimitives,
      designComponents,
      designCompositions,
      designInteract,
      designTokens,
      wireMod,
      gadgetsMod,
    ] = await Promise.all([
      import('react'),
      import('react-dom/client'),
      import('@ggui-ai/design/primitives'),
      import('@ggui-ai/design/components'),
      import('@ggui-ai/design/compositions'),
      import('@ggui-ai/design/interact'),
      import('@ggui-ai/design/tokens'),
      import('@ggui-ai/wire'),
      // Pre-load STDLIB gadget hooks so the data-URL shim resolves
      // `import { useGeolocation } from '@ggui-ai/gadgets'` to a real
      // callable at iframe boot. Without this, `__ggui__.gadgets` is
      // empty and every hook lookup returns undefined, crashing the
      // component.
      import('@ggui-ai/gadgets'),
    ]);
    const [globalsMod, reactRendererMod, gadgetLoaderMod] =
      await Promise.all([
        import('./globals.js'),
        import('./react-renderer.js'),
        import('./gadget-loader.js'),
      ]);

    // Compose the gadget-package registry: STDLIB seed PLUS any
    // operator-registered packages from the bootstrap. This path is
    // async, so we await the merge BEFORE installing — the per-package
    // data-URL shims see a fully-populated catalog from first render.
    // (The WS-driven path uses an in-place mutation fallback because
    // its `setup` callback is synchronous.)
    const composedGadgets =
      await gadgetLoaderMod.loadGadgetRegistry(
        gadgetsMod,
        session.gadgets ?? [],
      );

    // Install `globalThis.__ggui__` BEFORE mountReactRoot — the data-
    // URL shim rewrite reads it synchronously during module load.
    // Same TOCTOU-critical ordering as the WS-driven path.
    globalsMod.installGlobalRegistry({
      react: reactMod,
      reactDom: reactDomClient,
      primitives: designPrimitives,
      components: designComponents,
      compositions: designCompositions,
      interact: designInteract,
      tokens: designTokens,
      wire: wireMod,
      // Per-package gadget registry — STDLIB namespace merged with
      // operator-registered packages (composed above).
      gadgets: composedGadgets,
      // Server-filtered public env values for wrapper hooks to read
      // via `getPublicEnv(key)`. Absent ⇒ empty record; wrappers
      // needing values throw at hook-mount.
      publicEnv: session.publicEnv ?? {},
    });

    // Synthesize one React.createContext(default) per declared
    // contextSpec slot and register under
    // `globalThis.__ggui__.contexts[contextName]`. Idempotent: already-
    // registered context names REUSE the existing Context (the LLM's
    // destructured references must stay stable across re-mounts). Boot-
    // ordering: AFTER installGlobalRegistry, BEFORE mountReactRoot, so
    // the boilerplate's `globalThis.__ggui__.contexts` destructure
    // resolves on the first mount paint.
    const registry = globalsMod.getGlobalRegistry();
    const resolvedSlots: ReadonlyArray<ResolvedContextSlot> =
      registry !== undefined && stackItem?.contextSlots !== undefined
        ? installContextRegistry(
            registry.contexts,
            reactMod,
            stackItem.contextSlots,
          )
        : [];

    // Build a minimal WireConfig and pass it through `renderWrapper` so
    // generated components that call `useAction` / `useStream` resolve
    // their context. Without this, every self-contained mount whose
    // component touches `@ggui-ai/wire` throws "useWireContext must be
    // used within a WireProvider".
    //
    // Dispatch funnels through {@link dispatchWiredAction} — the
    // empirically-validated three-message bridge (`tools/call` +
    // `ui/update-model-context` + `ui/message`). See helper docstring
    // for the spec §401 / §1032 reasoning. An earlier single-message
    // dispatch only fired #1 and the LLM never saw the click on
    // claude.ai (the host-side scope:['app'] firewall blocks
    // tool-result feedback from reaching the model). Empirically
    // confirmed in a protocol probe.
    const dispatchToolName = resolveDispatchToolName();
    const wireConfig: import('@ggui-ai/wire').WireConfig = {
      app: { appId: session.appId, appName: session.appId },
      session: { sessionId: session.sessionId, isConnected: true },
      auth: { isAuthenticated: false },
      dispatch: (actionName, data) => {
        // Per-action routing — extracted to {@link routeDispatch} as
        // a pure helper so production + the dispatch-routing unit
        // tests share one code path. Pattern α: same-server,
        // app-visible target tool → direct `tools/call`. Pattern β:
        // anything else → 3-message bridge.
        routeDispatch({
          actionName,
          data,
          meta: {
            sessionId: session.sessionId,
            appId: session.appId,
            ...(stackItem?.stackItemId !== undefined
              ? { stackItemId: stackItem.stackItemId }
              : {}),
            ...(session.appCallableTools !== undefined
              ? { appCallableTools: session.appCallableTools }
              : {}),
            ...(stackItem?.actionNextSteps !== undefined
              ? { actionNextSteps: stackItem.actionNextSteps }
              : {}),
          },
          dispatchToolName,
        });
      },
      // Subscribe + wired-tools are no-ops in self-contained mode
      // (no live channel). Generated components that subscribe
      // receive nothing; the contract stays honest.
      subscribe: () => () => {},
      // `callWiredTool` is retired — `agentTools` is now a catalog
      // the AGENT invokes, not a component hook surface.
      // The `openLink` and `requestDisplayMode` host-control primitives
      // ride native idioms (anchor click + Element.requestFullscreen) —
      // see `installAnchorClickInterceptor` and
      // `installFullscreenInterceptors` below. No first-class
      // chat-shortcut primitive in v1; chat-shortcut UX degrades to the
      // Pattern β consent prompt.
    };
    // Runtime owns Provider tree + useState per slot. ContextStateHost
    // composes one SingleSlotProvider per declared slot around the
    // user's component, so the user's `useGguiContext` reads each
    // slot's live `[value, setValue]` tuple. An earlier design had
    // the boilerplate emit useState + Provider INSIDE the user
    // component while the runtime mounted observers as SIBLINGS —
    // every observer read the createContext default, never the live
    // state. Hoisting both useState and Provider into the runtime
    // makes the boilerplate's destructure line resolve to the live
    // tuple by construction.
    const ContextStateHost = createContextStateHost({
      react: reactMod,
      postToParent,
      consoleWarn:
        typeof console !== 'undefined' && typeof console.warn === 'function'
          ? console.warn.bind(console)
          : undefined,
      ...(stackItem?.stackItemId !== undefined
        ? {
            identity: {
              sessionId: session.sessionId,
              appId: session.appId,
              stackItemId: stackItem.stackItemId,
            },
          }
        : {}),
    });

    const renderWrapper = (mountedComponent: ReactNode): ReactNode =>
      reactMod.createElement(
        wireMod.GguiWireProvider,
        {
          config: wireConfig,
          children: reactMod.createElement(ContextStateHost, {
            slots: resolvedSlots,
            children: mountedComponent,
          }),
        },
      );

    // Native-idiom interceptors. Install BEFORE mountReactRoot so the
    // listeners are live the instant any generated component begins
    // rendering. Both helpers are idempotent (module-level guards) —
    // re-mounts via `installPostMountListener` re-call this without
    // stacking.
    installAnchorClickInterceptor({
      dispatchToolName,
      sessionId: session.sessionId,
      ...(stackItem?.stackItemId !== undefined
        ? { stackItemId: stackItem.stackItemId }
        : {}),
      appId: session.appId,
    });
    installFullscreenInterceptors({
      dispatchToolName,
      sessionId: session.sessionId,
      ...(stackItem?.stackItemId !== undefined
        ? { stackItemId: stackItem.stackItemId }
        : {}),
      appId: session.appId,
    });

    const mountOpts = {
      stackItem: {
        ...(stackItem?.stackItemId !== undefined ? { id: stackItem.stackItemId } : {}),
        componentCode,
        ...(props !== undefined ? { props } : {}),
      },
      renderWrapper,
      ...(session.themeId !== undefined ? { themeId: session.themeId } : {}),
      ...(session.themeMode !== undefined ? { themeMode: session.themeMode } : {}),
      // GG.8.2 — operator-registered 3rd-party gadget packages so the
      // rewriter resolves each direct gadget import to its per-package
      // shim. STDLIB `@ggui-ai/gadgets` is always rewritten regardless.
      ...(session.gadgets !== undefined
        ? { gadgetPackages: session.gadgets.map((g) => g.package) }
        : {}),
    };
    const mount = await reactRendererMod.mountReactRoot(container, mountOpts);

    postLifecycleToParent(
      makeLifecycleEvent('code-ready', {
        ...(stackItem?.stackItemId !== undefined
          ? { stackItemId: stackItem.stackItemId }
          : {}),
      }),
    );
    installResizeObserver(container);
    installPostMountListener();

    // B4 — when the bootstrap carries a live trio (wsUrl + token),
    // open a WS subscription so `ggui_update` props_update frames
    // reach the iframe. Without this the McpAppIframe-nested mount
    // never subscribed and `ggui_update` silently dropped on the
    // server's outbound side.
    //
    // Targeted scope: this path mounts a SINGLE component (not the
    // full stack), so the only frame type we need is `props_update`
    // matching THIS stackItemId. Other frame types are silently
    // dropped — no handler registered means the registry's dispatch
    // is a no-op for them.
    //
    // The subscribe call is fire-and-forget; failure is logged but
    // doesn't break the mount (the static component renders fine
    // without live updates). When the WS goes down, mount.update()
    // simply stops firing — gracefully degrades.
    if (
      typeof session.wsUrl === 'string' &&
      session.wsUrl.length > 0 &&
      typeof session.wsToken === 'string' &&
      session.wsToken.length > 0 &&
      stackItem?.stackItemId !== undefined
    ) {
      const targetStackItemId = stackItem.stackItemId;
      const sessionWsToken = session.wsToken;
      const subscribeRegistry = new ChannelRegistry({
        subscribeFrameBuilder: () => ({
          type: 'subscribe',
          payload: {
            sessionId: session.sessionId,
            appId: session.appId,
            wsToken: sessionWsToken,
          },
        }),
      });
      // Register only the `props_update` handler — `connectViaRegistry`
      // registers `ack` + `error` for the handshake. Other frame
      // types arriving on the WS will be no-ops (no handler).
      subscribeRegistry.register({
        type: 'props_update',
        onMessage: (payload) => {
          const shaped = payload as {
            readonly stackItemId?: unknown;
            readonly props?: unknown;
          };
          if (shaped.stackItemId !== targetStackItemId) return;
          if (shaped.props === null || typeof shaped.props !== 'object') return;
          void mount.update({
            ...mountOpts,
            stackItem: {
              ...mountOpts.stackItem,
              props: shaped.props as Record<string, unknown>,
            },
          });
        },
      });
      void connectViaRegistry({
        session,
        registry: subscribeRegistry,
        onStatusChange: () => {
          /* no-op — placeholder UI is not used in self-contained mode */
        },
      }).catch((err: unknown) => {
        // Self-contained mode tolerates WS failure — the component
        // still renders with initial props; only live updates stop.
        // eslint-disable-next-line no-console -- operator-visible degradation hint
        console.warn(
          '[ggui:bootSelfContained] live-update WS subscribe failed; props_update frames will not reach the mount:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Reuse the existing failure envelope. The reason is a synthesized
    // value because this code path is wholly outside the
    // `McpAppAiGguiMetaParseFailureReason` set (no postMessage parse
    // failed — there was no postMessage). Hosts pattern-matching legacy
    // reason strings see a new value and ignore it; new hosts can
    // route on the explicit code.
    postBootFailure(
      'UI_INITIALIZE_FAILED' as RendererBootFailureReason,
      `self-contained mount failed: ${message}`,
    );
    postLifecycleToParent(
      makeLifecycleEvent('error', {
        error: { code: 'SELF_CONTAINED_MOUNT_FAILED', message },
      }),
    );
  }
}

/**
 * Detect a live-channel bootstrap shape inlined onto `__GGUI_META__`.
 * The first-party session shells (`/s/<shortCode>`,
 * `ui://ggui/session/<sessionId>`, the embedded-ui SessionViewer's
 * thin shell) populate this synchronously before the runtime loads.
 *
 * Post-#109 the global carries a slice ENVELOPE (same shape as the
 * wire `_meta`): `{ "ai.ggui/session": {...}, "ai.ggui/stack-item":
 * {...} }`. A live-channel shell omits a static stack-item (no codeUrl
 * / kind) and ships wsUrl+token on the session slice instead.
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
  const sessionRaw = bag['ai.ggui/session'];
  if (sessionRaw === null || typeof sessionRaw !== 'object' || Array.isArray(sessionRaw)) {
    return false;
  }
  const sessionBag = sessionRaw as Record<string, unknown>;
  return (
    typeof sessionBag['wsUrl'] === 'string' &&
    (sessionBag['wsUrl'] as string).length > 0 &&
    typeof sessionBag['wsToken'] === 'string' &&
    (sessionBag['wsToken'] as string).length > 0 &&
    typeof sessionBag['sessionId'] === 'string' &&
    (sessionBag['sessionId'] as string).length > 0 &&
    typeof sessionBag['appId'] === 'string' &&
    (sessionBag['appId'] as string).length > 0
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
function runBootProduction(preResolvedMeta?: ValidatedMcpAppAiGguiMeta): void {
  const callUiInitialize = (): Promise<JsonRpcResponse> => {
    const caller = makeJsonRpcCaller();
    // Per MCP Apps spec (specification/2026-01-26/apps.mdx:554-563),
    // ui/initialize params are { appInfo, appCapabilities,
    // protocolVersion } — all three required. Spec-compliant
    // hosts (claude.ai's validator) reject empty params with
    // "Invalid input" for each missing field.
    return caller('ui/initialize', {
      appInfo: { name: 'ggui-iframe-runtime', version: '1.0.0' },
      // Declare the display modes ggui supports so spec-compliant
      // hosts know `ui/request-display-mode` requests for these
      // values are honored. The runtime emits `request-display-mode`
      // from the `Element.requestFullscreen` interceptor + the
      // canvas-mode display-mode escalation policy; both target this
      // enum.
      appCapabilities: {
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
      },
      protocolVersion: '2026-01-26',
    });
  };
  void bootProduction({
    doc: document,
    callUiInitialize,
    notifyParent: (msg) => {
      if (msg.type === 'ggui:renderer-ready') {
        postRendererReady();
        return;
      }
      postBootFailure(msg.reason, msg.message);
    },
    onObserve: postObservabilityToParent,
    onLifecycle: postLifecycleToParent,
    ...(preResolvedMeta !== undefined ? { preResolvedMeta } : {}),
  });
}

if (shouldAutostart() && typeof window !== 'undefined') {
  // Boot-source resolution. Three sources of slice meta + the
  // dispatch between `bootSelfContained` (static, no WS) and
  // `bootProduction` (live, opens WS subscribe).
  //
  //   1. Inline `__GGUI_META__` global — per-session shells
  //      (`buildSelfContainedHtml`, `/r/` shells pre-R5, console
  //      embeds) populate this synchronously before this bundle's
  //      `<script type="module">` evaluates.
  //
  //   2. Buffered `__GGUI_PENDING_TOOL_RESULTS__` — minimal-shell
  //      pattern. A shell installs a postMessage listener at
  //      first-paint, buffers any `ui/notifications/tool-result`
  //      arrivals into the array, and the runtime drains on load.
  //      Covers the host-races-the-bundle case (postMessage arrives
  //      BEFORE the runtime bundle finishes parsing).
  //
  //   3. Live `ui/notifications/tool-result` postMessage — the
  //      spec-canonical delivery channel per MCP-Apps SEP-1865.
  //      Listens via `awaitToolResultMeta(POSTMESSAGE_BOOT_TIMEOUT_MS)`.
  //      The ONLY path for spec-strict hosts (`<AppRenderer>`,
  //      ChatGPT MCP-Apps connector, claude.ai). Caught meta is
  //      threaded into `runBootProduction` via `preResolvedMeta` so
  //      `bootSequence` doesn't re-await the same delivery.
  //
  //   4. `bootProduction` fallthrough — when ALL three sources
  //      yield nothing (and `readLiveBootstrapShape` short-circuits
  //      the wait), bootSequence internally walks its own resolver
  //      chain (inline → Reading-B → postMessage) against the host.
  //
  // T3-1 (2026-05-13) — bootSelfContained requires static content
  // (codeUrl or kind) to mount. Live-only metas (wsUrl+token
  // without static content) MUST go through `bootProduction` so the
  // stack item arrives via the live-channel WS subscribe. Pre-T3-1
  // the inline `componentCode` channel made every push static.
  // Post-drop, we dispatch on the static-content discriminator
  // explicitly.
  const inline = readSelfContainedMeta();
  const inlineHasStatic =
    inline !== null
    && (typeof inline.stackItem?.codeUrl === 'string'
      || typeof inline.stackItem?.kind === 'string');
  if (inline !== null && inlineHasStatic) {
    void bootSelfContained(document, inline);
  } else if (inline !== null) {
    // Live-only inline meta — hand to bootProduction with the
    // pre-resolved slice so bootSequence skips re-parsing the same
    // global it already validated here.
    runBootProduction(inline);
  } else {
    const buffered = readPendingToolResults();
    const bufferedHasStatic =
      buffered !== null
      && (typeof buffered.stackItem?.codeUrl === 'string'
        || typeof buffered.stackItem?.kind === 'string');
    if (buffered !== null && bufferedHasStatic) {
      void bootSelfContained(document, buffered);
    } else if (buffered !== null) {
      runBootProduction(buffered);
    } else {
      // Pre-empt the postMessage tool-result race when `__GGUI_META__`
      // already carries a live-channel envelope (wsUrl + token + sessionId
      // + appId on `ai.ggui/session`) without a static stack-item slice —
      // that shape doesn't trip `readSelfContainedMeta` (no codeUrl /
      // kind to mount), but it IS the signal that a first-party shell
      // (`/s/<shortCode>`, `ui://ggui/session/<sessionId>`) has already
      // inlined the WS-driven boot envelope. Skip the 30s tool-result
      // wait and hand off to `bootProduction` directly — `bootProduction`
      // re-issues `ui/initialize` to the host, which re-emits the same
      // meta back via Reading-B, and the WS path proceeds without
      // delay. Without this short-circuit, the OSS embedded-ui (which
      // never sends a separate `ui/notifications/tool-result`) hangs at
      // `mounting` for the full 30s timeout before `code-ready`.
      const hasLiveMetaShape = readLiveBootstrapShape();
      if (hasLiveMetaShape) {
        runBootProduction();
      } else {
        // Race a postMessage listener against the legacy production
        // boot. Tool-result wins if it arrives within the timeout;
        // otherwise we hand off to the WS-driven path. Live-only
        // arrivals thread the meta through to `runBootProduction`
        // as `preResolvedMeta` so spec-strict hosts (AppRenderer,
        // ChatGPT) don't re-await a second postMessage inside
        // bootSequence.
        void awaitToolResultMeta(POSTMESSAGE_BOOT_TIMEOUT_MS).then(
          (postMessageMeta) => {
            const hasStatic =
              postMessageMeta !== null
              && (typeof postMessageMeta.stackItem?.codeUrl === 'string'
                || typeof postMessageMeta.stackItem?.kind === 'string');
            if (postMessageMeta !== null && hasStatic) {
              void bootSelfContained(document, postMessageMeta);
              return;
            }
            runBootProduction(postMessageMeta ?? undefined);
          },
        );
      }
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
//   2. ui/initialize postMessage.
//   3. parseMetaFromUiInitialize.
//   4. installGlobalRegistry (with real React+ReactDOM+design+wire
//      module handles).
//   5. Build StreamBus + root WireConfig.
//   6. Create StackRenderer with a containerFor factory that spins
//      per-item `<div data-ggui-stack-item-root="<id>">` children
//      inside the DOM placeholder.
//   7. Populate the channel registry; bootSequence calls connectFn
//      (default `connectViaRegistry`) which binds the WS transport.
//      Frames arrive directly through the registered handlers.
//
// Step 4 is the TOCTOU-critical barrier: MUST run before any stack
// item renders (generated code's data-URL shims read the global
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
  readonly callUiInitialize: () => Promise<JsonRpcResponse>;
  readonly notifyParent: (msg: RendererBootFailedMessage | { type: 'ggui:renderer-ready'; version: string }) => void;
  readonly onObserve?: ObservabilityEmitter;
  readonly onLifecycle?: LifecycleEmitter;
  /**
   * Pre-resolved slice meta from the autostart layer. When set,
   * threaded through `bootSequence` so the resolver skips the inline
   * + Reading-B + postMessage tiers.
   */
  readonly preResolvedMeta?: ValidatedMcpAppAiGguiMeta;
  /**
   * Async spec-canonical postMessage resolver. Default: listen for
   * `ui/notifications/tool-result` for {@link POSTMESSAGE_BOOT_TIMEOUT_MS}.
   */
  readonly awaitPostMessageMeta?: () => Promise<ValidatedMcpAppAiGguiMeta | null>;
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
    // STDLIB gadget hooks. See the `bootSelfContained` callsite
    // above for the rationale.
    import('@ggui-ai/gadgets'),
  ]);
  const [globalsMod, gadgetLoaderMod] = await Promise.all([
    import('./globals.js'),
    import('./gadget-loader.js'),
  ]);

  // Renderer wiring hook — constructs buses + stack renderer + wire
  // config on demand inside bootSequence.
  const renderer: RendererHooks = {
    setup: ({ meta, stackModel, renderInto, statusRefs, onObserve }) => {
      // Destructure once — session is guaranteed present on the
      // ok:true arm; stackItem may be absent (session-only).
      const { session, stackItem } = meta;
      // Compose the gadget registry: STDLIB seed PLUS any
      // operator-registered wrappers carried on the bootstrap.
      // Awaited inside the synchronous `setup` callback via an IIFE
      // because the boot orchestration calls `setup` synchronously and
      // we can't change its contract here; the wrappers dynamic-import
      // is fast (already-resolved bundles hit the module cache).
      //
      // For now we fall back to the STDLIB-only seed if the bootstrap
      // omits `gadgets`. The install happens BEFORE any stack
      // item renders so `rewrite-imports.ts` reads a fully-populated
      // registry on the first `loadModule` call.
      const composedGadgets = gadgetLoaderMod
        // Empty registrations → resolves to a Promise of the STDLIB
        // seed only; the boot path doesn't wait on wrapper imports.
        .loadGadgetRegistry(
          gadgetsMod,
          session.gadgets ?? [],
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
        publicEnv: session.publicEnv ?? {},
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
      // participate in contextSpec the same way `bootSelfContained`
      // does. Without this the WS-driven path installed neither —
      // `globalThis.__ggui__.contexts` stayed empty, the boilerplate's
      // destructure resolved to `undefined`, and any declared
      // `contextSpec` slot was silently dead. The registry entries
      // seed default values; the ContextStateHost (one
      // SingleSlotProvider per declared slot) hoists useState into the
      // runtime so `useGguiContext(slot)` reads the live tuple.
      const registry = globalsMod.getGlobalRegistry();
      const resolvedSlots: ReadonlyArray<ResolvedContextSlot> =
        registry !== undefined && stackItem?.contextSlots !== undefined
          ? installContextRegistry(
              registry.contexts,
              reactMod,
              stackItem.contextSlots,
            )
          : [];
      const ContextStateHost = createContextStateHost({
        react: reactMod,
        postToParent,
        consoleWarn:
          typeof console !== 'undefined' && typeof console.warn === 'function'
            ? console.warn.bind(console)
            : undefined,
        ...(stackItem?.stackItemId !== undefined
          ? {
              identity: {
                sessionId: session.sessionId,
                appId: session.appId,
                stackItemId: stackItem.stackItemId,
              },
            }
          : {}),
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
      // `push` + `data` + `feedback` + `drain_ack` + `channel_payload`).
      // Outbound user actions go through the MCP-Apps host relay per
      // spec §401: postMessage `tools/call:ggui_runtime_submit_action`
      // to the parent → `AppRenderer.onCallTool` → sample agent's
      // `/relay/tools-call` → ggui MCP server →
      // `createGguiSubmitActionHandler.append` → `pendingEventConsumer`
      // → `ggui_consume` wakes the agent. The server's WS
      // `handleInboundAction` writes to the session ledger only — no
      // downstream consumer — so the WS action path silently drops
      // clicks. `routeDispatch` is the same helper `bootSelfContained`
      // uses; threading it here aligns LIVE-mode with self-contained.
      const dispatchToolName = resolveDispatchToolName();
      const { config: rootConfig, buildScopedConfig } = buildRootWireConfig({
        sessionId: session.sessionId,
        appId: session.appId,
        getStack: () => stackModel.snapshot(),
        manager,
        streamBus,
        ...(onObserve !== undefined ? { onObserve } : {}),
        onDispatchEnvelope: (envelope) => {
          if (envelope.type !== 'data:submit') return;
          const payload = envelope.payload as
            | { action?: unknown; data?: unknown; tool?: unknown }
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
              sessionId: session.sessionId,
              appId: session.appId,
              ...(stackItem?.stackItemId !== undefined
                ? { stackItemId: stackItem.stackItemId }
                : {}),
              ...(session.appCallableTools !== undefined
                ? { appCallableTools: session.appCallableTools }
                : {}),
              ...(stackItem?.actionNextSteps !== undefined
                ? { actionNextSteps: stackItem.actionNextSteps }
                : {}),
            },
            dispatchToolName,
          });
        },
      });

      // containerFor: mint a `<div data-ggui-stack-item-root="<id>">`
      // child inside `renderInto` for each stack item id. Reuse on
      // re-apply.
      const containersById = new Map<string, HTMLElement>();
      const containerFor = (id: string): HTMLElement => {
        const existing = containersById.get(id);
        if (existing !== undefined) return existing;
        const el = renderInto.ownerDocument.createElement('div');
        el.setAttribute('data-ggui-stack-item-root', id);
        renderInto.appendChild(el);
        containersById.set(id, el);
        return el;
      };

      const stackCtx: StackRenderContext = {
        containerFor,
        getScopedWireConfig: (item) => {
          // item.type === 'mcpApps' stack items get NO wire config —
          // their iframe host has its own contract (adapter-boundary
          // rule). Component items scope via `buildScopedConfig`
          // (see `packages/wire/src/context.ts`). `contractHash` is
          // intentionally absent — it lives on the event envelope,
          // not on the stack item shape.
          if (item.type === 'mcpApps' || item.type === 'system') return null;
          return buildScopedConfig({
            stackItemId: item.id,
            ...(item.actionSpec !== undefined ? { actionSpec: item.actionSpec } : {}),
          });
        },
        // Wrap every per-item React mount in
        // `<ContextStateHost slots={resolvedSlots}>` so contextSpec
        // values flow through `ui/update-model-context` exactly like
        // the self-contained path. mcpApps + system items skip the
        // wrap (their renderers don't run user component code that
        // reads contexts). When `resolvedSlots` is empty
        // ContextStateHost short-circuits to a Fragment, so the wrap
        // is free for items with no contextSpec.
        getOuterWrapper: (item) => {
          if (item.type === 'mcpApps' || item.type === 'system') return undefined;
          return (mountedTree) =>
            reactMod.createElement(ContextStateHost, {
              slots: resolvedSlots,
              children: mountedTree,
            });
        },
        streamBus,
        sessionId: session.sessionId,
        // Forward bootstrap-stamped theme onto the renderer so per-stack-item
        // mounts inject the configured theme's CSS vars (indigo, claudic, etc).
        // Without this, react-renderer.ts falls back to `getScopedCssTokens`
        // (no preset) and every iframe renders with the default ggui theme
        // — even when `_meta["ai.ggui/session"].themeId` is `'indigo'`.
        // The sibling `bootSelfContained` path already threads these onto
        // its `mountOpts`; this seeds the same fields onto the renderer
        // hooks path so both boot routes produce the same theming.
        ...(session.themeId !== undefined ? { themeId: session.themeId } : {}),
        ...(session.themeMode !== undefined ? { themeMode: session.themeMode } : {}),
      };
      const stackRenderer = new StackRenderer(stackCtx);

      // Validator context — A2UI default for `_ggui:preview`; no
      // bootstrap-supplied overrides today (the
      // `extraReservedValidators` injection slot is reserved for a
      // future extension).
      const validatorCtx: RendererValidatorContext = {
        reservedValidators: mergeReservedValidators(undefined, undefined),
      };

      // Per-channel transport router. Created here so it
      // shares the buffered manager shim (and survives the
      // pre-attachManager send buffering) + the same StreamBus the
      // wire config emits onto. The router consults
      // `bootstrap.streamWebSocketLocalTools` to decide WS-subscribe
      // vs iframe-polling per channel; absent ⇒ universal polling
      // fallback. Activated lazily by `handleRendererMessage`'s push
      // case (which calls `channelTransport.applyStackItem` on every
      // stack-fold).
      const channelTransport = createChannelTransportRouter({
        sessionId: session.sessionId,
        appId: session.appId,
        ...(session.streamWebSocketLocalTools !== undefined
          ? {
              streamWebSocketLocalTools:
                session.streamWebSocketLocalTools,
            }
          : {}),
        send: (msg) => manager.send(msg),
        toolsCall: async ({ toolName, args }) => {
          // Iframe-polling transport — `tools/call` over the parent
          // MCP host's JSON-RPC channel. Pattern α direct call
          // (no LLM consent loop). Returns the tool's
          // structuredContent (or `content[0]` if that's where the
          // payload landed) as a JsonValue. On RPC error we throw —
          // the router catches and silently retries on the next tick.
          const resp = await postRpcToParent('tools/call', {
            name: toolName,
            arguments: args,
          });
          if (resp.error !== undefined) {
            throw new Error(resp.error.message ?? 'tools/call failed');
          }
          const result = resp.result;
          if (result === null || typeof result !== 'object') {
            return null;
          }
          const structured = (
            result as { structuredContent?: unknown }
          ).structuredContent;
          if (structured !== undefined) return structured as JsonValue;
          return result as JsonValue;
        },
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
            sessionId: session.sessionId,
            appId: session.appId,
            ...(session.wsToken !== undefined
              ? { wsToken: session.wsToken }
              : {}),
          },
        }),
      });
      channelRegistry.register(
        createPushHandler({
          stackModel,
          statusRefs,
          getStackRenderer: () => stackRenderer,
          getChannelTransport: () => channelTransport,
        }),
      );
      channelRegistry.register(
        createDataHandler({
          stackModel,
          streamBus,
          validatorCtx,
          ...(onObserve !== undefined ? { onObserve } : {}),
        }),
      );
      channelRegistry.register(
        createPropsUpdateHandler({
          stackModel,
          getStackRenderer: () => stackRenderer,
        }),
      );
      channelRegistry.register(
        createDrainAckHandler({ dispatch: dispatchDrainAck }),
      );
      channelRegistry.register(createFeedbackHandler());
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
      channelRegistry.register(
        createSystemHandler({
          ...(onObserve !== undefined ? { onObserve } : {}),
        }),
      );

      return {
        rootWireConfig: rootConfig,
        streamBus,
        stackRenderer,
        validatorCtx,
        manager,
        channelTransport,
        channelRegistry,
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
      handle.stackRenderer.unmountAll();
      // Tear down per-channel polling timers + clear subscription
      // registry. No-op when no channel was ever activated.
      handle.channelTransport.dispose();
    },
  };

  await bootSequence({
    doc: opts.doc,
    callUiInitialize: opts.callUiInitialize,
    notifyParent: opts.notifyParent,
    renderer,
    ...(opts.onObserve !== undefined ? { onObserve: opts.onObserve } : {}),
    ...(opts.onLifecycle !== undefined ? { onLifecycle: opts.onLifecycle } : {}),
    ...(opts.preResolvedMeta !== undefined
      ? { preResolvedMeta: opts.preResolvedMeta }
      : {}),
    awaitPostMessageMeta:
      opts.awaitPostMessageMeta
      ?? (() => awaitToolResultMeta(POSTMESSAGE_BOOT_TIMEOUT_MS)),
  });
}
