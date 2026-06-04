/**
 * Contract test factory for {@link Negotiator} implementations.
 *
 * Normative semantics covered:
 *   - `negotiate(input)` never throws on well-formed input. Failure
 *     surfaces as a decision with `action = "create"` per the
 *     interface docstring.
 *   - `input` is never mutated.
 *   - Timing fields are populated (zero is allowed for skipped steps).
 *   - The returned `decision.action` is one of the four protocol
 *     values: `create` | `update` | `compose` | `replace`.
 *
 * Decision _quality_ (did it pick the right blueprint? did intent map
 * correctly?) is implementation-specific and not part of this contract.
 * A `RulesNegotiator` that always returns `create` passes this suite
 * as legitimately as `V3Negotiator`.
 */
import { describe, expect, it } from 'vitest';
import type {
  Negotiator,
  NegotiatorInput,
  NegotiatorRenderState,
} from '../negotiator.js';

export function negotiatorContract(
  label: string,
  makeNegotiator: () => Promise<Negotiator> | Negotiator,
): void {
  describe(`Negotiator contract — ${label}`, () => {
    const emptyRender: NegotiatorRenderState = {
      stack: [],
      conversationHistory: [],
    };

    const baseInput: NegotiatorInput = {
      agentPrompt: 'Show current weather for Tokyo',
      renderState: emptyRender,
      scope: { appId: 'app-a', renderId: 'r1' },
    };

    it('returns a well-formed result for a minimal valid input', async () => {
      const n = await makeNegotiator();
      const result = await n.negotiate(baseInput);
      expect(result).toBeDefined();
      expect(result.decision).toBeDefined();
      expect(result.decision.action).toMatch(/^(create|update|compose|replace)$/);
      expect(result.alternatives).toBeInstanceOf(Array);
    });

    it('populates timing fields (zero permitted)', async () => {
      const n = await makeNegotiator();
      const result = await n.negotiate(baseInput);
      expect(typeof result.embeddingLatencyMs).toBe('number');
      expect(typeof result.searchLatencyMs).toBe('number');
      expect(typeof result.decisionLatencyMs).toBe('number');
      expect(result.embeddingLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.searchLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.decisionLatencyMs).toBeGreaterThanOrEqual(0);
    });

    it('does not mutate the input', async () => {
      const n = await makeNegotiator();
      const input: NegotiatorInput = {
        agentPrompt: 'Show weather',
        renderState: { stack: [], conversationHistory: [] },
        scope: { appId: 'app-a', renderId: 'r1' },
        agentTools: ['weather.lookup'],
      };
      const snapshot = JSON.stringify(input);
      await n.negotiate(input);
      expect(JSON.stringify(input)).toBe(snapshot);
    });
  });
}
