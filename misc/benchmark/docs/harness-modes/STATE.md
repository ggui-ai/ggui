# Harness State — Axis Era (2026-04-13)

Single source of truth for UI-generation harness engineering. Loaded at the
start of every harness-engineering session and by every `benchmark-runner`
sub-agent (and the autonomous `harness-engineer` agent that spawns them).
Supersedes the pre-Phase-5 3-mode state.

## Locked architectural decisions (do not re-litigate without bench evidence)

- **Active default prompt:** A4-lite v2 (`core/src/harness/runtime.ts` → `buildSystemPrompt()` + turn-1 impl prompt). See `../ui-generation-experiments.md` entries #8-#11.
- **Axis-based classification.** Contract+prompt+blueprint → `AxisVector` + `Classification.riskTier`. The 3-mode (`display | form | collection`) classifier is **retired in Phase 5** (2026-04-13).
  - AxisVector keys: `render`, `state`, `writes`, `writeTrigger`, `realtime`, `fetch`, `layout`, `tooling`
  - `Classification.riskTier ∈ {low, medium, high}` drives the eval bypass
- **ProcessMode** orthogonal: `single_pass | staged`. Default `single_pass`; `staged` behind `GGUI_A1=1` env. Adaptive runtime fallback is future work.
- **Prompt + boilerplate = axis-keyed `HarnessFragment`s.** Composed via `core/src/harness/compose.ts`. No per-mode boilerplate sections (`buildShapeSections` / `SHAPE_SECTIONS` are deleted).
- **Self-eval = axis-gated `AxisCheck`s.** `core/src/evaluation/axis-checks/` replaces `mode-checks/` (deleted).
- **No provider-specific harness logic.** Shipping harness is provider-agnostic; provider asymmetries handled via axis composition + runtime-signal process fallback.
- **No fixed-layout scaffolds.** No per-commit harnesses. No benchmark-shaped UI templates.
- **No generic helper additions** to `@ggui-ai/wire` (e.g., `useGroupedBy`, `useStreamMergeById`). Reverted after review.

## Current triad+process sources of truth

The triad was split across open and closed packages in the 2026-04 cloud-split +
core/-deletion refactor. **Open** = `packages/ui-gen/` (publishable as `@ggui-ai/ui-gen`).
**Closed** = `cloud/generation-runtime/` (hosted-runtime-internal harness wrapping the open core).

| Layer         | File                                                                                                    | Open/Closed | Notes                                                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Classifier    | `packages/ui-gen/src/classifier/classifier.ts`                                                          | open        | `classifyAxes({contract, prompt, blueprint})` → `Classification`                                                                                     |
| Fragments     | `packages/ui-gen/src/fragments/{render,state,writes,writeTrigger,realtime,fetch,layout,tooling}.ts`     | open        | ~30 axis-keyed `HarnessFragment`s with `promptText` / `boilerplateMarker` / `cacheTier`                                                              |
| Composer      | `packages/ui-gen/src/compose.ts`                                                                        | open        | `compose(classification) → ComposedHarness { promptText, boilerplateSections }`                                                                      |
| System prompt | `packages/ui-gen/src/boilerplate/system-prompt.ts::buildSystemPrompt(inputs)`                           | open        | Pure skeleton + injection points. Closed wrapper `cloud/generation-runtime/src/harness/runtime.ts` pre-fills pitfalls/design-system/primitives docs. |
| Boilerplate   | `packages/ui-gen/src/boilerplate/{generate.ts, render.ts, templates/base.tsx.tmpl, templates/layouts/}` | open        | `generateBoilerplate(prompt, contracts, shellType, screen, composedSections)` injects fragment markers                                               |
| Tier-0 CHECK  | `packages/ui-gen/src/check/run-tier0.ts`                                                                | open        | 25+ deterministic checks (compile, security, imports, tokens, types, contracts, wire imports, wire preservation)                                     |
| Axis checks   | `cloud/generation-runtime/src/evaluation/axis-checks/{checks/*, extras.ts, registry.ts, dispatch.ts}`   | closed      | 18 gated checks + 5 axis-only extras                                                                                                                 |
| Eval tiers    | `cloud/generation-runtime/src/evaluation/{loop.ts, evaluator.ts, criteria.ts, llm-evaluator.ts}`        | closed      | Shared across all classifications; low-risk bypass driven by `riskTier === "low"`                                                                    |

## Axis vocabulary (what the classifier emits)

Defined in `packages/ui-gen/src/classifier/axes.ts`. Values that matter for slicing:

| Axis           | Values                                                                 | Source of signal                                          |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `render`       | `static` / `list` / `grid` / `timeline` / `master-detail`              | props shape + prompt                                      |
| `state`        | `none` / `ui-affordance` / `payload` / `draft` / `merge`               | `arr<obj>` + streams + actions                            |
| `writes`       | `none` / `commit` / `multi-commit` / `per-item` / `submit` / `compose` | actions + payload shape                                   |
| `writeTrigger` | `click` / `drag` / `swipe`                                             | prompt keywords + gesture signals                         |
| `realtime`     | `none` / `append` / `merge` / `mixed` / `presence` / `status`          | stream kinds in contract                                  |
| `fetch`        | `none` / `manual` / `periodic` / `live`                                | streams + agent tools                                     |
| `layout`       | `single` / `multi-step` / `master-detail` / `overlay`                  | prompt + contract hints                                   |
| `tooling`      | `none` / `wired` / `client` / `both`                                   | `agentCapabilities.tools` + `clientCapabilities` presence |

