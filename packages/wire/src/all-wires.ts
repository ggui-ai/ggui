// packages/wire/src/all-wires.ts
//
// Contract-completeness manifest type.
//
// The hook signatures already enforce the "hook NAME-is-in-contract"
// direction: `useAction('nonExistent')` against a typed contract is a
// compile error via `InferActionNames<T>` narrowing. `AllWires<T>` closes
// the REVERSE direction. A contract can still declare an action / stream
// / wired tool / client tool that no generated component actually consumes
// — dead contract fields ship without a signal. `AllWires<T>` forces the
// generator to emit an exhaustive manifest of which wires the component
// touches; the typechecker rejects incomplete or misdeclared manifests.
//
// The resulting contract is observable via `pnpm typecheck`:
//   1. Manifest names must be IN the contract (name narrowing —
//      `Record<InferActionNames<T>, true>` with `InferActionNames<{}> =
//      never` collapses to `{}` for an empty slot, and any extra literal
//      key on the manifest that is not in the contract's actionSpec is
//      rejected as an excess-property error on the object literal).
//   2. Manifest must cover ALL names in the contract — a contract with
//      `actionSpec: { submit: {} }` narrows to `Record<'submit', true>`,
//      which REQUIRES the `submit` key on the manifest's `actions` slot.
//
// `agentTools` / `clientCapabilities` fallback to `Record<string, true>`
// on an absent contract slot (see `@ggui-ai/protocol/types/contract-inference`
// — only `InferActionNames` / `InferStreamNames` were tightened to
// `never` under Item 3b). This is harmless: when the contract declares
// no agentTools, there are no wires to omit — the index-signature allows
// an empty manifest slot. When the contract DOES declare agentTools,
// `Extract<keyof Tools, string>` narrows to the literal union and the
// completeness guarantee applies identically to the action/stream case.
//
// Emission is PURELY type-level. The generator emits a
// `_wires: AllWires<typeof contractShape>` const that the bundler
// dead-code-eliminates — zero runtime cost.

import type {
  DataContract,
  InferActionNames,
  InferAgentToolNames,
  InferGadgetNames,
  InferStreamNames,
} from '@ggui-ai/protocol';

/**
 * Exhaustive contract-completeness manifest for the code a generator
 * emits against `T`. Declaring
 * `const _wires: AllWires<typeof contractShape> = { … }` forces the
 * emitter (LLM or codegen) to enumerate every wire slot — the
 * typechecker then proves bidirectional agreement:
 *
 *   - A manifest key missing from the contract → excess-property error
 *     (`InferActionNames<T>` already narrowed the hook signature under
 *     Item 3b; `AllWires<T>` applies the same narrowing to the manifest).
 *   - A contract wire missing from the manifest → `Property 'X' is
 *     missing in type '{…}' but required in type 'Record<"X", true>'`.
 *
 * The `_wires` const itself is consumed ONLY by the typechecker
 * (`void _wires;` suppresses unused-variable diagnostics; bundlers
 * dead-code-eliminate the binding). No runtime observation site.
 *
 * @public
 * @typeParam T - A `DataContract`-shaped contract literal. Pass
 *   `typeof contractShape` where `contractShape` carries `actionSpec`,
 *   `streamSpec`, `agentTools`, and/or `clientCapabilities` via
 *   `as const`-preserved shape (the generator emits a local synthetic
 *   type alias for the slots it populates).
 */
export type AllWires<T extends DataContract> = {
  readonly actions: Readonly<Record<InferActionNames<T>, true>>;
  readonly streams: Readonly<Record<InferStreamNames<T>, true>>;
  readonly agentTools: Readonly<Record<InferAgentToolNames<T>, true>>;
  readonly clientCapabilities: Readonly<Record<InferGadgetNames<T>, true>>;
};
