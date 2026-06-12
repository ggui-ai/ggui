/**
 * GguiRender (React Native) — mounts one ggui render over the live WS
 * channel.
 *
 * ## Platform deltas vs the web twin
 *
 * Near-twin of `@ggui-ai/react`'s `components/GguiRender.tsx`. Mirror
 * behavior-neutral changes to the twin. Load-bearing differences
 * (everything else should match):
 *
 *   - Wire hooks: web wraps `children` in `GguiWireProvider`, so the
 *     scoped wire hooks (`useAction`, channel subscriptions) resolve
 *     through its `WireConfig`. RN renders children bare — the
 *     WireProvider port is a pending RN slice; RN's `api.action`
 *     validates against the active actionSpec inline instead.
 *   - `GguiSessionApi`: web exposes `send`; RN omits it.
 *   - Event bus: web dispatches/subscribes bridge events on `window`
 *     CustomEvents unconditionally; RN gates every `window` touch
 *     behind `Platform.OS === 'web'` (no DOM event bus on native).
 *
 * The byte-identical chat-thread / chat-helpers twins are pinned by
 * `twin-parity.test.ts` in both SDKs; the eventual fix is hoisting
 * the platform-neutral core into a shared package.
 */
import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type {
  ActionEnvelope,
  ActionSpec,
  EventType,
  JsonValue,
  GguiSession,
  ReservedChannelValidator,
  AckPayload,
  SystemPayload,
} from '@ggui-ai/protocol';
import { BRIDGE_EVENTS, CLIENT_SUPPORTED_VERSIONS, UpgradeRequiredError } from '@ggui-ai/protocol';
import {
  buildActionEnvelope,
  ClientContractViolationError,
  validateInboundPropsPayload,
  validateInboundStreamPayload,
  validateOutboundActionEnvelope,
} from '@ggui-ai/wire';
import { useGguiContext } from './GguiProvider';
import { useWebSocket } from '../hooks/useWebSocket';
import { emitPreviewBridge } from '../internal/preview-bridge';
import {
  composePreviewReservedValidator,
  mergeReservedValidators,
} from '../internal/reserved-validators';

/**
 * Surface a ClientContractViolationError at whichever path is wired:
 * prefer the explicit `onError` callback; when the caller didn't
 * provide one, fall back to `console.warn` so violations don't
 * silently vanish during integration. Tagged `[ggui:contract]` so
 * devs can grep / filter. Mirrors the web-client helper in
 * `@ggui-ai/react/components/GguiRender.tsx` exactly.
 */
function surfaceContractViolation(
  err: ClientContractViolationError,
  onError: ((err: Error) => void) | undefined,
): void {
  if (onError) {
    onError(err);
    return;
  }
  // eslint-disable-next-line no-console
  console.warn('[ggui:contract] ' + err.message, {
    direction: err.direction,
    violations: err.violations,
  });
}

/**
 * Minimal render metadata passed to lifecycle callbacks.
 */
export interface GguiSessionInfo {
  sessionId: string;
}

/**
 * Props for the {@link GguiRender} component.
 *
 * Provides lifecycle, data, interaction, and error hooks for
 * fine-grained control over the mounted render.
 */
