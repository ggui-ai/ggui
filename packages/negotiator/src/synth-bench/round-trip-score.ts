/**
 * Round-trip quality scorer.
 *
 * The shape scorer ({@link scoreSynthesizedContract}) answers "did the
 * negotiator emit the right SPECS?" — a validity floor. This scorer
 * answers the harder question the contract-quality frontier cares
 * about: "is the produced contract actually USABLE end-to-end?" — i.e.
 * after handshake agrees on it, can the agent `ggui_render` its seed
 * data, and `ggui_consume` its gestures, without the wire rejecting or
 * silently dropping anything?
 *
 * Why a structural scorer can't see this: a contract that reshapes a
 * seedable collection from `propsSpec` to `contextSpec` is STRUCTURALLY
 * VALID (passes `lintContract`) and PASSES the shape scorer (it has a
 * contextSpec). Yet it is round-trip-BROKEN: `propsSpec` is the only
 * agent→client seed channel (and the only `ggui_update` target);
 * `contextSpec` is client→agent observed state with NO runtime seed
 * path (`contextSpec.default` is `useState` scaffold, not wire data).
 * So the agent's `ggui_render({props:{todos:[…]}})` hits a contract
 * with no `propsSpec` — the accept-path silently drops the props and
 * the UI renders empty; the override-path hard-throws.
 *
 * This scorer mirrors that exact render-handler gate deterministically
 * (no LLM, no iframe), so the harness catches the "valid-but-broken"
 * class the shape scorer is blind to. The gate it mirrors lives at
 * `mcp-server-handlers/src/renders/render.ts:1218-1269` (props-vs-
 * propsSpec) and the consume action-declaration requirement at
 * `consume.ts` / `submit-action.ts` (every gesture intent MUST be a
 * declared `actionSpec` key).
 */

import type { DataContract } from '@ggui-ai/protocol';
import { validatePropsData } from '@ggui-ai/protocol';

/**
 * What the agent intends to do with the agreed contract on the NEXT
 * turn — the round-trip the produced contract must support. Authored
 * per repair-corpus entry from the agent's original draft + intent.
 */
export interface RoundTripExpectation {
  /**
   * The props the agent intends to pass on `ggui_render` once the
   * contract is agreed — its render-time SEED data. Every key here MUST
   * land in `contract.propsSpec.properties[key]` (the ONLY agent→client
   * seed channel — `contextSpec` has no runtime seed path), and the
   * value MUST satisfy that prop's schema. Mirrors the render handler's
   * props-vs-propsSpec gate. Omit / leave empty for contracts with no
   * agent-seeded data (pure forms, broadcasts, counters).
   */
  readonly renderProps?: Record<string, unknown>;
  /**
   * Gesture intents the agent expects to consume after render (e.g.
   * `toggleTodo`, `submit`). Each MUST be a declared `actionSpec[*]`
   * key, else the gesture is structurally unconsumable — the iframe has
   * no declared intent to dispatch and `ggui_consume` never wakes.
   */
  readonly consumableActions?: readonly string[];
}

export type RoundTripFailureKind =
  /** Repair bailed to an empty `{}` contract — nothing round-trips. */
  | 'contract-empty'
  /**
   * The agent would seed props but the produced contract declares NO
   * `propsSpec` — the accept-path drops them / the override-path throws.
   * The canonical reshape regression (propsSpec → contextSpec).
   */
  | 'props-no-home'
  /** A seed-prop key has no matching `propsSpec.properties` entry. */
  | 'props-key-unhomed'
  /** Seed props fail `validatePropsData` against the propsSpec (the
   *  real wire validator — wrong type, missing required, etc.). */
  | 'props-rejected'
  /** A consumable gesture intent is absent from `actionSpec`. */
  | 'action-undeclared';

export interface RoundTripFailure {
  readonly kind: RoundTripFailureKind;
  readonly hint: string;
}

export interface RoundTripScore {
  readonly pass: boolean;
  readonly failures: readonly RoundTripFailure[];
}

/**
 * True when a contract declares none of the six spec surfaces — the
 * `EMPTY_CONTRACT` (`{}`) that `ensureConformingContract` returns when a
 * draft is unrepairable. Such a contract is structurally valid but
 * carries no wire at all.
 */
function isEmptyContract(contract: DataContract): boolean {
  return (
    contract.propsSpec === undefined &&
    contract.actionSpec === undefined &&
    contract.streamSpec === undefined &&
    contract.contextSpec === undefined &&
    contract.agentCapabilities === undefined &&
    contract.clientCapabilities === undefined
  );
}

/**
 * Score whether a produced contract supports the agent's intended
 * round-trip. Pure / deterministic — mirrors the render + consume wire
 * gates so a "valid-but-round-trip-broken" contract fails here even
 * though `lintContract` and {@link scoreSynthesizedContract} pass it.
 */
export function scoreContractRoundTrip(
  contract: DataContract,
  rt: RoundTripExpectation,
): RoundTripScore {
  const failures: RoundTripFailure[] = [];
  const renderProps = rt.renderProps ?? {};
  const seedKeys = Object.keys(renderProps);
  const consumable = rt.consumableActions ?? [];

  // An empty contract round-trips nothing it was asked to carry.
  if (isEmptyContract(contract) && (seedKeys.length > 0 || consumable.length > 0)) {
    failures.push({
      kind: 'contract-empty',
      hint: `repair produced an empty contract ({}); the agent's seed data {${seedKeys.join(', ')}} and gestures [${consumable.join(', ')}] have no wire — the draft was unrepairable.`,
    });
  }

  // Props acceptance — mirrors render.ts:1218-1269 (the props-vs-propsSpec gate).
  if (seedKeys.length > 0) {
    const propsSpec = contract.propsSpec;
    if (propsSpec === undefined) {
      failures.push({
        kind: 'props-no-home',
        hint: `agent would seed props {${seedKeys.join(', ')}} on ggui_render, but the produced contract declares NO propsSpec. The accept-path silently drops them (render.ts:1233-1253) and the override-path throws (render.ts:1254-1268); the UI renders empty. A seedable collection was likely reshaped to contextSpec, which has no agent→client seed channel.`,
      });
    } else {
      const properties = propsSpec.properties ?? {};
      const unhomed = seedKeys.filter((k) => properties[k] === undefined);
      if (unhomed.length > 0) {
        failures.push({
          kind: 'props-key-unhomed',
          hint: `seed-prop keys {${unhomed.join(', ')}} have no propsSpec.properties entry — ggui_render would reject them as undeclared props.`,
        });
      }
      // The real wire validator the render handler runs (Branch A).
      const result = validatePropsData(renderProps, propsSpec);
      if (!result.valid) {
        failures.push({
          kind: 'props-rejected',
          hint: `validatePropsData rejected the agent's seed props against the produced propsSpec: ${result.violations
            .map((v) => `${v.field}: ${v.message}`)
            .join('; ')}`,
        });
      }
    }
  }

  // Consumable gestures — every intent the agent dispatches MUST be a
  // declared actionSpec key, else the gesture is structurally undefined.
  for (const action of consumable) {
    if (contract.actionSpec?.[action] === undefined) {
      failures.push({
        kind: 'action-undeclared',
        hint: `agent expects to consume gesture '${action}', but the produced contract's actionSpec has no '${action}' entry — the iframe has no declared intent to dispatch and ggui_consume never wakes.`,
      });
    }
  }

  return { pass: failures.length === 0, failures };
}
