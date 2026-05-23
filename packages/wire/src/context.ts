import { createContext, useContext } from 'react';
import type {
  ActionSpec,
  DataContract,
  InferActionNames,
  InferActionPayload,
  InferStreamNames,
  InferStreamPayload,
  StreamChannelMode,
} from '@ggui-ai/protocol';

/**
 * One delivery on a stream channel, forwarded to a `subscribe`
 * handler. Carries the per-delivery semantics a subscriber needs to
 * fold state correctly — `mode` (append vs replace) and the optional
 * `complete` terminal marker — without leaking transport plumbing
 * (sessionId, requestId).
 *
 * Maps 1:1 onto the `payload`/`mode`/`complete` fields of the
 * outbound {@link import('@ggui-ai/protocol').StreamEnvelope}. The
 * envelope's `sessionId` + `channel` are resolved by the provider
 * before dispatch, so handlers never see them.
 */
export interface StreamDelivery<T = unknown> {
  /** Channel payload — matches the delivery's `payload` field. */
  readonly payload: T;
  /**
   * State-folding mode declared by the sender on this delivery.
   * Consumers MUST honor it — `'append'` accumulates, `'replace'`
   * overwrites the channel's current value.
   */
  readonly mode: StreamChannelMode;
  /**
   * Terminal marker — truthy on the final delivery of a completable
   * channel. Subscribers use this to transition into a "channel
   * closed" state. Absent on non-terminal deliveries.
   */
  readonly complete?: boolean;
}

// =============================================================================
// Argument-type conditionals — degrade method generics back to the broad
// shape when `T` has no contract slot (T = DataContract / untyped callers).
// Tightened-case (typed contract) narrows to exact names + payloads.
// =============================================================================

/**
 * Expected `data` type for `dispatch(name, data)` given the contract
 * generic `T` and the resolved action name `N`. Post-Item-3b, an empty
 * `InferActionNames<T>` (no `actionSpec`) collapses the typed branch to
 * the broad `unknown` fallback, keeping untyped callers ergonomic. A
 * NAME that does not appear in the contract narrows to `never` —
 * compile-time enforcement the brief requires.
 */
export type WireDispatchData<T, N extends string> =
  [InferActionNames<T>] extends [never]
    ? unknown
    : N extends InferActionNames<T>
      ? InferActionPayload<T, N>
      : never;

/** Expected handler-payload generic for `subscribe(channel, handler)`. */
export type WireStreamPayload<T, N extends string> =
  [InferStreamNames<T>] extends [never]
    ? unknown
    : N extends InferStreamNames<T>
      ? InferStreamPayload<T, N>
      : never;

/**
 * Configuration injected by the provider — the renderer inside the
 * iframe.
 *
 * Every method is typed against the contract generic `T` so typed
 * callers get compile-time enforcement:
 *   - `dispatch(name, data)` — `name` MUST be a declared actionSpec
 *     key; `data` MUST satisfy that action's schema.
 *   - `subscribe(channel, handler)` — same discipline for streamSpec.
 *
 * Untyped callers (`T = DataContract` default) degrade to the broad
 * shape via the conditional `WireDispatchData` / `WireStreamPayload`
 * aliases — no call-site break.
 *
 * The contract's `agentTools` catalog declares tools the AGENT
 * invokes (not the component); user gestures fire via
 * `dispatch(name, data)` and the optional `nextStep` field on the
 * action entry names the tool the agent SHOULD invoke next.
 *
 * Per-item scoping is owned by the renderer via the standalone
 * `scopeWireConfig` function from `@ggui-ai/iframe-runtime`; providers
 * pass the scoped config directly through
 * `<GguiWireProvider config={scopedConfig}>`. Legacy consumers that
 * still need the factory pattern use {@link LegacyScopableWireConfig}.
 */
export interface WireConfig<T extends DataContract = DataContract> {
  readonly app: {
    readonly appId: string;
    readonly appName: string;
    readonly appDescription?: string;
    readonly appIcon?: string;
  };
  readonly session: {
    readonly sessionId: string;
    readonly isConnected: boolean;
  };
  readonly auth: {
    readonly userId?: string;
    readonly isAuthenticated: boolean;
  };
  /**
   * Fire an action to the agent (fire-and-forget over WS). Typed
   * callers get compile-time checked `name` + `data`; untyped callers
   * (`T = DataContract`) keep the broad shape.
   */
  readonly dispatch: <N extends string>(
    actionName: N,
    data: WireDispatchData<T, N>,
  ) => void;
  /**
   * Subscribe to deliveries on a named stream channel.
   */
  readonly subscribe: <N extends string>(
    channelName: N,
    handler: (delivery: StreamDelivery<WireStreamPayload<T, N>>) => void,
  ) => () => void;
  /**
   * Optional structured observability for `useAction`'s task-scoped
   * duplicate-dispatch suppression. Fires alongside the always-on
   * `console.warn` whenever the runtime coalesces a same-(name,
   * payload) re-dispatch within one event-loop task — the nested-
   * interactive double-fire backstop. Hosts can route this to
   * telemetry sinks (Sentry, Datadog, server-side log) for ops
   * dashboards; absent → only the dev-console signal fires.
   */
  readonly onDispatchSuppressed?: (info: DispatchSuppressedInfo) => void;
}

/**
 * Payload for the {@link WireConfig.onDispatchSuppressed} callback.
 */
export interface DispatchSuppressedInfo {
  /** The action name that was suppressed. */
  readonly actionName: string;
  /**
   * The dedup signature (`${actionName}::${JSON.stringify(payload)}`)
   * computed for this dispatch. `null` when the payload was
   * un-serializable (no signature, dedup bypassed) — though in that
   * branch suppression cannot fire anyway, so `null` is observable
   * here only if a future code path changes that invariant.
   */
  readonly payloadSignature: string | null;
  /** The raw payload as supplied to the dispatch call. */
  readonly payload: unknown;
  /** `Date.now()` at the moment suppression was decided. */
  readonly suppressedAt: number;
}

/**
 * @deprecated Legacy `WireConfig` + `scope(item)` factory shape used
 * by older session/shell components. The renderer iframe now owns
 * scoping via the standalone `scopeWireConfig` function — no factory
 * method on the wire interface. New consumers MUST NOT target this
 * shape; producer code should migrate to {@link WireConfig} and
 * pre-scoped `config` props.
 */
export interface LegacyScopableWireConfig<T extends DataContract = DataContract>
  extends WireConfig<T> {
  /**
   * Build a per-stack-item scoped config. Legacy pattern — slated for
   * removal together with the older session/shell components that
   * still build these objects.
   */
  readonly scope: (stackItem: {
    readonly stackItemId?: string;
    readonly contractHash?: string;
    readonly actionSpec?: ActionSpec;
  }) => LegacyScopableWireConfig<T>;
}

export const WireContext = createContext<WireConfig | null>(null);

/** Access the WireContext. Must be called inside a WireProvider. */
export function useWireContext(): WireConfig {
  const ctx = useContext(WireContext);
  if (!ctx) {
    throw new Error('useWireContext must be used within a WireProvider. Ensure the component is rendered inside a GguiSession.');
  }
  return ctx;
}
