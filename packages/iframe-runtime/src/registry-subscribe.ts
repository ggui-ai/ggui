/**
 * Registry-driven subscribe orchestration — owns the renderer's
 * "I have a parsed session-meta, now drive the live-channel handshake
 * to first ack" flow on top of `ChannelRegistry.bind()`.
 *
 * Replaces the pre-B3b `subscribe()` helper + the `RendererWebSocketManager`
 * lifecycle class. The two retired modules paired a hand-rolled WS
 * manager with a separate handshake helper; B3b unifies both behind
 * the `@ggui-ai/live-channel` library so every WS frame type (push,
 * data, props_update, drain_ack, channel_payload, channel_error,
 * system, feedback) flows through one registry-owned transport.
 *
 * Composition:
 *
 *   1. Caller-supplied `ChannelRegistry` (populated by `runtime.ts`'s
 *      triad-wiring `setup()` with every handler the iframe routes).
 *   2. Compose the WS URL with the WS auth token threaded as a
 *      `?wsToken=<encoded>` query string (mirrors the pre-B3b
 *      `composeWsUrl` shape so server-side upgrade-path auth keeps
 *      working).
 *   3. Register `ack` + `error` handlers on the registry BEFORE bind
 *      so the first inbound frame after socket open hits the
 *      handshake-resolver closure.
 *   4. Call `registry.bind({bootstrap, onStatusChange})` and capture
 *      the returned typed `WsTransportHandle` (narrow on
 *      `handle.kind === 'ws'`). The live-channel's `bootstrap`
 *      argument is its own internal name; the field on the wire is
 *      `wsToken`.
 *
 * The handshake resolves on the first `ack` (with the symmetric
 * `CLIENT_SUPPORTED_VERSIONS` check) or rejects on:
 *   - `UpgradeRequiredError` (pre-ack `error` with code UPGRADE_REQUIRED
 *     OR ack carrying an unrecognised `serverVersion`)
 *   - Plain `Error(payload.message)` (other pre-ack errors — typed
 *     ProtocolError emitted in parallel)
 *   - Plain `Error('subscribe-failed: transport went to failed state
 *     before ack')` when the transport status transitions to `'failed'`
 *     pre-ack.
 *
 * No timeout is enforced here — the runtime owns the visible "still
 * connecting…" UX and decides when to give up. Surface this module is
 * deliberately thin so the runtime can layer policy on top.
 */
import { CLIENT_SUPPORTED_VERSIONS, UPGRADE_REQUIRED } from '@ggui-ai/protocol/version';
import { UpgradeRequiredError } from '@ggui-ai/protocol/errors/version-mismatch';
import type {
  AckPayload,
  ContractErrorPayload,
} from '@ggui-ai/protocol';
import type { ConnectionStatus } from '@ggui-ai/protocol/transport/websocket';
import type { McpAppAiGguiSessionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  ChannelRegistry,
  TransportStatus,
  WsTransportHandle,
} from '@ggui-ai/live-channel';
import {
  fromAuthFailure,
  fromTransportFailure,
  fromUpgradeRequired,
  type ProtocolErrorEmitter,
} from './protocol-error.js';
import type { ObservabilityEmitter } from './observability.js';

/**
 * Result of a successful handshake — the live typed transport handle
 * plus the resolved `AckPayload` from the first ack frame. The caller
 * attaches `handle` to the triad's outbound send surface (via the
 * BufferedManagerShim flush) and applies `ack.stack` to the stack
 * model.
 */
export interface RegistrySubscribeHandle {
  readonly handle: WsTransportHandle;
  readonly ack: AckPayload;
}

/**
 * Caller-provided callbacks. The runtime's `bootSequence` owns the
 * concrete implementations; tests pass mocks via the `connectFn` seam.
 */
