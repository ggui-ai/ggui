// packages/protocol/src/types/contract-inference.ts
//
// Compile-time type inference from JSON Schema contract literals.
//
// Agents write a single `defineContract({ ... } as const)` call.
// TypeScript infers all prop types, action names/payloads, stream events,
// and tool signatures automatically from the JSON Schema literal — no
// parallel type definitions needed.

import type { DataContract, JsonObject, JsonValue } from './data-contract';

// =============================================================================
// SchemaToType — recursive JSON Schema → TypeScript type mapper
// =============================================================================

/**
 * Extract the JSON Schema `required` array from a schema literal as a
 * string union. Resolves to `never` when `required` is absent, empty,
 * or non-string-typed.
 *
 * Used by {@link SchemaToType} to split an object's `properties` into
 * required + optional sub-maps. Honors the spec's `required: string[]`
 * array; properties NOT listed are optional.
 */
export type RequiredKeysOf<S> =
  S extends { readonly required: readonly (infer R)[] }
    ? R extends string ? R : never
    : never;

/**
 * Flatten an intersection of object types into a single object type.
 *
 * Why this exists: the required/optional split in {@link SchemaToType}
 * (and the parallel split in {@link InferProps}) emits an intersection
 * `{ required keys } & { optional keys }`. TypeScript's `Equal` helper
 * (used in our type tests) treats `A & B` and the equivalent flat
 * shape as DIFFERENT types under its `[<T>() => …]` conditional
 * distribution trick, even though they're assignable in both
 * directions. `Prettify` walks every key one level deep and rebuilds
 * a flat shape, so `Equal` resolves correctly.
 *
 * Note: only one level deep — nested object properties keep their
 * own structure (which is fine because nested objects flow back
 * through `SchemaToType` themselves and emerge already-prettified).
 */
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * Map a JSON Schema literal type to its corresponding TypeScript type.
 *
 * Works with `as const` literals to preserve exact types:
 * - `{ type: 'string' }` -> `string`
 * - `{ type: 'number' }` -> `number`
 * - `{ type: 'boolean' }` -> `boolean`
 * - `{ type: 'null' }` -> `null`
 * - `{ type: 'array', items: S }` -> `SchemaToType<S>[]`
 * - `{ type: 'object', properties: { k: S }, required: ['k'] }` -> `{ k: SchemaToType<S> }`
 * - `{ type: 'object', properties: { k: S } }` -> `{ k?: SchemaToType<S> }` (no `required` ⇒ all optional, per JSON Schema draft-07)
 * - `{ type: 'object' }` (no properties) -> {@link JsonObject}
 * - `{ enum: ['a', 'b'] }` -> `'a' | 'b'`
 * - `{ const: 42 }` -> `42`
 * - `{ oneOf: [S1, S2] }` -> `SchemaToType<S1> | SchemaToType<S2>`
 *
 * Falls back to `unknown` for non-literal or unrecognized schemas.
 * Objects without explicit `properties` resolve to {@link JsonObject} (not `unknown`).
 *
 * Required-array honor: per JSON Schema draft-07, an object schema's
 * `required` array names the keys that MUST be present; properties NOT
 * listed are optional. The mapping splits `properties` into a required
 * sub-map (keys in `required`) and an
 * optional sub-map (the rest), then intersects them. When `required` is
 * absent or empty, all properties are optional.
 */
export type SchemaToType<S> =
  // Const literal
  S extends { readonly const: infer V } ? V :
  // Enum values
  S extends { readonly enum: readonly (infer E)[] } ? E :
  // Primitives
  S extends { readonly type: 'string' } ? string :
  S extends { readonly type: 'number' } ? number :
  S extends { readonly type: 'integer' } ? number :
  S extends { readonly type: 'boolean' } ? boolean :
  S extends { readonly type: 'null' } ? null :
  // Array with typed items
  S extends { readonly type: 'array'; readonly items: infer I } ? SchemaToType<I>[] :
  // Object with typed properties — split required vs optional per JSON Schema spec
  S extends { readonly type: 'object'; readonly properties: infer P } ? Prettify<
    & { -readonly [K in keyof P as K extends RequiredKeysOf<S> ? K : never]: SchemaToType<P[K]> }
    & { -readonly [K in keyof P as K extends RequiredKeysOf<S> ? never : K]?: SchemaToType<P[K]> }
  > :
  // Object without properties (dynamic)
  S extends { readonly type: 'object' } ? JsonObject :
  // oneOf union
  S extends { readonly oneOf: readonly (infer U)[] } ? SchemaToType<U> :
  // anyOf union
  S extends { readonly anyOf: readonly (infer U)[] } ? SchemaToType<U> :
  // Fallback — non-literal or unrecognized schema
  unknown;

