# baseline-diff-triage — v0 policy layer

Classifies each item in a `bench-baseline-diff.v0` JSON into one of
four severity buckets. Drives the pass/fail decision that CI will
consume later.

- `alert` — surface + block
- `notice` — surface but don't block
- `suppressed` — count only (noise-floor / unchanged)
- `informational` — count only (schema drift / structural nulls)

---

## Why triage is separate from diff

**`baseline-diff` is NEUTRAL.** It computes deltas honestly and
reports them without opinion. If the diff tool also applied
policy, three things break:

1. Policy changes would churn the raw diff schema.
2. Different consumers (CI, dashboards, debugging sessions) need
   different policies; the diff stays single-sourced.
3. The diff's honest "here's every delta" output becomes the audit
   trail when a triage rule fires — you can always re-triage an
   existing diff JSON if the policy changes. Re-running the bench
   would be expensive and might not reproduce.

So: **`baseline-diff`** reports what changed. **`baseline-diff-triage`**
decides what to do about it. Two tools, one clean separation.

---

## Severity semantics

| severity        | meaning                                      | CI action                     |
| --------------- | -------------------------------------------- | ----------------------------- |
| `alert`         | real regression or real failure signal       | block merge / page            |
| `notice`        | meaningful but non-blocking drift            | show in summary / don't block |
| `suppressed`    | within noise floor, or improvement           | count only                    |
| `informational` | schema drift, structural null, unknown field | count only                    |

**Exit codes:** process exits 0 on zero alerts, 1 on any alert,
**2 on invocation error** (missing file / unparseable JSON /
unsupported schema). CI can treat non-zero uniformly but the
distinction matters when a pipeline needs to tell "there's a real
regression" from "something is broken with the tooling."

---

## Threshold philosophy

**Every threshold lives in `policy.ts` inside `THRESHOLDS`.** One
place to adjust, one place to grep when calibrating.

**Every rule carries a `CalibrationAnchor`**:

- `R1` — calibrated against the deliberate-regression bundle
- `F1` — calibrated against the silent-internal-failure bundle
- `F2` — calibrated against the process-level-failure bundle
- `N1-N4` — calibrated against the same-code noise-floor bundles
- `provisional` — threshold exists but is a guess; not yet validated
  against a real bundle

A **provisional** tag is not shameful — it means "we emit alerts
here based on reasoning, but we haven't seen the rule catch a real
regression yet." The triage report surfaces a top-level note whenever
any item is provisional-anchored, so readers know parts of policy
are under-calibrated.

### Absolute vs relative thresholds

| bench      | metric type                           | threshold type                 | why                                                |
| ---------- | ------------------------------------- | ------------------------------ | -------------------------------------------------- |
| slo / a2ui | latency stats (stat bands)            | **absolute ms**                | sub-ms baselines — relative thresholds meaningless |
| any bench  | counters (`totalParseFailures`, etc.) | **absolute (≠ 0)**             | zero observed noise floor                          |
| any bench  | rates                                 | **absolute percentage points** | normalized already                                 |
| multi-sdk  | `avgScore`                            | **absolute points (0..100)**   | scores are already on a normalized scale           |
| multi-sdk  | `avgTimeMs`                           | **relative (%)**               | 10-second runs jitter by hundreds of ms naturally  |

### Null / missing discrimination

- `FieldDelta.kind: 'missing'` (field absent on both sides) →
  `informational`
- `null` value on one side of a scalar → `informational`
- Row `added`/`removed` WITH a schema-drift note on the entry →
  `informational`
- Row `added`/`removed` WITHOUT a schema-drift note →
  `notice`/`alert` (structural change)
- Structural nulls (e.g. `slo.oss_miss.timeToFirstPreview` is ALWAYS
  null by design) never trigger alerts because the null is stable
  across both sides.

---

## Composite rules

Two rules depend on SIBLING fields in the same row:

