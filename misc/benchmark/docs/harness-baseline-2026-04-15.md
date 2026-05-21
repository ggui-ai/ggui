# Harness Baseline — 2026-04-15

Canonical measured ground truth after the exp55–exp66 run. Future harness experiments start here.

## TL;DR

- **Blended ms (4 fixtures × 3 providers, n=6 same-session)**: **29.3s** on universal default; **27.8s** achievable with per-provider routing (unimplemented).
- **Winning universal config**: `tsformat` docs + `code: string` flat schema + `legacy5` pitfalls + no batch-fix text.
- **Ship-worthy via provider-conditional** (future): per-provider best configs differ.

## Per-provider best configs

| Provider                     | Best config              | Blended ms | Avg turns | Avg score | Pass rate |
| ---------------------------- | ------------------------ | ---------: | --------: | --------: | --------: |
| Claude Haiku 4.5             | `legacy5 + batch-off`    |  **24.2s** |       2.3 |        75 |       82% |
| OpenAI GPT-5.4-mini          | `legacy5 + batch-off`    |  **27.1s** |       2.8 |        69 |       71% |
| Google Gemini 3.1 Flash-Lite | `no-pitfalls + batch-on` |  **32.0s** |       4.0 |        77 |       85% |

**If per-provider routing is implemented → blended 27.8s** (below 30s target).

Why they differ:

- **Claude**: strong base-tier; extra rules dilute attention. Minimal necessary rules + no coercion wins.
- **OpenAI**: 5 legacy pitfalls are load-bearing (without them pass rate drops, ms +133%); but extra pitfalls regress too. Narrow rule set wins.
- **Google Gemini**: brittle tool-call decoder; any prompt bulk trips malformed_tool_call risk. Less prompt + explicit structural hint on retry (batch-on) wins.

## Shipped defaults (universal)

```
DEFAULT_CONTEXT_POLICY (core/src/harness/policy.ts):
  primitiveDocFormat: "ts"      — 128KB → 59KB TS-interface doc (exp57)
  codeFormat: "flat"             — code:string[] → code:string (exp60)
  [other fields default]         — batch-fix off, pitfalls via 5-legacy renderPitfallsBlock
```

Universal blended ms on this config: 29.3s (n=6, same-session).

## Retired ideas (documented so we don't re-test)

| Idea                                                                  | Tested in     | Result                                               |
| --------------------------------------------------------------------- | ------------- | ---------------------------------------------------- |
| Axis-keyed primitive slice                                            | exp45         | Opt-in only; universal bench mixed                   |
| Tool-driven primitive docs (fetch on demand)                          | exp55/55b/55c | Provider-asymmetric; falsified universal             |
| Forced fetch on turn 1                                                | exp55d        | Opens fetch loop failure mode                        |
| Fetch → plan → write pipeline                                         | exp56/58      | Catastrophic Claude regression                       |
| Hashline (`N:hh` line refs)                                           | exp53/59      | Provider-asymmetric; pattern regex didn't save it    |
| Hashline + flat code                                                  | exp60         | Flat alone wins; hashline adds no value              |
| 3 new pitfalls (useState/stream/null-vs-undef)                        | exp61/66      | Attention dilution; -8.8s blended regression         |
| Batch-fix retry emphasis                                              | exp61/62/66   | Universally worse on retry; +7.5s blended regression |
| System prompt cleanup (delete Protocol Notes, trim design system ref) | exp62         | Regression — repetition was load-bearing             |

## Infrastructure that shipped

- `core/src/harness/primitive-index.ts` — compact index builder (dormant; used by tool-driven-primitives profiles)
- `core/src/harness/hashline.ts` + `APPLY_CHANGES_HASHLINE_TOOL(_FLAT)` — dormant, env-opt-in
- `core/src/harness/pitfalls.ts` — pitfalls registry (5 rules, grows append-only)
- `core/src/harness/policy.ts` — `ContextPolicy` framework with opt-in profile knobs: `primitiveDocFormat`, `codeFormat`, `primitiveIndex`, `primitiveIndexForceFetch`, `primitiveIndexPlanTurn`, `planFirstTurn`, `hashline`
- `packages/design/scripts/generate-primitives-docs-ts.ts` — generates compact TS-interface docs (handles interfaces + type aliases)
- `core/scripts/bench.mjs` — validates `-c` commit IDs loudly (no silent fixture drop)
- `core/src/benchmarks/multi-sdk/post-eval.ts` — `dangerouslyAllowBrowser: true` on aesthetic-eval Anthropic client (was crashing under happy-dom)

Env toggles for future experiments:

- `GGUI_PITFALLS=off` — suppress entire Common Pitfalls block
- `GGUI_NEW_PITFALLS=off` — keep only 5 legacy pitfalls (drop the 3 retired ones if re-added)
- `GGUI_BATCH_FIX=on` — force batch-fix retry message (default off)
- `GGUI_POLICY_PROFILE` — activate a named experimental profile (hashline-v2, numberline-flat, primitives-ts-format, etc.)

## Methodology going forward

The practice that made exp66 reliable (and exp55–65 unreliable):

1. **Full factorial > one-at-a-time**. Interactions between levers are real and common. Test the square.
2. **n=6 minimum, same-session parallel**. n=3 variance was 20-30%, swamping marginal-delta signals.
3. **Include a zero arm**. "No pitfalls" calibrated what the rules were actually doing.
4. **Per-provider decomposition, not just blended**. Google wants opposite treatment from Claude — invisible in blended numbers.
5. **Pre-register expected signals**. Writing "win looks like X" before the bench avoids post-hoc rationalization.
6. **Variance floor**. Don't ship marginal deltas (Δ < 1 SE at n=6). Most prompt-text tweaks are below the floor.
7. **Commit bench summary JSON** for cohorts referenced in experiments.md. (TODO — currently `tmp-bench-logs/` gitignored.)

## Next harness-engineering candidates

Ranked by expected impact × effort:

1. **Provider-conditional ship path** — implement `resolveRunPolicyForProfile` branching on `provider`. Immediately gets us from 29.3s universal to 27.8s per-provider-optimal. Zero bench risk, infra-only change.
2. **Axis-sliced factorials** — run exp66-class benches restricted to state=merge or writes=submit to see if effects concentrate on specific fixture axes.
3. **Mined-error-class targeted rules** — when a bench run produces concentrated error types (not universal), add a narrowly-scoped rule via classification gate, not a global pitfall. Example: "wiredTools error-class → hint only on tooling=wired fixtures".
4. **Tier-0 self-check bypass for simple fixtures** — pipeline skip on risk:low already exists (#exp54 bypass). Consider extending to risk:medium fixtures when axis-checks are green.
5. **Eval-fix optionality** — currently every PASS code goes through eval-fix. For simple fixtures where eval rarely finds issues, skipping saves a turn.

## Cohort references

- exp66 n=6 3×2 factorial: `tmp-bench-logs/exp66-{nopitfalls,legacy5,full8}{,batch}-run{1..6}.log`
- exp60 flat-code win (canonical): `tmp-bench-logs/exp60-numberflat-run{1..3}.log`
- exp57 ts-format win: `tmp-bench-logs/exp57-tsformat-run{1..3}.log`
- All historical cohorts via `core/docs/ui-generation-experiments.md`.
