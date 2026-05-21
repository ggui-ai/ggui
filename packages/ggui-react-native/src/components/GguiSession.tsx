import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type { ActionEnvelope, ActionSpec, EventType, JsonObject, JsonValue, ReservedChannelValidator, SessionStackEntry, AckPayload, StreamPayload, ProgressPayload, SystemPayload } from '@ggui-ai/protocol';
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
 * `@ggui-ai/react/components/GguiSession.tsx` exactly.
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
 * Minimal session metadata passed to lifecycle callbacks.
 */
export interface SessionInfo {
  sessionId: string;
}


/**
 * Props for the {@link GguiSession} component.
 *
 * Provides lifecycle, data, interaction, progress, streaming, and error
 * hooks for fine-grained control over the session.
 */
export interface GguiSessionProps {
  sessionId: string;
  userToken?: string;
  userId?: string;

  // Lifecycle hooks
  onSessionStart?: (session: SessionInfo) => void;
  onSessionEnd?: (session: SessionInfo, reason: string) => void;
  onStackPush?: (stackItem: SessionStackEntry) => void;
  onStackPop?: (stackItem: unknown) => void;

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
   */
  extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>;

  children: ReactNode | ((api: SessionApi) => ReactNode);
}

/**
 * API object exposed to child render functions of {@link GguiSession}.
 *
 * Provides methods to submit data, dispatch events, and read the current
 * connection status and stack.
 *
 * NOTE: The legacy `invoke(text)` method was retired with the v1.1
 * Streamable Invoke Protocol cutover. User text messages now flow through
 * `useInvoke().send()` at the consumer layer.
 */
/**
 * Minimal context passed to {@link GguiSessionProps.onBeforeAction}.
 * Symmetric with the web SDK's ActionMeta — only fields real consumers
 * use; the legacy diagnostic `EventContext` bag was dropped when the
 * emitter migrated to canonical {@link ActionEnvelope}.
 */
export interface ActionMeta {
  sessionId: string;
  stackIndex: number;
}

export interface SessionApi {
  action: <T>(data: T) => void;
  connectionStatus: ConnectionStatus;
  /** Current session stack (populated from ack on subscribe and updated on push) */
  stack: SessionStackEntry[];
}

/**
 * Manages a single ggui session lifecycle on React Native.
 *
 * Opens a WebSocket connection (if `wsEndpoint` is set on the provider),
 * subscribes to the session, and handles incoming server messages (push,
 * progress, data, stream, error). On web platform, dispatches window
 * CustomEvents for shell hooks compatibility.
 *
 * @example
 * ```tsx
 * // User text messages flow through `useInvoke()` at the consumer layer.
 * const { send } = useInvoke();
 * return (
 *   <GguiSession sessionId={sid}>
 *     {({ stack, action, connectionStatus }) => (
 *       <MyUI stack={stack} onAction={action} onSend={send} status={connectionStatus} />
 *     )}
 *   </GguiSession>
 * );
 * ```
 */
