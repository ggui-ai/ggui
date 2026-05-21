import { useEffect, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ConnectionStatus, WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type { ActionEnvelope, ActionSpec, EventType, ReservedChannelValidator, SessionStackEntry, StreamEnvelope, StreamPayload, ProgressPayload, SystemPayload, JsonValue, JsonObject } from '@ggui-ai/protocol';
import { BRIDGE_EVENTS, CLIENT_SUPPORTED_VERSIONS, UpgradeRequiredError } from '@ggui-ai/protocol';
import {
  buildActionEnvelope,
  ClientContractViolationError,
  GguiWireProvider,
  validateInboundPropsPayload,
  validateInboundStreamPayload,
  validateOutboundActionEnvelope,
  type LegacyScopableWireConfig,
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
 * Minimal session metadata passed to lifecycle callbacks.
 */
export interface SessionInfo {
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
  // that didn't wire onError don't see the session blow up on a
  // single bad event.
  // eslint-disable-next-line no-console
  console.warn('[ggui:contract] ' + err.message, {
    direction: err.direction,
    violations: err.violations,
  });
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
   *
   * Pass `new Map()` (explicitly empty) to DISABLE the A2UI default —
   * useful for test harnesses that need the pre-Item-4 permissive
   * behavior on the preview channel.
   */
  extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>;

  children: ReactNode | ((api: SessionApi) => ReactNode);
}

/**
 * API object exposed to child render functions of {@link GguiSession}.
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
 * `useInvoke().send()` at the consumer layer and are threaded into shells
 * via `activeSession.send` on `ShellContext` — not through this object.
 */
/**
 * Minimal context passed to {@link GguiSessionProps.onBeforeAction}.
 * Only fields real consumers use; the legacy `EventContext` diagnostic
 * bag (deviceInfo / interfaceContext / user) was dropped when the
 * emitter migrated to canonical {@link ActionEnvelope} — those fields
 * live on the session, not per-delivery.
 */
export interface ActionMeta {
  sessionId: string;
  stackIndex: number;
}

export interface SessionApi {
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

  /** Current session stack (populated from ack on subscribe and updated on push). */
  stack: SessionStackEntry[];

  /** Session ID. */
  sessionId: string;
}

/**
 * Manages a single ggui session lifecycle.
 *
 * Opens a WebSocket connection (if `wsEndpoint` is set on the provider),
 * subscribes to the session, and handles incoming server messages (push,
 * progress, data, stream, error). Exposes a {@link SessionApi} via render
 * props or provides it implicitly to child components.
 *
 * @example
 * ```tsx
 * // User text messages flow through `useInvoke()` at the consumer layer.
 * // `GguiSession` exposes stack + action + raw-send via its render prop.
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
  const { appId, wsEndpoint, auth, appMetadata, appConfig } = useGguiContext();
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
  // semantics on key conflict. Ref keeps a stable handle so the
  // inbound-frame handler reads the composed map without widening
  // its deps.
  const reservedValidators = useMemo(
    () => mergeReservedValidators(composePreviewReservedValidator(), extraReservedValidators),
    [extraReservedValidators],
  );
  const reservedValidatorsRef = useRef(reservedValidators);
  reservedValidatorsRef.current = reservedValidators;

  // Always-current stack ref — wire dispatch reads this to look up active contract
  // without forcing wireConfig re-creation on every push.
  const stackRef = useRef<SessionStackEntry[]>(stack);
  stackRef.current = stack;

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
          // SessionChannelOptions). Defensive: treat the details
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
        // Subscribe response — populate initial stack
        if (message.payload.stack) {
          setStack(message.payload.stack);
        }
      }
      if (message.type === 'push') {
        const { stackItem, matchType } = message.payload;
        if (stackItem) {
          setStack((prev) => {
            // Replace existing item with same ID, or append
            const idx = prev.findIndex((item) => item.id === stackItem.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = stackItem;
              return next;
            }
            return [...prev, stackItem];
          });
          onStackPushRef.current?.(stackItem);
          // Forward matchType info as a synthetic progress event
          if (matchType) {
            const isHit = matchType === 'cached' || matchType === 'predefined' || matchType === 'exact';
            onProgressRef.current?.({
              sessionId: '',
              stackItemId: stackItem.id,
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
          // (e.g. stack popped between emit and receipt, or a
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
        // ggui_update: replace props on an existing stack item (no re-generation)
        const { stackItemId, props } = message.payload as { stackItemId: string; props: JsonObject };
        if (stackItemId && props) {
          // Defense-in-depth: server already validates props via
          // assertPropsContract on the ggui_update path; the client
          // re-checks against the target item's cached propsSpec to
          // catch spec-versioning drift before applying to React state.
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
              // `props` belongs to the component variant only; MCP
              // Apps items have no props and aren't targeted by
              // props_update frames.
              if (item.type === 'mcpApps' || item.type === 'system') return item;
              return { ...item, props } as SessionStackEntry;
            }),
          );
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
   * Resolve the stack item an emission should target. Prefers the top
   * of the stack (where the agent last pushed); falls back to index 0
   * for an empty stack so callers get a stable numeric index regardless
   * of timing. The resolved item's id (`stackItemId`) and actionSpec are
   * used for contract validation + envelope routing.
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
   *
   * `ctx.tool` (from the spec's `ActionEntry.tool`) is surfaced on the
   * envelope payload alongside `{action, data}` so the agent can
   * dispatch directly to the MCP tool without a contract round-trip.
   */
  const dispatchAction = useCallback(
    (
      actionName: string,
      data: unknown,
      ctx: {
        stackItemId?: string;
        stackIndex: number;
        tool?: string;
        actionSpec?: ActionSpec;
      },
    ) => {
      clientSeqRef.current += 1;
      const envelope = buildActionEnvelope({
        sessionId,
        type: 'data:submit',
        payload: {
          action: actionName,
          data: data as JsonValue,
          ...(ctx.tool ? { tool: ctx.tool } : {}),
        },
        stackIndex: ctx.stackIndex,
        ...(ctx.stackItemId ? { stackItemId: ctx.stackItemId } : {}),
        clientSeq: clientSeqRef.current,
      });
      const result = validateOutboundActionEnvelope(ctx.actionSpec, envelope);
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

  // Reset stack when sessionId changes
  useEffect(() => {
    setStack([]);
    onSessionStartRef.current?.({ sessionId });

    return () => {
      onSessionEndRef.current?.({ sessionId }, 'unmount');
    };
  }, [sessionId]);

  // Action handler with middleware (component interactions → agent).
  // Builds a canonical data:submit ActionEnvelope via the shared
  // emitter; onBeforeAction runs first and can transform/cancel the
  // payload before validation + send.
  const action = useCallback(
    <T,>(data: T) => {
      try {
        const active = resolveActiveStack();
        const meta: ActionMeta = { sessionId, stackIndex: active.stackIndex };

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
    [sessionId, resolveActiveStack, emitTyped]
  );

  // NOTE: The legacy `invoke(text)` method was retired with the v1.1
  // Streamable Invoke Protocol cutover (the `type: 'invoke'` WS route's
  // server handler was deleted). User text messages now go through
  // `useInvoke().send` at the consumer layer.

  const api = useMemo<SessionApi>(
    () => ({
      action,
      send,
      connectionStatus,
      stack,
      sessionId,
    }),
    [action, send, connectionStatus, stack, sessionId]
  );

  const wireConfig = useMemo<WireConfig>(() => ({
    app: {
      appId,
      appName: appMetadata?.appName ?? appId,
      appDescription: appMetadata?.appDescription,
      appIcon: appMetadata?.appIcon,
    },
    session: {
      sessionId,
      isConnected: connectionStatus === 'connected',
    },
    auth: {
      userId: auth?.userId,
      isAuthenticated: auth?.isAuthenticated ?? false,
    },
    // Default dispatch — used when no scope is set. Resolves binding from top of stack.
    // Note: StackItemRenderer wraps each card in a scoped wire (via `scope()` below)
    // so this default path is rarely hit in practice. It's the fallback for
    // standalone components not rendered through StackItemRenderer.
    dispatch: (actionName: string, data: unknown) => {
      const currentStack = stackRef.current;
      const activeItem = currentStack[currentStack.length - 1];
      const activeIndex = currentStack.length > 0 ? currentStack.length - 1 : 0;
      // McpApps + system items have no actionSpec — narrow before reading.
      const activeActionSpec =
        activeItem !== undefined &&
        activeItem.type !== 'mcpApps' &&
        activeItem.type !== 'system'
          ? activeItem.actionSpec
          : undefined;
      const entry = activeActionSpec?.[actionName];
      // Every action is agent-routed. The optional `nextStep` field on
      // the action entry names the tool the agent SHOULD invoke on its
      // next turn — surfaced here as advisory metadata for downstream
      // telemetry / dev console.
      const tool = entry?.nextStep;

      dispatchAction(actionName, data, {
        stackItemId: activeItem?.id,
        stackIndex: activeIndex,
        tool,
        actionSpec: activeActionSpec,
      });
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
  }), [appId, sessionId, connectionStatus, auth, appMetadata, appConfig, wsEndpoint, dispatchAction, send]);

  // Attach `scope()` factory after wireConfig is built — avoids circular self-reference.
  // Per-stack-item WireConfig so each rendered card emits actions tagged with its OWN
  // stackItemId/tool — not the top of stack. This prevents wrong-tool
  // dispatch in stacked / chat-style UIs.
  //
  // The `.scope(item)` method lives on `LegacyScopableWireConfig` and
  // is retired alongside `<GguiSession>` itself. In the renderer-iframe
  // model the iframe owns scoping; `<GguiSession>` is a legacy
  // component kept during the migration overlap. The runtime shape is
  // unchanged — only the interface that types it.
  const wireConfigWithScope = useMemo<LegacyScopableWireConfig>(() => {
    // Self-reference is factored out so the inner `scope()` return can
    // carry `.scope` too — `LegacyScopableWireConfig` is recursive on
    // its own return type by design.
    const buildScopedFor = (
      item: { stackItemId?: string; contractHash?: string; actionSpec?: import('@ggui-ai/protocol').ActionSpec },
    ): LegacyScopableWireConfig => ({
      ...wireConfig,
      dispatch: (actionName: string, data: unknown) => {
        const entry = item.actionSpec?.[actionName];
        const tool = entry?.nextStep;
        const currentStack = stackRef.current;
        const stackIdx = currentStack.findIndex((s) => s.id === item.stackItemId);
        dispatchAction(actionName, data, {
          stackItemId: item.stackItemId,
          stackIndex: stackIdx >= 0 ? stackIdx : 0,
          tool,
          actionSpec: item.actionSpec,
        });
      },
      scope: buildScopedFor,
    });
    return {
      ...wireConfig,
      scope: buildScopedFor,
    };
  }, [wireConfig, dispatchAction]);

  return (
    <GguiWireProvider config={wireConfigWithScope}>
      {typeof children === 'function' ? children(api) : children}
    </GguiWireProvider>
  );
}
