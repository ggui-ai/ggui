/**
 * `NegotiatorDecisionInput` — the full input to `makeDecision`.
 *
 * Kept in its own file so a typed re-export shim in
 * `core/negotiation/src/types.ts` can keep the legacy import path
 * alive without pulling the (bigger, commit-5) decision runtime
 * into a types-only import.
 *
 * The `blueprintCandidates` entry shape is inlined intentionally —
 * those five fields are the only projection `makeDecision` reads
 * from a `NegotiatorOption`; extracting a named type here would
 * grow public surface for no consumer.
 *
 * `renderState` is the decision engine's view of the live render
 * (at most ONE current render — see {@link RenderState.currentRender}).
 */

import type { GadgetDescriptor, DataContract } from '@ggui-ai/protocol';
import type { RenderState } from './render.js';

/** Input to the decision engine. */
export interface NegotiatorDecisionInput {
  agentData?: Record<string, unknown>;
  agentPrompt?: string;
  agentContext?: string | Record<string, unknown>;
  /**
   * MCP tools the AGENT invokes (catalog seed). The decision engine
   * merges these into the resulting contract's
   * `agentCapabilities.tools` catalog. Cross-references are authored
   * by the LLM: the catalog is referenced from
   * `actionSpec[*].nextStep` (post-action hint for the agent's next
   * turn) and `streamSpec[*].source.tool` (channel data source). The
   * component never calls these.
   */
  agentTools?: string[];
  /**
   * Browser-capability gadget catalog declared for the app. The
   * handshake handler reads this from `app.gadgets` and
   * threads it here so the decision LLM knows which gadget bindings
   * the produced UI may reference (and so the merge step can enrich
   * partial LLM output with canonical entries from the catalog).
   */
  gadgets?: readonly GadgetDescriptor[];
  renderState: RenderState;
  blueprintCandidates: Array<{
    blueprintId: string;
    description: string;
    contract?: DataContract;
    similarity: number;
    verdict: 'exact' | 'partial';
  }>;
}