export function GguiSession({
  sessionId,
  onSessionStart,
  onSessionEnd,
  onBeforeAction,
  onAfterAction,
  onInteraction,
  onProgress,
  onStream,
  onSystemMessage,
  onValidationError: _onValidationError,
  onError,
  onStackPush,
  extraReservedValidators,
  children,
}: GguiSessionProps) {
  const { appId, wsEndpoint } = useGguiContext();
  const [stack, setStack] = useState<SessionStackEntry[]>([]);

  // Stable refs for callbacks to avoid unnecessary effect re-runs
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onInteractionRef = useRef(onInteraction);
  onInteractionRef.current = onInteraction;
  const onBeforeActionRef = useRef(onBeforeAction);
  onBeforeActionRef.current = onBeforeAction;
  const onAfterActionRef = useRef(onAfterAction);
  onAfterActionRef.current = onAfterAction;
  const onSessionStartRef = useRef(onSessionStart);
  onSessionStartRef.current = onSessionStart;
  const onSessionEndRef = useRef(onSessionEnd);
  onSessionEndRef.current = onSessionEnd;
  const onStackPushRef = useRef(onStackPush);
  onStackPushRef.current = onStackPush;
  const onProgressRef = useRef(onProgress);
  onProgressRef.current = onProgress;
  const onStreamRef = useRef(onStream);
  onStreamRef.current = onStream;
  const onSystemMessageRef = useRef(onSystemMessage);
  onSystemMessageRef.current = onSystemMessage;

  // Compose reserved-channel payload validators once per GguiSession
  // instance (Item 4 injection pattern — client side). Defaults ship
  // the A2UI `_ggui:preview` validator; caller-provided
  // `extraReservedValidators` merge on top with caller-override
  // semantics on key conflict.
  const reservedValidators = useMemo(
    () => mergeReservedValidators(composePreviewReservedValidator(), extraReservedValidators),
    [extraReservedValidators],
  );
  const reservedValidatorsRef = useRef(reservedValidators);
  reservedValidatorsRef.current = reservedValidators;

  // Always-current stack snapshot — inbound validation (data streamSpec,
  // props_update propsSpec) reads this without re-running handleServer-
  // Message on every stack mutation.
  const stackRef = useRef<SessionStackEntry[]>(stack);
  stackRef.current = stack;

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
          // Lift `details.serverVersion` into the typed error when
          // the server populated it (first-party servers do — see
          // SessionChannelOptions). Defensive: treat the details
          // bag as unknown and only lift the string field.
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
        // Subscribe response — populate initial stack
        const payload = message.payload as AckPayload;
        // Protocol-version handshake — if the server advertised a
        // `serverVersion` AND it's not in this client's accepted set,
        // surface `UpgradeRequiredError` via onError. An absent
        // `serverVersion` is treated as version-agnostic (matches the
        // behavior of servers that predate the handshake).
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
        if (payload.stack) {
          setStack(payload.stack);
        }
      }
      if (message.type === 'push') {
        const payload = message.payload as { stackItem: SessionStackEntry; matchType?: string };
        if (payload.stackItem) {
          setStack((prev) => {
            // Replace existing item with same ID, or append
            const idx = prev.findIndex((item) => item.id === payload.stackItem.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = payload.stackItem;
              return next;
            }
            return [...prev, payload.stackItem];
          });
          onStackPushRef.current?.(payload.stackItem);
          // Forward matchType info as a synthetic progress event
          if (payload.matchType) {
            const isHit = payload.matchType === 'cached' || payload.matchType === 'predefined' || payload.matchType === 'exact';
            onProgressRef.current?.({
              sessionId: '',
              stackItemId: payload.stackItem.id,
              step: 'compiling',
              message: isHit ? 'Found matching blueprint' : 'No blueprint match found',
            });
          }
        }
      }
      if (message.type === 'progress') {
        const payload = message.payload;
        onProgressRef.current?.(payload);
        // Dispatch window events on web for shell hooks (useGenerationProgress etc.)
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(BRIDGE_EVENTS.AGENT_LOGS, { detail: payload }),
          );
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
          //      (ships the `_ggui:contract-error` validator).
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
          const currentStack = stackRef.current;
          const activeIndex = currentStack.length - 1;
          const activeItem = activeIndex >= 0 ? currentStack[activeIndex] : undefined;
          const streamSpec =
            activeItem !== undefined &&
            activeItem.type !== 'mcpApps' &&
            activeItem.type !== 'system'
              ? activeItem.streamSpec
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
          // bridge) AND to web window consumers. Keeping both so
          // native-side useChannelStream can observe non-reserved
          // channels if we ever widen the seam.
          emitPreviewBridge(envelope);
          if (Platform.OS === 'web' && typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent(BRIDGE_EVENTS.AGENT_DATA, { detail: envelope }),
            );
          }
        }
      }
      if (message.type === 'props_update') {
        // ggui_update: replace props on an existing stack item (no
        // re-generation). NEW in RN — mirrors the web client's
        // `props_update` handler shape exactly (slice-9 memory
        // `project_client_contract_symmetry.md`). Validate against
        // the target item's cached propsSpec BEFORE applying to React
        // state — defense-in-depth for server↔client spec drift.
        const { stackItemId, props } = message.payload as {
          stackItemId: string;
          props: JsonObject;
        };
        if (stackItemId && props) {
          const target = stackRef.current.find((item) => item.id === stackItemId);
          const propsSpec =
            target !== undefined &&
            target.type !== 'mcpApps' &&
            target.type !== 'system'
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
          setStack((prev) =>
            prev.map((item) => {
              if (item.id !== stackItemId) return item;
              // props_update targets component items only; MCP Apps
              // iframes + server-emitted system cards have no client-
              // mutable props and are unaffected.
              if (item.type === 'mcpApps' || item.type === 'system') return item;
              return { ...item, props } as SessionStackEntry;
            }),
          );
        }
      }
      if (message.type === 'stream') {
        const payload = message.payload as StreamPayload;
        onStreamRef.current?.(payload);
        if (Platform.OS === 'web' && typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent(BRIDGE_EVENTS.AGENT_STREAM, { detail: payload }),
          );
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
   * Resolve the stack item an emission should target. Mirrors the
   * web SDK resolver — prefers top-of-stack, falls back to index 0
   * for an empty stack so emissions get a stable numeric index.
   */
  const resolveActiveStack = useCallback((): {
    stackIndex: number;
    stackItemId: string | undefined;
    actionSpec: ActionSpec | undefined;
  } => {
    const currentStack = stackRef.current;
    const stackIndex = currentStack.length > 0 ? currentStack.length - 1 : 0;
    const activeItem = currentStack[stackIndex];
    const actionSpec =
      activeItem !== undefined &&
      activeItem.type !== 'mcpApps' &&
      activeItem.type !== 'system'
        ? activeItem.actionSpec
        : undefined;
    return {
      stackIndex,
      stackItemId: activeItem?.id,
      actionSpec,
    };
  }, []);

  /**
   * Emit a fully-built envelope over the live channel AND fire the
   * `onInteraction` callback for `interaction:*` types. Single code
   * path for every emission site — consumers MUST route their sends
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
   * Emit a non-action event (`lifecycle:*` / `interaction:*`) or the
   * iframe-bridged `data:submit` as a canonical envelope. No contract
   * validation — those types don't carry an actionSpec-bound payload;
   * server enforcement gates by `subscription.events` allowlist only.
   */
  const emitTyped = useCallback(
    (type: EventType, payload: JsonValue | undefined) => {
      const active = resolveActiveStack();
      clientSeqRef.current += 1;
      const envelope = buildActionEnvelope({
        sessionId,
        type,
        ...(payload !== undefined ? { payload } : {}),
        stackIndex: active.stackIndex,
        ...(active.stackItemId ? { stackItemId: active.stackItemId } : {}),
        clientSeq: clientSeqRef.current,
      });
      emitEnvelope(envelope);
    },
    [sessionId, resolveActiveStack, emitEnvelope],
  );

  // Forward user data from component iframe/WebView → WebSocket
  // (web platform only — RN renders components natively). Wrapped as
  // a canonical data:submit ActionEnvelope.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;

    function handleUserData(event: Event) {
      const detail = (event as CustomEvent).detail;
      if (detail !== undefined) {
        emitTyped('data:submit', detail as JsonValue);
      }
    }

    window.addEventListener(BRIDGE_EVENTS.USER_DATA, handleUserData);
    return () => window.removeEventListener(BRIDGE_EVENTS.USER_DATA, handleUserData);
  }, [emitTyped]);

  // Reset stack when sessionId changes
  useEffect(() => {
    setStack([]);
    onSessionStartRef.current?.({ sessionId });

    return () => {
      onSessionEndRef.current?.({ sessionId }, 'unmount');
    };
  }, [sessionId]);

  // Action handler with middleware (component interactions → agent).
  // Builds a canonical data:submit ActionEnvelope; onBeforeAction runs
  // first and can transform/cancel the payload before
  // validation + send. Mirrors the web SDK's `action` semantics.
  //
  // NOTE: no contract validation here — RN's session emitter doesn't
  // go through a WireProvider's `useAction` path today (see
  // `project_rn_contract_symmetry.md`), so there's no actionSpec
  // round-trip from a scoped hook. Server still authoritative — any
  // violation is rejected on ingress with CONTRACT_VIOLATION. The
  // full actionSpec-validated path lands with the RN WireProvider
  // port (separate slice).
  const action = useCallback(
    <T,>(data: T) => {
      try {
        const active = resolveActiveStack();
        const meta: ActionMeta = { sessionId, stackIndex: active.stackIndex };

        // Call onBeforeAction middleware — may transform or cancel
        // (by returning undefined).
        const transformedData = onBeforeActionRef.current
          ? onBeforeActionRef.current(data, meta)
          : data;
        if (transformedData === undefined) return;

        // Validate against active actionSpec when one is known — gives
        // RN the same early-failure UX as web for malformed submits.
        // The `data` shape here is the raw user payload, so we build
        // a transient envelope with an `action: '<default>'` wrapper
        // only when actionSpec exists; otherwise skip validation
        // (permissive — matches the server's no-contract behavior).
        if (active.actionSpec) {
          clientSeqRef.current += 1;
          const envelope = buildActionEnvelope({
            sessionId,
            type: 'data:submit',
            payload: transformedData as JsonValue,
            stackIndex: active.stackIndex,
            ...(active.stackItemId ? { stackItemId: active.stackItemId } : {}),
            clientSeq: clientSeqRef.current,
          });
          const result = validateOutboundActionEnvelope(active.actionSpec, envelope);
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
    [sessionId, resolveActiveStack, emitTyped, emitEnvelope],
  );

  // NOTE: The legacy `invoke(text)` method was retired with the v1.1
  // Streamable Invoke Protocol cutover. User text messages now go through
  // `useInvoke().send` at the consumer layer.

  const api = useMemo<SessionApi>(
    () => ({
      action,
      connectionStatus,
      stack,
    }),
    [action, connectionStatus, stack]
  );

  return <>{typeof children === 'function' ? children(api) : children}</>;
}
