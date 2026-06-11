// oss/misc/benchmark/src/contract-synthesis/corpus.ts
//
// Contract-synthesis convergence corpus.
//
// Measures how quickly the REAL `synthesizeContract` (@ggui-ai/negotiator)
// converges on a spec-conforming `DataContract` — the pre-UI-gen step.
// The conformance gate is pure deterministic code (lintContract +
// structural/placement/coherence validators), so pass/fail is objective
// and reproducible even though the synthesis LLM is non-deterministic.
// The metric we drive down is `SynthesizeContractResult.attempts` (1..5).
//
// Two halves:
//   - COLD: synthesize from a natural-language intent alone (draft omitted).
//   - REPAIR: fix a deliberately-malformed agent draft in place (draft set).
//     Repair cases are the higher-value half — that's where iterations pile up.
//
// Each draft is typed `unknown` because that is exactly what
// `synthesizeContract`'s `options.draft` accepts: a raw, possibly-malformed
// agent proposal. Encoding the malformations honestly (a string where an
// object belongs, `type: 'list'` instead of `'array'`, etc.) is the point.

/** One contract-synthesis benchmark case. */
export interface ContractSynthCase {
  /** Stable id (used in reports + as a CLI filter). */
  readonly id: string;
  /**
   * Archetype the case exercises (counter, form, chat, weather, search,
   * mixed, stream-source, display, …). Reports aggregate per archetype.
   */
  readonly archetype: string;
  /** `cold` = synthesize from intent; `repair` = fix a malformed draft. */
  readonly mode: 'cold' | 'repair';
  /** Natural-language intent fed to the synthesizer. */
  readonly intent: string;
  /**
   * Raw agent draft for repair cases — passed verbatim as
   * `synthesizeContract(..., { draft })`. Intentionally malformed; typed
   * `unknown` to mirror the production signature. Omitted for cold cases.
   */
  readonly draft?: unknown;
  /**
   * Whether we expect a non-null conforming contract within the attempt
   * budget. Almost always true — a `false` would assert "this intent is
   * genuinely unsynthesizable" (none today).
   */
  readonly expectConverges: boolean;
  /**
   * Advisory target: the attempt count we'd like this case to stay at or
   * under. Reporting flags cases that exceed it. Not a hard gate.
   */
  readonly targetMaxAttempts: number;
  /** What malformation / shape this case probes. */
  readonly note: string;
}

// ── COLD PATH — synthesize from intent alone ────────────────────────────
// Healthy target: one-shot (attempts === 1) for every archetype.

const COLD_CASES: readonly ContractSynthCase[] = [
  {
    id: 'cold-counter',
    archetype: 'counter',
    mode: 'cold',
    intent:
      'A counter widget with increment and reset buttons that displays the current count.',
    expectConverges: true,
    targetMaxAttempts: 1,
    note: 'Empty-payload actions + a single context slot. Canonical actions-vs-context split.',
  },
  {
    id: 'cold-feedback-form',
    archetype: 'form',
    mode: 'cold',
    intent:
      'A feedback form with a name field, a multi-line comment field, and a submit button.',
    expectConverges: true,
    targetMaxAttempts: 1,
    note: 'Payload action (submit carries form data) + local draft context.',
  },
  {
    id: 'cold-live-chat',
    archetype: 'chat',
    mode: 'cold',
    intent:
      'A chat interface with a live-streaming message list and a text box to send a message.',
    expectConverges: true,
    targetMaxAttempts: 1,
    note: 'streamSpec (incoming messages) + payload action (send). Bidirectional.',
  },
  {
    id: 'cold-weather-card',
    archetype: 'display',
    mode: 'cold',
    intent:
      'A weather card showing the city, current temperature, humidity, wind speed, and a five-day forecast strip. All data comes from the agent.',
    expectConverges: true,
    targetMaxAttempts: 1,
    note: 'Pure passive propsSpec — no actions, no state, no streams.',
  },
  {
    id: 'cold-product-search',
    archetype: 'search',
    mode: 'cold',
    intent:
      'A search box that filters a list of products by name as the user types.',
    expectConverges: true,
    targetMaxAttempts: 1,
    note: 'Client-local filter state (context) over agent-provided list (props). No action needed.',
  },
  {
    id: 'cold-task-board',
    archetype: 'mixed',
    mode: 'cold',
    intent:
      'A task tool: add a task through a submit action, track the in-progress draft locally, and show the list of existing tasks provided by the agent.',
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'All three of propsSpec (tasks) + contextSpec (draft) + actionSpec (add). Hardest cold case.',
  },
  {
    id: 'cold-stock-ticker',
    archetype: 'stream',
    mode: 'cold',
    intent:
      'A live stock ticker that streams price updates for a set of symbols, colour-coded by gain or loss.',
    expectConverges: true,
    targetMaxAttempts: 1,
    note: 'streamSpec-dominant, no actions. Broadcast archetype.',
  },
  {
    id: 'cold-pricing-table',
    archetype: 'display',
    mode: 'cold',
    intent:
      'A pricing table comparing three subscription plans with their features and a select-plan button on each.',
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'propsSpec (plans) + payload action (selectPlan carries which plan).',
  },
];

