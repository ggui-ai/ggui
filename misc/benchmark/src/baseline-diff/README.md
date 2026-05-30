# Baseline-diff — v0 comparison tool

Given two baseline bundles produced by `bench:baseline`, emit one
honest diff report. Per-bench. No composite scores.

---

## Purpose

The baseline bundle is the collection layer. Comparison is the next
layer — without it, a 4-bench snapshot has no leverage against the
previous snapshot. `baseline-diff` is the narrow comparison tool:

- Read two `manifest.json` files
- Read the per-bench report copies inside each bundle
- Emit a diff that tells you: **what status transitions happened, and
  what numeric deltas are per bench**

---

## What it is NOT

- **Not a CI gate.** Always exits 0 on a valid invocation.
  Regressions live in the JSON output, not the exit code. CI wiring
  reads the JSON and decides.
- **Not a dashboard.** Local diff only. No HTML, no upload, no hosted
  UI.
- **Not a composite scorer.** Each bench's numbers stay in their own
  units. No "overall quality index." Each bench exists because its
  dimension is orthogonal — averaging them would paper over
  regressions in under-weighted layers.
- **Not a re-runner.** If a bundle is stale, rerun `bench:baseline`
  first, then diff the new bundle.

---

## Why no global score exists

The four benches measure four different things:

| bench       | dimension                                        |
| ----------- | ------------------------------------------------ |
| `slo`       | user-facing `ggui_render` latency checkpoints    |
| `multi-sdk` | ui-gen code quality (floor-split: OSS vs hosted) |
| `a2ui`      | provisional-preview emission latency + validity  |

A 10-point quality regression on `multi-sdk` and a 5ms latency
regression on `slo` are not comparable. Averaging them into a
single number means the first big mover dominates and smaller signals
get lost. The diff surfaces all layers independently — the human
reader weights them.

---

## Usage

```bash
# Pass two bundle paths. Order is before → after.
pnpm --filter @ggui-ai/benchmark bench:baseline-diff \
  tmp-bench-logs/baseline-2026-04-20T00-00-00.000Z \
  tmp-bench-logs/baseline-2026-04-20T04-44-10.016Z

# Override the output path
pnpm --filter @ggui-ai/benchmark bench:baseline-diff \
  --out /tmp/my-diff.json  \
  tmp-bench-logs/before  tmp-bench-logs/after
```

Default output path: `tmp-bench-logs/diff-<before-basename>-vs-<after-basename>.json`.

---

## Output shape

Console (short + scannable):

```
Baseline-Diff bench-baseline-diff.v0 — baseline-… vs baseline-…
  before: 2026-04-20T00:00:00Z  git=abc123…
  after:  2026-04-20T04:44:10Z  git=def456…

  ── status transitions ──
  ✗ regressed      slo
  = same-success   multi-sdk, a2ui

  ── per-bench deltas ──

  [slo] success → failed
    (no summary diff — see notes)
    note: after bench failed with exit code 1

  [multi-sdk] success → success
    = floor=oss               avgTimeMs=12300→13100 (+800) avgScore=75→78 (+3) …
    = floor=hosted            avgTimeMs=12000→14500 (+2500) avgScore=83→81 (-2) …

  [a2ui] success → success
    = intentShape=form        timeToFirstFrame=0→0 frameCount=4→4 totalParseFailures=0→0
    = intentShape=list        timeToFirstFrame=0→0 frameCount=4→4 totalParseFailures=0→0
    = intentShape=minimal     timeToFirstFrame=0→0 frameCount=4→4 totalParseFailures=0→0
```

JSON (machine-readable, full):

```jsonc
{
  "schemaVersion": "bench-baseline-diff.v0",
  "beforeBaselineId": "baseline-…",
  "afterBaselineId": "baseline-…",
  "beforeTimestamp": "…",
  "afterTimestamp": "…",
  "beforeGitSha": "abc…",
  "afterGitSha": "def…",
  "notes": [],
  "benchDiffs": [
    {
      "benchName": "slo",
      "beforeStatus": "success",
      "afterStatus": "failed",
      "statusChange": "regressed",
      "summaryDiff": null,
      "notes": ["before: report copy unreadable: …"],
    },
    // … one entry per bench
  ],
}
```

---

## Status transitions (six values)

| statusChange   | meaning                      |
| -------------- | ---------------------------- |
| `same-success` | both sides passed            |
| `same-failed`  | both sides failed            |
| `regressed`    | success → failed             |
| `recovered`    | failed → success             |
| `added`        | new bench in after bundle    |
| `removed`      | bench disappeared from after |

---

## Schema drift tolerance

Per-bench summary shapes evolve. The diff degrades gracefully:

- **Missing summary array**: note on the bench entry; rows on the
  present side marked `added`/`removed`.
- **Missing field in one row**: `FieldDelta` of `kind: 'scalar'` with
  the missing side as `null`; delta is `null`.
- **Missing field on both sides**: `FieldDelta` of `kind: 'missing'`
  with a reason. Never crashes.
- **Schema-version mismatch**: note on the bench entry, diff still
  attempted. Reader interprets.
- **Malformed report** (JSON parse fails): bench entry carries a note
  and `summaryDiff: null`. Other benches still diff.

No silent data loss. Every absence is either a `null`/`missing`
value or a note.

---

## Field classification per bench

Each bench has a centralized `BenchDiffSpec` at
`diff.ts → BENCH_DIFF_SPECS` that tells the diff:

- Where the summary array lives (`summary` or `floorSummaries`)
- Which field is the group key (`path` / `floor` / `intentShape` / `registryMode`)
- Which fields to surface, and whether each is `scalar` or `stat`
  (nested `{count, nullCount, min, median, max}`)

Adding a new bench → add one entry to `BENCH_DIFF_SPECS`. Adding a
new field to an existing bench → add one line to that bench's
`fields` array. The generic diff logic doesn't change.

---

## What v0 does NOT do

- **No auto-baseline-discovery.** Caller passes explicit paths. We
  don't scan `tmp-bench-logs/` for "the last two bundles."
- **No diff-of-diffs.** Comparing more than two bundles is out of
  scope; run multiple pairwise diffs instead.
- **No regression threshold config.** The diff reports all deltas;
  "which deltas matter" is consumer policy, not tool policy.
- **No visual presentation** beyond the compact console table.

---

## When this tool earns width

- A real regression is first visible here (before a human noticed it
  manually).
- CI wiring reads the JSON and blocks a merge.
- A fifth bench joins the stack — one entry added to
  `BENCH_DIFF_SPECS`, no other changes.

Until then: don't widen the schema, don't promote to a gate, don't
invent composite scores.
