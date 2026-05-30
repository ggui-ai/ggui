/**
 * Seed-surface preservation — the deterministic backstop that keeps the
 * repair loop FAITHFUL.
 *
 * The agent's draft declares its agent-owned render-time data as
 * `propsSpec.properties` (the only agent→client seed channel —
 * `contextSpec` has no runtime seed path). A repair that drops or
 * reshapes one of those keys away from propsSpec (the canonical
 * `propsSpec.X → contextSpec.X` regression) produces a contract that is
 * VALID (`lintContract` passes) yet round-trip-BROKEN: the agent can no
 * longer seed X at render, so the UI renders empty.
 *
 * `lintContract` + the placement validators can't catch this — none of
 * them sees the agent's DRAFT. These helpers do: they compare the
 * repaired candidate against the draft and report which agent-owned seed
 * surfaces went missing, so the synth loop can drive a corrective retry.
 * Model-independent — it works even when a weak model keeps reshaping.
 */

import type { DataContract } from '@ggui-ai/protocol';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `propsSpec.properties` keys an agent declared on a (possibly
 * malformed) draft — its agent-owned render-time SEED surfaces.
 * Defensive: the draft is untrusted, so every level is probed before
 * access. Returns `[]` for any non-propsSpec-bearing draft.
 */
export function draftSeedPropKeys(draft: unknown): string[] {
  if (!isRecord(draft)) return [];
  const propsSpec = draft['propsSpec'];
  if (!isRecord(propsSpec)) return [];
  const properties = propsSpec['properties'];
  if (!isRecord(properties)) return [];
  return Object.keys(properties);
}

/**
 * Agent-owned seed surfaces (propsSpec property keys) present in `draft`
 * that the repaired `candidate` DROPPED — i.e. they are no longer
 * seedable as a propsSpec property. Reshaping `propsSpec.X` to
 * `contextSpec.X`, or dropping it entirely, both surface here (contextSpec
 * is not an agent-seedable home). Returns `[]` when every declared seed
 * surface survived (preservation holds).
 *
 * Preservation-biased on purpose: keeping a seed key the intent turned
 * out not to need is harmless (an unsent optional prop); DROPPING one the
 * agent relies on is the round-trip break. So we only ever flag drops.
 */
export function findDroppedSeedSurfaces(
  draft: unknown,
  candidate: DataContract,
): string[] {
  const seedKeys = draftSeedPropKeys(draft);
  if (seedKeys.length === 0) return [];
  const candidateProps = candidate.propsSpec?.properties ?? {};
  return seedKeys.filter((key) => candidateProps[key] === undefined);
}
