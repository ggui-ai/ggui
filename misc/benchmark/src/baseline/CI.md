# Baseline pipeline — CI soft rollout

The post-OSS-split benchmark stack is wired into CI as a **soft
rollout**: it blocks the build only on calibration-anchored
regressions. Provisional alerts are visible but non-blocking.

## The pipeline

```
  bench:baseline          (collect)
       │
       ▼
  bench:baseline-diff     (compare vs cached main baseline)
       │
       ▼
  bench:baseline-diff-triage  (classify by severity)
       │
       ▼
  bench-baseline-ci       (apply CI soft-rollout policy)
       │
       ▼
  exit 0 / 1 / 2          (PASS / FAIL-real-regression / FAIL-tooling)
```

- **Location**: `baseline-pipeline` job in `.github/workflows/ci.yml`
- **Trigger model** (deliberate trust split — mirrors `ff-subtree-oss`):
  - **Automatic on push to `main`** — trusted baseline/cache prime
    path. Only path that writes cache. Gated by `core_changed == 'true'`
    so docs-only pushes skip it.
  - **Manual via `workflow_dispatch`** — maintainer-triggered audit
    path. Runs against the selected ref (default `main`; pick any
    branch/PR ref via the "Run workflow" UI or `gh workflow run`).
    Bypasses the `core_changed`/`docs_only` gates (an explicit
    dispatch is intent enough). Reads the last-good main baseline
    via cache restore-key prefix; runs diff + triage; uploads
    artifacts. **Does NOT write cache** — the save step is gated
    on `github.event_name == 'push' AND github.ref == refs/heads/main`,
    so manual runs are read-only.
  - **No automatic run on `pull_request`.** Benchmarks are not part
    of the default PR gate. Audit a PR by dispatching manually with
    its branch as the ref.
- **Scope**: deterministic benches only (`slo`, `a2ui`).
  `multi-sdk` stays covered by the existing `smoke-benchmark`
  Tier 2 job — keeps the baseline pipeline LLM-free and cheap.

### How to trigger a manual audit

```bash
# Main (re-prime / sanity check)
gh workflow run ci.yml --ref main

# A PR branch (audit — compares HEAD against cached main baseline)
gh workflow run ci.yml --ref fix/my-branch
```

Or: Actions tab → "CI" → "Run workflow" → pick branch.

## Soft-rollout policy

| severity × anchor                                         | CI action                                               |
| --------------------------------------------------------- | ------------------------------------------------------- |
| `alert` + non-provisional anchor (`R1`/`F1`/`F2`/`N1-N4`) | **BLOCK** — step fails, CI job red                      |
| `alert` + `provisional` anchor                            | **SURFACE** — `::notice::` annotation, does NOT fail CI |
| `notice`                                                  | counted in summary, does NOT fail CI                    |
| `suppressed` / `informational`                            | counted, not surfaced                                   |

**Exit code distinction preserved:**

- Exit 0 = zero blocking alerts (PASS)
- Exit 1 = one or more blocking alerts (real regression found)
- Exit 2 = tooling / invocation error (file missing, unreadable JSON,
  unsupported schema). Failed CI step, but distinguishable from a
  semantic regression — CI logs make it clear which happened.

## Why soft, not hard?

The triage tool has two classes of rules:

1. **Calibration-anchored**: threshold validated against a real
   bundle (`R1`, `F1`, `F2`, `N1-N4`). If this fires, we have real
   evidence it catches a real regression.
2. **Provisional**: threshold is a best-guess with no real regression
   bundle behind it yet. Might be right, might be over-tuned, might
   fire on LLM variance.

Hard-failing on provisional alerts would punish PRs for noise before
the thresholds are validated. Soft-rollout gives provisional alerts
a feedback loop: they surface in CI, humans read them, and if a
provisional alert repeatedly catches real regressions, the rule's
anchor gets upgraded in `baseline-diff-triage/policy.ts` and the
block turns on.

See the "Provisional thresholds (v0)" section in
`core/src/benchmarks/baseline-diff-triage/README.md` for the current
provisional ledger.

## Cold-start / no-baseline path

On the very first CI run — or after a GitHub Actions cache eviction
— there's no cached main baseline to diff against. The pipeline
handles this gracefully:

1. `bench:baseline` runs, produces a new bundle.
2. No cache hit → diff + triage skipped.
3. Bundle uploaded as artifact.
4. `bench-baseline-ci --allow-empty` returns exit 0 with a summary
   note: _"Cold start — no cached baseline to diff against."_