// =============================================================================
// Props Inference
// =============================================================================

/**
 * Infer the TypeScript props type from a `PropsSpec` literal.
 *
 * Given `{ properties: { city: { schema: { type: 'string' }, required: true }, temp: { schema: { type: 'number' } } } }`,
 * infers `{ city: string; temp?: number }`.
 *
 * Falls back to {@link JsonObject} when no props spec is present (untyped usage).
 *
 * Required honor: each {@link PropEntry} carries a per-property
 * `required?: boolean` flag (NOT a `required: string[]` at the props
 * level — that's the JSON Schema convention used elsewhere by
 * {@link SchemaToType}). Entries with `required: true` map to
 * required keys; everything else (`required: false`, `required` omitted,
 * or any non-`true` value) maps to optional `?:` keys. The split uses
 * a key-remap, mirroring the JSON-Schema `required: string[]` handling
 * in {@link SchemaToType}.
 */
export type InferProps<T> =
  T extends { readonly propsSpec: { readonly properties: infer P } }
    ? Prettify<
      & {
        -readonly [K in keyof P as P[K] extends { readonly required: true } ? K : never]:
          P[K] extends { readonly schema: infer S } ? SchemaToType<S> : unknown
      }
      & {
        -readonly [K in keyof P as P[K] extends { readonly required: true } ? never : K]?:
          P[K] extends { readonly schema: infer S } ? SchemaToType<S> : unknown
      }
    >
    : JsonObject;

// =============================================================================
// Action Inference
// =============================================================================

/**
 * Extract action names as a string literal union from a contract.
 *
 * `DataContract.actionSpec` is a flat `Record<actionName, ActionEntry>`;
 * this type matches that shape directly.
 *
 * The fallback (no `actionSpec` key on `T`) resolves to `never`, not
 * `string`. A `string` fallback would silently let generated code
 * pattern-match against arbitrary names when no contract was declared;
 * `never` makes `useAction('nonExistent')` a compile error instead.
 * Consumers that still need a broad name/payload shape (e.g. the
 * server-side untyped-handler default) keep it by going through
 * `TypedAction<T>`, which falls back to `{ name: string; data: JsonValue }`
 * when Names narrows to `never`.
 */
export type InferActionNames<T> =
  T extends { readonly actionSpec: infer A }
    ? Extract<keyof A, string>
    : never;

/**
 * Infer the payload type for a specific action.
 * Actions without a `schema` field have `void` payload (fire-and-forget).
 */
export type InferActionPayload<T, N extends string> =
  T extends { readonly actionSpec: infer A }
    ? N extends keyof A
      ? A[N] extends { readonly schema: infer S } ? SchemaToType<S> : void
      : never
    : unknown;

// =============================================================================
// Stream Inference
// =============================================================================

/**
 * Extract stream channel names as a string literal union from a contract.
 *
 * `DataContract.streamSpec` is a flat
 * `Record<channelName, StreamChannelEntry>`; this type matches that
 * shape directly.
 *
 * The fallback (no `streamSpec` key on `T`) resolves to `never`, not
 * `string`. Parallel to `InferActionNames` — `useStream('nonExistent')`
 * becomes a compile error when no contract is declared.
 * `TypedStreamEvent<T>` preserves the broad
 * `{ channel: string; payload: JsonValue; … }` fallback when names
 * narrow to `never`, so untyped-handler defaults still work.
 */
export type InferStreamNames<T> =
  T extends { readonly streamSpec: infer C }
    ? Extract<keyof C, string>
    : never;

/** Infer the payload type for a specific stream channel. */
export type InferStreamPayload<T, N extends string> =
  T extends { readonly streamSpec: infer C }
    ? N extends keyof C
      ? C[N] extends { readonly schema: infer S } ? SchemaToType<S> : unknown
      : never
    : unknown;

// =============================================================================
// Context Inference
// =============================================================================

/**
 * Extract contextSpec slot names as a string literal union from a contract.
 *
 * Mirrors {@link InferActionNames} / {@link InferStreamNames}: when the
 * contract declares a `contextSpec` map, returns the keys as a literal
 * union; absent → `never` (so a context-slot lookup for a `'nonExistent'`
 * key against an empty contract is a compile error rather than a silent
 * broad-string fallback).
 */
export type InferContextNames<T> =
  T extends { readonly contextSpec: infer S }
    ? Extract<keyof S, string>
    : never;

/**
 * Infer the value type for a specific contextSpec slot, narrowed by
 * its declared `schema`. Mirrors {@link InferActionPayload} /
 * {@link InferStreamPayload}.
 *
 * - Present `contextSpec` + known slot name → `SchemaToType<schema>`.
 * - Present `contextSpec` + unknown slot name → `never`.
 * - Absent `contextSpec` entirely → `unknown` (parallel to the
 *   payload-fallback posture on actionSpec / streamSpec).
 */
