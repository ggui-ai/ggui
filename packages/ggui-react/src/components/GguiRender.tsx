/**
 * GguiRender (web) — mounts one ggui render over the live WS channel.
 *
 * ## Platform deltas vs the React Native twin
 *
 * Near-twin of `@ggui-ai/react-native`'s `components/GguiRender.tsx`.
 * Mirror behavior-neutral changes to the twin. Load-bearing
 * differences (everything else should match):
 *
 *   - Wire hooks: web wraps `children` in `GguiWireProvider` with a
 *     `WireConfig` built by `@ggui-ai/wire`'s shared `buildWireConfig`
 *     (the same pipeline the iframe runtime composes), so the scoped
 *     wire hooks (`useAction`, channel subscriptions) resolve through
 *     it. RN renders children bare — the WireProvider port is a
 *     pending RN slice; RN's `api.action` validates against the
 *     active actionSpec inline instead.
 *   - `GguiSessionApi`: web exposes `send`; RN omits it.
 *   - Event bus: web delivers inbound `data` frames on a per-render
 *     `StreamBus` (reserved-channel replay ring included) consumed by
 *     wire subscriptions + `useChannelStream`, and ALSO broadcasts
 *     them as `window` CustomEvents for host shells; RN gates every
 *     `window` touch behind `Platform.OS === 'web'` (no DOM event bus
 *     on native) and has no StreamBus yet — porting the bus + replay
 *     ring is part of the same pending RN slice.
 *
 * The byte-identical chat-thread / chat-helpers twins are pinned by
 * `twin-parity.test.ts` in both SDKs; the eventual fix is hoisting
 * the platform-neutral core into a shared package.
 */
import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionEnvelope,
  ActionSpec,
  EventType,
  GguiSession,
  ReservedChannelValidator,
  SystemPayload,
  JsonValue,
} from '@ggui-ai/protocol';
import { BRIDGE_EVENTS, CLIENT_SUPPORTED_VERSIONS, UpgradeRequiredError } from '@ggui-ai/protocol';
import {
  buildActionEnvelope,
  buildWireConfig,
  ClientContractViolationError,
  GguiWireProvider,
  StreamBus,
  validateInboundPropsPayload,
  validateInboundStreamPayload,
  type WireConfig,
} from '@ggui-ai/wire';
import { useGguiContext } from './GguiProvider';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  composePreviewReservedValidator,
  mergeReservedValidators,
} from '../internal/reserved-validators';
import { StreamBusContext } from '../internal/stream-bus-context';

/**
 * Minimal render metadata passed to lifecycle callbacks.
 */
export interface GguiSessionInfo {
  sessionId: string;
}

/**
 * Surface a ClientContractViolationError at whichever path is wired:
 * prefer the explicit `onError` callback; when the caller didn't
 * provide one, fall back to `console.warn` so violations don't
 * silently vanish during integration. Tagged with `[ggui:contract]`
 * so devs can grep / filter.
 *
 * This is intentionally NOT a `console.error` — the server is still
 * authoritative and the user-facing impact is "the malformed event
 * didn't flow through", not a crash. `warn` keeps the signal honest.
 */
function surfaceContractViolation(
  err: ClientContractViolationError,
  onError: ((err: Error) => void) | undefined,
): void {
  if (onError) {
    onError(err);
    return;
  }
  // Fallback path — `console.warn` rather than throw so host apps
  // that didn't wire onError don't see the render blow up on a
  // single bad event.
  // eslint-disable-next-line no-console
  console.warn('[ggui:contract] ' + err.message, {
    direction: err.direction,
    violations: err.violations,
  });
}


/**
 * Props for the {@link GguiRender} component.
 *
 * Provides lifecycle, data, interaction, and error hooks for
 * fine-grained control over the mounted render.
 */
export interface GguiRenderProps {
  /**
   * GguiSession identity. Post-Phase-B this is the canonical key the server
   * binds the WS subscriber to; envelopes with a mismatching sessionId
   * are rejected `SESSION_MISMATCH`.
   */
  sessionId: string;
  userToken?: string;
  userId?: string;

