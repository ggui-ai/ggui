/**
 * Hand-labeled seed/probe pairs for the blueprint match-precision
 * probe (`run-probe.ts` in this directory).
 *
 * LABELING DISCIPLINE (read before adding a pair):
 *
 * - Ground truth is HAND-labeled. Never derive a gold label from an
 *   LLM — the matcher's own verdict comes from an LLM judge, and a
 *   model grading itself is not a measurement.
 * - Every pair carries TWO levels of truth:
 *     `expect`  — the MATCHER-verdict expectation (hit/miss, and
 *                 optionally which strategy/decision bucket). Recall
 *                 is scored on should-hit pairs against this level.
 *     `reuseWouldBeWrong` — SYSTEM-level truth: if the matcher DID
 *                 propose reuse here, would the reused surface be
 *                 wrong for the user (given the agent also sees
 *                 COVERAGE_GAP findings and may override)? Precision
 *                 is scored on hits against this level. The two levels
 *                 differ deliberately: under the similarity-only judge
 *                 philosophy, field-count deltas are hit-with-findings,
 *                 not misses.
 * - `tier: 'gated'` pairs count toward pass/fail metrics.
 *   `tier: 'debated'` pairs are genuinely ambiguous — they are scored
 *   for judge STABILITY (repeat agreement) only, never correctness.
 *   Promoting a debated pair to gated requires a recorded ruling in
 *   the experiment ledger, not an edit here.
 * - The judge philosophy these labels encode is the CURRENT prompt
 *   (similarity-only, coverage-blind): MATCH = same intended user
 *   task AND same broad UI shape; added/omitted fields, paraphrase,
 *   and visual style never block; NO-MATCH = different task, different
 *   UI shape, or a conflicting load-bearing fixed value. If that
 *   prompt changes, these labels must be re-adjudicated — record the
 *   sweep in the experiment ledger.
 *
 * Experiment: rnd/gen-ui/economy/experiments/001-match-precision-instrument.md
 */
import type { DataContract, BlueprintVariance } from '@ggui-ai/protocol';

export interface PairSeed {
  readonly intent: string;
  readonly contract: DataContract;
  readonly variance?: BlueprintVariance;
}

