/**
 * Deterministic structure-only bench.
 *
 * Runs WITHOUT an LLM. Two roles:
 *
 *   1. Corpus integrity — every BENCH_CORPUS entry has internally
 *      consistent expected shape (no actionNames declared while
 *      hasActionSpec=false, etc.). Catches author errors before they
 *      poison the live LLM probe.
 *
 *   2. Scorer pinning — synthetic "good shape" / "bad shape" contracts
 *      compared against representative entries score the way the
 *      discrimination rule says they should. This pins the scorer's
 *      semantics so a regression in scoreSynthesizedContract surfaces
 *      in CI without burning LLM cost.
 *
 *   3. Validator alignment — the redundant-action validator fires on
 *      the load-bearing counter-bug shape and stays silent on the
 *      preferred shape. The bench's redundantActionFindings counter
 *      moves accordingly.
 */

import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { BENCH_CORPUS, contractShape } from './corpus.js';
import {
  scoreSynthesizedContract,
  summarize,
  type BenchOutcome,
} from './run-bench.js';
import { validateContractStructure } from '../contract-validators.js';

describe('synth-bench corpus integrity', () => {
  it('loads at least 50 entries', () => {
    expect(BENCH_CORPUS.length).toBeGreaterThanOrEqual(50);
  });

  it('every entry has a unique id', () => {
    const ids = BENCH_CORPUS.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('every entry has a non-empty intent', () => {
    for (const entry of BENCH_CORPUS) {
      expect(entry.intent.trim().length).toBeGreaterThan(0);
    }
  });

  it('actionNames is only declared when hasActionSpec is true', () => {
    for (const entry of BENCH_CORPUS) {
      if (
        entry.expected.actionNames !== undefined &&
        entry.expected.actionNames.length > 0
      ) {
        expect(
          entry.expected.hasActionSpec,
          `entry ${entry.id} declares actionNames but hasActionSpec=false`,
        ).toBe(true);
      }
    }
  });

  it('contextSlots is only declared when hasContextSpec is true', () => {
    for (const entry of BENCH_CORPUS) {
      if (
        entry.expected.contextSlots !== undefined &&
        entry.expected.contextSlots.length > 0
      ) {
        expect(
          entry.expected.hasContextSpec,
          `entry ${entry.id} declares contextSlots but hasContextSpec=false`,
        ).toBe(true);
      }
    }
  });

  it('capabilityHooks is only declared when hasClientCapabilities is true', () => {
    for (const entry of BENCH_CORPUS) {
      if (
        entry.expected.capabilityHooks !== undefined &&
        entry.expected.capabilityHooks.length > 0
      ) {
        expect(
          entry.expected.hasClientCapabilities,
          `entry ${entry.id} declares capabilityHooks but hasClientCapabilities is not true`,
        ).toBe(true);
      }
    }
  });

  it('agentToolNames is only declared when hasAgentTools is true', () => {
    for (const entry of BENCH_CORPUS) {
      if (
        entry.expected.agentToolNames !== undefined &&
        entry.expected.agentToolNames.length > 0
      ) {
        expect(
          entry.expected.hasAgentTools,
          `entry ${entry.id} declares agentToolNames but hasAgentTools is not true`,
        ).toBe(true);
      }
    }
  });

  it('appGadgets, when present, carries a non-empty catalog', () => {
    // An entry that registers a per-app gadget catalog drives the
    // synth's `appGadgets` channel; an empty catalog defeats the
    // purpose. (Some such entries are distractors — a gadget is
    // registered but the intent does not justify using it — so this
    // does NOT assert `hasClientCapabilities`.)
    const withCatalog = BENCH_CORPUS.filter((e) => e.appGadgets !== undefined);
    expect(withCatalog.length).toBeGreaterThan(0);
    for (const entry of withCatalog) {
      expect(
        (entry.appGadgets ?? []).length,
        `entry ${entry.id} registers an empty appGadgets catalog`,
      ).toBeGreaterThan(0);
    }
  });

  it('every contract-shape bucket is exercised by the corpus', () => {
    const shapes = new Set(BENCH_CORPUS.map((e) => contractShape(e.expected)));
    for (const s of [
      'props-only',
      'context-only',
      'context+action',
      'stream',
      'with-gadgets',
    ] as const) {
      expect(shapes.has(s), `no corpus entry exercises shape ${s}`).toBe(true);
    }
  });
});

describe('scoreSynthesizedContract — preferred shapes pass', () => {
  it('counter contextSpec-only passes the counter entry', () => {
    const counter = BENCH_CORPUS.find((e) => e.id === 'mut-counter-1')!;
    const contract: DataContract = {
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
    };
    const score = scoreSynthesizedContract(contract, counter.expected);
    expect(score.pass).toBe(true);
    expect(score.failures).toEqual([]);
  });

  it('weather card props-only passes the weather entry', () => {
    const weather = BENCH_CORPUS.find((e) => e.id === 'display-weather-1')!;
    const contract: DataContract = {
      propsSpec: {
        properties: {
          city: { schema: { type: 'string' }, required: true },
          temp: { schema: { type: 'number' }, required: true },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, weather.expected);
    expect(score.pass).toBe(true);
  });

  it('feedback form context+action passes', () => {
    const feedback = BENCH_CORPUS.find((e) => e.id === 'form-feedback-1')!;
    const contract: DataContract = {
      contextSpec: {
        rating: { schema: { type: 'number' }, default: 0 },
        comment: { schema: { type: 'string' }, default: '' },
      },
      actionSpec: {
        submit: {
          label: 'Submit feedback',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, feedback.expected);
    expect(score.pass).toBe(true);
  });

  it('clock streamSpec-only passes the clock entry', () => {
    const clock = BENCH_CORPUS.find((e) => e.id === 'bcast-clock-1')!;
    const contract: DataContract = {
      streamSpec: {
        tick: { schema: { type: 'string' } },
      },
    };
    const score = scoreSynthesizedContract(contract, clock.expected);
    expect(score.pass).toBe(true);
  });

  it('geolocation capability shape passes the cap-location entry', () => {
    const cap = BENCH_CORPUS.find((e) => e.id === 'cap-location-1')!;
    const contract: DataContract = {
      contextSpec: {
        location: {
          schema: { type: 'object' },
          default: {},
        },
      },
      clientCapabilities: {
        // Wire shape — package-keyed two-level map. The export
        // name keys the inner map; the wire carries identity only (no
        // `version`, no `permission`).
        gadgets: {
          '@ggui-ai/gadgets': {
            useGeolocation: {},
          },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, cap.expected);
    expect(score.pass).toBe(true);
  });

  it('plugin-positive shape passes the leaflet positive-1 entry', () => {
    // Pin that the scorer credits the registered COMPONENT-gadget
    // reference (Leaflet ships `<LeafletMap>`). Tolerated pass since
    // the corpus marks gadget-bearing entries with
    // `tolerateEitherShape: true` until the synth has retrained
    // behaviour.
    const pos = BENCH_CORPUS.find(
      (e) => e.id === 'capplug-leaflet-positive-1',
    )!;
    const contract: DataContract = {
      propsSpec: {
        properties: { center: { schema: { type: 'array' }, required: true } },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-leaflet': {
            LeafletMap: {},
          },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, pos.expected);
    expect(score.pass).toBe(true);
  });

  it('plugin-negative shape passes the leaflet negative-1 entry', () => {
    // Form-editing intent that should NOT reach for the registered
    // map wrapper. Contract has actionSpec + contextSpec, no
    // clientCapabilities. Passes both the "no plugin attached" rule
    // AND the forbidden-hooks check (vacuously, since map is empty).
    const neg = BENCH_CORPUS.find(
      (e) => e.id === 'capplug-leaflet-negative-1',
    )!;
    const contract: DataContract = {
      actionSpec: {
        save: { label: 'Save' },
      },
      contextSpec: {
        name: { schema: { type: 'string' } },
        email: { schema: { type: 'string' } },
      },
    };
    const score = scoreSynthesizedContract(contract, neg.expected);
    expect(score.pass).toBe(true);
  });

  it('source-fed stream shape passes the src-stream-ticker entry', () => {
    const src = BENCH_CORPUS.find((e) => e.id === 'src-stream-ticker-1')!;
    const contract: DataContract = {
      streamSpec: {
        ticker: {
          schema: { type: 'object' },
          source: { tool: 'fetch_quote' },
        },
      },
      agentCapabilities: {
        tools: {
          fetch_quote: {
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
          },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, src.expected);
    expect(score.pass).toBe(true);
  });
});

describe('scoreSynthesizedContract — bad shapes fail', () => {
  it('counter with redundant actionSpec FAILS the counter entry', () => {
    const counter = BENCH_CORPUS.find((e) => e.id === 'mut-counter-1')!;
    const contract: DataContract = {
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
      actionSpec: {
        increment: {
          label: 'Increment',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
        decrement: {
          label: 'Decrement',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
        reset: {
          label: 'Reset',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, counter.expected);
    expect(score.pass).toBe(false);
    expect(score.failures.some((f) => f.kind === 'has-action-mismatch')).toBe(
      true,
    );
  });

  it('weather card with extra contextSpec FAILS the weather entry', () => {
    const weather = BENCH_CORPUS.find((e) => e.id === 'display-weather-1')!;
    const contract: DataContract = {
      propsSpec: {
        properties: { city: { schema: { type: 'string' }, required: true } },
      },
      contextSpec: {
        someState: { schema: { type: 'string' }, default: '' },
      },
    };
    const score = scoreSynthesizedContract(contract, weather.expected);
    expect(score.pass).toBe(false);
  });

  it('form without actionSpec FAILS the feedback entry', () => {
    const feedback = BENCH_CORPUS.find((e) => e.id === 'form-feedback-1')!;
    const contract: DataContract = {
      contextSpec: {
        rating: { schema: { type: 'number' }, default: 0 },
      },
    };
    const score = scoreSynthesizedContract(contract, feedback.expected);
    expect(score.pass).toBe(false);
    expect(score.failures.some((f) => f.kind === 'has-action-mismatch')).toBe(
      true,
    );
  });

  it('over-eager-Leaflet on a form intent triggers forbidden-capability-hooks-present', () => {
    // The "LLM attaches everything in the catalog" failure mode.
    // Distractor case: profile-form intent, Leaflet registered;
    // contract MUST NOT include `useLeafletMap`. Note: the entry has
    // `tolerateEitherShape: true`, so the entry-level `pass` field
    // stays true — but the `failures` array MUST still surface the
    // forbidden-hooks finding so reports show WHY the over-eager
    // shape is wrong. This pins that the scorer's forbidden-hooks
    // check fires even when tolerance is granted on the headline
    // structural shape.
    //
    // Implementation note: tolerateEitherShape currently short-
    // circuits the headline `hasActionSpec`/`hasContextSpec`/etc.
    // mismatches but NOT the per-field hooks/names checks (those
    // run unconditionally). The forbidden-hooks check follows the
    // same posture — it surfaces the violation regardless of
    // tolerance, but the entry's `pass` flag may still be true if
    // the only failure is in a tolerated dimension.
    const neg = BENCH_CORPUS.find(
      (e) => e.id === 'capplug-leaflet-negative-1',
    )!;
    const contract: DataContract = {
      actionSpec: { save: { label: 'Save' } },
      contextSpec: { name: { schema: { type: 'string' } } },
      clientCapabilities: {
        gadgets: {
          // The LLM over-eagerly attached the registered Leaflet
          // gadget to a form-editing intent — exactly the failure
          // the bench is meant to catch.
          '@ggui-samples/gadget-leaflet': {
            LeafletMap: {},
          },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, neg.expected);
    expect(
      score.failures.some(
        (f) => f.kind === 'forbidden-capability-hooks-present',
      ),
    ).toBe(true);
  });
});

describe('scoreSynthesizedContract — advisory name checks', () => {
  it('an off-list slot name is advisory — correct shape still PASSES', () => {
    const counter = BENCH_CORPUS.find((e) => e.id === 'mut-counter-1')!;
    // Shape is exactly right (contextSpec-only, no actions); only the
    // slot is named `tally` instead of the allow-listed `count`.
    const contract: DataContract = {
      contextSpec: { tally: { schema: { type: 'number' }, default: 0 } },
    };
    const score = scoreSynthesizedContract(contract, counter.expected);
    expect(score.pass).toBe(true);
    // The mismatch is still surfaced as a (non-gating) finding.
    expect(
      score.failures.some((f) => f.kind === 'context-slots-disjoint'),
    ).toBe(true);
  });

  it('an off-list action name is advisory — correct shape still PASSES', () => {
    const publish = BENCH_CORPUS.find((e) => e.id === 'misc-publish-button')!;
    const contract: DataContract = {
      contextSpec: { postText: { schema: { type: 'string' }, default: '' } },
      actionSpec: {
        // `release` is a valid publish-action name, off the allow-list.
        release: {
          label: 'Release',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    };
    const score = scoreSynthesizedContract(contract, publish.expected);
    expect(score.pass).toBe(true);
    expect(
      score.failures.some((f) => f.kind === 'action-names-disjoint'),
    ).toBe(true);
  });
});

describe('scoreSynthesizedContract — tolerateEitherShape', () => {
  it('todo-list local passes EITHER shape (with or without actionSpec)', () => {
    const todo = BENCH_CORPUS.find((e) => e.id === 'list-todo-local')!;
    expect(todo.expected.tolerateEitherShape).toBe(true);
    const noActions: DataContract = {
      contextSpec: { todos: { schema: { type: 'array' }, default: [] } },
    };
    const withActions: DataContract = {
      contextSpec: { todos: { schema: { type: 'array' }, default: [] } },
      actionSpec: {
        addTodo: {
          label: 'Add a todo',
          schema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      },
    };
    expect(scoreSynthesizedContract(noActions, todo.expected).pass).toBe(true);
    expect(scoreSynthesizedContract(withActions, todo.expected).pass).toBe(
      true,
    );
  });
});

describe('validator alignment with bench', () => {
  it('redundant-action fires on the counter-bug shape', () => {
    const buggyCounter: DataContract = {
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
      actionSpec: {
        increment: {
          label: 'Increment',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    };
    const findings = validateContractStructure(buggyCounter).findings;
    expect(findings.some((f) => f.kind === 'redundant-action')).toBe(true);
  });

  it('redundant-action stays silent on the preferred counter shape', () => {
    const goodCounter: DataContract = {
      contextSpec: {
        count: { schema: { type: 'number' }, default: 0 },
      },
    };
    const findings = validateContractStructure(goodCounter).findings;
    expect(findings).toEqual([]);
  });

  it('redundant-action stays silent on legitimate form shape', () => {
    const form: DataContract = {
      contextSpec: {
        draft: { schema: { type: 'string' }, default: '' },
      },
      actionSpec: {
        submit: {
          label: 'Submit',
          schema: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
    };
    const findings = validateContractStructure(form).findings;
    expect(findings).toEqual([]);
  });
});

describe('summarize — structural roll-up', () => {
  it('aggregates pass/fail counts and per-shape precision', () => {
    const synthetic: BenchOutcome[] = [
      {
        entry: BENCH_CORPUS.find((e) => e.id === 'mut-counter-1')!,
        contract: {
          contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
        },
        score: { pass: true, tolerated: false, failures: [] },
        findings: [],
        latencyMs: 1000,
        attempts: 1,
        synthReason: 'synthesize-ok',
      },
      {
        entry: BENCH_CORPUS.find((e) => e.id === 'display-weather-1')!,
        contract: {
          contextSpec: { extra: { schema: { type: 'string' }, default: '' } },
        },
        score: {
          pass: false,
          tolerated: false,
          failures: [
            { kind: 'has-action-mismatch', hint: 'extra contextSpec' },
          ],
        },
        findings: [],
        latencyMs: 1500,
        attempts: 2,
        synthReason: 'synthesize-ok',
      },
    ];
    const report = summarize(synthetic);
    expect(report.totals.all).toBe(2);
    expect(report.totals.pass).toBe(1);
    expect(report.totals.fail).toBe(1);
    expect(report.totals.precision).toBe(0.5);
    expect(report.byShape['context-only']?.pass).toBe(1);
    expect(report.byShape['props-only']?.pass).toBe(0);
  });
});
