import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionEnvelope,
  ActionSpec,
  EventType,
  GguiSession,
  ReservedChannelValidator,
  StreamEnvelope,
  StreamPayload,
  ProgressPayload,
  SystemPayload,
  JsonValue,
} from '@ggui-ai/protocol';
import { BRIDGE_EVENTS, CLIENT_SUPPORTED_VERSIONS, UpgradeRequiredError } from '@ggui-ai/protocol';
import {
  buildActionEnvelope,
  ClientContractViolationError,
  GguiWireProvider,
  validateInboundPropsPayload,
  validateInboundStreamPayload,
  validateOutboundActionEnvelope,
  type StreamDelivery,
  type WireConfig,
} from '@ggui-ai/wire';
import { useGguiContext } from './GguiProvider';
import { useWebSocket } from '../hooks/useWebSocket';
import {
  composePreviewReservedValidator,
  mergeReservedValidators,
} from '../internal/reserved-validators';

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
 * Provides lifecycle, data, interaction, progress, streaming, and error
 * hooks for fine-grained control over the mounted render.
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

  // Interaction hooks — receives the canonical {@link ActionEnvelope}
  // that was emitted. Called only for `interaction:*` event types;
  // the envelope's `payload` carries the interaction-specific data.
  onInteraction?: (envelope: ActionEnvelope) => void;

  // Progress hooks
  onProgress?: (progress: ProgressPayload) => void;

  // Streaming hooks
  onStream?: (payload: StreamPayload) => void;

  // System hooks
  onSystemMessage?: (payload: SystemPayload) => void;

  // Error hooks
  onValidationError?: (errors: unknown[], data: unknown) => void;
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
   * `_ggui:contract-error` is validated via the protocol's built-in
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
 *   component. Dispatches a `data:submit` event that the agent can receive
 *   via `ggui_consume`. Named "action" to match the data contract concept.
 *
 * - **send** — Send a raw WebSocket message. Internal SDK use only
 *   (feedback, diagnostics). Not intended for application code.
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
   * originating from generated components. The agent receives these
   * via `ggui_consume`. Named "action" to match data contract actions.
   *
   * @param data - Interaction payload (e.g., form data, action event)
   */
  action: <T>(data: T) => void;

  /**
   * Send a raw WebSocket message. Internal SDK use only.
   *
   * Used for feedback submissions, diagnostics, and other low-level
   * protocol messages. Not intended for application code — use `action`
   * for UI interactions and `useInvoke().send` for chat.
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
 * (render, progress, data, stream, error). Exposes a {@link GguiSessionApi}
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
  onInteraction,
  onProgress,
  onStream,
  onSystemMessage,
  onValidationError: _onValidationError,
  onError,
  onRenderReceived,
  extraReservedValidators,
  children,
}: GguiRenderProps) {
  const { appId, wsEndpoint, auth, appMetadata, appConfig } = useGguiContext();
  const [render, setRender] = useState<GguiSession | undefined>(undefined);

  // Stable refs for callbacks to avoid unnecessary effect re-runs
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onInteractionRef = useRef(onInteraction);
  onInteractionRef.current = onInteraction;
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
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onStreamRef = useRef(onStream);
  onStreamRef.current = onStream;
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
        const { session: nextRender, matchType } = message.payload;
        if (nextRender) {
          setRender(nextRender);
          onRenderReceivedRef.current?.(nextRender);
          // Forward matchType info as a synthetic progress event
          if (matchType) {
            const isHit = matchType === 'cached' || matchType === 'predefined' || matchType === 'exact';
            onProgressRef.current?.({
              sessionId: nextRender.id,
              step: 'compiling',
              message: isHit ? 'Found matching blueprint' : 'No blueprint match found',
            });
          }
        }
      }
      if (message.type === 'progress') {
        onProgressRef.current?.(message.payload);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(BRIDGE_EVENTS.AGENT_LOGS, { detail: message.payload }),
          );
        }
      }
      if (message.type === 'agent-msg') {
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(BRIDGE_EVENTS.AGENT_MSG, { detail: message.payload }),
          );
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
          //      ships the `_ggui:contract-error` validator.
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
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, { detail: envelope }),
            );
          }
        }
      }
      if (message.type === 'stream') {
        const payload = message.payload as StreamPayload;
        onStreamRef.current?.(payload);
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(BRIDGE_EVENTS.AGENT_STREAM, { detail: payload }),
          );
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
    []
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
   * Emit a fully-built envelope over the live channel AND fire the
   * `onInteraction` callback for `interaction:*` types. Single code
   * path for every emission site; consumers MUST route their sends
   * through here rather than calling `sendAction` directly so the
   * interaction hook stays in sync.
   */
  const emitEnvelope = useCallback(
    (envelope: ActionEnvelope) => {
      if (wsEndpoint) {
        sendAction(envelope);
      }
      if (envelope.type.startsWith('interaction:')) {
        onInteractionRef.current?.(envelope);
      }
    },
    [wsEndpoint, sendAction],
  );

  /**
   * Build + validate + emit a canonical {@link ActionEnvelope} for a
   * named user action. Validates against the supplied `actionSpec` via
   * {@link validateOutboundActionEnvelope} — same check the server
   * runs on ingress (saves the round-trip on locally-knowable
   * violations). On violation: surface via `onError` (or fall back to
   * console.warn) and skip the send.
   */
  const dispatchAction = useCallback(
    (
      actionName: string,
      data: unknown,
      actionSpec: ActionSpec | undefined,
    ) => {
      clientSeqRef.current += 1;
      const entry = actionSpec?.[actionName];
      const tool = entry?.nextStep;
      const envelope = buildActionEnvelope({
        sessionId,
        type: 'data:submit',
        payload: {
          action: actionName,
          data: data as JsonValue,
          ...(tool ? { tool } : {}),
        },
        clientSeq: clientSeqRef.current,
      });
      const result = validateOutboundActionEnvelope(actionSpec, envelope);
      if (!result.valid) {
        const err = new ClientContractViolationError(
          'outbound-action',
          result.violations,
        );
        surfaceContractViolation(err, onErrorRef.current);
        return;
      }
      emitEnvelope(envelope);
    },
    [sessionId, emitEnvelope],
  );

  /**
   * Emit a non-action event (`lifecycle:*` / `interaction:*`) as a
   * canonical envelope. No contract validation — those types don't
   * carry an actionSpec-bound payload; server enforcement gates by
   * `subscription.events` allowlist only.
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

  // Forward user data from rendered components (via window CustomEvent)
  // as a canonical data:submit ActionEnvelope.
  useEffect(() => {
    if (typeof window === 'undefined') return;

    function handleUserData(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail !== undefined) {
        emitTyped('data:submit', detail as JsonValue);
      }
    }

    window.addEventListener(BRIDGE_EVENTS.USER_DATA, handleUserData);
    return () => window.removeEventListener(BRIDGE_EVENTS.USER_DATA, handleUserData);
  }, [emitTyped]);

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

  const wireConfig = useMemo<WireConfig>(() => ({
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
    // Single render per mount — no scope factory. Every dispatch
    // resolves the actionSpec from the active render snapshot at the
    // moment of dispatch (renderRef.current), keeping spec edits
    // observed on `props_update` (which doesn't replace the spec but
    // does refresh the snapshot identity) in sync.
    dispatch: (actionName: string, data: unknown) => {
      const actionSpec = resolveActiveActionSpec();
      dispatchAction(actionName, data, actionSpec);
    },
    subscribe: <T = unknown>(
      channelName: string,
      handler: (delivery: StreamDelivery<T>) => void,
    ) => {
      const listener = (e: Event) => {
        const detail = (e as CustomEvent).detail as StreamEnvelope | undefined;
        if (detail?.channel === channelName) {
          handler({
            payload: detail.payload as T,
            mode: detail.mode,
            ...(detail.complete !== undefined ? { complete: detail.complete } : {}),
          });
        }
      };
      window.addEventListener(BRIDGE_EVENTS.AGENT_DATA, listener);
      return () => window.removeEventListener(BRIDGE_EVENTS.AGENT_DATA, listener);
    },
    // There is no `callWiredTool` — the contract's `agentTools` is a
    // catalog the AGENT invokes; the component never reaches the
    // underlying tool. Cross-refs surface via `actionSpec[*].nextStep`
    // (event hint) and `streamSpec[*].source.tool` (channel data
    // source).
  }), [appId, sessionId, connectionStatus, auth, appMetadata, appConfig, dispatchAction, resolveActiveActionSpec]);

  return (
    <GguiWireProvider config={wireConfig}>
      {typeof children === 'function' ? children(api) : children}
    </GguiWireProvider>
  );
}
