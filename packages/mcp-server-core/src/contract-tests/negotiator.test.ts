/**
 * Exercises `negotiatorContract` against a minimal stub so the contract
 * itself is covered. No reference `V3Negotiator` ships from this
 * package yet — that promotion is a separate plan-delta step. This
 * test ensures the contract rules are satisfiable and that any future
 * adapter plugging into `negotiatorContract` immediately sees green on
 * a trivial-but-correct impl.
 */
import type {
  Negotiator,
  NegotiatorInput,
  NegotiatorResult,
} from '../negotiator.js';
import { negotiatorContract } from './negotiator.js';

class StubCreateNegotiator implements Negotiator {
  async negotiate(input: NegotiatorInput): Promise<NegotiatorResult> {
    // Intentionally ignore `input` entirely — the contract's mutation
    // check verifies we didn't change it, not that we consumed it.
    void input;
    return {
      decision: {
        action: 'create',
        reasoning: 'stub negotiator — always create',
        contract: {},
      },
      alternatives: [],
      embeddingLatencyMs: 0,
      searchLatencyMs: 0,
      decisionLatencyMs: 0,
    };
  }
}

negotiatorContract('StubCreateNegotiator', () => new StubCreateNegotiator());
