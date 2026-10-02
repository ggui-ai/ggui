/**
 * Blueprint coverage report — the deterministic, INFORMATIONAL check
 * attached to every reuse of a cached blueprint against a
 * contract-bearing request.
 *
 * Reusing a cached blueprint for a request whose canonical contract
 * differs is safe ONLY when the cached blueprint COVERS the request's
 * declared surface: every action, prop, context slot, stream channel,
 * and gadget the request declares must also exist in the candidate.
 *
 * Without this, the semantic judge can serve a SUBSET blueprint to a
 * SUPERSET request — the 2026-05-09 regression: a request for a counter
 * with {increment, decrement, reset} was served a cached {increment,
 * reset} blueprint (judge confidence 0.876) and the rendered widget had
 * no decrement button. Atomic reuse (serving the cached contract+UI
 * together) keeps the UI internally coherent, but coherence is not
 * COMPLETENESS — the agent asked for a capability the cache lacks. This
 * guard is the deterministic check the LLM judge cannot be trusted to
 * make. It is INFORMATIONAL, not a gate: a candidate that fails to
 * cover the request is NOT dropped — the resulting `coverageGap` is
 * reported on the match hit so the agent can SEE the uncovered surface.
 * The matcher proposes the reuse; the agent disposes — overriding the
 * proposed contract is the safety valve when a flagged surface is one
 * the user must directly see or act on.
 *
 * Pure — no store, no LLM. Compares declared key-SETS, plus ONE thing
 * inside a shared action: the members that change what the runtime does
 * with a gesture ({@link LOAD_BEARING_ACTION_MEMBERS}). Every other
 * difference WITHIN a shared surface (a relabeled action, an `id` vs
 * `id+done` payload schema) is tolerated, because atomic reuse hands the
 * agent the cached contract and it drives that contract, not its own
 * draft.
 */

import type { DataContract } from '@ggui-ai/protocol';
import { listContractGadgets } from '@ggui-ai/protocol';

/** The request-declared surfaces a candidate fails to cover. Empty
 *  arrays everywhere ⇒ the candidate covers the request. */
export interface CoverageGap {
  readonly actions: readonly string[];
  readonly props: readonly string[];
  readonly context: readonly string[];
  readonly streams: readonly string[];
  readonly gadgets: readonly string[];
  /**
   * `<action>.<member>` for every load-bearing member the request declares
   * on an action BOTH contracts carry, where the candidate's entry does not
   * say the same (ggui#1428). An action the candidate lacks altogether is in
   * {@link actions}, never here.
   */
  readonly actionMembers: readonly string[];
}

/**
 * The action-entry members that change what the runtime DOES with a gesture,
 * as opposed to how the action reads: `oneShot` arms the single-dispatch
 * guard, `confirm` asks before firing, `nextStep` names the tool the agent is
 * routed to. A stored card that lacks one the draft declares serves a card
 * without that behaviour, so the agent is told. `label`, `description`,
 * `icon`, `example` and `schema` stay tolerated differences.
 */
export const LOAD_BEARING_ACTION_MEMBERS = ['oneShot', 'confirm', 'nextStep'] as const;

/**
 * Members the request DECLARES on `name` that the candidate's entry does not
 * match. One direction, like the rest of coverage: a boolean member counts as
 * declared only when `true` (`false` and absent both mean "off"), `nextStep`
 * when present. A candidate that is stricter than the request (it carries a
 * member the request does not) is not a gap. That holds for `nextStep` too,
 * because the case that would matter there is already refused elsewhere: a
 * stored `nextStep` naming a tool the requesting agent does not declare makes
 * the candidate unfulfillable, and `isFulfillable` declines it before it is
 * ever proposed (`blueprint-fulfillability.ts`).
 */
function mismatchedActionMembers(
  request: DataContract,
  candidate: DataContract,
): string[] {
  const out: string[] = [];
  for (const [name, wanted] of Object.entries(request.actionSpec ?? {})) {
    const stored = candidate.actionSpec?.[name];
    if (stored === undefined) continue;
    if (wanted.oneShot === true && stored.oneShot !== true) out.push(`${name}.oneShot`);
    if (wanted.confirm === true && stored.confirm !== true) out.push(`${name}.confirm`);
    if (wanted.nextStep !== undefined && stored.nextStep !== wanted.nextStep) out.push(`${name}.nextStep`);
  }
  return out.sort();
}

function keySet(map: Record<string, unknown> | undefined): Set<string> {
  return new Set(Object.keys(map ?? {}));
}

/** Gadget identity = package + export name (the discriminating pair). */
function gadgetIdSet(contract: DataContract): Set<string> {
  return new Set(listContractGadgets(contract).map((g) => `${g.package}\t${g.name}`));
}

/** Keys present in `request` but absent from `candidate`, sorted. */
function missing(
  request: ReadonlySet<string>,
  candidate: ReadonlySet<string>,
): string[] {
  return [...request].filter((k) => !candidate.has(k)).sort();
}

/**
 * Compute the surfaces the request declares that the candidate does NOT.
 * A wholly-empty gap means the candidate covers the request.
 */
export function coverageGap(
  candidate: DataContract,
  request: DataContract,
): CoverageGap {
  return {
    actions: missing(keySet(request.actionSpec), keySet(candidate.actionSpec)),
    props: missing(
      keySet(request.propsSpec?.properties),
      keySet(candidate.propsSpec?.properties),
    ),
    context: missing(keySet(request.contextSpec), keySet(candidate.contextSpec)),
    streams: missing(keySet(request.streamSpec), keySet(candidate.streamSpec)),
    gadgets: missing(gadgetIdSet(request), gadgetIdSet(candidate)),
    actionMembers: mismatchedActionMembers(request, candidate),
  };
}

/** True iff `candidate` declares every surface `request` declares —
 *  i.e. the candidate is safe to reuse for the request. */
export function covers(candidate: DataContract, request: DataContract): boolean {
  const gap = coverageGap(candidate, request);
  return (
    gap.actions.length === 0 &&
    gap.props.length === 0 &&
    gap.context.length === 0 &&
    gap.streams.length === 0 &&
    gap.gadgets.length === 0 &&
    gap.actionMembers.length === 0
  );
}