export interface ConnectViaRegistryOptions {
  /**
   * Session slice (`McpAppAiGguiSessionMeta`) — the live-channel
   * credentials this subscribe path actually needs: `sessionId`,
   * `appId`, `wsUrl`, `wsToken`. The stack-item slice is not consulted
   * here (it's load-bearing only for the renderer / mount layer).
   */
  readonly session: McpAppAiGguiSessionMeta;
  readonly registry: ChannelRegistry;
  /**
   * Fires on every transport-status transition mapped onto the
   * protocol-level `ConnectionStatus` axis. The mapping is:
   *
   *   - First `'connecting'` after construction → `'connecting'`.
   *   - First `'open'` → `'connected'`.
   *   - `'closed'` after a prior `'open'` (drop) → `'disconnected'`.
   *   - `'connecting'` after a prior `'open'` (reconnect attempt) →
   *     `'reconnecting'`.
   *   - `'failed'` → `'disconnected'` (terminal — the reconnect ladder
   *     gave up). Also rejects the handshake promise pre-ack.
   *
   * The mapping is load-bearing for the renderer's status DOM logic
   * (which already keyed off `ConnectionStatus`) and the
   * `subscribe-failed` observability emission rule (fires on
   * `'reconnecting'` only).
   */
  readonly onStatusChange: (status: ConnectionStatus) => void;
  /**
   * Optional typed {@link ProtocolError} sink. Pre-ack `error`
   * frames are classified through this emitter in parallel with the
   * throw/reject path.
   */
  readonly onProtocolError?: ProtocolErrorEmitter;
  /**
   * Optional {@link ObservabilityEmitter} sink. Two events flow:
   *
   *   - `schema-version-mismatch` — on every UPGRADE_REQUIRED
   *     classification (client-side ack-mismatch + server-emitted
   *     error frame).
   *   - `subscribe-failed` — on non-terminal transport status
   *     transitions to `'reconnecting'`. Terminal failures route
   *     through the ProtocolError path only.
   */
  readonly onObserve?: ObservabilityEmitter;
  /**
   * Optional post-handshake ack callback. Fires for every ack frame
   * AFTER the initial handshake settled — i.e. on every reconnect's
   * subscribe ack. The runtime uses this to reapply the server's
   * authoritative `stack` snapshot so a push or update that landed
   * during a WS dropout window flows back into the iframe on
   * reconnect.
   *
   * Idempotent at the runtime layer: `stackModel.setAll(ack.stack)`
   * is a snapshot replace. Channels re-subscribed by
   * `ChannelTransportRouter.onWsStatusChange('connected')` upstream
   * of this callback, so the per-channel transport state is already
   * coherent by the time the resubscribe-ack arrives.
   */
  readonly onResubscribeAck?: (ack: AckPayload) => void;
}

/**
 * Compose the WebSocket URL with the WS auth token threaded as a
 * query parameter. Servers that authenticate the upgrade path read
 * the token from here; the same value also rides inside the subscribe
 * payload so server-side handlers that consume credentials on the
 * subscribe frame see it too.
 */
function composeWsUrl(base: string, wsToken: string): string {
  const sep = base.indexOf('?') >= 0 ? '&' : '?';
  return `${base}${sep}wsToken=${encodeURIComponent(wsToken)}`;
}

/**
 * Lift a server-emitted `{type:'error'}` frame into the appropriate
 * Error subclass. Returns `null` for a frame whose code is not
 * UPGRADE_REQUIRED — the caller decides how to surface non-upgrade
 * errors (typically a plain `Error` with the server's message).
 */
function liftUpgradeRequiredFromError(payload: {
  readonly code: string;
  readonly message?: string;
  readonly details?: unknown;
}): UpgradeRequiredError | null {
  if (payload.code !== UPGRADE_REQUIRED) return null;
  const details = payload.details;
  let observedVersion: string | undefined;
  if (
    details !== null &&
    typeof details === 'object' &&
    !Array.isArray(details) &&
    typeof (details as { serverVersion?: unknown }).serverVersion === 'string'
  ) {
    observedVersion = (details as { serverVersion: string }).serverVersion;
  }
  return new UpgradeRequiredError({
    ...(observedVersion !== undefined ? { observedVersion } : {}),
    acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
    observedBy: 'server',
  });
}

/**
 * Collapse the `UpgradeRequiredError.observedVersion` variant
 * (`string | readonly string[] | undefined`) onto the single string
 * shape that `SchemaVersionMismatchEvent.observedVersion` carries.
 * Undefined falls back to the sentinel `'unknown'` so hosts always
 * have a rendered value.
 */
function normalizeObservedVersion(
  value: string | readonly string[] | undefined,
): string {
  if (value === undefined) return 'unknown';
  if (typeof value === 'string') return value;
  return value.join(', ');
}

/**
 * Map a pre-ack `error` frame onto a non-UPGRADE_REQUIRED ProtocolError.
 * `SESSION_NOT_FOUND` / `AUTH_REJECTED` → `'auth'`; every other code
 * → `'protocol'` with the extensibly-closed tail carrying the wire code
 * verbatim.
 */