  // Lifecycle hooks
  onRenderStart?: (render: GguiSessionInfo) => void;
  onRenderEnd?: (render: GguiSessionInfo, reason: string) => void;
  /** Fires on the initial subscribe ack carrying the current GguiSession snapshot. */
  onRenderReceived?: (render: GguiSession) => void;

  // Data hooks
  onBeforeAction?: <T>(data: T, meta: ActionMeta) => T | undefined;
  onAfterAction?: <T>(data: T, response: unknown) => void;

  // System hooks
  onSystemMessage?: (payload: SystemPayload) => void;

  // Error hooks — validation failures (inbound stream/props AND
  // outbound actions) surface here as ClientContractViolationError;
  // pattern-match on `error.direction` / instanceof to handle them.
  onError?: (error: Error) => void;

  /**
   * Extra reserved-channel payload validators merged with the A2UI
   * default before passing to `validateInboundStreamPayload` on every
   * `data`-type inbound envelope (Item 4 injection pattern on the
   * client side). Caller-provided entries WIN on key conflict — the
   * pattern is "SDK supplies A2UI default for `_ggui:preview`,
   * operator may replace by key".
   *
   * Absent = only the A2UI validator runs on `_ggui:preview`.
   * `_ggui:lifecycle` is validated via the protocol's built-in
   * regardless of this prop.
   *
   * Pass `new Map()` (explicitly empty) to DISABLE the A2UI default —
   * useful for test harnesses that need the pre-Item-4 permissive
   * behavior on the preview channel.
   */
  extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>;

  children: ReactNode | ((api: GguiSessionApi) => ReactNode);
}

/**
 * Minimal context passed to {@link GguiRenderProps.onBeforeAction}.
 * Only fields real consumers use; the legacy `EventContext` diagnostic
 * bag (deviceInfo / interfaceContext / user) was dropped when the
 * emitter migrated to canonical {@link ActionEnvelope} — those fields
 * live on the render, not per-delivery.
 */
export interface ActionMeta {
  sessionId: string;
}

/**
 * API object exposed to child render functions of {@link GguiRender}.
 *
 * Two communication methods plus a raw sender:
 *
 * - **action** — Submit user interaction data from a rendered UI component.
 *   Used when a user clicks a button or submits a form inside a generated
 *   component. Dispatches a `data:submit` event over the live channel;
 *   the server bridges it onto the pending-events pipe, so the agent
 *   receives it via `ggui_consume`. Named "action" to match the data
 *   contract concept. Requires a `GguiProvider` `wsEndpoint` — without
 *   one there is no transport and the action is dropped with a console
 *   warning.
 *
 * - **send** — Send a raw WebSocket message. Internal SDK use only
 *   (diagnostics). Not intended for application code.
 *
 * NOTE: The legacy `invoke(text)` method was retired with the v1.1
 * Streamable Invoke Protocol cutover. User text messages now flow through
 * `useInvoke().send()` at the consumer layer.
 */
export interface GguiSessionApi {
  /**
   * Submit user interaction data from a rendered UI component.
   *
   * Use for form submissions, button clicks, and other interactions
   * originating from generated components. The envelope rides the WS
   * live channel; the server's action ingress dual-writes it onto the
   * pending-events pipe, so the agent receives it via `ggui_consume`.
   * Named "action" to match data contract actions.
   *
   * @param data - Interaction payload (e.g., form data, action event)
   */
  action: <T>(data: T) => void;

  /**
   * Send a raw WebSocket message. Internal SDK use only.
   *
   * Used for diagnostics and other low-level protocol messages. Not
   * intended for application code — use `action` for UI interactions
   * and `useInvoke().send` for chat.
   */
  send: (message: WebSocketMessage) => void;

  /** Current WebSocket connection status. */
  connectionStatus: ConnectionStatus;

  /** Current GguiSession snapshot (populated from ack on subscribe and refreshed
   *  on render frame). Absent until the first ack arrives. */
  render: GguiSession | undefined;

  /** GguiSession ID. */
  sessionId: string;
}