5. On push to main, the new bundle is saved to cache as the
   reference for subsequent runs.

## Cache strategy

- Key: `ggui-bench-baseline-main-<sha>` — pinned to the commit SHA
  that produced it.
- Restore-keys: `ggui-bench-baseline-main-` — prefix fallback picks
  the most-recent matching entry.
- Save: ONLY on push-to-main AND job success — PRs never overwrite
  the reference.
- Size: ~50KB per bundle — well under GH Actions cache quota.

If the cache drifts too far from HEAD on a long-lived PR, the diff
becomes less useful. That's an acceptable cost for v0 — the baseline
comparison is "current HEAD vs last main baseline", which matches
what a reviewer wants to see.

## Artifacts

Every CI run uploads (even on failure) to an artifact named
`baseline-pipeline-<sha>` containing:

```
baseline-pipeline-abc12345.zip
├── baseline-2026-XX-XX-YY-YY-YY.NNNZ/   ← full bundle
│   ├── manifest.json
│   ├── slo.json
│   ├── a2ui.json
│   └── stdout/
├── ci-diff.json           ← only when cache hit
└── ci-triage.json         ← only when cache hit
```

Retention: 14 days. Download from the GitHub Actions run UI.

## How to respond to each CI outcome

### Build is green, zero alerts

Nothing to do. The baseline pipeline passed cleanly.

### Build is green, provisional alerts surfaced

Review the `::notice::` annotations. If the alert pinpoints something
real, consider:

- Upgrading the rule's anchor in `policy.ts` after producing a
  calibration bundle that exercises the signal.
- Tightening/loosening the provisional threshold based on what the
  noise turned out to be.

### Build is red, blocking alerts

Real regression — the alert is anchored to a calibration bundle,
which means the threshold is already validated against a known-real
signal class. Investigate: the `location` field tells you which
bench + row + field moved. The artifact bundle has the raw
`<bench>.json` report for full before/after detail.

Options:

- Fix the regression
- Justify it in PR comments (e.g., intentional boilerplate change
  that shifts latency) — and update the baseline once merged
- In rare cases, recalibrate the threshold (but this requires a new
  calibration bundle and a PR to `policy.ts`)

### Build is red, tooling error (exit 2)

The pipeline itself is broken, not the benchmarks. Symptoms:

- `triage file not found` → upstream diff step failed
- `failed to parse triage JSON` → one of the bench reports is
  malformed
- `unsupported triage schemaVersion` → the triage tool and its input
  are on different schema versions

Fix the tooling, re-run the workflow. This is NOT a product
regression.

## Why deterministic-only (no multi-sdk)?

`multi-sdk` uses real LLM API calls. Running it on every PR:

- Adds $cost per PR
- Risks API rate limits on busy days
- Introduces LLM variance that would flood the triage with
  provisional alerts

The existing `smoke-benchmark` job already covers `multi-sdk`
on push-to-main. Keeping the baseline pipeline LLM-free keeps the
soft rollout low-noise and fast.

Additionally, the pipeline's `Build dependencies` step does NOT
build `@ggui-ai/design`. None of the deterministic benches in scope
(slo, a2ui) import from design, so building
it would be wasted work — and would couple this gate to the
separate design-package build, which is an independent concern.

When the signal proves useful and
multi-sdk triage is calibrated, a follow-up slice can extend the
pipeline by dropping `--skip multi-sdk`.

## What this rollout does NOT do

- No CI dashboard / history trending
- No cross-bench composite score
- No remote artifact upload (artifacts stay in GH Actions)
- No new benchmark families introduced by CI wiring
- No change to the individual bench schemas, diff schema, or triage
  policy — purely an orchestration + interpretation layer

## When to tighten the rollout

- When a provisional rule has caught a real regression 2+ times and
  we have a calibration bundle for it, upgrade its anchor in
  `policy.ts`. It then becomes a blocking alert automatically.
- When `multi-sdk` variance is better characterized (more same-code
  samples, a real score-regression calibration bundle), drop
  `--skip multi-sdk` from the CI step.
- When the cache-based "last main baseline" pattern proves limiting
  (long-lived PRs, stale comparisons), consider persisting baselines
  to a dedicated branch or artifact registry.

Until then: keep it narrow.
