/**
 * The view's live channel across credentials (ggui#1496 part B, R3).
 *
 * A LADDER is one registry bound with one credential: WS → SSE → HTTP
 * polling → bridge. The boot binds the first; when the view adopts a
 * refreshed credential, a new ladder is built beside the old one, and this
 * module owns the hand-over:
 *
 * - **Data.** The new ladder becomes the data holder when it starts reading
 *   from the resume point: its WS subscribe (which carries `fromSeq`, the
 *   view's stream cursor), its SSE open, or its first polling or bridge
 *   read of the shared ledger cursor. From then on the old ladder's
 *   deliveries drop, and its writes to the ledger cursor are no-ops
 *   (rev 2.1), so every ledger event after the resume point is applied
 *   once, by whichever ladder carries it. A lagging old ladder can
 *   therefore never overwrite the new ack's snapshot with older props.
 *   Stream envelopes are also deduped on their `seq` by the `data` handler.
 * - **Status and send** follow the ACTIVE ladder. It switches at the new
 *   ladder's first token-rung acceptance (a WS or SSE ack, or a polling
 *   `ok`), or when the new ladder reaches its bridge rung. The old ladder
 *   is disposed at that switch, so only one bridge loop runs at a time.
 * - **Expiry** is reported to the credential controller from three places:
 *   a WS `BOOTSTRAP_EXPIRED` frame (the only auth code that triggers), the
 *   first polling `410` whose body is not a replay horizon, and entering
 *   the bridge rung while the ladder's credential is past `expiresAt`. An
 *   adopted credential builds the next ladder.
 *
 * A new ladder omits WS when the one it replaces left WS without ever
 * receiving a frame (the never-opened fail-fast): a jailed socket would
 * only fail again.
 */
import { ChannelRegistry } from '@ggui-ai/live-channel';
import type {
  AnyTransportHandle,
  ChannelFrame,
  ChannelHandler,
  ChannelLogger,
  FrameClassifier,
  RegistryPollingOptions,
  RegistrySseOptions,
  WsTransportHandle,
} from '@ggui-ai/live-channel';
import type { AckPayload } from '@ggui-ai/protocol/wire';
import type { ConnectionStatus } from '@ggui-ai/protocol/transport/websocket';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { CredentialController, ExpirySource, RefreshOutcome } from './credential-controller.js';
import {
  buildBridgePolling,
  buildEventsPolling,
  type BuildBridgePollingOptions,
  type SequenceCursor,
} from './events-polling.js';
import {
  classifyChannelFrame,
  type ConnectFn,
  type ConnectViaRegistryOptions,
  type RegistrySubscribeHandle,
} from './registry-subscribe.js';
import type { StreamSeqTracker } from './stream-seq.js';
import type { HeldCredential } from './types.js';
import type { ObservabilityEmitter } from './observability.js';
import type { ProtocolErrorEmitter } from './protocol-error.js';

/** What one ladder is bound with. */
export interface LadderSpec {
  /** The credential its token-bearing rungs carry; `undefined` on a trio-less bind. */
  readonly credential: HeldCredential | undefined;
  readonly sseUrl: string | undefined;
  readonly pollingUrl: string | undefined;
}

export interface LadderSetOptions {
  /** The boot meta: identity (`sessionId`, `appId`) and the slice fields `connectFn` passes through. */
  readonly meta: McpAppAiGguiRenderMeta;
  /** The handlers every ladder delivers through, shared by all of them. */
  readonly handlers: readonly ChannelHandler[];
  /** The shared ledger cursor; `undefined` when the view has no fallback rung. */
  readonly cursor: SequenceCursor | undefined;
  /** The view's stream cursor, read into a rebuilt ladder's `fromSeq`. */
  readonly streamSeq: StreamSeqTracker | undefined;
  readonly controller: CredentialController | null;
  readonly connectFn: ConnectFn;
  /** The host relay the bridge rung pulls through; `undefined` → no bridge rung. */
  readonly bridgeCallTool: BuildBridgePollingOptions['callTool'] | undefined;
  /** Status of the ACTIVE ladder. */
  readonly onStatus: (status: ConnectionStatus) => void;
  /** Every ack after the boot's first one, from the ladder holding data (a re-snapshot to apply). */
  readonly onAck: (ack: AckPayload) => void;
  /** Each refresh a ladder asked for, and what it got. */
  readonly onRefresh?: (source: ExpirySource, outcome: RefreshOutcome) => void;
  readonly logger?: ChannelLogger;
  readonly onProtocolError?: ProtocolErrorEmitter;
  readonly onObserve?: ObservabilityEmitter;
  /** Test seams, passed to every ladder's registry. */
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly eventSourceFactory?: (url: string) => EventSource;
  readonly fetchImpl?: typeof fetch;
  /** Test seam for the bridge-entry expiry check. */
  readonly now?: () => number;
}