/**
 * Manages a single ggui render lifecycle.
 *
 * Opens a WebSocket connection (if `wsEndpoint` is set on the provider),
 * subscribes to the render, and handles incoming server messages
 * (render, data, props_update, error). Exposes a {@link GguiSessionApi}
 * via render props or provides it implicitly to child components.
 *
 * Post-Phase-B: a single render per component instance — no stack, no
 * vessel, no compose. The renderer mounts the current render and applies
 * `props_update` frames in place. If the agent decides to replace the
 * render, the server emits a fresh `render` frame and this component
 * swaps the in-memory snapshot.
 *
 * @example
 * ```tsx
 * // User text messages flow through `useInvoke()` at the consumer layer.
 * // `GguiRender` exposes the live render + action + raw-send via its
 * // render prop.
 * const { send } = useInvoke();
 * return (
 *   <GguiRender sessionId={rid}>
 *     {({ render, action, connectionStatus }) => (
 *       <MyUI render={render} onAction={action} onSend={send} status={connectionStatus} />
 *     )}
 *   </GguiRender>
 * );
 * ```
 */
export function GguiRender({
  sessionId,
  onRenderStart,
  onRenderEnd,
  onBeforeAction,
  onAfterAction,
  onSystemMessage,
  onError,
  onRenderReceived,
  extraReservedValidators,
  children,
}: GguiRenderProps) {
  const { appId, wsEndpoint, auth, appMetadata } = useGguiContext();
  const [render, setRender] = useState<GguiSession | undefined>(undefined);

  // Stable refs for callbacks to avoid unnecessary effect re-runs
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onBeforeActionRef = useRef(onBeforeAction);
  onBeforeActionRef.current = onBeforeAction;
  const onAfterActionRef = useRef(onAfterAction);
  onAfterActionRef.current = onAfterAction;
  const onRenderStartRef = useRef(onRenderStart);
  onRenderStartRef.current = onRenderStart;
  const onRenderEndRef = useRef(onRenderEnd);
  onRenderEndRef.current = onRenderEnd;
  const onRenderReceivedRef = useRef(onRenderReceived);
  onRenderReceivedRef.current = onRenderReceived;
  const onSystemMessageRef = useRef(onSystemMessage);
  onSystemMessageRef.current = onSystemMessage;

  // Compose reserved-channel payload validators once per GguiRender
  // instance (Item 4 injection pattern — client side). Defaults ship
  // the A2UI `_ggui:preview` validator; caller-provided
  // `extraReservedValidators` merge on top with caller-override
  // semantics on key conflict. Ref keeps a stable handle so the
  // inbound-frame handler reads the composed map without widening
  // its deps.
  const reservedValidators = useMemo(
    () => mergeReservedValidators(composePreviewReservedValidator(), extraReservedValidators),
    [extraReservedValidators],
  );
  const reservedValidatorsRef = useRef(reservedValidators);
  reservedValidatorsRef.current = reservedValidators;

  // Always-current render ref — wire dispatch reads this to look up the
  // active contract without forcing wireConfig re-creation on every frame.
  const renderRef = useRef<GguiSession | undefined>(render);
  renderRef.current = render;

  // Per-render inbound stream bus (shared `@ggui-ai/wire` StreamBus —
  // the same class the iframe runtime boots with). Validated `data`
  // frames are emitted here; `WireConfig.subscribe` (wire's
  // `useStream`) and `useChannelStream` (via {@link StreamBusContext})
  // both read from it. Reserved (`_ggui:*`) channels replay from the
  // bus's bounded ring, so a late subscriber — e.g. the
  // `_ggui:preview` provisional renderer, which mounts only after the
  // ack's session payload commits through React state — is caught up
  // synchronously instead of dropping the frames that arrived in the
  // ack → mount window. Keyed by sessionId so replay never bleeds
  // across renders.
  const streamBus = useMemo(() => new StreamBus(), [sessionId]);

  // Handle incoming WebSocket messages from server
  const handleServerMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === 'error') {
        // Server-emitted `{type:'error'}` frame. Recognize the
        // canonical `UPGRADE_REQUIRED` code and surface it as a typed
        // `UpgradeRequiredError` so callers pattern-match without
        // string-sniffing `.message`. Every other code falls through
        // to a generic `Error` — the wire shape of `ErrorPayload.code`
        // is an open `string` by design.
        if (message.payload.code === 'UPGRADE_REQUIRED') {
          // Lift `details.serverVersion` into the typed error when
          // the server populated it (first-party servers do — see
          // GguiSessionChannelOptions). Defensive: treat the details
          // bag as unknown and only lift the string field.
          const details = message.payload.details;
          const serverVersion =
            details !== null &&
            typeof details === 'object' &&
            !Array.isArray(details) &&
            typeof (details as { serverVersion?: unknown }).serverVersion === 'string'
              ? ((details as { serverVersion: string }).serverVersion)
              : undefined;
          onErrorRef.current?.(
            new UpgradeRequiredError({
              ...(serverVersion !== undefined ? { observedVersion: serverVersion } : {}),
              acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
              observedBy: 'server',
            }),
          );
        } else {
          onErrorRef.current?.(new Error(message.payload.message));
        }
      }
      if (message.type === 'ack') {
        // Protocol-version handshake — if the server advertised a
        // `serverVersion` AND it's not in this client's accepted set,
        // surface `UpgradeRequiredError` via onError. An absent
        // `serverVersion` is treated as version-agnostic (matches the
        // behavior of servers that predate the handshake).
        const serverVersion = message.payload.serverVersion;
        if (
          typeof serverVersion === 'string' &&
          !CLIENT_SUPPORTED_VERSIONS.includes(serverVersion)
        ) {
          onErrorRef.current?.(
            new UpgradeRequiredError({
              observedVersion: serverVersion,
              acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
              observedBy: 'client',
            }),
          );
        }
        // Subscribe response — populate initial render snapshot
        if (message.payload.session) {
          setRender(message.payload.session);
          onRenderReceivedRef.current?.(message.payload.session);
        }
      }
      if (message.type === 'render') {
        const { session: nextRender } = message.payload;
        if (nextRender) {
          setRender(nextRender);
          onRenderReceivedRef.current?.(nextRender);
        }
      }
      if (message.type === 'data') {
        const envelope = message.payload;
        if (envelope?.channel) {
          // Defense-in-depth: server already validates outbound
          // fan-out via `assertStreamContract` (which includes the
          // Item 4 reserved-channel validator injection). The client
          // re-runs validation on receipt so server↔client drift
          // (e.g. render replaced between emit and receipt, or a
          // third-party server without Item 4 enforcement) still
          // gets caught here.
          //
          // Reserved channels (`_ggui:*` — see
          // `isKnownReservedChannel`) flow through the same
          // `validateInboundStreamPayload` path, hitting its two-tier
          // validator lookup:
          //   1. `extraReservedValidators` prop (caller-provided) —
          //      composed with the A2UI default for `_ggui:preview`.
          //   2. `BUILTIN_RESERVED_VALIDATORS` from the protocol —
          //      ships the `_ggui:lifecycle` validator.
          //   3. Fall-through to `{valid: true}` for known-reserved
          //      channels without a registered validator.
          // F10 closed-set still applies: a typo inside the reserved
          // namespace (e.g. `_ggui:preveiw`) is NOT recognized and
          // falls through to the declared-channel check which
          // surfaces the typo as an "unknown channel" violation.
          const activeRender = renderRef.current;
          const streamSpec =
            activeRender !== undefined &&
            activeRender.type !== 'mcpApps' &&
            activeRender.type !== 'system'
              ? activeRender.streamSpec
              : undefined;
          const result = validateInboundStreamPayload(
            streamSpec,
            envelope.channel,
            envelope.payload,
            reservedValidatorsRef.current,
          );
          if (!result.valid) {
            surfaceContractViolation(
              new ClientContractViolationError('inbound-stream', result.violations),
              onErrorRef.current,
            );
            return;
          }
          // Primary delivery: the per-render StreamBus —
          // `WireConfig.subscribe` + `useChannelStream` consumers,
          // with reserved-channel replay for late subscribers.
          streamBus.emit(envelope);
          // Host-shell broadcast: external (non-React-tree) listeners
          // observe deliveries via the window bridge event. One-way —
          // no first-party subscriber reads it anymore.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, { detail: envelope }),
            );
          }
        }
      }
      if (message.type === 'props_update') {
        // ggui_update: replace props on the active render (no re-generation)
        const { sessionId: targetSessionId, props } = message.payload;
        if (targetSessionId && props) {
          // Defense-in-depth: server already validates props via
          // assertPropsContract on the ggui_update path; the client
          // re-checks against the active render's cached propsSpec to
          // catch spec-versioning drift before applying to React state.
          const target = renderRef.current;
          // Ignore frames targeting a different render — the server
          // routes by subscription, but a sloppy implementation could
          // fan out cross-render updates; reject locally.
          if (!target || target.id !== targetSessionId) return;
          const propsSpec =
            target.type !== 'mcpApps' && target.type !== 'system'
              ? target.propsSpec
              : undefined;
          const result = validateInboundPropsPayload(propsSpec, props);
          if (!result.valid) {
            surfaceContractViolation(
              new ClientContractViolationError('inbound-props', result.violations),
              onErrorRef.current,
            );
            return;
          }
          setRender((prev) => {
            if (!prev || prev.id !== targetSessionId) return prev;
            // `props` belongs to the component variant only; MCP
            // Apps + system renders have no props and aren't targeted
            // by props_update frames.
            if (prev.type === 'mcpApps' || prev.type === 'system') return prev;
            return { ...prev, props } as GguiSession;
          });
        }
      }
      if (message.type === 'system') {
        onSystemMessageRef.current?.(message.payload as SystemPayload);
      }
    },
    [streamBus]
  );

  // Initialize WebSocket connection (only if wsEndpoint is provided)
  const { sendAction, send, status: connectionStatus } = useWebSocket({
    url: wsEndpoint || '',
    sessionId,
    appId,
    onMessage: handleServerMessage,
  });

  /**
   * Client-monotonic sequence counter. Populates
   * {@link ActionEnvelope.clientSeq} for future at-least-once dedup
   * infra. Starts at 0; increments before every emit so the first
   * envelope carries `clientSeq: 1`.
   */
  const clientSeqRef = useRef(0);

  /**
   * Resolve the actionSpec for outbound emissions. With a single-render
   * mount there's no resolution beyond "read the render's actionSpec";
   * the helper exists for symmetry with the legacy stack-resolving
   * version and to centralize the mcpApps/system narrowing.
   */
  const resolveActiveActionSpec = useCallback((): ActionSpec | undefined => {
    const active = renderRef.current;
    if (!active) return undefined;
    if (active.type === 'mcpApps' || active.type === 'system') return undefined;
    return active.actionSpec;
  }, []);

  /**
   * Emit a fully-built envelope over the live channel. Single code
   * path for every emission site (the shared wire-config dispatch
   * pipeline AND the imperative `api.action` / bridge-event paths);
   * consumers MUST route their sends through here rather than calling
   * `sendAction` directly.
   *
   * The WS send is what completes the documented action loop: the
   * server's live channel bridges `data:submit` envelopes onto the
   * pending-events pipe `ggui_consume` drains. Without a provider
   * `wsEndpoint` there is no transport — warn loudly instead of
   * dropping the user's gesture silently.
   */
  const emitEnvelope = useCallback(
    (envelope: ActionEnvelope) => {
      if (wsEndpoint) {
        sendAction(envelope);
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[ggui] action dropped: GguiProvider has no `wsEndpoint`, so there ' +
            'is no live channel to carry the envelope to the agent.',
          { sessionId: envelope.sessionId, type: envelope.type },
        );
      }
    },
    [wsEndpoint, sendAction],
  );

  /**
   * Build + emit a canonical typed envelope. {@link EventType} has one
   * member (`'data:submit'`); the server validates the payload against
   * the render's `actionSpec` at ingress.
   */
  const emitTyped = useCallback(
    (type: EventType, payload: JsonValue | undefined) => {
      clientSeqRef.current += 1;
      const envelope = buildActionEnvelope({
        sessionId,
        type,
        ...(payload !== undefined ? { payload } : {}),
        clientSeq: clientSeqRef.current,
      });
      emitEnvelope(envelope);
    },
    [sessionId, emitEnvelope],
  );

  // Reset render when sessionId changes
  useEffect(() => {
    setRender(undefined);
    onRenderStartRef.current?.({ sessionId });

    return () => {
      onRenderEndRef.current?.({ sessionId }, 'unmount');
    };
  }, [sessionId]);

  // Action handler with middleware (component interactions → agent).
  // Builds a canonical data:submit ActionEnvelope via the shared
  // emitter; onBeforeAction runs first and can transform/cancel the
  // payload before validation + send.
  const action = useCallback(
    <T,>(data: T) => {
      try {
        const meta: ActionMeta = { sessionId };

        // Call onBeforeAction middleware — may transform or cancel (by
        // returning undefined). Return-undefined remains the "drop"
        // signal; preserved across the envelope migration.
        const transformedData = onBeforeActionRef.current
          ? onBeforeActionRef.current(data, meta)
          : data;
        if (transformedData === undefined) return;

        emitTyped('data:submit', transformedData as JsonValue);

        onAfterActionRef.current?.(transformedData, null);
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [sessionId, emitTyped]
  );

  // NOTE: The legacy `invoke(text)` method was retired with the v1.1
  // Streamable Invoke Protocol cutover (the `type: 'invoke'` WS route's
  // server handler was deleted). User text messages now go through
  // `useInvoke().send` at the consumer layer.

  const api = useMemo<GguiSessionApi>(
    () => ({
      action,
      send,
      connectionStatus,
      render,
      sessionId,
    }),
    [action, send, connectionStatus, render, sessionId]
  );

  // Shared wire-config pipeline (`@ggui-ai/wire`'s `buildWireConfig`)
  // — the SAME envelope-build → validate → emit implementation the
  // iframe runtime's `buildRootWireConfig` composes, so the two
  // first-party renderers cannot drift (MCP Apps Compliance). This
  // component injects its own seams:
  //   - actionSpec resolution reads the active render snapshot at
  //     dispatch time (renderRef.current), keeping spec edits
  //     observed on `props_update` in sync without a rebuild;
  //   - violations surface through `onError` (console.warn fallback);
  //   - transport is the live-channel WS `action` frame
  //     (`emitEnvelope`), which the first-party server bridges onto
  //     the `ggui_consume` pending-events pipe;
  //   - `clientSeq` shares this component's counter so config
  //     dispatches and imperative `api.action` emissions stay
  //     monotonic on one sequence;
  //   - `subscribe` reads the per-render StreamBus (reserved-channel
  //     replay included).
  const wireConfig = useMemo<WireConfig>(
    () =>
      buildWireConfig({
        app: {
          appId,
          appName: appMetadata?.appName ?? appId,
          appDescription: appMetadata?.appDescription,
          appIcon: appMetadata?.appIcon,
        },
        render: {
          sessionId,
          isConnected: connectionStatus === 'connected',
        },
        auth: {
          userId: auth?.userId,
          isAuthenticated: auth?.isAuthenticated ?? false,
        },
        getActiveActionSpec: resolveActiveActionSpec,
        onViolation: (err) => surfaceContractViolation(err, onErrorRef.current),
        emitEnvelope,
        streamBus,
        nextClientSeq: () => {
          clientSeqRef.current += 1;
          return clientSeqRef.current;
        },
      }),
    [appId, sessionId, connectionStatus, auth, appMetadata, resolveActiveActionSpec, emitEnvelope, streamBus],
  );

  return (
    <StreamBusContext.Provider value={streamBus}>
      <GguiWireProvider config={wireConfig}>
        {typeof children === 'function' ? children(api) : children}
      </GguiWireProvider>
    </StreamBusContext.Provider>
  );
}
