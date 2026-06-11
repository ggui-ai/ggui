# ui-gen bench — OSS vs Hosted floor (v0)

The ui-gen bench reports **two numbers, not one blended number**, so
post-OSS-split comparisons are interpretable. This file explains what
the split is, what it currently controls, and what is deliberately NOT
wired yet.

---

## The two floors

| floor    | what it represents                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| `oss`    | honest open-source baseline — what a developer running the OSS stack gets. Default when no `--floor` is passed |
| `hosted` | hosted-path enabled — what hosted/default users get                                                            |

Today's default (`--floor oss`) preserves pre-split behavior exactly.
Old variant ids are not suffixed on the default path; historical
reports stay comparable.

---

## What the floor ACTUALLY controls in v0

**Nothing, and it is documented here so that reviewers can verify it
against code.** The original v0 divergence (a predefined-components
lookup tool wired only on the hosted floor) was deleted along with the
dead predefined-match pipeline — both floors now run the identical
tool set, system prompt, criteria, and runtime render.

Every hosted-vs-OSS divergence (blueprint-finder wiring at dispatch,
provisional-preview preamble, model-routing overrides, system-prompt
fragments, criteria / evaluation, runtime-render) is **single-pathed
today**. When those land, they route through this same `floor` flag —
the reporting surface is already shaped for them.

---

## How to read the report

Every report carries `floorSummaries: FloorSummary[]` — one row per
floor that was exercised, printed side-by-side in the console output.

Field semantics (see `FloorSummary` in `types.ts` for the canonical
definitions):

- **avgTime / avgScore / successRate** — computed over runs where
  generation succeeded. Same convention as the existing
  `variantSummaries`.
- **capHitRate** — fraction of ALL runs (including failures) where
  `turnsUsed >= BENCH_MAX_TURNS` (45 today). A high rate on one floor
  without a matching rise on the other means that floor's path is
  causing churn, not saving work.
- **errorBuckets** — sum of `breakdown.outcomes.*` across all runs on
  this floor. Per-floor aggregation lets you see whether one floor
  drives more patch-invalid churn or self-check failures.

---

## CLI usage

```bash
# Default — OSS floor only, no variant-id changes (preserves history)
pnpm --filter @ggui-ai/benchmark bench -p google -c weather-card

# Opt into hosted floor — variant ids suffixed '-hosted'
pnpm --filter @ggui-ai/benchmark bench -p google -c weather-card --floor hosted

# Side-by-side comparison — every variant runs twice
pnpm --filter @ggui-ai/benchmark bench -p google -c weather-card --floor both
```

`--floor both` multiplies variant count by 2. Budget accordingly.

---

## Design discipline

- **`floor` is the ONLY public-interface axis for the split.** Do not
  add scattered `if (env.DEPLOYMENT === 'hosted')` or
  `if (process.env.CI_HOSTED)` branches in the generation path — they
  break the "one honest number per floor" invariant. Route them
  through the floor dimension or a new, equally explicit, documented
  config surface.
- **Default behavior must remain OSS.** When in doubt, new
  hosted-only capability is opt-in via `--floor hosted`, not
  default-on.
- **Runner observables are additive.** `PathUsageMetrics` reserves
  slots for future hosted-vs-OSS signals (e.g., preview producer
  invoked, blueprint-finder consulted). New fields always start
  null/false on OSS and populate only when the corresponding hosted
  path is wired.

---

## When this section stops being honest

The moment a hosted-vs-OSS divergence lands (e.g., provisional-preview
preamble gated on hosted), **update this table first, land the code
second**. Floors that secretly control two things without
documentation here are worse than no floor split.
