/**
 * Negotiator — UI decision engine.
 *
 * Given the agent's signal (data / prompt / context / agentTools) and
 * the current render-history snapshot, produces a
 * {@link NegotiatorDecision} with optional RAG-backed blueprint match,
 * alternatives, and timing breakdown.
 *
 * The `NegotiatorDecision` shape is already public in `@ggui-ai/protocol`
 * (`create` / `update` / `compose` / `replace`). This seam lifts the
 * _engine_ itself into a public contract so self-hosters can either use
 * the reference `V3Negotiator` (OSS) or plug their own.
 *
 * Reference implementations:
 *   - V3Negotiator    (OSS reference; intent → RAG search → LLM decision)
 *   - RulesNegotiator (optional; no LLM; pure blueprint-id routing)
 *
 * There is no closed-source variant — the hosted runtime uses the same
 * V3 engine internally. Decision semantics are kept open; they are
 * protocol-adjacent.
 */
import type {
  InterfaceContext,
  NegotiatorAlternative,
  NegotiatorDecision,
} from '@ggui-ai/protocol';

/**
 * Negotiator-facing snapshot of the current render(s) the agent has
 * already produced for the current host conversation, plus the running
 * transcript. Promoted here as a public surface so self-hosters can
 * implement custom negotiators. Kept narrow — the negotiator only
 * needs prior render outlines + conversation, not the full
 * `StoredRender`.
 */
export interface NegotiatorRenderState {
  /**
   * Previously-committed renders for the same host conversation,
   * ordered oldest to newest. Most calls supply at most one (the
   * just-superseded render); multi-render contexts arise when the
   * agent has rendered several siblings in a row.
   */
  stack: Array<{
    id: string;
    prompt?: string;
    /**
     * Loose shape — the negotiator only inspects `.intent` and top-level
     * `.props`. Typed as `Record<string, unknown>` rather than re-exporting
     * the full `DataContract` type so this seam does not re-export
     * protocol contract types callers can import directly.
     */
    contract?: Record<string, unknown>;
    componentCode?: string;
  }>;

  /** Turn-by-turn transcript seen by the agent. */
  conversationHistory: Array<{
    role: 'user' | 'agent';
    content: string;
  }>;

  /** Optional rendering-surface context — shell type, viewport, etc. */
  interfaceContext?: InterfaceContext;
}

export interface NegotiatorInput {
  /** Agent-supplied data payload. */
  agentData?: Record<string, unknown>;
  /** Agent-supplied natural-language request. */
  agentPrompt?: string;
  /** Agent-supplied context (string narrative or structured). */
  agentContext?: string | Record<string, unknown>;
  /**
   * MCP tools the AGENT invokes (catalog seed). The negotiator merges
   * these into the resulting contract's `agentTools.tools` catalog.
   * The component never calls these; cross-references surface via
   * `actionSpec[*].nextStep` and `streamSpec[*].source.tool`.
   *
   * Renamed from `wiredTools` 2026-05-11.
   */
  agentTools?: string[];
  /** Current render state. */
  renderState: NegotiatorRenderState;
  /** Tenant + RAG scope keys. */
  scope: {
    appId: string;
    renderId: string;
  };
  /** 'shared' = global catalog; 'private' = per-app index. Default 'shared'. */
  poolMode?: 'shared' | 'private';
  /** How opinionated the negotiator should be. Default 'opinionated'. */
  opinionLevel?: 'opinionated' | 'suggestive' | 'passive';
}

export interface NegotiatorResult {
  /** The negotiator's committed decision. */
  decision: NegotiatorDecision;
  /** Other candidates the negotiator considered, ordered by confidence. */
  alternatives: NegotiatorAlternative[];
  /** Deterministic cache key from the matched blueprint's contract, if any. */
  storedContractHash?: string;
  /** Which pool the matched blueprint lives in. */
  storedPoolSource?: 'shared' | 'private';
  /** Timing breakdown (ms). */
  embeddingLatencyMs: number;
  searchLatencyMs: number;
  decisionLatencyMs: number;
}

export interface Negotiator {
  /**
   * Decide how to render for this turn. Implementations MUST:
   *
   * - Never mutate the `input` argument.
   * - Populate `timingMs` fields even on fast paths (use `0` for skipped steps).
   * - Return `decision.action = "create"` when no reasonable alternative
   *   exists, rather than throwing — the caller treats `NegotiatorResult`
   *   as authoritative.
   */
  negotiate(input: NegotiatorInput): Promise<NegotiatorResult>;
}
