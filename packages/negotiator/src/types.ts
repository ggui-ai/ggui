/**
 * Negotiator types — open RAG-result projection shape.
 *
 * `NegotiatorOption` is the projected result shape `ragSearch`
 * returns: one entry per candidate blueprint, with the contract
 * + pro/con reasoning + pool provenance. The V3 decision engine
 * reads these to populate `NegotiatorDecisionInput.blueprintCandidates`.
 *
 * `DataContract` is imported from `@ggui-ai/protocol` (already
 * public). Do NOT re-export it — callers should import contract
 * types from the protocol package directly.
 */

import type { DataContract } from '@ggui-ai/protocol';

/** RAG-projected blueprint option surfaced to the decision engine. */
export interface NegotiatorOption {
  id: string;
  type: 'brainstorm' | 'blueprint';
  pattern?: string;
  blueprintId?: string;
  description: string;
  pros: string[];
  cons: string[];
  renderTime: 'instant' | 'standard';
  contract: DataContract;
  /** Stored contract hash from embedding index — deterministic pool key. */
  contractHash?: string;
  /** Which pool this blueprint's code lives in. */
  poolSource?: 'shared' | 'private';
}
