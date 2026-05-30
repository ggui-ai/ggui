/**
 * Blueprint coverage guard — the deterministic safety floor for reusing
 * a cached blueprint against a contract-bearing request.
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
 * make: it drops any candidate that fails to cover the request BEFORE
 * the judge runs, so an incomplete blueprint is never reused.
 *
 * Pure — no store, no LLM. Compares only declared key-SETS; differences
 * WITHIN a shared surface (a relabeled action, an `id` vs `id+done`
 * payload schema) are tolerated, because atomic reuse hands the agent
 * the cached contract and it drives that contract, not its own draft.
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
    gap.gadgets.length === 0
  );
}
