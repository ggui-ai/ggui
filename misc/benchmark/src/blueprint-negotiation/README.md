# Blueprint-Negotiation bench — v0 seed harness

Thin pre-generation benchmark for the decision layer that fires
BEFORE any UI generation. Measures:

- did we retrieve the right blueprint? (hit vs miss vs wrong_hit)
- did we miss cleanly when we should have?
- how long did the decision take?

Pairs with the three existing benches:

- `../multi-sdk/` — ui-gen (final component code)
- `../a2ui/` — provisional preview path
- `../slo/` — end-to-end `ggui_render` checkpoints

**This is not a negotiator quality bench.** It's a labeled-corpus
regression harness. If an outcome is wrong, the report tells you
_which_ class of wrong (wrong*hit vs false-negative vs error) —
not \_how close* to right the decision was.

---

## Scope

### 3-case seed corpus

| case                          | registryMode | expected | seeded store |
| ----------------------------- | ------------ | -------- | ------------ |
| `clear-hit-feedback-form`     | `hosted`     | `hit`    | 3 entries    |
| `clean-miss-nothing-relevant` | `hosted`     | `miss`   | 2 irrelevant |
| `empty-registry-miss`         | `empty`      | `miss`   | 0 entries    |

**Why only 3 cases (not 4)?** The brief asked for a potential
"multi-registry arbitration" case #4. The current `negotiate()`
signature takes a single `VectorStore`; arbitration across plural
sources is roadmap (§6.9 RAG partitioning). The schema reserves the
`arbitrationObserved` + `arbitrationCorrectnessRate` slots for v0.5;
until then they're hardcoded `false`/`0`.

### Outcome classification (four values, no collapse)

| observed    | meaning                                                |
| ----------- | ------------------------------------------------------ |
| `hit`       | blueprintId returned AND matches `expectedBlueprintId` |
| `miss`      | no blueprintId returned (clean miss)                   |
| `wrong_hit` | blueprintId returned but WRONG blueprint               |
| `error`     | negotiator threw (see `errorClass`)                    |

`wrong_hit` is deliberately distinct from `miss` — collapsing the two
would hide the most dangerous false-positive class. A harness that
says "90% hit rate" while all hits are the wrong blueprint is worse
than a harness with "0% hit rate."

---

## Why `miss` can be a success

Per the brief: "treat empty-registry miss as a first-class success
case, not 'no data'."

If the registry is empty, the correct behavior is to miss. The
`empty-registry-miss` case explicitly expects this — its
`emptyRegistryCleanMissRate` field on the empty-mode summary should
read `100%` on a healthy negotiator. A non-zero hit rate on empty
mode is a BUG — the negotiator hallucinated a match from zero data.

---

## Why confidence is null in v0

`negotiate()` does NOT surface numeric confidence on its result.
Internally, RAG scoring uses bands (`exact ≥ 0.45`, `partial ≥ 0.15`)
but the public result only exposes `decision.blueprintId` + latency
breakdowns. The tag slot `confidence: null` is explicit first-class
absence. When the public API grows a confidence field, this becomes
`number | null`.

---

## Why no LLM in v0

The runner injects a deterministic stub `LLMCaller`. Hit cases skip
the LLM via the RAG fast path (similarity ≥ 0.45); miss cases route
through the decision-LLM path, but the stub returns a fixed JSON
response (`action: 'create'`) — no API calls, no tokens, no cost,
no flakiness.

This is consistent with v0's "no LLM grading" constraint. The bench
measures the negotiator's DECISION STRUCTURE (did it produce a
blueprintId when it should? did it miss cleanly?), not the LLM's
reasoning quality.

---

## Stats discipline

- Report min/median/max per registry mode.
- Label the whole report `floorLabel: 'v0-seed'`.
- Do NOT promote to p50/p95 until the corpus is ≥15 cases × ≥10 runs
  each.

---

## What v0 does NOT measure

- Blueprint quality or semantic relevance (that's the LLM's job).
- Multi-registry arbitration (not wired).
- Confidence-threshold tuning (thresholds are internal).
- Cross-tenant scope leakage (covered by `mcp-server-core` contract tests).
- Warm-cache behavior across multi-step scenarios (that's what the
  existing `core/src/benchmarks/negotiation/` bench does).

---

## Running

```bash
pnpm --filter @ggui-ai/benchmark bench:blueprint-negotiation
```

Writes a timestamped JSON under
`core/src/benchmarks/blueprint-negotiation/reports/`.

Flags:

- `--runs <n>` — runs per case (default 3)
- `--cases <csv>` — subset of case ids (default all)

---

## When this harness has earned width

1. A real regression is caught here before any other bench does —
   e.g., a RAG threshold change that turns hits into misses.
2. The `wrongHitRate` moves against a real code change, proving
   the four-way outcome split is load-bearing.
3. Multi-registry arbitration lands → add a 4th case with
   `registryMode: 'multi'` and the arbitration slots populate.

Until then: don't widen the corpus, don't promote stats, don't
collapse `wrong_hit` into `miss`.