// ── REPAIR PATH — fix a malformed agent draft in place ──────────────────
// The high-value half: each draft trips a specific deterministic validator,
// so it forces at least one repair iteration. Healthy target: repaired in
// ≤2 attempts. These map 1:1 to the failure modes lintContract +
// validateContractRedundancy / validateActionsVsContext / coherence catch.

const REPAIR_CASES: readonly ContractSynthCase[] = [
  {
    id: 'repair-schema-type-list',
    archetype: 'form',
    mode: 'repair',
    intent: 'A signup form collecting an email and a list of interests.',
    draft: {
      propsSpec: {
        properties: {
          // `list` is not a valid JSON-Schema type — must become `array`.
          interests: { schema: { type: 'list', items: { type: 'string' } } },
        },
      },
    },
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'Invalid JSON-Schema type (`list`→`array`). Schema-shape lint error.',
  },
  {
    id: 'repair-redundant-action',
    archetype: 'counter',
    mode: 'repair',
    intent: 'A counter with an increment button and a visible count.',
    draft: {
      // Empty-payload `increment` that mutates an existing context slot is a
      // redundant action — the client mutates context locally, no turn needed.
      actionSpec: { increment: { label: 'Increment' } },
      contextSpec: { count: { schema: { type: 'number' } } },
    },
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'redundant-action: empty-payload mutator duplicating a context slot.',
  },
  {
    id: 'repair-props-not-object',
    archetype: 'display',
    mode: 'repair',
    intent: 'A profile card showing a name and an avatar URL.',
    draft: {
      // propsSpec must be an object with `properties`, not a string.
      propsSpec: 'name and avatar',
    },
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'propsSpec is a string, not a spec object. Structural lint error.',
  },
  {
    id: 'repair-dangling-tool-ref',
    archetype: 'stream',
    mode: 'repair',
    intent: 'A live quotes panel streaming prices from a market-data tool.',
    draft: {
      streamSpec: {
        quotes: {
          schema: { type: 'object', properties: { price: { type: 'number' } } },
          // References a tool that is NOT declared in agentCapabilities.tools.
          source: { tool: 'fetch_quote' },
        },
      },
    },
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'CTR_REF_*: streamSpec.source.tool names an undeclared tool.',
  },
  {
    id: 'repair-name-collision',
    archetype: 'mixed',
    mode: 'repair',
    intent: 'A toggle that both reflects state and notifies the agent when flipped.',
    draft: {
      // Same key in actionSpec and contextSpec — a name collision.
      actionSpec: { active: { label: 'Toggle', schema: { type: 'object', properties: { on: { type: 'boolean' } } } } },
      contextSpec: { active: { schema: { type: 'boolean' } } },
    },
    expectConverges: true,
    targetMaxAttempts: 2,
    note: 'actions-vs-context name collision (same key in both specs).',
  },
  {
    id: 'repair-actionspec-only-data-intent',
    archetype: 'display',
    mode: 'repair',
    intent:
      'A leaderboard showing the top ten players with their scores and ranks.',
    draft: {
      // Intent is data-bearing but the draft has only an action and no data
      // surface — coherence validator rejects the degenerate shape.
      actionSpec: { refresh: { label: 'Refresh' } },
    },
    expectConverges: true,
    targetMaxAttempts: 3,
    note: 'incoherent-no-data-surface: data-bearing intent, actionSpec-only draft.',
  },
];

/** The full contract-synthesis corpus (cold + repair). */
export const CONTRACT_SYNTH_CORPUS: readonly ContractSynthCase[] = [
  ...COLD_CASES,
  ...REPAIR_CASES,
];

/** Look up a case by id (CLI `--case` filter). */
export function getCaseById(id: string): ContractSynthCase | undefined {
  return CONTRACT_SYNTH_CORPUS.find((c) => c.id === id);
}
