# Cross-bench baseline — v0 snapshot bundle

A thin orchestrator that runs all four v0 benches and produces a
single self-contained bundle with a manifest tying them together.

**This is the new post-OSS-split reference epoch.** Individual
benches remain authoritative for their own metrics — the bundle is
a snapshot, not a new scoring layer.

---

## What it runs

| bench       | how                                    |
| ----------- | -------------------------------------- |
| `slo`       | `pnpm bench:slo --runs 3`              |
| `multi-sdk` | `pnpm bench -p claude -c weather-card` |
| `a2ui`      | `pnpm bench:a2ui --runs 3`             |

`multi-sdk` is the only bench requiring real LLM API keys
(ANTHROPIC/OPENAI/GEMINI). When they're absent the bench fails; the
manifest records the failure honestly and the other benches
still complete. No silent skip.

---

## Output layout

Each baseline run gets its own timestamped bundle:

```
tmp-bench-logs/baseline-<iso>/
  manifest.json                    ← cross-bench manifest
  slo.json                         ← copy of slo's report
  multi-sdk.json                   ← copy of multi-sdk's report (on success)
  a2ui.json                        ← copy of a2ui's report
  stdout/
    slo.log                        ← full stdout+stderr capture
    multi-sdk.log
    a2ui.log
```

`tmp-bench-logs/` is gitignored by convention. Bundles are portable:
zip the directory, ship it, or diff two bundles directly.

---

## Manifest shape (`manifest.json`)

```jsonc
{
  "schemaVersion": "bench-baseline.v0",
  "baselineId": "baseline-2026-04-20T00-00-00.000Z",
  "timestamp": "2026-04-20T00:00:00.000Z",
  "gitSha": "abc123…", // null if git resolution failed
  "bundleDir": "/…/baseline-…",
  "notes": ["…honesty notes…"],
  "results": [
    {
      "benchName": "slo",
      "status": "success",
      "command": "pnpm bench:slo --runs 3",
      "outputPath": "/abs/path/to/original/slo-<stamp>.json",
      "bundlePath": "/abs/path/inside/bundle/slo.json",
      "exitCode": 0,
      "summary": {
        "totalRuns": 9,
        "headline": "blueprint_hit: 3r, prev 3/0 | generation_miss: 3r, prev 3/0 | oss_miss: 3r, prev 0/0",
      },
      "errorExcerpt": null,
    },
    // … one entry per bench
  ],
}
```

On failure:

```jsonc
{
  "benchName": "multi-sdk",
  "status": "failed",
  "command": "pnpm bench -p claude -c weather-card",
  "outputPath": null,
  "bundlePath": null,
  "exitCode": 1,
  "summary": null,
  "errorExcerpt": "WARNING: ANTHROPIC_API_KEY not set\n  ✗ ...",
}
```

---

## Running

```bash
# All four benches, default 3 runs per deterministic bench
pnpm --filter @ggui-ai/benchmark bench:baseline

# Override runs for the 3 deterministic benches (slo, a2ui, negotiation).
# multi-sdk has its own args and is NOT affected by --runs.
pnpm --filter @ggui-ai/benchmark bench:baseline --runs 5

# Skip multi-sdk (e.g., in CI environments without API keys)
pnpm --filter @ggui-ai/benchmark bench:baseline --skip multi-sdk
```

Exit code is **always 0** on a completed orchestrator run, even when
some benches failed. The manifest is the authoritative record —
downstream tooling reads `results[].status` to decide what to do.

---

## Partial-failure semantics

If one bench fails, the baseline:

1. Captures the exit code and a ~500-char excerpt from combined stdout/stderr
2. Persists the full log to `stdout/<bench>.log`
3. Continues running the remaining benches
4. Writes the manifest with mixed `status` values

There is NO retry, NO fallback, NO synthetic success. If multi-sdk
failed because keys are missing, that's in the manifest and stays
in the manifest.

---

## Why this is the "new post-OSS-split reference epoch"

Before the OSS split, the bench stack was a single LLM-scoring
matrix (`multi-sdk`). Post-split, the stack is orthogonal layers,
each answering a different question:

- `slo` — does `ggui_render` hit its user-facing latency checkpoints?
- `multi-sdk` — does ui-gen produce quality output?
- `a2ui` — does the provisional-preview path emit valid frames quickly?

The baseline bundle is the authoritative cross-layer snapshot — a
single artifact proving all layers ran together. Bundles are
timestamped + git-sha'd so a regression in any layer can be traced
back to the exact commit that introduced it.

---

## What this bundle does NOT do

- **No cross-bench composite scores.** Each bench carries its own
  summary; the manifest does not invent a "combined quality score"
  or similar. Aggregating four orthogonal signals into one number
  would hide regressions in layers that aren't weighted heavily.
- **No dashboard or storage layer.** The bundle is a local directory
  of JSON + logs. Hosting/dashboards/comparison tooling are separate
  projects.
- **No retry on failure.** If multi-sdk hangs or flakes, the manifest
  records it. The operator decides whether to rerun.
- **No bench mutation.** Each bench is invoked with its existing
  entry script and existing args. The baseline adds NO new metric
  slots inside individual benches.

---

## When this orchestrator has earned width

- The manifest gets read by CI / dashboard / comparison tooling and
  proves its shape is useful.
- A cross-bench regression is caught by diffing two baselines.
- A fifth bench is ready to join the stack — the spec list in
  `bench-baseline.mjs` takes one more entry, schema stays stable.