export interface LadderSet {
  /** Bind the boot ladder. The caller handles its first ack, or its refusal. */
  connectBoot(spec: LadderSpec): Promise<RegistrySubscribeHandle>;
  /**
   * The boot ladder's first refresh, when it reported an expiry; `undefined`
   * when it reported none. A WS frame is classified in the same task that
   * dispatches it, so a `BOOTSTRAP_EXPIRED` refusal has already asked for its
   * refresh by the time `connectBoot` resolves with it.
   */
  bootRefresh(): Promise<RefreshOutcome> | undefined;
  /** Send on the active ladder's WS, when it has one. */
  send(msg: Parameters<WsTransportHandle['send']>[0]): void;
}

/** One ladder's state; the closures its registry is built with read and write it. */
interface LadderState {
  readonly id: number;
  readonly spec: LadderSpec;
  readonly rebuilt: boolean;
  readonly hasWs: boolean;
  handle: AnyTransportHandle | undefined;
  disposed: boolean;
  wsFrameSeen: boolean;
  bridgeEntered: boolean;
  polling410Seen: boolean;
  lastStatus: ConnectionStatus | undefined;
  /** The first refresh this ladder asked for, when it reported an expiry. */
  refresh: Promise<RefreshOutcome> | undefined;
}

interface Ladder extends LadderState {
  readonly registry: ChannelRegistry;
}

const REPLAY_HORIZON_PASSED = 'REPLAY_HORIZON_PASSED';

function errorCodeOf(frame: ChannelFrame): string | undefined {
  if (frame.type !== 'error') return undefined;
  const payload: unknown = frame.payload;
  if (typeof payload !== 'object' || payload === null) return undefined;
  const code = Reflect.get(payload, 'code');
  return typeof code === 'string' ? code : undefined;
}

/** Whether a 410 body is the ledger's replay-horizon answer (read from a clone, so the transport's own read is untouched). */
async function isReplayHorizon(response: Response): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await response.text());
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      Reflect.get(parsed, 'reason') === REPLAY_HORIZON_PASSED
    );
  } catch {
    // Not JSON: the expired-token answer is plain text.
    return false;
  }
}