export type InferContextValue<T, N extends string> =
  T extends { readonly contextSpec: infer S }
    ? N extends keyof S
      ? S[N] extends { readonly schema: infer Sch } ? SchemaToType<Sch> : unknown
      : never
    : unknown;

// =============================================================================
// Agent Capabilities Inference
// =============================================================================

/**
 * Extract agent-tool names as a string literal union. Used by the
 * generator's `AllWires<T>` completeness manifest to enumerate the
 * catalog at type-time.
 *
 * The catalog is invoked by the AGENT, not the component — there is no
 * payload-type inference for component callers because the component
 * never calls these tools. The catalog is referenced from
 * `actionSpec[*].nextStep` and `streamSpec[*].source.tool`.
 */
export type InferAgentToolNames<T> =
  T extends { readonly agentCapabilities: { readonly tools: infer Tools } }
    ? Extract<keyof Tools, string>
    : string;

// =============================================================================
// Client Library Inference
// =============================================================================

/**
 * Extract gadget EXPORT names as a string literal union — the union
 * of every export name across every package the contract declares on
 * `clientCapabilities.gadgets` (which is package-keyed:
 * `Record<package, Record<exportName, GadgetExportUse>>` — there is no
 * `exports` wrapper; a package entry IS its export map).
 *
 * Gadgets are declarations, not RPC, so they have no input/output
 * schemas to narrow against. The value type for a declared gadget is
 * consumed via the runtime hook / rendered component (e.g.,
 * `useMicrophone()` returns `GadgetHook<TOutput>`), not via a
 * contract-level type query — so the export NAME is the unit the
 * completeness manifest enumerates.
 */
export type InferGadgetNames<T> =
  T extends {
    readonly clientCapabilities: { readonly gadgets: infer Pkgs };
  }
    ? {
        [K in keyof Pkgs]: Extract<keyof Pkgs[K], string>;
      }[keyof Pkgs]
    : string;

// =============================================================================
// Typed stream event union — for ctx.stream() and client.send()
// =============================================================================

/**
 * Discriminated union of all stream emissions in a contract.
 *
 * Each member has `{ channel: ChannelName; payload: PayloadType; complete?: boolean }`
 * — the agent-supplied fields of {@link GguiEmitInput} minus `sessionId`
 * (which is caller context, not per-delivery).
 *
 * `mode` / `seq` / transport details are intentionally NOT on this union:
 * `mode` is derived from `streamSpec[channel].mode` server-side,
 * and `seq` is server-assigned via `GguiSessionStreamBuffer`. Producers that
 * try to set either are drifting against the streamSpec design lock.
 *
 * Falls back to `{ channel: string; payload: JsonValue; complete?: boolean }`
 * when the contract has no `streamSpec` declared.
 */
export type TypedStreamEvent<T> =
  // When `T` has no `streamSpec`, `InferStreamNames<T>` narrows to
  // `never`. Fall back to the broad
  // `{ channel: string; payload: JsonValue; … }` shape so untyped
  // callers (e.g. the `mcp-client.send()` non-generic overload +
  // `HandlerContext.stream()` with `T = DataContract`) keep ergonomic
  // runtime-data types.
  [InferStreamNames<T>] extends [never]
    ? { channel: string; payload: JsonValue; complete?: boolean }
    : InferStreamNames<T> extends infer Names extends string
      ? {
          [N in Names]: {
            channel: N;
            payload: InferStreamPayload<T, N>;
            complete?: boolean;
          };
        }[Names]
      : { channel: string; payload: JsonValue; complete?: boolean };

/**
 * Discriminated union of all action events in a contract.
 * Each member has `{ name: ActionName; data: PayloadType }`.
 *
 * Falls back to `{ name: string; data: JsonValue }` when no action spec is present.
 */
export type TypedAction<T> =
  // When `InferActionNames<T>` narrows to `never` (no `actionSpec` on
  // `T`), emit the broad `{name: string; data: JsonValue}` shape so
  // untyped server-side defaults (`ActionHandler<T = DataContract>`,
  // `dispatchEvent`'s untyped overload) keep their ergonomic runtime-
  // data shape. Tightening intentionally fires at the `useAction` /
  // `useContract` seam, not at the handler-payload seam.
  [InferActionNames<T>] extends [never]
    ? { name: string; data: JsonValue }
    : InferActionNames<T> extends infer Names extends string
      ? { [N in Names]: { name: N; data: InferActionPayload<T, N> } }[Names]
      : { name: string; data: JsonValue };

// =============================================================================
// defineContract — zero-cost identity that locks literal types
// =============================================================================