- **`multisdk-time-zero-composite`** (F1 silent-failure): fires when
  `avgTimeMs` drops to 0 AND `successRate` collapsed to 0 on the
  same row. Both conditions together are a strong "runs failed
  internally" signal beyond either alone.

- **`multisdk-score-sentinel`** (F1): fires when `avgScore` was ≥ 0
  on the before side and is now < 0 (the -1 "n/a" sentinel multi-sdk
  uses when no runs produced a score).

These catch F1-class failures that don't produce `statusChange:
regressed` (the bench exits 0, but all internal runs failed).

---

## Provisional thresholds (v0)

These rules fire alerts today but lack a real calibration anchor.
Treat them as "best-guess until a regression bundle validates the
number."

| rule                            | threshold                                | why provisional                               |
| ------------------------------- | ---------------------------------------- | --------------------------------------------- |
| `multisdk-score-alertdrop`      | avgScore drop ≥ 3.0 points               | no real score-regression bundle in R1         |
| `multisdk-time-rel-alert`       | avgTimeMs shift ≥ 50%                    | undersampled; LLM run-to-run variance unknown |
| `bp-neg-wrongHitRate-rise`      | > 0 (any increase)                       | no wrongHit-class regression bundle yet       |
| `bp-neg-errorRate-rise`         | > 0                                      | same                                          |
| `bp-neg-falsePositiveRate-rise` | > 0                                      | same                                          |
| `bp-neg-falseNegativeRate-rise` | > 0                                      | same                                          |
| `row-removed-unexplained`       | any row disappearance without drift note | no real bench-row-removal bundle              |
| `status-same-failed`            | alerts on persistent failure             | no bundle validates the re-alert cadence      |

When a real regression bundle ships that exercises one of these,
the anchor changes from `provisional` to the bundle name and (if
needed) the threshold tightens.

---

## Usage

```bash
# Produce a diff first
pnpm --filter @ggui-ai/benchmark bench:baseline-diff  <before>  <after>

# Then triage it
pnpm --filter @ggui-ai/benchmark bench:baseline-diff-triage  \
    tmp-bench-logs/diff-<...>.json

# Or specify output path
pnpm --filter @ggui-ai/benchmark bench:baseline-diff-triage  \
    --out triage-result.json  tmp-bench-logs/diff-<...>.json
```

Default output path: `tmp-bench-logs/triage-<diff-basename>.json`.

---

## Test coverage (calibration-anchored)

Every test case maps to a real calibration class from
`tmp-bench-logs/calibration-manifest.md`:

| test case                      | source class                              |
| ------------------------------ | ----------------------------------------- |
| `N↔N same-code noise`          | N1–N4 pairs                               |
| `N→F1 silent internal failure` | N1 → F1                                   |
| `N→F2 process-level failure`   | N1 → F2                                   |
| `N→R1 counter regression`      | N1 → R1 (a2ui)                            |
| `N→R1 stat regression`         | N1 → R1 (slo)                             |
| `schema drift → informational` | B2 → B3 multi-sdk floorSummaries recovery |
| `malformed input → exit 2`     | synthetic                                 |

---

## What v0 does NOT do

- **No CI wiring.** The triage tool runs locally; CI integration is
  a separate step once the tool has stabilized against a few code
  changes.
- **No policy configuration file.** All thresholds are in
  `policy.ts`. A config-file knob can come later if the thresholds
  need per-repo tuning.
- **No global composite score.** Each item keeps its own bench
  of origin and units. "Pass" ≠ "quality improved"; it means "no
  alerts."
- **No historical trending.** Triage looks at one diff. Trends across
  many diffs are a separate concern.

---

## When this tool earns width

- A real regression is blocked in CI by `exit 1` before anyone
  noticed it manually.
- A provisional threshold catches something unexpected and we
  re-tag its anchor to the bundle that proved it.
- A fifth bench joins the stack — one `classifyXField` function is
  added, thresholds go into `THRESHOLDS`, no other code changes.

Until then: don't broaden the schema, don't pre-optimize, don't
promote provisional thresholds without data.