export function createLadderSet(opts: LadderSetOptions): LadderSet {
  const now = opts.now ?? Date.now;
  const baseFetch = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  let nextId = 0;
  const built = new Map<LadderState, Ladder>();
  let ladders: LadderState[] = [];
  let active: Ladder | undefined;
  let holder: LadderState | undefined;
  let newest: LadderState | undefined;

  /** The newest ladder takes the data when it starts reading from the resume point. */
  const claim = (ladder: LadderState): void => {
    if (ladder.rebuilt && ladder === newest && holder !== ladder && !ladder.disposed) holder = ladder;
  };

  /** Hand status, send and data to `ladder`, and dispose every other one. */
  const switchTo = (state: LadderState): void => {
    const ladder = built.get(state);
    if (ladder === undefined || active === ladder || ladder.disposed) return;
    const others = ladders.filter((l) => l !== ladder);
    ladders = [ladder];
    active = ladder;
    holder = ladder;
    for (const old of others) {
      old.disposed = true;
      if (old.handle !== undefined) void old.handle.dispose();
    }
    if (ladder.lastStatus !== undefined) opts.onStatus(ladder.lastStatus);
  };

  const accept = (ladder: LadderState): void => {
    if (ladder.disposed) return;
    if (ladder.spec.credential !== undefined) opts.controller?.markAccepted(ladder.spec.credential);
    switchTo(ladder);
  };

  const onAck = (ladder: LadderState, ack: AckPayload): void => {
    accept(ladder);
    if (holder === ladder) opts.onAck(ack);
  };

  const reportExpired = async (ladder: LadderState, source: ExpirySource): Promise<void> => {
    const credential = ladder.spec.credential;
    const controller = opts.controller;
    if (controller === null || credential === undefined || ladder.disposed) return;
    const pending = controller.onExpired(credential, source);
    if (ladder.refresh === undefined) ladder.refresh = pending;
    const outcome = await pending;
    opts.onRefresh?.(source, outcome);
    if (outcome.kind === 'adopted') rebind(ladder, outcome.credential, source);
  };

  const build = (spec: LadderSpec, rebuilt: boolean, omitWs: boolean): Ladder => {
    const hasWs = spec.credential !== undefined && !omitWs;
    const ladder: LadderState = {
      id: nextId++,
      spec,
      rebuilt,
      hasWs,
      handle: undefined,
      disposed: false,
      wsFrameSeen: false,
      bridgeEntered: false,
      polling410Seen: false,
      lastStatus: undefined,
      refresh: undefined,
    };
    const classifyFrame: FrameClassifier = (frame) => {
      ladder.wsFrameSeen = true;
      if (errorCodeOf(frame) === 'BOOTSTRAP_EXPIRED') void reportExpired(ladder, 'ws');
      return classifyChannelFrame(frame);
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (response.ok) {
        accept(ladder);
      } else if (response.status === 410 && !ladder.polling410Seen) {
        ladder.polling410Seen = true;
        if (!(await isReplayHorizon(response.clone()))) void reportExpired(ladder, 'polling');
      }
      return response;
    };
    const registry = new ChannelRegistry({
      subscribeFrameBuilder: () => {
        claim(ladder);
        const wsToken = ladder.spec.credential?.wsToken;
        const fromSeq = ladder.rebuilt ? opts.streamSeq?.last() : undefined;
        return {
          type: 'subscribe',
          payload: {
            sessionId: opts.meta.sessionId,
            appId: opts.meta.appId,
            ...(wsToken !== undefined ? { wsToken } : {}),
            ...(fromSeq !== undefined ? { fromSeq } : {}),
          },
        };
      },
      classifyFrame,
      fetchImpl,
      ...(opts.webSocketFactory !== undefined ? { webSocketFactory: opts.webSocketFactory } : {}),
      ...(opts.eventSourceFactory !== undefined ? { eventSourceFactory: opts.eventSourceFactory } : {}),
    });
    for (const handler of opts.handlers) {
      registry.register({
        type: handler.type,
        onMessage: (payload: unknown) => (holder === ladder ? handler.onMessage(payload) : undefined),
      });
    }
    const complete: Ladder = Object.assign(ladder, { registry });
    built.set(ladder, complete);
    ladders.push(complete);
    newest = complete;
    return complete;
  };

  /** The ledger cursor as `ladder` sees it: shared reads; writes only while it holds the data. */
  const cursorView = (ladder: LadderState, shared: SequenceCursor): SequenceCursor => ({
    get: () => {
      claim(ladder);
      return shared.get();
    },
    advance: (seq) => {
      if (holder === ladder) shared.advance(seq);
    },
    reset: (seq) => {
      if (holder === ladder) shared.reset(seq);
    },
  });

  const connectOptions = (ladder: Ladder): ConnectViaRegistryOptions => {
    const { spec } = ladder;
    const shared = opts.cursor;
    const view = shared !== undefined ? cursorView(ladder, shared) : undefined;
    const credential = spec.credential;
    const { wsUrl: _wsUrl, wsToken: _wsToken, expiresAt: _expiresAt, sseUrl: _sse, pollingUrl: _polling, ...identity } = opts.meta;
    const meta: McpAppAiGguiRenderMeta = {
      ...identity,
      ...(ladder.hasWs && credential !== undefined
        ? { wsUrl: credential.wsUrl, wsToken: credential.wsToken }
        : {}),
      ...(credential?.expiresAt !== undefined ? { expiresAt: credential.expiresAt } : {}),
    };
    const sse: RegistrySseOptions | undefined =
      spec.sseUrl !== undefined && view !== undefined
        ? {
            url: spec.sseUrl,
            initialSinceSequence: () => view.get(),
            ...(ladder.rebuilt && opts.streamSeq !== undefined
              ? { fromSeq: opts.streamSeq.last }
              : {}),
            onSequence: (seq: number) => view.advance(seq),
          }
        : undefined;
    const polling: RegistryPollingOptions | undefined =
      spec.pollingUrl !== undefined && view !== undefined
        ? buildEventsPolling({ baseUrl: spec.pollingUrl, cursor: view })
        : undefined;
    const callTool = opts.bridgeCallTool;
    const bridge: RegistryPollingOptions | undefined =
      callTool !== undefined && view !== undefined
        ? buildBridgePolling({
            callTool: (name, args) => {
              enterBridge(ladder);
              return callTool(name, args);
            },
            sessionId: opts.meta.sessionId,
            cursor: view,
          })
        : undefined;
    return {
      meta,
      registry: ladder.registry,
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.onProtocolError !== undefined ? { onProtocolError: opts.onProtocolError } : {}),
      ...(opts.onObserve !== undefined ? { onObserve: opts.onObserve } : {}),
      onStatusChange: (status) => {
        ladder.lastStatus = status;
        if (ladder === active) opts.onStatus(status);
      },
      onResubscribeAck: (ack) => onAck(ladder, ack),
      ...(sse !== undefined ? { sse } : {}),
      ...(polling !== undefined ? { polling } : {}),
      ...(bridge !== undefined ? { bridge } : {}),
    };
  };

  /** The ladder's first bridge pull: it has left its token rungs (R3 (b), fact 8). */
  const enterBridge = (ladder: LadderState): void => {
    if (ladder.bridgeEntered) return;
    ladder.bridgeEntered = true;
    switchTo(ladder);
    const expiresAt = ladder.spec.credential?.expiresAt;
    if (expiresAt !== undefined && Date.parse(expiresAt) <= now()) void reportExpired(ladder, 'bridge');
  };

  const bind = async (ladder: Ladder): Promise<RegistrySubscribeHandle> => {
    const result = await opts.connectFn(connectOptions(ladder));
    ladder.handle = result.handle;
    if (ladder.disposed) void result.handle.dispose();
    return result;
  };

  const rebind = (from: LadderState, credential: HeldCredential, source: ExpirySource): void => {
    // A jailed socket that never delivered a frame would only fail again.
    const omitWs = source !== 'ws' && from.hasWs && !from.wsFrameSeen;
    const ladder = build(
      { credential, sseUrl: credential.sseUrl, pollingUrl: credential.pollingUrl },
      true,
      omitWs,
    );
    void bind(ladder).then(
      (result) => {
        if (result.ack !== undefined) onAck(ladder, result.ack);
        // A refusal before acceptance: the ladder demotes on its own and
        // takes over when it reaches its bridge rung. Its credential is
        // never refreshed again unaccepted (the loop guard).
      },
      () => {
        // UPGRADE_REQUIRED or a bind failure: nothing takes over, and the
        // old ladder keeps the view.
      },
    );
  };

  let bootLadder: Ladder | undefined;
  return {
    async connectBoot(spec) {
      const ladder = build(spec, false, false);
      bootLadder = ladder;
      active = ladder;
      holder = ladder;
      const result = await bind(ladder);
      if (result.ack !== undefined && spec.credential !== undefined) {
        opts.controller?.markAccepted(spec.credential);
      }
      return result;
    },
    bootRefresh: () => bootLadder?.refresh,
    send(msg) {
      const handle = active?.handle;
      if (handle !== undefined && handle.kind === 'ws') handle.send(msg);
    },
  };
}