function classifyPreAckError(payload: {
  readonly code: string;
  readonly message?: string;
  readonly details?: unknown;
}): import('./protocol-error.js').ProtocolError {
  if (payload.code === 'SESSION_NOT_FOUND' || payload.code === 'AUTH_REJECTED') {
    return fromAuthFailure(payload.code, payload.message);
  }
  if (payload.code === 'TOKEN_EXPIRED') {
    return fromAuthFailure('TOKEN_EXPIRED', payload.message);
  }
  return {
    kind: 'protocol',
    code: payload.code,
    ...(payload.message !== undefined ? { message: payload.message } : {}),
    ...(payload.details !== undefined ? { details: payload.details } : {}),
  };
}

/**
 * Open the WS via the registry, send subscribe (composed by the
 * registry's `subscribeFrameBuilder`), await the first `ack`. Resolves
 * with `{ handle, ack }` on success; rejects with
 * `UpgradeRequiredError` on a version-handshake failure (either side);
 * rejects with a plain `Error` on any other server-emitted pre-ack
 * error.
 *
 * Once the promise settles, subsequent server frames flow through the
 * registered channel handlers (props_update, drain_ack, push, data,
 * etc.) — there is no longer a separate `onMessage` callback fanning
 * frames across multiple handler chains.
 */
