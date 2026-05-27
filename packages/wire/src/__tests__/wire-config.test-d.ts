/**
 * Compile-time type tests for the Phase 2 C7c-tightened
 * {@link import('../context').WireConfig}<T>. The file MUST compile
 * with zero errors except where `@ts-expect-error` intentionally
 * pins a compile-time rejection — those errors ARE the tests.
 *
 * The shape claims this file locks:
 *
 *   1. **Typed callers get compile-time `name` + `data` enforcement.**
 *      Given a `defineContract()` literal,
 *      `dispatch<N extends InferActionNames<T>>` rejects names not in
 *      the actionSpec AND data that doesn't match the action's schema.
 *      Same discipline for subscribe. (`callWiredTool` / `useWiredTool`
 *      retired 2026-05-11 alongside the EE+ wire-shape v2 — agentTools
 *      is now a catalog the AGENT invokes, never a component-side hook
 *      surface; there is no `useAgentTool` replacement.)
 *
 *   2. **Untyped callers (T = DataContract, the default) degrade
 *      ergonomically.** `dispatch(name, data)` takes any `string` name
 *      and `unknown` data; same for subscribe. Post-Item-3b the
 *      `InferActionNames<DataContract> = never` fallback would have
 *      collapsed typed-method signatures to `never`; the
 *      `[InferActionNames<T>] extends [never]` branch in
 *      `WireDispatchData` etc. keeps the default-case usable.
 *
 *   3. **`scope(item)` is NOT on `WireConfig`.** Post-flatten-render-
 *      identity (Phase B) the renderer mounts exactly one render per
 *      iframe; there is no per-stack-item scoping factory because there
 *      is no stack. `LegacyScopableWireConfig` is DELETED.
 */
import { defineContract } from '@ggui-ai/protocol';
import type {
  WireConfig,
  WireDispatchData,
  WireStreamPayload,
} from '../context';

// Compile-time assertions without vitest (wire has no vitest dep).
type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// =============================================================================
// 1. Typed caller — full generics + compile-time enforcement
// =============================================================================

const _weather = defineContract({
  intent: 'Show weather + alerts',
  actionSpec: {
    refresh: { label: 'Refresh' },
    changeUnit: {
      label: 'Change Unit',
      schema: {
        type: 'object',
        properties: { unit: { type: 'string' } },
        required: ['unit'],
      },
    },
  },
  streamSpec: {
    tick: { schema: { type: 'number' } },
  },
  agentCapabilities: {
    tools: {
      getForecast: {
        inputSchema: {
          type: 'object',
          properties: { days: { type: 'number' } },
          required: ['days'],
        },
        outputSchema: {
          type: 'object',
          properties: { temp: { type: 'number' } },
          required: ['temp'],
        },
      },
    },
  },
  clientCapabilities: {
    gadgets: {
      '@ggui-ai/gadgets': {
        useGeolocation: {},
      },
    },
  },
} as const);

type WeatherContract = typeof _weather;

declare const typedCfg: WireConfig<WeatherContract>;

// ── dispatch ────────────────────────────────────────────────────────────
// Name in actionSpec → OK. Payload narrows.
typedCfg.dispatch('refresh', undefined);
typedCfg.dispatch('changeUnit', { unit: 'C' });

// Payload wrong shape → compile error.
// @ts-expect-error changeUnit expects { unit: string }, not a plain string.
typedCfg.dispatch('changeUnit', 'celsius');

// Name not in actionSpec → compile error (WireDispatchData = never).
// @ts-expect-error 'nonExistent' is not declared in actionSpec.
typedCfg.dispatch('nonExistent', {});

// ── subscribe ───────────────────────────────────────────────────────────
typedCfg.subscribe('tick', (_d) => {
  // delivery.payload narrows to the tick schema payload (number).
  type _PayloadOK = Expect<Equal<typeof _d.payload, number>>;
  void ({} as _PayloadOK);
});
// 'nowhere' not declared in streamSpec → handler's payload narrows to
// `never`. Calling `.subscribe` with no-arg handler is still assignable
// (fewer args are always compatible), so the method call itself does
// NOT error — the compile-time lock is on payload SHAPE: attempting to
// read a property from the typed-never payload errors.
typedCfg.subscribe('nowhere', (_d) => {
  type _NeverPayload = Expect<Equal<typeof _d.payload, never>>;
  void ({} as _NeverPayload);
});