export interface MatchPair {
  readonly id: string;
  /** Taxonomy class, for per-class aggregation in the report. */
  readonly klass:
    | 'tier1-invariance'
    | 'tier1-boundary'
    | 'semantic-should-hit'
    | 'semantic-must-miss'
    | 'debated';
  readonly tier: 'gated' | 'debated';
  /** Rows registered before the probe fires (first is the "expected" hit target where one exists). */
  readonly seeds: readonly PairSeed[];
  /** The ask under test. */
  readonly probe: {
    readonly intent: string;
    readonly contract?: DataContract;
    readonly variance?: BlueprintVariance;
  };
  readonly expect: {
    readonly verdict: 'hit' | 'miss';
    /** When set, the strategy the hit MUST come from (or must NOT, prefixed '!'). */
    readonly strategy?: 'exact-key' | 'semantic' | '!exact-key';
    /** When set, the exact cache-trace decision bucket expected. */
    readonly decision?: string;
  };
  /** System-level truth: would reuse here be WRONG for the user? */
  readonly reuseWouldBeWrong: boolean;
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Shared contract material. Compact but realistic shapes; where a pair
// needs a delta, the variant is authored inline next to its pair so the
// delta is reviewable in one screen.
// ---------------------------------------------------------------------------

const TODO: DataContract = {
  propsSpec: {
    properties: { todos: { required: true, schema: { type: 'array' } } },
  },
  actionSpec: {
    addTodo: { label: 'Add todo item' },
    toggleTodo: {
      label: 'Toggle',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  },
};

const COUNTER: DataContract = {
  contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
  actionSpec: {
    increment: { label: 'Increment' },
    reset: { label: 'Reset' },
  },
};

const WEATHER: DataContract = {
  propsSpec: {
    properties: {
      city: { required: true, schema: { type: 'string' } },
      tempF: { required: true, schema: { type: 'number' } },
      conditions: { required: true, schema: { type: 'string' } },
    },
  },
};

const FEEDBACK_FORM: DataContract = {
  contextSpec: {
    rating: { schema: { type: 'number' }, default: 0 },
    comment: { schema: { type: 'string' }, default: '' },
  },
  actionSpec: {
    submitFeedback: {
      label: 'Submit feedback',
      schema: {
        type: 'object',
        properties: {
          rating: { type: 'number' },
          comment: { type: 'string' },
        },
        required: ['rating'],
      },
    },
  },
};

const CALENDAR: DataContract = {
  propsSpec: {
    properties: {
      month: { required: true, schema: { type: 'string' } },
      events: { required: true, schema: { type: 'array' } },
    },
  },
  actionSpec: {
    selectDay: {
      label: 'Select day',
      schema: {
        type: 'object',
        properties: { date: { type: 'string' } },
        required: ['date'],
      },
    },
  },
};

const STUB_CODE = 'export default () => null;';

/** Convenience: a seed with the shared stub component body. */
function seed(intent: string, contract: DataContract, variance?: BlueprintVariance): PairSeed {
  return variance === undefined ? { intent, contract } : { intent, contract, variance };
}

export { STUB_CODE };

// ---------------------------------------------------------------------------
// Tier 1 — canonicalization invariances (deterministic; no LLM should run).
// These gate the CANONICALIZER, not the judge: the exact key must be
// insensitive to key order, stripped prose, NFC form, and empty-variance
// elision — and sensitive to enum order, variance seedPrompt, and
// required flips.
// ---------------------------------------------------------------------------

export const PAIRS: readonly MatchPair[] = [
  {
    id: 't1-key-reorder',
    klass: 'tier1-invariance',
    tier: 'gated',
    seeds: [seed('my todo items', TODO)],
    probe: {
      intent: 'my todo items',
      // Same contract, object keys authored in a different order — JCS
      // canonicalization must make this byte-identical.
      contract: {
        actionSpec: {
          toggleTodo: {
            schema: {
              required: ['id'],
              properties: { id: { type: 'string' } },
              type: 'object',
            },
            label: 'Toggle',
          },
          addTodo: { label: 'Add todo item' },
        },
        propsSpec: {
          properties: { todos: { schema: { type: 'array' }, required: true } },
        },
      },
    },
    expect: { verdict: 'hit', strategy: 'exact-key' },
    reuseWouldBeWrong: false,
    rationale: 'Key order is serialization noise; RFC 8785 sort must collapse it.',
  },
  {
    id: 't1-prose-edit',
    klass: 'tier1-invariance',
    tier: 'gated',
    seeds: [
      seed('team feedback form', {
        ...FEEDBACK_FORM,
        actionSpec: {
          submitFeedback: {
            ...FEEDBACK_FORM.actionSpec!.submitFeedback,
            description: 'Submits the feedback to the server.',
          },
        },
      } as DataContract),
    ],
    probe: {
      intent: 'team feedback form',
      contract: {
        ...FEEDBACK_FORM,
        actionSpec: {
          submitFeedback: {
            ...FEEDBACK_FORM.actionSpec!.submitFeedback,
            description: 'Sends the user rating and comment upstream.',
          },
        },
      } as DataContract,
    },
    expect: { verdict: 'hit', strategy: 'exact-key' },
    reuseWouldBeWrong: false,
    rationale: 'Description prose is stripped by canonicalization; only shapes are identity.',
  },
  {
    id: 't1-empty-variance-elision',
    klass: 'tier1-invariance',
    tier: 'gated',
    seeds: [seed('a counter widget', COUNTER)],
    probe: {
      intent: 'a counter widget',
      contract: COUNTER,
      variance: {},
    },
    expect: { verdict: 'hit', strategy: 'exact-key' },
    reuseWouldBeWrong: false,
    rationale: 'D9 empty-elision: {} variance and absent variance hash to the same default variant.',
  },
  {
    id: 't1-enum-reorder',
    klass: 'tier1-boundary',
    tier: 'gated',
    seeds: [
      seed('priority picker', {
        contextSpec: {
          priority: {
            schema: { type: 'string', enum: ['low', 'medium', 'high'] },
            default: 'medium',
          },
        },
      }),
    ],
    probe: {
      intent: 'priority picker',
      contract: {
        contextSpec: {
          priority: {
            schema: { type: 'string', enum: ['high', 'medium', 'low'] },
            default: 'medium',
          },
        },
      },
    },
    // Enum ORDER is identity (order matters for select UIs) — the exact
    // key MUST miss. Whether the semantic path should then reuse is
    // genuinely debatable, so this pair gates ONLY the not-exact half.
    expect: { verdict: 'hit', strategy: '!exact-key' },
    reuseWouldBeWrong: false,
    rationale: 'Reordered enum must break exact identity; semantic reuse afterwards is acceptable (same task/shape).',
  },
  {
    id: 't1-seedprompt-variance',
    klass: 'tier1-boundary',
    tier: 'gated',
    seeds: [
      seed('a counter widget', COUNTER, {
        seedPrompt: 'brutalist concrete aesthetic, oversized digits',
      }),
    ],
    probe: {
      intent: 'a counter widget',
      contract: COUNTER,
      variance: { seedPrompt: 'soft pastel rounded look' },
    },
    expect: { verdict: 'hit', strategy: '!exact-key' },
    reuseWouldBeWrong: false,
    rationale: 'seedPrompt prose is load-bearing variance — different prompts are different variants by design; exact must miss.',
  },
  {
    id: 't1-required-flip',
    klass: 'tier1-boundary',
    tier: 'gated',
    seeds: [seed('weather card', WEATHER)],
    probe: {
      intent: 'weather card',
      contract: {
        propsSpec: {
          properties: {
            city: { required: true, schema: { type: 'string' } },
            tempF: { required: true, schema: { type: 'number' } },
            conditions: { required: false, schema: { type: 'string' } },
          },
        },
      },
    },
    expect: { verdict: 'hit', strategy: '!exact-key' },
    reuseWouldBeWrong: false,
    rationale: 'required flags are identity — exact must miss; semantic reuse of the same card afterwards is correct.',
  },

  // -------------------------------------------------------------------------
  // Tier 2 — semantic SHOULD-HIT (gated on verdict=hit).
  // -------------------------------------------------------------------------
  {
    id: 's-paraphrase',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('a counter widget', COUNTER)],
    probe: {
      intent: 'simple tally counter with a plus button and a reset',
      contract: {
        contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
        actionSpec: {
          increment: { label: 'Add one' },
          reset: { label: 'Start over' },
        },
      },
    },
    expect: { verdict: 'hit', strategy: 'semantic' },
    reuseWouldBeWrong: false,
    rationale: 'Same task, same shape, reworded intent + relabeled actions — the core reuse promise.',
  },
  {
    id: 's-contractless-recall',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('team feedback form with a star rating and comment box', FEEDBACK_FORM)],
    probe: {
      intent: 'feedback form where users rate us and leave a comment',
      // No contract at all — the pure-semantic path an agent without a
      // draft takes.
    },
    expect: { verdict: 'hit', strategy: 'semantic' },
    reuseWouldBeWrong: false,
    rationale: 'Draft-less ask for the same surface must recall the cached shape.',
  },
  {
    id: 's-optional-superset',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('weather card for a city', WEATHER)],
    probe: {
      intent: 'weather card for a city',
      contract: {
        propsSpec: {
          properties: {
            city: { required: true, schema: { type: 'string' } },
            tempF: { required: true, schema: { type: 'number' } },
            conditions: { required: true, schema: { type: 'string' } },
            tempC: { required: false, schema: { type: 'number' } },
          },
        },
      },
    },
    expect: { verdict: 'hit', strategy: 'semantic' },
    reuseWouldBeWrong: false,
    rationale: 'One added optional prop — the calibration suite’s regression anchor; hit-with-gap, never a miss.',
  },
  {
    id: 's-subset',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('weather card for a city', WEATHER)],
    probe: {
      intent: 'compact weather card, just city and temperature',
      contract: {
        propsSpec: {
          properties: {
            city: { required: true, schema: { type: 'string' } },
            tempF: { required: true, schema: { type: 'number' } },
          },
        },
      },
    },
    expect: { verdict: 'hit', strategy: 'semantic' },
    reuseWouldBeWrong: false,
    rationale: 'Fewer fields, same task/shape — subset reuse is the philosophy’s explicit MATCH case.',
  },
  {
    id: 's-cosmetic-variance',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('sleek dark dashboard-style counter', COUNTER)],
    probe: {
      intent: 'light, minimal, friendly counter',
      contract: COUNTER,
    },
    expect: { verdict: 'hit' },
    reuseWouldBeWrong: false,
    rationale: 'Visual style is explicitly ignored by the judge; same contract seals it. (Strategy unpinned: identical contract may exact-hit.)',
  },
  {
    id: 's-label-noise',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('my todo items', TODO)],
    probe: {
      intent: 'my todo items',
      contract: {
        propsSpec: {
          properties: { todos: { required: true, schema: { type: 'array' } } },
        },
        actionSpec: {
          addTodo: { label: 'Add a new todo item' },
          toggleTodo: {
            label: "Toggle a todo's done state",
            schema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      },
    },
    expect: { verdict: 'hit' },
    reuseWouldBeWrong: false,
    rationale: 'Pure label noise (cache-reuse-probe scenario 1a). Labels may or may not be exact-identity — verdict gated, strategy left free.',
  },
  {
    id: 's-payload-delta',
    klass: 'semantic-should-hit',
    tier: 'gated',
    seeds: [seed('my todo items', TODO)],
    probe: {
      intent: 'my todo items',
      contract: {
        propsSpec: {
          properties: { todos: { required: true, schema: { type: 'array' } } },
        },
        actionSpec: {
          addTodo: { label: 'Add a new todo item' },
          toggleTodo: {
            label: "Toggle a todo's done state",
            schema: {
              type: 'object',
              properties: { id: { type: 'string' }, done: { type: 'boolean' } },
              required: ['id', 'done'],
            },
          },
        },
      },
    },
    expect: { verdict: 'hit', strategy: 'semantic' },
    reuseWouldBeWrong: false,
    rationale: 'Payload field added to one action (probe scenario 1b) — field deltas never block under Path-A; surfaced as findings.',
  },

  // -------------------------------------------------------------------------
  // Tier 2 — semantic MUST-MISS (gated on verdict=miss). A hit on any of
  // these is a FALSE HIT — the class that paints the wrong surface.
  // -------------------------------------------------------------------------
  {
    id: 'm-task-same-vocab',
    klass: 'semantic-must-miss',
    tier: 'gated',
    seeds: [seed('my todo items', TODO)],
    probe: {
      intent: 'shopping cart checkout with item list and remove buttons',
      contract: {
        propsSpec: {
          properties: {
            items: { required: true, schema: { type: 'array' } },
            totalUsd: { required: true, schema: { type: 'number' } },
          },
        },
        actionSpec: {
          removeItem: {
            label: 'Remove from cart',
            schema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
          checkout: { label: 'Checkout' },
        },
      },
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: true,
    rationale: 'Shared list/add/remove vocabulary, different user task (task management vs purchasing) — a todo surface for a checkout ask is wrong.',
  },
  {
    id: 'm-ui-shape',
    klass: 'semantic-must-miss',
    tier: 'gated',
    seeds: [seed('my schedule as a flat list of upcoming events', {
      propsSpec: {
        properties: { events: { required: true, schema: { type: 'array' } } },
      },
    })],
    probe: {
      intent: 'my schedule as a month calendar grid',
      contract: CALENDAR,
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: true,
    rationale: 'Same domain (schedule), different broad UI shape (flat list vs month grid) — the prompt’s explicit NO-MATCH case.',
  },
  {
    id: 'm-fixed-value-intent-only',
    klass: 'semantic-must-miss',
    tier: 'gated',
    seeds: [
      seed('calendar of January 2026 with the launch-week events pinned', {
        // Deliberately NO month prop: the month exists ONLY in intent
        // prose, so a generated component can only ever bake it in —
        // reuse for a different month is guaranteed-wrong.
        propsSpec: {
          properties: { events: { required: true, schema: { type: 'array' } } },
        },
        actionSpec: CALENDAR.actionSpec,
      }),
    ],
    probe: {
      intent: 'calendar of March 2026 with the launch-week events pinned',
      // Contract differs trivially (an optional highlight prop) so the
      // EXACT key misses and the ask actually reaches the judge — run 1
      // proved an identical contract short-circuits at exact-key and the
      // judge is never consulted (ledgered as F1).
      contract: {
        propsSpec: {
          properties: {
            events: { required: true, schema: { type: 'array' } },
            highlightToday: { required: false, schema: { type: 'boolean' } },
          },
        },
        actionSpec: CALENDAR.actionSpec,
      },
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: true,
    rationale:
      'Conflicting load-bearing fixed value (January vs March) that lives ONLY in intent prose — with no month prop, the cached surface can only be the wrong month. Contract delta forces the semantic path (H2 target, now actually reachable).',
  },
  {
    id: 'd-fixed-value-prop-carried',
    klass: 'debated',
    tier: 'debated',
    seeds: [seed('calendar of January 2026 with the launch-week events pinned', CALENDAR)],
    probe: {
      intent: 'calendar of March 2026 with the launch-week events pinned',
      contract: CALENDAR,
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: false,
    rationale:
      "Run-1 lesson (was gated must-miss; demoted): `month` is a REQUIRED PROP here, so a correctly-generated component re-renders March from props and reuse is arguably RIGHT — the identical contract exact-hits at cosine 1.0 without a judge. Whether generation bakes intent values despite prop-carriage is a generation-side question, not a matcher one.",
  },
  {
    id: 'm-form-vs-dashboard',
    klass: 'semantic-must-miss',
    tier: 'gated',
    seeds: [seed('team feedback form', FEEDBACK_FORM)],
    probe: {
      intent: 'dashboard of feedback analytics: average rating over time and comment volume',
      contract: {
        propsSpec: {
          properties: {
            avgRating: { required: true, schema: { type: 'number' } },
            ratingHistory: { required: true, schema: { type: 'array' } },
            commentCount: { required: true, schema: { type: 'number' } },
          },
        },
      },
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: true,
    rationale: 'Same domain vocabulary (feedback, rating), input form vs read-only analytics — different task AND shape.',
  },
  {
    id: 'm-crossdomain-farmiss',
    klass: 'semantic-must-miss',
    tier: 'gated',
    seeds: [seed('weather card for a city', WEATHER)],
    probe: {
      intent: 'invoice line-item table with subtotal, tax and grand total',
      contract: {
        propsSpec: {
          properties: {
            lineItems: { required: true, schema: { type: 'array' } },
            taxUsd: { required: true, schema: { type: 'number' } },
            totalUsd: { required: true, schema: { type: 'number' } },
          },
        },
      },
    },
    // Run-1 lesson: real bge-small geometry puts even this cross-domain
    // far miss at cosine 0.726 — the 0.2 gate NEVER fires in practice
    // (dead code; every candidate reaches the judge; ledgered as F2).
    // The judge caught it at 0.00. Expectation corrected to the judge
    // bucket; the pair now guards "far misses still die SOMEWHERE".
    expect: { verdict: 'miss', decision: 'no-match' },
    reuseWouldBeWrong: true,
    rationale: 'Unrelated domain and shape — must miss; in real geometry that means the judge, the cosine gate being dead (F2).',
  },
  {
    id: 'm-live-vs-click-search',
    klass: 'semantic-must-miss',
    tier: 'gated',
    seeds: [
      seed('search box that filters the result list as you type', {
        contextSpec: { query: { schema: { type: 'string' }, default: '' } },
        propsSpec: {
          properties: { results: { required: true, schema: { type: 'array' } } },
        },
      }),
    ],
    probe: {
      intent: 'search form with a query field and a Search button that fetches results on click',
      contract: {
        contextSpec: { query: { schema: { type: 'string' }, default: '' } },
        actionSpec: {
          runSearch: {
            label: 'Search',
            schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
          },
        },
        propsSpec: {
          properties: { results: { required: true, schema: { type: 'array' } } },
        },
      },
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: true,
    rationale:
      'Live-filter vs click-to-search are different interaction patterns (the synth corpus treats them as distinct shapes); a live-filter surface cannot honor the submit contract.',
  },

  // -------------------------------------------------------------------------
  // DEBATED — scored for judge stability (repeat agreement) only; never
  // for correctness. Promotion to gated requires a ledger ruling.
  // -------------------------------------------------------------------------
  {
    id: 'd-table-domains',
    klass: 'debated',
    tier: 'debated',
    seeds: [
      seed('inventory table', {
        propsSpec: {
          properties: {
            columns: { required: true, schema: { type: 'array' } },
            rows: { required: true, schema: { type: 'array' } },
          },
        },
      }),
    ],
    probe: {
      intent: 'user directory table',
      contract: {
        propsSpec: {
          properties: {
            columns: { required: true, schema: { type: 'array' } },
            rows: { required: true, schema: { type: 'array' } },
          },
        },
      },
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: false,
    rationale:
      'Identical generic table summaries, different domain data — kept with IDENTICAL contracts deliberately: this pair documents the exact-key face of the debate (run 1: exact-hit at cosine 1.0, judge never consulted). A generic table arguably serves both.',
  },
  {
    id: 'd-calculator-tier',
    klass: 'debated',
    tier: 'debated',
    seeds: [
      seed('basic calculator', {
        contextSpec: { display: { schema: { type: 'string' }, default: '0' } },
        actionSpec: {
          pressKey: {
            label: 'Press key',
            schema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        },
      }),
    ],
    probe: {
      intent: 'scientific calculator with trig functions',
      contract: {
        contextSpec: {
          display: { schema: { type: 'string' }, default: '0' },
          // Trivial delta so exact-key misses and the judge actually
          // runs (run-1 lesson: identical contracts short-circuit).
          angleUnit: { schema: { type: 'string' }, default: 'deg' },
        },
        actionSpec: {
          pressKey: {
            label: 'Press key',
            schema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        },
      },
    },
    expect: { verdict: 'miss' },
    reuseWouldBeWrong: false,
    rationale:
      'Identical contract, different button set implied only by intent. Is a basic keypad "the same broad UI shape" as a scientific one? Unresolved.',
  },
  {
    id: 'd-wizard-steps',
    klass: 'debated',
    tier: 'debated',
    seeds: [
      seed('3-step onboarding wizard: account, profile, confirm', {
        contextSpec: { step: { schema: { type: 'number' }, default: 0 } },
        actionSpec: {
          nextStep: { label: 'Next' },
          prevStep: { label: 'Back' },
          finish: { label: 'Finish' },
        },
      }),
    ],
    probe: {
      intent: '5-step onboarding wizard: account, profile, team, billing, confirm',
      contract: {
        contextSpec: {
          step: { schema: { type: 'number' }, default: 0 },
          // Trivial delta — same run-1 lesson as d-calculator-tier.
          totalSteps: { schema: { type: 'number' }, default: 5 },
        },
        actionSpec: {
          nextStep: { label: 'Next' },
          prevStep: { label: 'Back' },
          finish: { label: 'Finish' },
        },
      },
    },
    expect: { verdict: 'hit' },
    reuseWouldBeWrong: false,
    rationale:
      'Step COUNT lives in intent prose; the wizard chrome is identical. Fixed-value conflict or cosmetic delta? Unresolved — stability only.',
  },
] as const;
