/**
 * Compile-time type tests for Phase 2 C7d's
 * {@link import('../all-wires').AllWires}<T>. The file MUST compile with
 * zero errors except where `@ts-expect-error` intentionally pins a
 * compile-time rejection — those errors ARE the tests.
 *
 * The four completeness claims this file locks:
 *
 *   1. **Empty contract allows an empty manifest.** With no `actionSpec`
 *      / `streamSpec` / `agentTools` / `clientCapabilities` on `T`, every
 *      slot narrows to `Record<never, true>` = `{}` (for action/stream)
 *      or `Record<string, true>` = index signature (for agentTools /
 *      clientCapabilities, which still fall back to `string` on the
 *      Infer* helpers). Either way, an empty `{}` satisfies the slot —
 *      zero-wire components compile cleanly.
 *
 *   2. **Contract-declared wire forces manifest coverage (`actions` /
 *      `streams`).** A contract with `actionSpec: { submit: … }` narrows
 *      the manifest's `actions` slot to `Record<'submit', true>` — the
 *      `submit` key is REQUIRED. Omitting it fails compile.
 *
 *   3. **Extra keys beyond the contract are rejected (`actions` /
 *      `streams`).** Declaring a manifest key that is not in the
 *      contract fails compile via the literal-record narrowing Item 3b
 *      seeded. Bidirectional agreement is verified.
 *
 *   4. **Symmetric narrowing for `agentTools` / `clientCapabilities` when
 *      the contract DOES declare them.** `agentTools: { tools: { search:
 *      … } }` narrows to `Record<'search', true>`; missing / extra keys
 *      are rejected identically to actions. (The index-signature fallback
 *      on absent contract slots is the documented weakness — harmless
 *      because there are no wires to omit.)
 */
import type { AllWires } from '../all-wires';

// Compile-time assertion helpers (no vitest — parallels C7c's test-d).
type Expect<T extends true> = T;
type Equal<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// Empty contract base — contributes no slot fields, so the
// `Infer{Action,Stream,AgentTool,ClientCapability}Names<BaseContract>`
// helpers all collapse to `never` and the AllWires<T> narrowing is
// exercised purely by the `& { actionSpec: … }` intersections below.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type BaseContract = {};

// =============================================================================
// 1. Empty contract — zero-wire manifest compiles
// =============================================================================

{
  const manifest: AllWires<BaseContract> = {
    actions: {},
    streams: {},
    agentTools: {},
    clientCapabilities: {},
  };
  type _Pinned = Expect<Equal<typeof manifest, AllWires<BaseContract>>>;
  void ({} as _Pinned);
  void manifest;
}

// =============================================================================
// 2. actionSpec with one key — manifest MUST declare it
// =============================================================================

type WithSubmit = BaseContract & {
  readonly actionSpec: {
    readonly submit: { readonly label: 'Submit' };
  };
};

{
  // Valid — manifest covers 'submit'.
  const valid: AllWires<WithSubmit> = {
    actions: { submit: true },
    streams: {},
    agentTools: {},
    clientCapabilities: {},
  };
  void valid;

  // Missing 'submit' key → compile error.
  const missing: AllWires<WithSubmit> = {
    // @ts-expect-error manifest.actions missing required 'submit' key from contract.
    actions: {},
    streams: {},
    agentTools: {},
    clientCapabilities: {},
  };
  void missing;

  // Extra 'unknown' key → compile error via excess-property.
  const extra: AllWires<WithSubmit> = {
    // @ts-expect-error manifest.actions declares 'unknown' — not in contract's actionSpec.
    actions: { submit: true, unknown: true },
    streams: {},
    agentTools: {},
    clientCapabilities: {},
  };
  void extra;
}

// =============================================================================
// 3. streamSpec — same coverage + narrowing semantics
// =============================================================================

type WithProgress = BaseContract & {
  readonly streamSpec: {
    readonly progress: {
      readonly description: 'progress updates';
      readonly schema: { readonly type: 'number' };
    };
  };
};

{
  const valid: AllWires<WithProgress> = {
    actions: {},
    streams: { progress: true },
    agentTools: {},
    clientCapabilities: {},
  };
  void valid;

  const missing: AllWires<WithProgress> = {
    actions: {},
    // @ts-expect-error manifest.streams missing required 'progress' key.
    streams: {},
    agentTools: {},
    clientCapabilities: {},
  };
  void missing;

  const extra: AllWires<WithProgress> = {
    actions: {},
    // @ts-expect-error manifest.streams declares 'wat' — not in contract's streamSpec.
    streams: { progress: true, wat: true },
    agentTools: {},
    clientCapabilities: {},
  };
  void extra;
}

// =============================================================================
// 4. agentTools + clientCapabilities — narrowing under populated contract slots
// =============================================================================

type WithTools = BaseContract & {
  readonly agentCapabilities: {
    readonly tools: {
      readonly search: { readonly outputSchema: Record<string, never> };
    };
  };
  readonly clientCapabilities: {
    readonly gadgets: {
      readonly '@example/gadgets': {
        readonly useSelection: Record<string, never>;
      };
    };
  };
};

{
  const valid: AllWires<WithTools> = {
    actions: {},
    streams: {},
    agentTools: { search: true },
    clientCapabilities: { useSelection: true },
  };
  void valid;

  const missingAgentTool: AllWires<WithTools> = {
    actions: {},
    streams: {},
    // @ts-expect-error manifest.agentTools missing required 'search' key.
    agentTools: {},
    clientCapabilities: { useSelection: true },
  };
  void missingAgentTool;

  const missingCapability: AllWires<WithTools> = {
    actions: {},
    streams: {},
    agentTools: { search: true },
    // @ts-expect-error manifest.clientCapabilities missing required 'useSelection' key.
    clientCapabilities: {},
  };
  void missingCapability;

  const extraAgentTool: AllWires<WithTools> = {
    actions: {},
    streams: {},
    // @ts-expect-error manifest.agentTools declares 'extra' — not in contract's agentTools.tools.
    agentTools: { search: true, extra: true },
    clientCapabilities: { useSelection: true },
  };
  void extraAgentTool;
}

// =============================================================================
// 5. Combined — full four-slot contract, full four-slot manifest
// =============================================================================

type FullContract = WithSubmit & WithProgress & WithTools;

{
  const valid: AllWires<FullContract> = {
    actions: { submit: true },
    streams: { progress: true },
    agentTools: { search: true },
    clientCapabilities: { useSelection: true },
  };
  void valid;

  // Drop one from each slot → four errors.
  const missingAll: AllWires<FullContract> = {
    // @ts-expect-error missing 'submit'.
    actions: {},
    // @ts-expect-error missing 'progress'.
    streams: {},
    // @ts-expect-error missing 'search'.
    agentTools: {},
    // @ts-expect-error missing 'useSelection'.
    clientCapabilities: {},
  };
  void missingAll;
}

export {};