// ── callWiredTool retired 2026-05-11 ────────────────────────────────────
// `agentTools` is a catalog the AGENT invokes; the component never calls
// these tools directly. The pre-EE+ `useWiredTool` + `callWiredTool`
// surfaces are RETIRED — no `useAgentTool` replacement was introduced.
// User gestures fire via `dispatch(name, data)`; if the action declares
// `nextStep: '<tool>'`, that names the tool the agent SHOULD invoke on
// its next turn (the runtime forwards as event metadata).
// @ts-expect-error callWiredTool method retired with the useWiredTool hook.
typedCfg.callWiredTool('getForecast', { days: 3 });

// ── registerClientTool retired 2026-05-11 ───────────────────────────────
// `clientCapabilities` are declared hooks owned by the UI; no RPC seam
// remains on `WireConfig`. Capability values reach the agent only via
// `actionSpec` payloads or `contextSpec` slots.
// @ts-expect-error registerClientTool method retired with clientTools.
typedCfg.registerClientTool('getLocation', () => undefined);

// =============================================================================
// 2. Untyped caller (T = DataContract default) — ergonomic fallback
// =============================================================================

declare const untypedCfg: WireConfig;

// Arbitrary string name + unknown data accepted.
untypedCfg.dispatch('anything', { x: 1 });
untypedCfg.dispatch('anything', 'a string');
untypedCfg.dispatch('anything', undefined);
untypedCfg.subscribe('any-channel', (_d) => {
  // `d.payload` degrades to unknown at the untyped caller.
  type _UntypedPayload = Expect<Equal<typeof _d.payload, unknown>>;
  void ({} as _UntypedPayload);
});
// @ts-expect-error callWiredTool retired with the useWiredTool hook.
untypedCfg.callWiredTool('any-tool', { opaque: true });
// @ts-expect-error registerClientTool retired with the clientTools surface.
untypedCfg.registerClientTool('any-client-tool', () => undefined);

// =============================================================================
// 3. Fallback-alias shape locks — the `[…] extends [never]` collapse
// =============================================================================

// WireDispatchData: typed contract → typed payload; default → unknown.
type _WDD1 = Expect<Equal<WireDispatchData<WeatherContract, 'changeUnit'>, { unit: string }>>;
type _WDD2 = Expect<Equal<WireDispatchData<WeatherContract, 'refresh'>, void>>;
// Non-existent name on typed contract → never.
type _WDD3 = Expect<Equal<WireDispatchData<WeatherContract, 'phantom'>, never>>;
// Default contract → unknown.
type _WDD4 = Expect<Equal<WireDispatchData<import('@ggui-ai/protocol').DataContract, 'anything'>, unknown>>;

// WireStreamPayload: similar.
type _WSP1 = Expect<Equal<WireStreamPayload<WeatherContract, 'tick'>, number>>;
type _WSP2 = Expect<Equal<WireStreamPayload<WeatherContract, 'phantom'>, never>>;
type _WSP3 = Expect<Equal<WireStreamPayload<import('@ggui-ai/protocol').DataContract, 'anything'>, unknown>>;

// WireToolRequest / WireToolResponse retired 2026-05-11. agentTools is
// a catalog, not a component hook surface — there is no payload type
// for component invocation because the component never invokes.

// WireClientToolArgs / WireClientToolResult retired 2026-05-11.

// Silence unused-type warnings for the pinning assertions above.
type _Pinned = [_WDD1, _WDD2, _WDD3, _WDD4, _WSP1, _WSP2, _WSP3];
void ({} as _Pinned);

// =============================================================================
// 4. `scope(item)` is NOT on WireConfig — regression lock.
// =============================================================================

// Post-flatten-render-identity (Phase B), `WireConfig.scope` does not
// exist and `LegacyScopableWireConfig` is deleted. The renderer mounts
// exactly one render per iframe; "scope" collapses to identity.
// @ts-expect-error WireConfig no longer carries a `scope(item)` method.
typedCfg.scope({ renderId: 'x' });

export {};