/**
 * Define a data contract with full type inference.
 *
 * The `const` type parameter preserves literal types from `as const`,
 * enabling automatic TypeScript type inference from JSON Schema definitions.
 *
 * @example
 * ```typescript
 * const contract = defineContract({
 *   intent: 'Show weather for a city with refresh control',
 *   props: { properties: {
 *     city: { schema: { type: 'string' } },
 *     temp: { schema: { type: 'number' } },
 *   }},
 *   actionSpec: {
 *     refresh: { label: 'Refresh' },
 *     changeUnit: { label: 'Unit', schema: { type: 'object', properties: { unit: { type: 'string' } } } },
 *   },
 *   streamSpec: {
 *     weatherUpdate: { schema: { type: 'object', properties: { temp: { type: 'number' }, conditions: { type: 'string' } } } },
 *   },
 * } as const);
 *
 * // TypeScript infers:
 * //   InferProps<typeof contract> = { city: string; temp: number }
 * //   InferActionNames<typeof contract> = 'refresh' | 'changeUnit'
 * //   InferActionPayload<typeof contract, 'changeUnit'> = { unit: string }
 * //   InferStreamPayload<typeof contract, 'weatherUpdate'> = { temp: number; conditions: string }
 * ```
 */
export function defineContract<const T extends DataContract>(contract: T): T {
  return contract;
}

// =============================================================================
// ContractTypeMap — manual fallback for complex schemas
// =============================================================================

/**
 * Manual type map for cases where `SchemaToType` can't infer
 * (complex unions, conditional schemas, branded types, etc.).
 *
 * Both paths (auto-inferred via `defineContract` and manual via `ContractTypeMap`)
 * work with `useContract`, typed handlers, and typed MCP client methods.
 *
 * All map slots default to {@link JsonObject} (props, actions, streams) or
 * `Record<string, { request/args: JsonValue; response: JsonValue }>` (tools)
 * when not overridden.
 *
 * @example
 * ```typescript
 * interface MyContract extends ContractTypeMap {
 *   props: { city: string; temperature: number };
 *   actions: { refresh: void; changeUnit: { unit: 'C' | 'F' } };
 *   streams: { weatherUpdate: { temp: number; conditions: string } };
 * }
 * ```
 */
export interface ContractTypeMap {
  props?: JsonObject;
  actions?: JsonObject;
  streams?: JsonObject;
  agentCapabilities?: Record<string, { input: JsonValue; output: JsonValue }>;
  /**
   * Per-gadget binding-name set. Values are intentionally typed
   * `unknown` — gadget hooks own their own typed `value` / `start()`
   * shape (see `GadgetHook` in `./gadget.ts`), which
   * is not derivable from a contract-level type query.
   */
  clientCapabilities?: Record<string, unknown>;
}

// Manual type map extraction utilities

/** Extract props from a manual ContractTypeMap. */
export type PropsOf<C extends ContractTypeMap> =
  C extends { props: infer P } ? P : JsonObject;

/** Extract action names from a manual ContractTypeMap. */
export type ActionNames<C extends ContractTypeMap> =
  C extends { actions: infer A } ? Extract<keyof A, string> : string;

/** Extract action payload from a manual ContractTypeMap. */
export type ActionPayload<C extends ContractTypeMap, N extends ActionNames<C>> =
  C extends { actions: infer A }
    ? N extends keyof A ? A[N] : unknown
    : unknown;

/** Extract stream event names from a manual ContractTypeMap. */
export type StreamNames<C extends ContractTypeMap> =
  C extends { streams: infer S } ? Extract<keyof S, string> : string;

/** Extract stream payload from a manual ContractTypeMap. */
export type StreamPayloadOf<C extends ContractTypeMap, N extends StreamNames<C>> =
  C extends { streams: infer S }
    ? N extends keyof S ? S[N] : unknown
    : unknown;

/**
 * Extract agent-tool names from a manual ContractTypeMap. Used by the
 * generator's `AllWires<T>` completeness manifest to enumerate the
 * catalog at type-time.
 *
 * The catalog is invoked by the AGENT, never a component-side hook
 * surface, so there is no payload-type inference for component callers.
 */
export type AgentToolNames<C extends ContractTypeMap> =
  C extends { agentCapabilities: infer T } ? Extract<keyof T, string> : string;

/**
 * Extract gadget binding names from a manual ContractTypeMap.
 *
 * Libraries are declarations, not RPC, so there is no payload-type
 * inference. Value types are consumed via the runtime hook
 * (`GadgetHook<TOutput>`), not via a contract-level query.
 */
export type GadgetNames<C extends ContractTypeMap> =
  C extends { clientCapabilities: infer T } ? Extract<keyof T, string> : string;