export interface GguiRenderProps {
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
 */
export interface ActionMeta {
  sessionId: string;
}

/**
 * API object exposed to child render functions of {@link GguiRender}.
 */
export interface GguiSessionApi {
  action: <T>(data: T) => void;
  connectionStatus: ConnectionStatus;
  /** Current GguiSession snapshot (populated from ack on subscribe and refreshed
   *  on render frame). Absent until the first ack arrives. */
  render: GguiSession | undefined;
  sessionId: string;
}

/**
 * Manages a single ggui render lifecycle on React Native.
 *
 * Opens a WebSocket connection (if `wsEndpoint` is set on the provider),
 * subscribes to the render, and handles incoming server messages
 * (render, data, props_update, error). On web platform, dispatches
 * window CustomEvents for shell hooks compatibility.
 *
 * Post-Phase-B: a single render per component instance — no stack, no
 * vessel. The renderer mounts the current render and applies
 * `props_update` frames in place. If the agent decides to replace the
 * render, the server emits a fresh `render` frame and this component
 * swaps the in-memory snapshot.
 *
 * @example
 * ```tsx
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
  const { appId, wsEndpoint } = useGguiContext();
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
  // instance (Item 4 injection pattern — client side).
  const reservedValidators = useMemo(
    () => mergeReservedValidators(composePreviewReservedValidator(), extraReservedValidators),
    [extraReservedValidators],
  );
  const reservedValidatorsRef = useRef(reservedValidators);
  reservedValidatorsRef.current = reservedValidators;

  // Always-current render snapshot — inbound validation (data
  // streamSpec, props_update propsSpec) reads this without re-running
  // handleServerMessage on every render mutation.
  const renderRef = useRef<GguiSession | undefined>(render);
  renderRef.current = render;

  // Handle incoming WebSocket messages from server
  const handleServerMessage = useCallback(
    (message: WebSocketMessage) => {
      if (message.type === 'error') {
        const payload = message.payload as {
          code?: string;
          message: string;
          details?: JsonValue;
        };
        // Server-emitted `{type:'error'}` frame. Recognize the
        // canonical `UPGRADE_REQUIRED` code and surface it as a typed
        // `UpgradeRequiredError` so callers pattern-match without
        // string-sniffing `.message`. Every other code falls through
        // to a generic `Error`.
        if (payload.code === 'UPGRADE_REQUIRED') {
          const details = payload.details;
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
          onErrorRef.current?.(new Error(payload.message));
        }
      }
      if (message.type === 'ack') {
        const payload = message.payload as AckPayload;
        // Protocol-version handshake.
        if (
          typeof payload.serverVersion === 'string' &&
          !CLIENT_SUPPORTED_VERSIONS.includes(payload.serverVersion)
        ) {
          onErrorRef.current?.(
            new UpgradeRequiredError({
              observedVersion: payload.serverVersion,
              acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
              observedBy: 'client',
            }),
          );
        }
        if (payload.session) {
          setRender(payload.session);
          onRenderReceivedRef.current?.(payload.session);
        }
      }
      if (message.type === 'render') {
        const payload = message.payload as { session: GguiSession };
        if (payload.session) {
          setRender(payload.session);
          onRenderReceivedRef.current?.(payload.session);
        }
      }
      if (message.type === 'data') {
        const envelope = message.payload;
        if (envelope?.channel) {
          // Defense-in-depth against server↔client drift (Item 4):
          // server already validates outbound fan-out through
          // `assertStreamContract` with the injected A2UI validator.
          // The client re-runs validation on receipt so third-party
          // servers without Item 4 enforcement, or drift between
          // server-side emit and client-side snapshot of streamSpec,
          // still get caught here.
          //
          // Reserved channels (`_ggui:*`) flow through the same
          // `validateInboundStreamPayload` path, hitting its two-tier
          // validator lookup:
          //   1. `extraReservedValidators` (caller-provided, composed
          //      with the A2UI default for `_ggui:preview`).
          //   2. `BUILTIN_RESERVED_VALIDATORS` from the protocol
          //      (ships the `_ggui:lifecycle` validator).
          //   3. Fall-through to `{valid: true}` for known-reserved
          //      channels without a registered validator.
          //
          // F10 closed-set still applies: a typo inside the reserved
          // namespace (e.g. `_ggui:preveiw`) is NOT recognized and
          // falls through to the declared-channel check which
          // surfaces the typo as an "unknown channel" violation.
          //
          // Runs on ALL platforms — even on native (where today
          // `data` has no user-facing consumer), a future subscribe-
          // to-data path inherits the gate.
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
          // Fan out to native subscribers (through the RN preview
          // bridge) AND to web window consumers.
          emitPreviewBridge(envelope);
          if (Platform.OS === 'web' && typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, { detail: envelope }),
            );
          }
        }
      }
      if (message.type === 'props_update') {
        // ggui_update: replace props on the active render (no re-
        // generation). Validate against the active render's cached
        // propsSpec BEFORE applying to React state — defense-in-depth
        // for server↔client spec drift.
        const { sessionId: targetSessionId, props } = message.payload;
        if (targetSessionId && props) {
          const target = renderRef.current;
          // Ignore frames targeting a different render.
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
            // props_update targets component renders only; MCP Apps
            // iframes + server-emitted system cards have no client-
            // mutable props and are unaffected.
            if (prev.type === 'mcpApps' || prev.type === 'system') return prev;
            return { ...prev, props } as GguiSession;
          });
        }
      }
      if (message.type === 'system') {
        const payload = message.payload as SystemPayload;
        onSystemMessageRef.current?.(payload);
      }
    },
    []
  );

  // Initialize WebSocket connection (only if wsEndpoint is provided)
  const { sendAction, status: connectionStatus } = useWebSocket({
    url: wsEndpoint || '',
    sessionId,
    appId,
    onMessage: handleServerMessage,
  });

  /**
   * Client-monotonic sequence counter — populates
   * {@link ActionEnvelope.clientSeq} for future at-least-once dedup
   * infra. Starts at 0; increments before every emit.
   */
  const clientSeqRef = useRef(0);