export function connectViaRegistry(
  opts: ConnectViaRegistryOptions,
): Promise<RegistrySubscribeHandle> {
  return new Promise<RegistrySubscribeHandle>((resolve, reject) => {
    let receivedAck = false;
    let settled = false;
    let seenOpen = false;

    const emitProtocolError: ProtocolErrorEmitter =
      opts.onProtocolError ?? (() => {});
    const emitObserve: ObservabilityEmitter = opts.onObserve ?? (() => {});

    // Defense-in-depth — live mode requires both wsUrl + wsToken. The
    // caller validates this before invoking; reject early with a
    // typed transport failure if either is missing.
    const wsUrl = opts.session.wsUrl;
    const wsToken = opts.session.wsToken;
    if (typeof wsUrl !== 'string' || wsUrl.length === 0 ||
        typeof wsToken !== 'string' || wsToken.length === 0) {
      const err = new Error(
        'connectViaRegistry: session-meta missing wsUrl/wsToken — live-mode required',
      );
      emitProtocolError(fromTransportFailure('DISCONNECTED', false, err.message));
      reject(err);
      return;
    }

    // Register `ack` + `error` handlers BEFORE bind so the first
    // inbound frame after socket open hits the handshake-resolver
    // closure. The registry guards against double-registration; the
    // caller must NOT have pre-registered handlers of these types.
    opts.registry.register({
      type: 'ack',
      onMessage: (payload) => {
        const ack = payload as AckPayload;
        // Post-handshake ack — the WS reconnected and the server
        // re-sent the subscribe ack with a fresh `stack` snapshot.
        // Fan it onto the caller's resubscribe callback so the
        // runtime can reapply the authoritative stack (a push or
        // update that landed during the WS dropout window now
        // restores). Skip the version handshake / settle bookkeeping
        // — that already fired on the original ack.
        if (settled) {
          opts.onResubscribeAck?.(ack);
          return;
        }
        const serverVersion = ack.serverVersion;
        if (
          typeof serverVersion === 'string' &&
          !CLIENT_SUPPORTED_VERSIONS.includes(serverVersion)
        ) {
          settled = true;
          receivedAck = true;
          const upgradeErr = new UpgradeRequiredError({
            observedVersion: serverVersion,
            acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
            observedBy: 'client',
          });
          emitProtocolError(fromUpgradeRequired(upgradeErr));
          emitObserve({
            kind: 'schema-version-mismatch',
            observedVersion: serverVersion,
            acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
            observedBy: 'client',
          });
          reject(upgradeErr);
          return;
        }
        settled = true;
        receivedAck = true;
        // Resolution is deferred — the typed handle is set by the
        // `bind()` resolution path below. We just record the ack and
        // let the bind continuation finish wiring.
        ackResolverState.payload = ack;
        ackResolverState.onAck?.();
      },
    });

    opts.registry.register({
      type: 'error',
      onMessage: (payload) => {
        // Post-ack error frames are NOT handled here — the runtime
        // doesn't currently route post-ack `error` frames through a
        // registered handler (they used to surface via the legacy
        // `onMessage` callback; B3b drops that channel since
        // post-ack errors are rare + the host inspector logs them
        // through the typed ProtocolError emitter).
        if (settled) return;
        const errPayload = payload as {
          readonly code: string;
          readonly message?: string;
          readonly details?: unknown;
        };
        const upgrade = liftUpgradeRequiredFromError(errPayload);
        if (upgrade !== null) {
          settled = true;
          emitProtocolError(fromUpgradeRequired(upgrade));
          emitObserve({
            kind: 'schema-version-mismatch',
            observedVersion: normalizeObservedVersion(upgrade.observedVersion),
            acceptedVersions: upgrade.acceptedVersions,
            observedBy: 'server',
          });
          reject(upgrade);
          return;
        }
        settled = true;
        emitProtocolError(classifyPreAckError(errPayload));
        reject(new Error(errPayload.message ?? errPayload.code));
      },
    });

    // Captured-state closure so the ack handler can hand the resolved
    // payload to the bind continuation without sharing a mutable
    // local with the outer Promise body.
    const ackResolverState: {
      payload: AckPayload | null;
      onAck: (() => void) | null;
    } = { payload: null, onAck: null };

    const mappedStatusCallback = (status: TransportStatus): void => {
      // `connecting` is the initial state from WSTransport — first
      // surfaced concurrent with `start()`. Subsequent `connecting`
      // transitions mean the reconnect ladder is firing (after a
      // prior `open` → `closed`).
      if (status === 'connecting') {
        if (!seenOpen) {
          opts.onStatusChange('connecting');
        } else {
          opts.onStatusChange('reconnecting');
          emitObserve({
            kind: 'subscribe-failed',
            reason: 'transport-reconnecting',
            message: 'renderer WebSocket dropped; reconnect ladder running',
          });
        }
        return;
      }
      if (status === 'open') {
        seenOpen = true;
        opts.onStatusChange('connected');
        return;
      }
      if (status === 'closed') {
        // Graceful close — propagate as `disconnected` so the status
        // DOM reflects the drop. WSTransport will fire `connecting`
        // again on its reconnect path; we don't pre-empt.
        opts.onStatusChange('disconnected');
        return;
      }
      // `failed` — terminal. Map to `disconnected` for the
      // protocol-level status; reject the handshake if we never
      // saw an ack so callers don't hang on a dead transport.
      opts.onStatusChange('disconnected');
      emitProtocolError(
        fromTransportFailure(
          'DISCONNECTED',
          false,
          'transport went to failed state',
        ),
      );
      if (!settled && !receivedAck) {
        settled = true;
        reject(
          new Error(
            'connectViaRegistry: transport went to failed state before ack',
          ),
        );
      }
    };

    const composedUrl = composeWsUrl(wsUrl, wsToken);

    // `bind()` selects the transport (WS for wsUrl+wsToken sessions;
    // the live-channel narrows on its `bootstrap` shape) and starts
    // it. We override `session.wsUrl` with the composed URL so the
    // registry's WS transport gets the wsToken-threaded variant. The
    // live-channel's `bootstrap` arg is its internal name; the field
    // on the wire is `wsToken`.
    void opts.registry
      .bind({
        bootstrap: {
          wsUrl: composedUrl,
          wsToken,
          sessionId: opts.session.sessionId,
          appId: opts.session.appId,
        },
        onStatusChange: mappedStatusCallback,
      })
      .then((bound) => {
        // bound is `AnyTransportHandle`. Composed URL + wsToken means
        // the registry selected WSTransport — `kind === 'ws'` is the
        // structural invariant. Narrow defensively.
        if (bound.kind !== 'ws') {
          if (!settled) {
            settled = true;
            reject(
              new Error(
                "connectViaRegistry: registry returned non-ws transport despite wsUrl+wsToken session-meta",
              ),
            );
          }
          return;
        }
        const wsHandle = bound;
        // If we already received the ack while bind was resolving,
        // settle the outer Promise now.
        if (ackResolverState.payload !== null) {
          resolve({ handle: wsHandle, ack: ackResolverState.payload });
          return;
        }
        // Otherwise wire the ack handler's continuation so it
        // resolves with the handle when the first ack lands.
        ackResolverState.onAck = () => {
          const ack = ackResolverState.payload;
          if (ack !== null) {
            resolve({ handle: wsHandle, ack });
          }
        };
      })
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        const message = err instanceof Error ? err.message : String(err);
        emitProtocolError(fromTransportFailure('DISCONNECTED', false, message));
        reject(err instanceof Error ? err : new Error(message));
      });
  });
}

/**
 * Default `connectFn` seam — tests can swap this for a fake to drive
 * the handshake without a real WebSocket. The renderer's `bootSequence`
 * accepts an optional override via the `BootSequenceOptions.connectFn`
 * field; the default below points back at this module's
 * `connectViaRegistry` export.
 */
export type ConnectFn = typeof connectViaRegistry;

/**
 * Type re-export for callers that want to thread the handle type
 * through their own seams (e.g. `bootSequence`'s shim attach).
 */
export type { WsTransportHandle, ContractErrorPayload };