`riskTier` derivation is in `classifier.ts::riskTierFromVector`. Roughly:

- **low** — passive display with no writes/streams (e.g., `render=static, writes=none, realtime=none`)
- **medium** — single write path, no stream merge
- **high** — stream+write combos, multi-step, drag/swipe triggers

## Fixture classification snapshot (14 fixtures, 2026-04-13)

See `core/src/classifier/classifier.test.ts` for the locked snapshot. Sample:

| Fixture                                                  | Risk   | Dominant axes                                             |
| -------------------------------------------------------- | ------ | --------------------------------------------------------- |
| weather-card                                             | low    | render=static, state=none                                 |
| periodic-table                                           | low    | render=grid, state=ui-affordance                          |
| product-page                                             | medium | state=ui-affordance, writes=commit                        |
| survey-form                                              | medium | writes=submit, layout=multi-step, state=payload           |
| onboarding-wizard                                        | medium | writes=submit, layout=multi-step                          |
| kanban-board                                             | high   | render=grid, state=merge, writes=per-item, realtime=merge |
| chat-interface                                           | high   | render=list, state=merge, writes=commit, realtime=mixed   |
| stock-ticker                                             | high   | render=grid, state=merge, realtime=mixed                  |
| plan-my-week                                             | high   | writeTrigger=drag, writes=compose, layout=master-detail   |
| inbox-triage                                             | high   | writeTrigger=swipe, layout=overlay                        |
| activity-feed / flight-status / place-search / uber-ride | varies | fixture-only (not yet in bench commits)                   |

## Latency + quality targets

| Metric                      | Target                           | Priority |
| --------------------------- | -------------------------------- | -------- |
| Avg generation time         | ≤30s across all 3 providers      | #1       |
| Avg score                   | ≥75 across all providers         | #2       |
| Avg turns                   | ≤3                               | #3       |
| Low-risk bypass correctness | 0 false positives on medium/high | Gate     |

## The 4 required questions per sub-agent analysis

Every `benchmark-runner` run must explicitly answer these for its slice:

1. **Current latency floor for this slice?** (p50, p90, min across providers, n)
2. **Dominant retry/error engine?** (PATCH_INVALID, SELF_CHECK_FAIL, transport, eval-fix)
3. **Which triad layer is most likely to move it?** (classification / fragments / system prompt / boilerplate / axis-checks / process — primary + optional secondary, with axis+value gate)
4. **Cheapest falsifying bench?** (n, commits, providers, expected Δ)

Vague "tune the harness" proposals without these 4 answers must be rejected.

## Bench discipline

- **Smoke first** (n=1 per commit, one run) — verify no crashes, inspect source output.
- **Narrow n=3** per slice × affected commits — confirm direction.
- **Full matrix** only if narrow is promising.
- **Same-session control required for any Google-specific claim.** Silent cross-session comparisons produce false wins/regressions.
- **Google score filter:** drop runs with `score<20` or `compiled<500B` from impl-pass. Track `malformed_tool_call` rate separately.
- **n=3 minimum for decisions.** Single runs have ±15-20s variance.

## File ownership (parallel-safe)

Sub-agents are **analysis-only**. May:

- Read any code/log/result
- Run benchmarks
- Append to `internal/benchmarks/docs/harness-modes/experiments.md` (single chronological log)
- Write scratch files under `tmp/` or `tmp-bench-logs/`

Sub-agents **must not** edit:

- `packages/ui-gen/src/boilerplate/system-prompt.ts`
- `packages/ui-gen/src/boilerplate/generate.ts`
- `packages/ui-gen/src/boilerplate/templates/**`
- `packages/ui-gen/src/fragments/**`
- `packages/ui-gen/src/compose.ts`
- `packages/ui-gen/src/classifier/**`
- `packages/ui-gen/src/check/run-tier0.ts`
- `cloud/generation-runtime/src/harness/runtime.ts`
- `cloud/generation-runtime/src/evaluation/criteria.ts`
- `cloud/generation-runtime/src/evaluation/llm-evaluator.ts`
- `cloud/generation-runtime/src/evaluation/axis-checks/**`
- `cloud/generation-runtime/src/harness/coding/tools.ts` (or wherever the apply_changes tool lives)

Main agent owns all shared-code edits.

## Shared analysis tooling

`internal/benchmarks/src/analysis/`:

- `compare.py` — per-(provider, commit) deltas, score filter. Update `MODE_COMMITS` if you add a new slice.
- `turn-breakdown.py` — PATCH_INVALID class tally, turn phase mix.

## Experiment log

Single chronological log: `internal/benchmarks/docs/harness-modes/experiments.md`. Per-mode
dirs (`display/`, `form/`, `collection/`) remain as **historical archive**.
Entry format per experiment: see `benchmark-runner` skill Step 7.

## Cohort references

Canonical cohort list: tail of `docs/ui-generation-experiments.md` (or wherever the
historical cohort log was migrated post-core/-deletion).
Axis-era cohorts start at cohort **19** (post-Phase-5 baseline). Pre-Phase-5
cohorts (01–18) remain valid for Claude/OpenAI cross-cohort comparison, but
Google claims must always use same-session control.