  /**
   * Resolve the actionSpec for outbound emissions. With a single-render
   * mount there's no resolution beyond "read the render's actionSpec".
   */
  const resolveActiveActionSpec = useCallback((): ActionSpec | undefined => {
    const active = renderRef.current;
    if (!active) return undefined;
    if (active.type === 'mcpApps' || active.type === 'system') return undefined;
    return active.actionSpec;
  }, []);

  /**
   * Emit a fully-built envelope over the live channel. Single code
   * path for every emission site — consumers MUST route their sends
   * through here rather than calling `sendAction` directly.
   */
  const emitEnvelope = useCallback(
    (envelope: ActionEnvelope) => {
      if (wsEndpoint) {
        sendAction(envelope);
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

  // Reset render snapshot when sessionId changes
  useEffect(() => {
    setRender(undefined);
    onRenderStartRef.current?.({ sessionId });

    return () => {
      onRenderEndRef.current?.({ sessionId }, 'unmount');
    };
  }, [sessionId]);

  // Action handler with middleware (component interactions → agent).
  // Builds a canonical data:submit ActionEnvelope; onBeforeAction runs
  // first and can transform/cancel the payload before validation +
  // send. Mirrors the web SDK's `action` semantics.
  //
  // NOTE: no GguiWireProvider wrap here — RN's render emitter
  // doesn't go through a WireProvider's `useAction` path today, so
  // there's no actionSpec round-trip from a scoped hook. Server still
  // authoritative — any violation is rejected on ingress with
  // CONTRACT_VIOLATION. The full actionSpec-validated path lands with
  // the RN WireProvider port (separate slice); see the platform-delta
  // header at the top of this file.
  const action = useCallback(
    <T,>(data: T) => {
      try {
        const meta: ActionMeta = { sessionId };

        // Call onBeforeAction middleware — may transform or cancel
        // (by returning undefined).
        const transformedData = onBeforeActionRef.current
          ? onBeforeActionRef.current(data, meta)
          : data;
        if (transformedData === undefined) return;

        // Validate against active actionSpec when one is known — gives
        // RN the same early-failure UX as web for malformed submits.
        const actionSpec = resolveActiveActionSpec();
        if (actionSpec) {
          clientSeqRef.current += 1;
          const envelope = buildActionEnvelope({
            sessionId,
            type: 'data:submit',
            payload: transformedData as JsonValue,
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
        } else {
          emitTyped('data:submit', transformedData as JsonValue);
        }

        onAfterActionRef.current?.(transformedData, null);
      } catch (error) {
        onErrorRef.current?.(error instanceof Error ? error : new Error(String(error)));
      }
    },
    [sessionId, resolveActiveActionSpec, emitTyped, emitEnvelope],
  );

  // NOTE: The legacy `invoke(text)` method was retired with the v1.1
  // Streamable Invoke Protocol cutover. User text messages now go through
  // `useInvoke().send` at the consumer layer.

  const api = useMemo<GguiSessionApi>(
    () => ({
      action,
      connectionStatus,
      render,
      sessionId,
    }),
    [action, connectionStatus, render, sessionId]
  );

  return <>{typeof children === 'function' ? children(api) : children}</>;
}
