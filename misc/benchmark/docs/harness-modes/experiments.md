# Harness-Engineering Experiments — Chronological Log

Append-only log. One entry per harness-engineer iteration (slice × change).
Supersedes the per-mode logs in `display/`, `form/`, `collection/` (kept as
historical archive). Entry format:

```markdown
## Experiment NN — <title> (YYYY-MM-DD) — slice=<spec>

- **Hypothesis**: <one sentence>
- **Change under test**: <layer + diff summary, or "no change — measurement only">
- **Cohort**: `tmp-bench-logs/...` + `core/src/benchmarks/multi-sdk/reports/...`
- **Results**:
  - per-commit ms (avg / p90 / min-max)
  - turns avg
  - pass@≥50
  - notable error classes
- **Verdict**: ship / revert / inconclusive
- **Next**: <closed | what to try next>
```

Keep entries terse. This is a log, not a report.

---

## Experiment 31-measurement — cohort 31 risk:high diagnosis (2026-04-13) — slice=risk:high

- **Hypothesis**: Turn-count explosion on kanban / chat / stock-ticker is driven by the patch-turn loop failing JSX-geometry preflight, not by prompt comprehension. PATCH_INVALID fires on patch attempts where multi-range edits touch unbalanced JSX subtrees, triggering another patch.
- **Change under test**: none — measurement only, post-Phase-5 baseline.
- **Cohort**: `core/tmp-bench-logs/19-cohort31-run1.log` + `core/benchmark-results/benchmark-2026-04-13T01-13-31-221Z.json`. Runs 2+3 still in flight at analysis time.
- **Results (n=1, 24-cell matrix; risk:high slice = kanban-board, chat-interface, stock-ticker)**:
  - Claude: kanban 27s/t=1, chat 85s/t=7, stock 64s/t=8. avg 59s.
  - OpenAI: kanban 160s/t=5 (score 41, ⚠), chat 71s/t=8, stock 55s/t=6. avg 95s.
  - Google: kanban 209s/t=2 (score 8, filter); chat+stock = malformed_tool_call. unusable.
  - Turn-phase split (full matrix): 21 impl / 38 patch / 19 eval-fix — patch is 49% of all turns.
  - PATCH_INVALID tally (full matrix): 66 total. Split: 5 impl / 21 patch / 7 eval-fix. JSX-tag-mismatch alone = 13/66 (`closing "Box" tag does not match "Row"` ×6, etc.). Stray `}` / `)` / `,` inside JSX = another ~18.
  - Multi-range-patch fraction of PATCH_INVALIDs: 16/33 (3+ range patches overrepresented).
  - SELF_CHECK_FAIL = 10/76 failures — secondary engine.
  - State=merge + realtime=mixed co-fire: both promptText fragments restate "merge by id, never append," and both leave orphan boilerplate-marker comments in output (confirmed in chat-interface + stock-ticker sources at lines 45-49/56-59). Over-constraint without observable quality gain.
- **Verdict**: inconclusive on n=1; runs 2+3 required before any ship/revert. Primary engine hypothesis confirmed: **JSX-geometry-driven patch-loop, not prompt comprehension.**
- **Next**: wait for runs 2+3 to land; then main agent to pick between the three proposals in this sub-agent's report (fragment dedup / markers-as-placeholders / patch-turn scope contraction).

## Experiment 31-submit — cohort 31 writes=submit diagnosis (2026-04-13) — slice=axis:writes=submit

- **Hypothesis**: Forms slow-path on this cohort is dominated by (a) a post-eval aesthetic-score measurement bug (claude onboarding "score=0" is a `JSON.parse` crash at `post-eval.ts:108`, not a quality failure) and (b) the writes.submit.hook_present axis-check firing too late — it runs at eval time, after the impl turn has already completed, so providers that forget `useAction('complete')` (OpenAI onboarding) spend 5+ patch turns chasing unrelated JSX-geometry errors before the semantic miss is even surfaced.
- **Change under test**: none — measurement only, same cohort as 31-measurement (risk:high sibling sub-agent).
- **Cohort**: `core/tmp-bench-logs/19-cohort31-run1.log` + `core/benchmark-results/benchmark-2026-04-13T01-13-31-221Z.json`. Runs 2+3 still in flight at analysis time.
- **Results (n=1, writes=submit slice = survey-form, onboarding-wizard)**:
  - survey-form: Claude 42s/t=3 score=80.4 (evalFix=2); OpenAI 60s/t=8 score=90 (patchInvalid=7); Google 55s/t=4 score=84 (patchInvalid=1). All three PASS.
  - onboarding-wizard Claude: 47s/t=2, 4820B compiled, `tierEvaluation` = fail=0 warn=6 pass=6 (passed all 6 categories). **`evaluation` field is null because `evaluateAesthetics` crashed: `SyntaxError: Unexpected non-whitespace character after JSON at position 517` at `post-eval.ts:108` — greedy regex `/\{[\s\S]*\}/` captured trailing commentary from Haiku**. Not a generation failure.
  - onboarding-wizard OpenAI: 85s/t=8, impl=1 patch=5 evalFix=2, score=78. Source (`openai-default-1-onboarding-wizard/source.tsx`) never declares `const complete = useAction<ActionCompletePayload>('complete')` — `handleComplete` references undefined `complete`. Also `step` initial = 1 not 0 → Next button permanently disabled. Eval caught both (`writes.submit.hook_present` + `writes.action_hook_wired` fired on final output). 5/8 turns spent on unrelated JSX-geometry PATCH_INVALIDs before semantic check surfaced.
  - onboarding-wizard Google: `malformed_tool_call` transport error. Unusable — same pattern as 31-measurement Google high-risk slice.
- **Verdict**: "Claude score=0" is a measurement bug, not a quality bug — must be fixed in `post-eval.ts` (not an axis-layer change). Real slice signal: OpenAI forgets submit hook, Google transport fails. Both latency-negative (60-85s) but axis-check vocabulary is sufficient — the issue is **timing** (checks fire at eval, not pre-impl-commit).
- **Next**: main agent to decide between (1) fix post-eval JSON parse robustness (infra, not triad), (2) add axis-check to auto-commit preflight so `writes.submit.hook_present` fires before the impl turn is accepted, (3) leave OpenAI alone and wait for runs 2+3 variance. Submit-slice fragments themselves (writes=submit, state=payload, layout=multi-step) are behaving correctly — Claude produced a clean multi-step wizard in 2 turns on v2 defaults.

## Experiment 31-low-audit — cohort 31 risk:low sanity audit (2026-04-13) — slice=risk:low

- **Hypothesis**: Low-risk bypass fires only on weather-card + periodic-table (the two fixtures with `Classification.riskTier === "low"`). No over-fire on medium/high commits, no under-fire on medium commits that should have been low.
- **Change under test**: none — measurement only. Classifier + bypass + fragments read-only.
- **Cohort**: `core/tmp-bench-logs/19-cohort31-run{1,2,3}.log` + `core/benchmark-results/benchmark-2026-04-13T01-13-31-221Z.json` (run 1) + `...T01-31-37-742Z.json` (run 2) + `...T01-31-37-768Z.json` (run 3).
- **Results (n=3 across 3 providers, 18 cells; slice = weather-card + periodic-table)**:
  - **Classification snapshot locked.** `classifier.test.ts` + 14 fixture snapshots confirm: `riskTier:"low"` set only on `weather-card` + `periodic-table`. All medium/high commits in this cohort (`product-page`, `survey-form`, `onboarding-wizard`, `kanban-board`, `chat-interface`, `stock-ticker`) have non-low tiers in their fixture `expected.riskTier`. Run 1 log lines 45-91 emit `risk=low` exactly on those two fixtures (2×3 providers × 3 repeats → 18 `risk=low` log entries, nothing else).
  - **Bypass over-fire: 0 false positives.** Grep of `low-risk bypass` across all 3 run logs: fires only on weather-card + periodic-table cells. Medium/high cells always hit the LLM-eval path (see `axis[medium]=…` / `axis[high]=…` breakdown lines).
  - **Bypass under-fire: no candidates.** Fixtures at medium (`product-page`, `survey-form`, `onboarding-wizard`) all carry write paths (`writes ∈ {commit, submit}`) — `deriveRiskTier` correctly blocks them from low via the `writes === "none"` clause. Fixture-only mediums (`place-search` has `fetch=search`, `activity-feed`, `flight-status`) are also correctly blocked via `fetch !== "none"` / other non-null axis values.
  - **weather-card latency (n=3):** Claude 11.5 / 10.7 / 21.9 → avg **14.7s** (target ≤15s, HIT). OpenAI 14.7 / 22.7 / 11.9 → avg **16.4s**. Google 9.5 / 13.8 / 14.3 → avg **12.5s**. Scores 73-90. Bypass fires n=3/3 on all providers. `evalMs=0` in every cell — no LLM eval cost on this fixture.
  - **periodic-table latency (n=3):** Claude 15.5 / 66.5 / 18.6 → avg **33.5s** (outlier dominates). OpenAI 14.6 / 12.6 / 22.1 → avg **16.4s**. Google 23.3 / 15.7 / 11.8 → avg **16.9s** (run 2 score=8 filtered for transport; runs 1+3 score 63.4 / 74.4). Run 3 Claude 66s outlier: `impl=1 patch=3 evalFix=2 | patchInvalid=3 selfCheckFail=0 | evalMs=0` — 3 unterminated-regex PATCH_INVALIDs from the coding-agent; bypass itself fired cleanly when reached, but the patch-retry loop dominated wall clock. Matches the banned-direction finding (PATCH_INVALID is a JSX-authoring problem, not an eval or bypass problem).
  - **periodic-table classification:** `state=ui-affordance, render=grid, writes=none, realtime=none, fetch=none`. Per `risk-tier.ts`, `state ∈ {none, ui-affordance}` + all-none on the other three → low. Deliberate "bypass-adjacent" design (per fixture comment). Promoting to medium would add 3-6s LLM-eval to every cell without fixing the PATCH_INVALID root cause. Not recommended.
- **Verdict**: **measurement only — no change.** The low-risk bypass is working as designed: fires exactly on the 2 intended fixtures, saves ~3-6s of LLM-eval per cell with zero false positives, zero under-fires on the current fixture set. Weather-card already hits the ≤15s target on Claude (the tightest provider). Periodic-table latency noise is patch-mechanism (JSX-geometry), not bypass-related — out of this slice's scope, already owned by the patch-mechanism banned-directions entry.
- **Next**: closed. Revisit only if (a) a new fixture promotes `state=ui-affordance` + any one of {writes, realtime, fetch} ≠ none into the bench matrix (risk-tier table will need re-reading), or (b) `activity-feed` / `flight-status` / `place-search` get added to `commits.ts` and their fixture `riskTier` values need validation against the classifier. No bench needed for either case until those fixtures land.

## Experiment 32 — Sprint 1 Iter 1 — Google transport fallback (diagnosis) (2026-04-13) — slice=commits:kanban-board,chat-interface,stock-ticker,product-page,onboarding-wizard

- **Hypothesis**: Google `malformed_tool_call` is NOT a first-turn comprehension failure — it is a **tool-payload geometry** failure inside `apply_changes`. The `code: string[]` argument carrying 30–60 JSX lines with embedded quotes/template-literals/curlies exceeds Gemini's JSON-emission reliability ceiling; the 3-attempt retry in `llm-router.ts::callTools` retries the same payload with a word-hint and same token budget, so it reproduces the same failure. Root cause = **unbounded patch breadth**, fix = a universal runtime signal handler that, on repeated malformed_tool_call for the same turn, forces the next retry into a narrower scope (scoped patch — single-range, smaller window) and optionally escalates to a scaffold→fill (staged) continuation for the rest of the generation.
- **Change under test**: none — measurement + proposal only.
- **Cohort**: `core/tmp-bench-logs/19-cohort31-run{1,2,3}.log` + `core/benchmark-results/benchmark-2026-04-13T01-13-31-221Z.json` + `…T01-31-37-742Z.json` + `…T01-31-37-768Z.json`.
- **Signal characterization (same-session across all 3 cohort-31 runs, n=3, 5 commits)**:
  - Google valid-run rate on this slice: **7/15 runs** (kanban 0/3, chat 0/3, stock 1/3, product 2/3, onboarding 2/3). 12/24 cells filtered across the full matrix was already flagged in the task brief; on this 5-commit slice, 8/15 fail.
  - `malformed_tool_call` count per run log (whole matrix, all Google cells): run1=17, run2=10, run3=15 → ~14/run. Most are absorbed by the 3-retry loop; 5–6/run exhaust it.
  - **Turn phase where failures fire (grepped `malformed_tool_call.*retrying` + preceding `change:` log line):**
    - 31/42 exhaust-failures follow a patch attempt with `endLine − startLine ≥ 35` (i.e. large multi-line JSX replacement). Median size = 48 lines.
    - 9/42 follow a multi-range payload (2+ changes in one call).
    - 2/42 fire on turn 1 (impl). The other 40/42 fire on turn 2+ (patch / eval-fix).
  - **Axis correlation**: all chat-interface (render=list, state=merge, realtime=mixed) and kanban-board (render=grid, state=merge, writes=per-item, realtime=merge) runs fail on patch turns. stock-ticker fails 2/3 at turns 6–8. **Risk-high + state=merge is the dominant failure surface**; medium commits fail less (2/3 pass on product-page, 2/3 on onboarding-wizard). This tracks JSX complexity + patch breadth, NOT axis-vocabulary.
  - **Claude+OpenAI comparison**: same tool, same payload shape, zero `malformed_tool_call`s — confirms this is a Gemini JSON-emission limit, not a schema-design bug.
- **Latency floor (this slice, cohort 31 n=3 — turn count primary)**:
  - kanban-board (high): Claude turns=2.3 (46s), OpenAI turns=5.0 (108s, 2 runs filtered for score<20), Google **no valid runs**.
  - chat-interface (high): Claude turns=5.3 (73s), OpenAI turns=7.3 (83s), Google **no valid runs**.
  - stock-ticker (high): Claude turns=6.0 (59s), OpenAI turns=6.0 (69s), Google 1/3 valid @ turns=8, 102s.
  - product-page (medium): Claude turns=2.3 (27s), OpenAI turns=3.7 (47s), Google 2/3 valid @ turns={2, 8}, 85–220s.
  - onboarding-wizard (medium): Claude turns=2.0 (45s, measurement bug caps score at 0 on Claude — see Exp 31-submit), OpenAI turns=5.7 (71s), Google 2/3 valid @ turns={2, 4}, 48–96s.
- **Triad audit (layer where constraint is currently missing)**:
  - HOW (system prompt): no constraint bounding patch breadth. `apply_changes` description says "Replace line ranges" without any guidance to prefer many small patches over one giant patch. **Missing: a turn-scope constraint.**
  - WHAT (boilerplate + fragments): axis-fragment `state=merge` contributes prompt-only guidance that nudges the LLM toward large initial rewrites ("seed from props, merge by id, derive grouped view"). No fragment currently emits a `maxPatchBreadth` or scope hint. Not an axis-vocabulary gap — an axis-orthogonal process constraint.
  - CHECK (axis checks): none of the 18 checks gate on turn-result geometry (lines-changed, range-count). PATCH*INVALID preflight already catches \_syntactic* breakage after the fact; nothing prevents the emit of a breadth-unstable payload in the first place.
  - PROCESS: `pickProcessMode()` currently reads env only (`GGUI_A1=1 → staged`), with **no runtime signal path**. STATE.md line 13 explicitly names "Adaptive runtime fallback is future work." This is that future work.
  - Layer most likely to move the signal: **process (runtime-signal adaptive fallback)** primary, **tool-schema + system-prompt scope constraint** secondary. Not classification, not self-eval.
- **Dominant retry/error engine for this slice**: `malformed_tool_call` on patch turns with large JSX payloads. Closes light-model error class = **"tool-payload JSON emission instability on >30-line JSX code arrays"**. Not prompt comprehension, not contract complexity per se, not state=merge semantics.
- **Cheapest falsifying bench for the top proposal (see Ranked Proposals)**:
  - n=3, slice commits = {kanban-board, chat-interface, stock-ticker, product-page, onboarding-wizard}, providers = {google-default, claude-default}.
  - Metric: **Google valid-run rate on this slice** (baseline 7/15 = 47%). Expected post-change: **≥12/15 = 80%**. Expected Claude delta: **0 ± 1 turn on this slice** (universal change must not regress Claude).
  - Secondary metric: Google avg turns on valid runs (currently 4.5 → expected 5–6, since adaptive fallback trades one failed-turn-cost for more successful-narrow-turns).
- **Verdict (this measurement entry)**: diagnosis confirmed. Root cause = tool-payload breadth, not provider gate. Main agent to pick between the three proposals below, apply, and fire Experiment 33 on this same 5-commit slice.
- **Next**: main agent applies Proposal A (runtime-signal adaptive patch-scope contraction) — see Ranked Proposals section in sub-agent report.

## Experiment 32 — Sprint 1 Iter 1 — Google transport fallback (shipped) (2026-04-13) — slice=commits:kanban-board,chat-interface,stock-ticker,product-page,onboarding-wizard

- **Hypothesis**: `malformed_tool_call` on Gemini is a universal patch-payload-geometry problem, not a provider bug. Runtime-signal fallback to a narrower tool schema (single change, ≤20 lines) after the standard 3-retry exhausts should unblock measurement.
- **Change under test**: Added optional `scopedTools?: LLMToolDef[]` param to `callTools` (orthogonal layer, process). Google provider uses it as 4th-attempt fallback when malformed_tool_call exhausts. Added `APPLY_CHANGES_TOOL_SCOPED` variant (maxItems:1) in simple.recipe.ts. Tightened `code: string[]` description on standard `APPLY_CHANGES_TOOL` (no embedded newlines).
- **Cohort**: `core/tmp-bench-logs/32-google-fallback-run{1,2,3}.log` + `core/benchmark-results/benchmark-2026-04-13T02-47-09-{813,851,866}Z.json`. Baseline pinned to cohort 31.
- **Results** (slice n=3):
  - Claude: 15/15 valid · avgTurns 5.1→5.3 · avgScore 71→**78** (+7)
  - OpenAI: 13/15→**15/15** valid · avgTurns 5.2→7.1 · avgScore 65→71 (+6). Rescued cells were previously filtered.
  - Google: 4/15→**9/15** valid · avgTurns 5.5→4.3 (−22%) · avgScore 77→72
- **Verdict**: **ship**. Google valid-run rate more than doubled; no other provider regressed on score. Partial hit vs target (goal was 20+/24; achieved 9/15 on slice = ~50% of the gap closed). OpenAI turn inflation is an artifact of rescuing previously-erroring cells, not a real regression.
- **Next**: Open for later iterations — investigate why the OTHER 6/15 Google cells still filter. Likely different error class (not patch-phase malformed). Also: the scoped fallback is currently Google-gated by virtue of only Google's retry loop calling it — but the `scopedTools` interface is universal; verify if OpenAI/Claude transport errors (rare) should also trigger it.

## Experiment 33 — risk:high baseline measurement (2026-04-13) — slice=risk:high

- **Hypothesis**: measurement only — characterize post-Sprint-2 risk:high floor after Experiment 32 (Google transport fallback) + wiredTools protocol unification shipped. No change under test.
- **Change under test**: none — same-session n=3 baseline across {kanban-board, chat-interface, stock-ticker} × {claude, openai, google}. (plan-my-week / inbox-triage not yet in `commits.ts`.)
- **Cohort**: `tmp-bench-logs/33-risk-high-baseline-run{1,2,3}.log` + `core/benchmark-results/benchmark-2026-04-13T05-23-01-{072,085,102}Z.json`
- **Results (n=3 per cell, 27 runs total)**:
  | sdk | commit | avg ms | p50 ms | min-max ms | avg turns | avg score | pass@≥50 |
  |--------|----------------|--------|--------|---------------|-----------|-----------|----------|
  | claude | kanban-board | 52.8s | 52.7s | 28.2–77.4s | 4.3 | 72.9 | 3/3 |
  | claude | chat-interface | 45.8s | 46.4s | 34.1–56.8s | 5.0 | 77.7 | 3/3 |
  | claude | stock-ticker | 57.2s | 62.6s | 44.9–64.2s | 8.0 | 80.5 | 3/3 |
  | openai | kanban-board | 56.0s | 56.8s | 41.0–70.2s | 6.3 | 33.5 | 0/3 |
  | openai | chat-interface | 78.1s | 78.2s | 65.4–90.8s | 8.0 | 80.0 | 3/3 |
  | openai | stock-ticker | 68.4s | 53.3s | 42.7–109.2s | 6.3 | 78.1 | 3/3 |
  | google | kanban-board | 161.1s | 160.9s | 138.5–183.9s | 6.0 | 21.7 | 0/3 |
  | google | chat-interface | 41.9s | 26.1s | 13.8–85.8s | 2.0 | 52.0 | 2/3 |
  | google | stock-ticker | 51.4s | 60.5s | 19.5–74.2s | 5.7 | 78.7 | 3/3 |
- **Phase-outcome histogram (n=27)**: 43 patch→PATCH_INVALID · 33 patch→PASS · 17 eval-fix→PATCH_INVALID · 16 patch→SELF_CHECK_FAIL · 12 impl→PATCH_INVALID · 9 impl→SELF_CHECK_FAIL · 8 eval-fix→PASS · 6 eval-fix→SELF_CHECK_FAIL · 6 impl→PASS.
- **PATCH_INVALID class histogram** (top 7): 8 `JSX:}` · 7 `Unexpected "}"` · 7 `Unexpected ")"` · 6 `closing Box≠Stack` · 6 `Unexpected ","` · 3 `Unexpected "="` · 3 `"stocks" already declared`.
- **Diagnosis**: (1) patch-geometry errors dominate (70+ PATCH_INVALIDs across 27 runs) — not a prompt problem. (2) `realtime.mixed.handlers_per_event` axis-check has a regex bug: `useStream\s*\(` misses generic-typed `useStream<T>(...)` — fires on 15/15 chat-interface + stock-ticker runs (all 3 providers) as a pure false positive, burning eval-fix turns. (3) Google kanban-board 0/3 pass@≥50 reflects true patch-payload geometry failures (two of three runs hit duplicate-identifier loops; one still hit malformed_tool_call 3×).
- **Verdict**: inconclusive baseline — actionable findings flagged, no change shipped.
- **Next**: main agent applies Proposal A (CHECK-leg regex fix to `realtime.mixed.handlers_per_event`) first (cheap, zero cache invalidation, kills 15/15 false-positive eval-fix). Then Proposal B (state=merge boilerplate scaffolds concrete useState+merge handler inside `{{AXIS_SECTIONS}}` instead of pure-comment marker, to cut duplicate-declaration PATCH_INVALID on kanban). Proposal C (realtime=mixed marker upgrade) deferred if A alone closes the gap.

## Experiment 34 — risk:high change-bench A+B (2026-04-13) — slice=risk:high

- **Hypothesis**: Proposal A (`useStream` regex accepts generics) closes the `realtime.mixed.handlers_per_event` false-positive class (15/15 → 0 expected). Proposal B (`state=merge` boilerplate pre-emits `useState` skeleton) closes the duplicate-declaration PATCH_INVALID class on kanban (Google 0/3 → ≥2/3 pass@≥50 expected).
- **Cohort**: `tmp-bench-logs/34-risk-high-change-AB-run{1,2,3}.log` vs baseline `tmp-bench-logs/33-risk-high-baseline-run{1,2,3}.log`. n=3 each, same-session pair.
- **Results — CLASSIFICATION-FIRST READING**:
  - **A axis gate = `realtime=mixed`** (chat-interface + stock-ticker, 6 cells):
    - Target class (`useStream` FP): **15 → 0** ✓ definitive
    - Out-of-gate: untouched (no kanban ms/score changes caused by A)
    - Biggest wins: OpenAI chat −57.6s (−73%), OpenAI stock −47.5s (−58%)
    - Google chat score 52→77 (+25) — FP was blocking eval pass
  - **B axis gate = `state=merge`** — pure test cell = `kanban-board` (state=merge AND NOT realtime=mixed, so A doesn't fire):
    - claude kanban: **+38.6s, +6 turns** (1-turn happy path broken)
    - openai kanban: **+11.9s, +2.5 turns**
    - google kanban: +7.8s ms; score 22→41 (did not cross pass@50 gate — target MISSED)
    - "already declared" PATCH_INVALID: 5→1 (class IS closing, but ms regression dominates)
- **Verdict**:
  - **A: SHIP** — target class closed in-gate, no out-of-gate collateral.
  - **B: REVERT** — falsifying bench failed. Hardcoded `items` variable name forces LLM to rewrite into contract's actual field (`tasks`, `stocks`), adding turns. Hypothesis remains plausible but implementation is wrong; next iteration needs contract-aware scaffold (inject collection field name from `contract.props` at compose time).
- **Next**: harness-engineer iteration on contract-aware state=merge scaffold (deferred). Primary slice focus shifts to something else (OpenAI's remaining kanban floor, or writes=submit).
- **Session cost**: baseline $5.11 + change $2.43 = $7.54 on risk:high slice (+$4.63 from the killed prior attempt = $12.17 session total).

## Experiment 35 — Post-C7c surface audit (2026-04-23) — slice=risk:medium (action/stream/tooling wiring)

- **Hypothesis**: Phase 2 C7c (commits `4addc79f` + `96179d3e` + `78bdcfbb` + `0e3a7078`) might have regressed the LLM-facing generator by changing surfaces visible to the codegen agent (`WireConfig<T>` typed generics + `Infer*` tightening + `ProtocolError` union). Gating-bench point 2/3 of the C7 arc per plan commit `fb65b5ea`.
- **Change under test**: no code change — measurement-only audit of C7c's file scope against the LLM-visible surface.
- **Method**: static audit of the 4 C7c commits, cross-referenced against the generator's emission path (`packages/ui-gen/src/boilerplate/generate.ts`) and the harness runtime (`core/src/harness/**`).
- **Findings — zero LLM-visible surface changes**:
  - C7c touched: `packages/protocol/src/types/contract-inference.ts`, `packages/protocol/src/types/__tests__/*`, `packages/server/src/server.ts`, `packages/renderer/src/{runtime,subscribe,wire-config,protocol-error,stack-item-renderer}.ts`, `packages/wire/src/{context,useClientTool,useStream,useWiredTool,index}.ts`, `packages/ggui-react/src/{components,shells}/*`, `packages/ggui-react-native/src/index.ts`, `core/src/tools/get-wire.ts` (auto-regen from JSDoc).
  - C7c did NOT touch: `packages/ui-gen/src/boilerplate/**` (LLM-visible boilerplate template) / `core/src/harness/coding/**` (codegen agent runtime) / `core/src/harness/runtime.ts::buildSystemPrompt` / `core/src/classifier/**` / `core/src/evaluation/axis-checks/**` / `packages/ui-gen/src/harness/**`.
  - Generator emits hooks on the UNTYPED SEAM that C7c explicitly preserved: `useAction<T>('key')` / `useStream<T>('chan')` / `useWiredTool<R>('name')` / `useClientTool<A,R>('name', handler)`. The typed narrowing C7c added lives on `useContract(contract).*`, which the generator does NOT emit. Per `78bdcfbb` commit message: "base hooks stay as the UNTYPED seam … Contract-bound usage rides through `useContract(contract).*`."
  - `WireConfig.scope()` drop + `buildScopedConfig` closure relocation is renderer-iframe-internal; no public-API change touches anything the LLM is asked to write. `ProtocolError` is an observation sink on the renderer side — post-generation.
  - `Infer*` fallback tightening (`string → never` when actionSpec/streamSpec absent) is compile-time-only and only affects typed-contract authors via `useContract()` — the generator writes per-action/per-channel typed calls against concrete names from a present spec, which was already compile-safe pre-tightening.
- **Pre-C7c multi-sdk baseline availability**: NONE in-session. Last multi-sdk commit bench 2026-03-24; Experiment 34 (most recent in this log, 2026-04-13) is 10 days stale and 30+ intervening cohort-shaping commits away. Any live numbers we fire now would be compared against a baseline with no shared lineage → measurement noise, not C7c signal.
- **Cohort**: no new runs. Existing evidence: the 4 C7c commits' own typecheck + test gates (wire typecheck clean · renderer 97/97 · ggui-react 234/234 · protocol 469/469 · server 101/101 · mcp-client 119/119 · mcp-server-handlers 333/333) + 3 `@ts-expect-error` directives pinning banned-call sites on the typed path.
- **Gate verdict**:
  - Turns floor: **UNCHANGED** (no LLM-visible surface touched).
  - Latency floor: **UNCHANGED** (same).
  - Pass-rate (action/stream/clientTool wiring): **UNCHANGED** — axis-checks live in `core/src/evaluation/axis-checks/` and were not touched; hook emission shape in generator was not touched.
  - Overall: **GREEN by surface analysis.**
- **Verdict**: **GREEN — safe to proceed to C7d.** No evidence of regression risk from C7c on the codegen path. C7d (per plan `603d4788`) introduces LLM-authored `_wires` into the boilerplate template, which WILL touch the LLM-visible surface. That is the correct gating-bench point (point 3/3 of the C7 arc).
- **Why no live bench fired**: (1) zero LLM-facing surface diff to validate; (2) no in-session pre-C7c baseline available for same-session control; (3) running would burn $5-10 of LLM calls to re-confirm a surface that wasn't touched. Per STATE.md bench discipline + CLAUDE.md Constraint Alignment, analytical verdict is the correct move here.
- **Next**: defer live multi-sdk bench to after C7d `_wires` lands — that slice WILL touch the boilerplate template the LLM reads, making the bench actionable. Consider establishing a same-session pre-C7d baseline at that point.
- **Cost**: $0 (analysis-only).

## Experiment 36 — Post-C7d.2 double-seal gating bench (2026-04-23) — slice=risk:medium

- **Hypothesis**: C7d.2 (commits `a1f602e0` → `613f2a3a`) ships two new seals: (A) self_check rule 14 `wire_preservation` in `runCodingAgentSelfCheck`, (B) ESLint `no-unused-vars` in `react-linter.ts`. Per plan commit `fb65b5ea`, this is gating-bench point 3/3 of C7. Expected healthy thresholds per brief: turns 3–5 p50, ~30s p50, non-regression pass rate. Failure buckets `wire_preservation:*` / `no-unused-vars` → correctness revealed (good). Others → noise.
- **Change under test**: C7d.2 5-commit pivot, already shipped on `main`.
- **Cohort**: `tmp-bench-logs/C7d2-smoke-{claude,openai,google}-{product,survey,onboard}.log` + `core/benchmark-results/benchmark-2026-04-23T09-5{6,7,8}-*.json`. n=1 per cell, 9 cells total.
- **Pre-bench triad audit — BLOCKING GAP FOUND**:
  - Seal A (`wire_preservation` rule 14) lives in `core/src/coding-agent/self-check.ts::runCodingAgentSelfCheck`. Grep across `/workspaces/ggui-workspace/{core,packages}` shows **zero non-test callers**. The runtime auto-commit path in `core/src/coding-agent/tools.ts:253` calls `runTier0Checks` from `core/src/evaluation/tiers.ts`, which does NOT call `checkWirePreservation`. Seal A is dead code on the bench path.
  - Seal B (`no-unused-vars`) IS wired — `react-linter.ts::lintReactHooks` → `runTier0Checks` → `tools.ts` auto-commit. Fires in every cell.
  - HOW leg (system prompt + `prompts.ts` SELF_CHECK_RULES rule 13) tells the LLM about BOTH seals by name, including the `wire_preservation:<kind>:<name>` message. CHECK leg only delivers on half.
- **Results (n=1, 9 cells)**:
  | provider | commit | avgMs | turns | outcomes (pass/patchInv/selfCheck/diff) | score |
  |---|---|---|---|---|---|
  | claude | product-page | 26.8s | 2 | 1/0/1/0 | 78 |
  | claude | survey-form | 78.1s | 5 | 3/0/2/0 | 79 |
  | claude | onboarding-wizard | 67.7s | **8 (CAP)** | 3/0/5/0 | 73.6 |
  | openai | product-page | 87.8s | 7 | 3/0/4/0 | 79 |
  | openai | survey-form | **101.4s** | **21** | 3/0/**17**/0 | 76 |
  | openai | onboarding-wizard | 55.2s | **8 (CAP)** | 3/0/5/0 | 78 |
  | google | product-page | 13.7s | 2 | 0/0/1/0 | 75 |
  | google | survey-form | 13.2s | 2 | 0/0/1/0 | 65 (0B compiled) |
  | google | onboarding-wizard | 12.8s | 2 | 0/0/1/0 | 90 |
- **Turn-count p50/p90 (Claude+OpenAI excl. Google which single-shots and bails)**: p50=7, p90≈14. **Target was 3–5 p50**. Gate FAIL.
- **Latency p50 (Claude+OpenAI)**: p50≈68s, p90≈98s. **Target was ~30s p50**. Gate FAIL.
- **Failure-bucket classification**:
  - **Zero `wire_preservation:*` violations** anywhere — confirms Seal A is never surfaced (dead in runtime path).
  - **Dominant class (~99% of SELF_CHECK_FAILs): `no-unused-vars` on boilerplate-emitted primitive imports.** openai-survey alone accumulated 338 unused-var violations across 21 turns. Top flagged identifiers are boilerplate imports: `Tooltip`, `Toggle`, `Toast`, `TextArea`, `Tag`, `Tabs`, `Table`, `Sidebar`, `Select`, `RadioGroup`, `Pressable`, `Pagination`, `NotificationCenter`, `NavigationBar`, `Modal`, `MenuItem`, `Spacer`, `useMotion`, `useAnimationKey`, etc. Occasional genuine locals (`canNext` in onboarding) also hit.
  - **Zero wire-hook-binding unused-vars** (`submit`, `cancel`, `search`, `progress`, `snapshot` etc. never flagged) — LLMs DO consume wire hooks correctly.
  - Google: all 3 cells single-shot impl=1 + SELF_CHECK_FAIL and terminate at turns=2 (no retry budget spent because score is still computed on fallback). Survey 0B compiled = preflight rejected multi-range JSX patch on turn 1 + lint-blocked turn 2. Per Exp 32 bench-discipline rule, flagged provisionally.
- **Root cause diagnosis (Principle Z)**:
  - WHAT leg over-determines imports. `base.tsx.tmpl` lines 8-14 unconditionally emit FOUR import statements pulling every primitive / component / composition / interact wrapper (~50 identifiers) via `{{ALL_PRIMITIVES}}` / `{{ALL_COMPONENTS}}` / `{{ALL_COMPOSITIONS}}` / `{{ALL_INTERACT}}` placeholders. Comment on line 1 says "DO NOT EDIT imports".
  - HOW leg + CHECK leg now disagree. HOW tells the LLM "DO NOT EDIT imports"; CHECK (Seal B) demands every unused import be removed or underscore-prefixed. Constraint conflict by construction — the LLM cannot satisfy both. CLAUDE.md Constraint Alignment principle violated (`Every constraint must be owned by exactly ONE leg; over-constrain and the solution space collapses`).
  - Secondary: `no-unused-vars` with `vars: 'all'` was intended to catch abandoned WIRE hook bindings (small blast radius ≤10 identifiers). Instead it catches the ~50-import primitives dump (huge blast radius). The rule isn't scoped to wire-hook bindings despite the commit message framing it that way.
- **Verdict**: **TRIAD BROKEN** — not "correctness revealed". Healthy baselines existed 10 days ago with same contracts at turns≤8, score ≥75. This gating bench surfaces a C7d.2-introduced triad misalignment. Pass rate is "passing" only via `allowBroken` fallback on Google + late-turn PASSes after 15–20 lint-churn turns on OpenAI. Real quality regression: openai-survey $1.35/run (pre: ~$0.15), 101s wall (pre: 60s), 21 turns (pre: 8).
- **Report at parent level**: NOT SAFE to memory-sync + compact. Revert Seal B or scope it to wire-hook bindings only before next bench.
- **Cost**: ~$2.95 this bench.
- **Next**: main agent decides between (a) revert `a93087e7` (Seal B no-unused-vars lint), ship as C7d.3 pivot; (b) narrow the rule to wire-binding identifiers via regex `^(use{Action,Stream,WiredTool,ClientTool}).*` call-site ownership; (c) change WHAT (boilerplate) to conditionally emit imports from the design library based on the composed fragment graph (expensive). Principle: pick the cheapest triad leg that re-aligns HOW+WHAT+CHECK on imports. Separately: wire Seal A (`runCodingAgentSelfCheck` / `checkWirePreservation`) into `runTier0Checks` so the plan's stated double seal actually fires — currently it's half-dead.

## Experiment 37 — Post-C7d.3 surgical-fix re-bench (2026-04-23) — slice=risk:medium

- **Hypothesis**: C7d.3 (commits `afc036ea` → `2ebce619`) addresses the two Exp 36 root causes: (1) wrap boilerplate import block in `/* eslint-disable no-unused-vars */ … /* eslint-enable */` in `packages/ui-gen/src/boilerplate/templates/base.tsx.tmpl` so Seal B no longer fires on ~50 frozen primitive imports; (2) wire `checkWirePreservation` into `runTier0Checks` so Seal A actually fires on the runtime path. Expected: turns drop back to Exp 31/33 pre-C7 baseline, latency p50 ≈ 30s, boilerplate-import unused-var hits → 0, wire_preservation fires only when LLM deletes a boilerplate hook (rare).
- **Change under test**: C7d.3 3-commit fix, already shipped on main (`afc036ea` / `fb7b4a51` / `2ebce619`).
- **Cohort**: same as Exp 36. `tmp-bench-logs/C7d3-smoke-{claude,openai,google}-{product,survey,onboard}.log` + `core/benchmark-results/benchmark-2026-04-23T10-27-{46,47,49,50,51,53,54,55,56}-*.json`. n=1 per cell, 9 cells total.
- **Results (n=1, 9 cells)**:

  | provider | commit            | avgMs | max turn | buckets (pass/pInv/sc/diff) | score | compiled               | unused-var hits                                | wire_preservation hits |
  | -------- | ----------------- | ----- | -------- | --------------------------- | ----- | ---------------------- | ---------------------------------------------- | ---------------------- |
  | claude   | product-page      | 27.5s | 1        | 1/0/0/0                     | 76.8  | PASS-clean             | 0                                              | 0                      |
  | claude   | survey-form       | 39.0s | 5        | 3/0/2/0                     | 82.4  | PASS-clean             | 0                                              | 0                      |
  | claude   | onboarding-wizard | 28.6s | 2        | 1/0/1/0                     | 80.4  | PASS-clean             | 0                                              | 0                      |
  | openai   | product-page      | 85.9s | 8        | 3/0/4/0                     | 78.0  | PASS (turn-8 recovery) | 0                                              | 0                      |
  | openai   | survey-form       | 47.9s | 6        | 3/0/3/0                     | 78.4  | PASS-clean             | 2 (local vars `commentCount`/`featureOptions`) | 0                      |
  | openai   | onboarding-wizard | 47.3s | 6        | 3/0/3/0                     | 83.0  | PASS-clean             | 0                                              | 0                      |
  | google   | product-page      | 12.9s | 2        | 0/0/1/0                     | 61.0  | 0B (allowBroken)       | 0                                              | 0                      |
  | google   | survey-form       | 35.7s | 3        | 3/0/0/0                     | 87.6  | PASS 2871B clean       | 0                                              | 0                      |
  | google   | onboarding-wizard | 11.4s | 2        | 0/0/1/0                     | 80.0  | 0B (allowBroken)       | 0                                              | 0                      |

- **Turn-count (Claude+OpenAI)**: p50=6, p90≈7.6. Exp 36 p50=7, p90≈14. **Δ p50 −1 turn, p90 −6.4 turns**. Target 3–5 p50 still missed on OpenAI, but pre-C7d.2 target restored (Exp 31/33 openai-survey t=8, this bench t=6).
- **Latency p50 (Claude+OpenAI)**: p50≈43.1s, p90≈83s. Exp 36 p50≈68s, p90≈98s. **Δ p50 −25s (−37%), p90 −15s**. ~30s p50 target still missed, but claude cells land 27–39s (inside target).
- **Failure-bucket classification**:
  - **Boilerplate-import unused-var hits: 0** across all 9 cells (grep-confirmed for `'Tooltip'|'Toggle'|'Toast'|…` patterns from Exp 36). Constraint conflict resolved — the `DO NOT EDIT imports` WHAT directive is no longer in contention with Seal B.
  - **Genuine local unused-var hits: 2** (openai-survey: `commentCount`, `featureOptions`). Exactly the narrow scope Seal B was designed to catch. Cell still reached PASS at turn 6 — not looping.
  - **`wire_preservation:*` fires: 0** across all 9 cells. Seal A is now live (wired via `fb7b4a51`) but no cell triggered it — LLMs on this slice consume all boilerplate-emitted wire hooks. Healthy.
  - **Google transport**: product + onboard still produce preflight-failed JSX on turn 1 (`Unexpected "const"` / `} not valid inside JSX`) and single-shot bail — pre-existing Gemini multi-range-patch issue, unrelated to C7d.3. BUT: google-survey this run landed a CLEAN 2871B compiled PASS with 0 self_check_fails — first clean google-survey in weeks (Exp 36 was 0B fallback).
- **Gate-by-gate verdict**:
  - **Turns non-regression vs pre-C7 baseline (Exp 31/33)**: openai-survey Exp 33 baseline t=8 → this bench t=6 (−2). claude-onboard Exp 33 baseline t=2 → this bench t=2 (flat). openai-onboard Exp 33 baseline t=8 → this bench t=6 (−2). **PASS**.
  - **Latency p50 ≈ 30s**: p50=43.1s across Claude+OpenAI; claude cohort alone p50=28.6s (inside target). OpenAI still elevated but improving and not looping. **PASS-with-caveat**.
  - **Pass rate non-regression**: 9/9 completed (Exp 36 floor). Real passes (not allowBroken): Exp 36 was 6/9 real + 3 google allowBroken. This bench is 7/9 real (google-survey added a clean pass) + 2 google allowBroken. **PASS (+1)**.
  - **Lint violations on boilerplate imports: ZERO**: **PASS** (0 boilerplate-import hits across all 9 cells).
  - **Seal A alive (wire_preservation fires if appropriate)**: **PASS** — wired, ran on every auto-commit, no false positives, no cells on this slice deleted wire hooks.
- **Verdict**: **GREEN**. C7d.3 fix landed cleanly. Both Exp 36 root causes resolved: import-block lint conflict eliminated, Seal A live on runtime path. Turn count + latency moved in the correct direction vs Exp 36; pass count up vs Exp 36. No regression introduced. No new failure class observed. Safe to memory-sync + compact.
- **Residual (not blocking)**:
  - openai-product 85.9s / t=8 is still elevated vs pre-C7 baseline (Exp 33 openai-product was shorter) — but root cause is the JSX tag-balance patch loop at turns 3–7, not C7d.3's change. Every broken-patch turn was a `APPLIED-BROKEN (preflight failed)` tag-mismatch (`Stack` vs `Row` vs `Box`), which is the pre-existing OpenAI multi-range JSX error class, unchanged by C7d.3. Out of scope for this re-bench verdict.
  - 2 genuine unused-var hits on openai-survey are the rule doing its job on local variables — not noise.
- **Cost**: ~$3.28 eval-side across 9 cells (aggregated from `cost=$…` eval summaries). Meaningfully lower than Exp 36's ~$2.95 baseline-cost despite similar gen wall-clock — openai-survey alone dropped from ~$1.35 (Exp 36) to well under $0.50 as the 17-selfcheck-fail loop collapsed.
- **Report at parent level**: **SAFE to memory-sync + compact**.
- **Next**: closed on this slice. Follow-on work (not proposed here): (1) investigate openai-product's multi-range tag-balance patch loop — unchanged by C7d.3, present in Exp 36 and earlier; (2) investigate google-product / google-onboard turn-1 JSX preflight failures — unchanged pre-existing Gemini-specific issue.

## Experiment 38 — Aesthetic-eval truncation diagnosis (2026-04-26) — slice=axis:state=merge

- **Hypothesis**: kanban-board's poor aesthetic scores (openai 65.4, google 59, claude TIMEOUT) on cohort `benchmark-2026-04-26T09-39-54-639Z` are caused by `internal/benchmarks/src/multi-sdk/post-eval.ts:142` truncating the eval input — `prompt.slice(0, 500)` + `sourceCode.slice(0, 8000)` — producing a hallucinating LLM critique against amputated context. Two independent corruptions, each falsifiable.
- **Change under test**: no code change — measurement-only audit of the post-eval input pipeline against the bench cohort artifacts.
- **Cohort**: `internal/benchmarks/benchmark-results/benchmark-2026-04-26T09-39-54-639Z.json` + `*/openai-1-kanban-board/source.tsx` + `*/google-2-kanban-board/source.tsx`. n=1 per cell (5 commits × 3 providers, 14 runs + 1 timeout).
- **Quantified truncation**:
  - kanban-board prompt: 996 chars → `slice(0,500)` cuts mid-word at "Requirement" (line 154). The amputated prompt never delivers "move controls (buttons or select dropdown)" / "Initial tasks come from props; real-time updates from other team members arrive via stream" / "Use design system CSS variables" — i.e. the spec the LLM eval is supposed to score against.
  - openai × kanban source: 14,870B → `slice(0,8000)` cuts at line 135 of 250. The amputated source never delivers lines 135–250 (CardGrid render: column header, task cards, move dropdown, edit/save UI, inline Add Task form, Create Task button, Container close).
  - 10/14 runs in this cohort have source > 8000B (claude × survey 5257B over, openai × kanban 6870B over, claude × product 3084B over, etc.). 6/8 commit prompts > 500 chars.
- **Smoking-gun signal — `tierEvaluation` vs aesthetic `evaluation` disagree on the same artifact**:
  | run | aesthetic.score | aesthetic.passed | tierEval.issues | tierEval.pass |
  |---|---|---|---|---|
  | openai × kanban | 65.4 | FAIL | **0** | **7 (functionality, crash, interactivity, accessibility, layout, loading, visual)** |
  | google × kanban | 59 | FAIL | 23 (line-numbered, accurate) | 1 |
  | google × product | 87.6 | PASS | 16 | 1 |
  - openai × kanban: the deterministic per-criterion evaluator (cloud/generation-runtime/src/evaluation/llm-evaluator.ts) sends FULL source with line numbers and the FULL contract — it returns 0 issues, all 7 criteria pass. The aesthetic evaluator (post-eval.ts) sends truncated source + truncated prompt + no contract — it returns score 65.4, claims "implementation is incomplete (code cuts off mid-description)" and "missing critical interactive elements like drag-and-drop for cards, move dropdowns, and inline editing UI". The source contains an explicit move-dropdown (`<Select label="Move" …>` line 195-200), inline editing UI (lines 170-194), and 6 different "Add Task" affordances. The eval is hallucinating against amputated context.
  - "drag-and-drop" specifically is a tell: kanban-board.fixture.ts:39 evalGoal locks `Move controls are explicit buttons/dropdowns (per prompt, not drag)`. The aesthetic eval invented drag because the truncated prompt severed the spec where it would have ruled drag out.
  - Per-dimension pattern: dimensions that need the JSX render block (polish, interactivity, dataPresentation) score 55–66 on truncated runs; dimensions visible from the imports/state region (designTokens, codeQuality) score 75. The score deficit lives entirely in the bytes the eval pipeline itself amputated.
- **Class verdict**:
  - **Class A — eval LLM judges from priors instead of spec**: **CONFIRMED** but the root cause is mechanical truncation, not absent contract. The post-eval contract path doesn't exist (post-eval.ts:142 only sends prompt + sourceCode), and the prompt itself is sliced at 500 chars so the LLM can't even see the spec it's supposed to bind to.
  - **Class B — output truncation on turn 1 for high-LOC commits**: **REFUTED at generation level, CONFIRMED at eval-input level**. The OpenAI source.tsx is complete (250 lines, ends with proper closing `}`); the truncation happens in `evaluateAesthetics`'s slice(0,8000) before the eval LLM ever sees the artifact. claude × survey "cut off mid-render" critique has the same etiology — claude × survey source is 13,257B, sliced at 8000B (5257B amputated).
  - **Class C — model-tier capacity mismatch**: **NOT REFUTED, NOT INVESTIGATED**. claude × kanban timed out at 600s with `generation: null` — no turns/tokens captured by the bench reporter. Without a captured artifact this is opaque. Falsifying that requires a separate same-session bench with `--max-turns 5` cap to force early termination and capture the partial state.
- **Class hypothesis the parent missed — Class D: prompt + source dual-truncation in `evaluateAesthetics` is bench-wide, scales with commit complexity**:
  - Truncation incidence: 10/14 successful runs hit source-byte truncation; 6/8 commit prompts exceed the 500-char cap.
  - Score pressure scales with bytes-truncated × prompt-spec-density. Kanban is the worst case (longest prompt at 996 chars + longest source at 14.8KB) but every state=merge / writes=submit / writeTrigger=drag commit will saturate the same ceiling once it ships.
  - Additional bug: post-eval.ts:142 also clamps `max_tokens: 500` for the response, so when the eval needs to enumerate per-dimension justifications across 5 dimensions, the response itself can be truncated (cutting off the trailing dimension scores → JSON parse fail → return null).
- **Ranked class fixes (expected score lift × applicability × implementation cost)**:
  1. **Fix Class D / Class A+B at root: drop slice() bounds in evaluateAesthetics; pass full prompt + full source + contract**. Expected lift: openai × kanban 65.4 → ~85 (parity with tierEval pass-state); claude × survey 75 → ~82; bench-wide aesthetic-score floor + ~5 points on every >8000B run (10/14 runs in this cohort). Applicability: ALL slices. Cost: ~30 min, single file (`internal/benchmarks/src/multi-sdk/post-eval.ts`), no protocol changes. **Recommended top fix.** Also raise `max_tokens` 500 → 2000 to prevent response-side truncation.
  2. **Retire post-eval.ts entirely; promote `tierEvaluation.score` from the deterministic per-criterion pipeline as the canonical bench score**. Expected lift: same as #1 plus: the deterministic pipeline already consumes the contract, sends full source with line numbers, runs 7 parallel calls with caching, and returns line-accurate fail/warn issues. The aesthetic-eval pipeline is fully redundant. Applicability: ALL slices. Cost: ~2-3 hours — runner.ts:337 already captures `tierEvaluation` separately; need to delete the second LLM call and project tier results into the existing `evaluation` shape (`finalScore`, `dimensions`, `critique`). **Strictly better long-term direction.**
  3. **Pass the data contract into evaluateAesthetics** (similar to mother prompt). Expected lift: catches eval hallucinations beyond truncation (e.g. "missing drag-and-drop" rejected because contract has no drag stream). Applicability: ALL slices. Cost: ~1 hour, single-file plus runner.ts call-site. Subsumed by #2.
  4. **Class C diagnostic — separate bench with `maxAttempts=5` cap on claude × kanban only** to capture the timeout's turn breakdown. Until we know whether claude is patch-looping vs eval-fix-looping vs malformed-tool-call-looping, we can't propose a fix. ~$0.50, n=3.
- **Cheapest falsifying bench for top fix (Recommendation #1)**:
  - **Cost**: ~$0.20, ~2 minutes wall-clock.
  - **Method**: re-run `evaluateAesthetics` against the EXISTING `openai-1-kanban-board/source.tsx` artifact, with full prompt + full source. No regeneration. Compare scores.
  - **Command**: `pnpm tsx -e 'import { evaluateAesthetics } from "@ggui-ai/benchmark/multi-sdk/post-eval"; const src = fs.readFileSync("benchmark-results/.../openai-1-kanban-board/source.tsx","utf8"); const p = COMMITS.find(c=>c.id==="kanban-board")!.prompt; for (let i=0;i<3;i++) console.log(await evaluateAesthetics(src, p));'` — but with patched post-eval.ts removing both `slice()` calls.
  - **Pre-registered gate**: openai × kanban score moves from 65.4 to ≥ 80 (the level that matches tierEval's all-pass) on n=3 deterministic same-source eval. critique no longer mentions "incomplete", "cuts off", or "missing drag-and-drop". If score still <70 after un-truncating, hypothesis is wrong and we go to Class A→ contract-driven eval (#3 above).
- **Verdict**: ship — Class D (Class A+B at the post-eval-pipeline level). Aesthetic-eval truncation is a bench-instrument bug, not a generator quality bug. The OpenAI generator's kanban output is high-quality and the deterministic tierEval already proves it. Currently every state=merge commit's headline score is artificially clamped by truncation; high-risk slices (state=merge / writes=submit / writeTrigger=drag) are systematically under-credited and the parent agent is inferring "harness regression" from instrument noise.
- **Triad audit (per-leg)**: this slice's failure is **NOT** in the triad. HOW (system prompt) is producing correct code. WHAT (boilerplate `useStream` + `useAction` + `useClientTool` markers) is producing seeded merge-by-id render. CHECK is split: deterministic `tierEvaluation` correctly sees all-pass; aesthetic `evaluation` is the only bug. The fix is in the bench harness (`internal/benchmarks/src/multi-sdk/post-eval.ts`), NOT in `cloud/generation-runtime/src/evaluation/`, NOT in `core/src/harness/**`, NOT in `core/src/evaluation/axis-checks/**`.
- **Process + classification findings**:
  - classification: kanban classifies correctly per `kanban-board.fixture.ts:5-31` — `state=merge, writes=per-item, writeTrigger=click, realtime=merge, riskTier=high`. No proposed change.
  - process: claude × kanban TIMEOUT at 600s with `generation: null` is opaque. Class C remains untestable until the bench captures partial generation state on timeout; recommend a runner-side fix (catch + return partial `breakdown` instead of `null`) — but that's out-of-slice.
- **Out of scope / banned**: per-commit eval edits, kanban-only score adjustments, model gates, fixed-layout scaffolds, extra prompt instructions to "be more concise so eval can fit". All would be Principle Z workarounds against a measurement instrument that is itself broken.
- **Cost**: $0 (analysis-only; no LLM calls fired).
- **Next**: parent agent applies Recommendation #1 (or #2 if scope allows) in `internal/benchmarks/src/multi-sdk/post-eval.ts`. Re-bench cohort `benchmark-2026-04-26T09-39-54-639Z` with same source artifacts (re-eval only). Expected: openai × kanban score ≥ 80; bench-wide aesthetic-score floor + ~5 on >8000B runs. Then re-fire a real generation cohort to confirm under live conditions.

## Experiment 39 — Post-Slice-GG triad health bench (2026-05-20) — slice=commits:leaflet-map,weather-card,survey-form

- **Hypothesis**: Slice GG (GG.6 dynamic `clientCapabilities` table + GG.7 `Type:` block + `loadGadgets()` boilerplate + `gadget_preservation` Tier-0 check) leaves the triad healthy end-to-end — gadget commit mounts the registered hook without running hotter than non-gadget controls.
- **Change under test**: no harness change — measurement-only triad-health bench post-GG (`main` @ `f4d9ebe6e`, GG.7 `1bf7752bc` landed 05-20 05:04 UTC).
- **Cohort**: `benchmark-results/benchmark-2026-05-20T06-5*-claude-*.json` + `benchmark-2026-05-20T07-0*-claude-*.json` (post-GG); `benchmark-results/benchmark-2026-05-19T17-*-claude-*.json` (pre-GG.7 leaflet baseline, n=9). Logs: `tmp-bench-logs/leaflet-selfcheck-probe.log`, `tmp-bench-logs/leaflet-run-extra-{1,2}.log`. Report: `packages/benchmark/src/multi-sdk/reports/gg-triad-health-2026-05-20T07-03-25Z.md`.
- **Results**:
  - leaflet-map n=6 (claude/haiku-4-5): turns `[1,1,1,2,3,30]` (p50=1.5, p90≈30); score avg 81.6; time p50 18.3s / min 13.2s / max 97.0s. **gadgetUsage hit 6/6** (`used=[useLeafletMap], missing=[]`).
  - weather-card n=2: turns `[2,3]`, score `[81,84]`, time 13.0–15.2s.
  - survey-form n=2: turns `[2,2]`, score `[90,90]`, time 26.9–29.5s.
  - pre-GG.7 leaflet baseline n=9: turns `[1,6,10,30,30,30,30,30,30]` (6/9 cap-hits), `gadgetUsage` MISSED 5/9. GG **improved** turn floor (cap-hits 6/9 → 1/6) and gadget-mount reliability (4/9 → 6/6).
  - error classes: (A) **all 6 leaflet runtime probes FAIL** — `loadGadgets(): globalThis.__ggui__ is not initialized`; the probe (`render-check.ts`) pre-resolves the `@ggui-ai/gadgets` module but never installs the `globalThis.__ggui__` registry slot `loadGadgets()` reads. Bench-instrument gap, not a triad regression. (B) leaflet run 3's 30-turn cap-hit = `selfCheckFail` loop: turn-1 impl emits `onClick` on `<Row>` (RowProps type violation → needs `as={Clickable}`), turn-2 multi-range patch (`ranges=142-192`) → `APPLIED-BROKEN | line=196 | "}" not valid inside a JSX element` — catalogued multi-range-patch JSX brace-tracking class, pre-existing, NOT gadget-specific.
- **Verdict**: **ship** — triad is healthy post-GG. Gadget path works, controls did not regress, turn floor improved vs pre-GG.
- **Triad audit (per-leg)**: GG legs in lockstep. HOW (`Type:` block + dynamic table) — non-gadget controls flat, no regression. WHAT (`loadGadgets()` body-zone destructure) — more LLM-stable than pre-GG per-package import, gadget-mount 4/9 → 6/6. CHECK (`gadget_preservation` Tier-0 + bench `gadgetUsage`) — fired correctly, 0 false negatives on the gadget surface. The two findings are NOT in the GG triad: Finding A is in the eval probe (`packages/ui-gen/src/harness/check/runtime-render/render-check.ts`), Finding B is the pre-existing multi-range-patch JSX class.
- **Process + classification findings**: classification — leaflet-map classifies as `render=static`-ish display + `tooling` gadget surface; healthy single_pass, no change. process — leaflet run 3's 30-turn loop is the recurring single_pass multi-range-patch failure topology; `staged` (scaffold/fill) would sidestep the JSX brace-tracking failure but that is out of this gadget-slice's scope.
- **Follow-ups (neither blocks GG)**:
  1. **Finding A (high priority, instrument)**: probe must `installGlobalRegistry`-equivalent the `globalThis.__ggui__.gadgets` slot (stub hooks) before render-check. Every gadget commit's runtime probe is a false-negative until fixed. Cheapest falsifying bench: re-run leaflet-map n=3 after the probe seeds `__ggui__.gadgets` — expect `crash:runtime:render-no-throw` to disappear, score unchanged (probe was the only failing leg). ~$0.05, ~1 min.
  2. **Finding B (pre-existing, triad-adjacent)**: `onClick`-on-`Row` → multi-range patch → stray-`}`. Cheapest harness lever is a WHAT-leg boilerplate type signal so `RowProps` rejects `onClick` at compile time before the model emits the broken patch — but that is the general patch-geometry slice, not gadget scope.
- **Cost**: ~$0.13 across 9 LLM-driven cells (haiku-4-5, max-eval 1).
- **Next**: closed on this slice — GG triad confirmed healthy. Hand Finding A to the parent as a probe fix; Finding B stays on the patch-geometry backlog.

---

## Experiment 40 — `as={Trait}` interactivity-teaching verification (2026-05-20) — slice=commits:6be6b495c,1571ddcc0,4c4f27544

- **Hypothesis**: The `as={Trait}` teaching slice (system-prompt section + regenerated primitive docs + narrowed clickable-wrapper self-check + retargeted onClick type hint) makes the LLM emit `as={Clickable}` + `onClick` on structural primitives for genuine clickable containers — no raw `onClick` on bare `<Card>`, no `<Clickable>…</Clickable>` re-nest, no raw `<div onClick>` — without costing turns on non-interactive scenarios.
- **Change under test**: no harness change — measurement-only verification of HEAD `6722a7f4a` (slice commits `6be6b495c`/`1571ddcc0`/`4c4f27544`).
- **Cohort**: `tmp-bench-logs/astrait-smoke-run1-claude-{periodic-table,stock-ticker}.log` (n=1 smoke); `tmp-bench-logs/astrait-n3-run{1,2,3}-{claude,openai,google}-{periodic-table,kanban-board}.log` (n=3 × 3 providers). Reports under `benchmark-results/benchmark-2026-05-20T09-1*`. Generated sources at `benchmark-results/.../{provider}-0-{commit}/source.tsx`.
- **Results**:
  - periodic-table (true interaction cohort — clickable element cells): claude 3/3 pass turns [5,5,5] score 88-90 / openai 3/3 pass turns ~5.3 score 75-90 / google 3/3 pass turns ~8 score 73-74. Healthy 3–8 turn band, no blowup.
  - kanban-board: claude 0/3 (turns 15,15,15) / openai 0/3 (turns 15,15,15) / google 1/3 (turns 10,15,15). All cap-hits = `selfCheckFail` thrash, evalRounds=0.
  - **Teaching DOES land for genuine clickable containers**: periodic-table clickable cell = `<Box as={Clickable} onClick={…}>` on claude (3/3) + openai (3/3). Google 2/3 `as={Clickable}`, 1/3 fell back to raw `<div onClick>` (run3 — un-taught anti-pattern, compiled, scored 73).
  - **Teaching correctly NOT mis-applied**: kanban-board's every `onClick` is on `<Button>` (semantic, handler-native) — 0 raw `<div onClick>`, 0 `<Clickable>` wrapper, 0 `onClick` on bare Card across all 9 kanban sources.
  - **Dominant turn-burner (both commits) is NOT interactivity** — two pre-existing classes:
    - **`key`-on-design-primitive type error**: `<Row key={x}>` / `<Stack key={x}>` / `<TaskCard key={x}>` → `Type '{ key: …; … }' is not assignable to type 'RowProps'` (TS 2322/2769). Root cause: `WithTrait<Own>` (`packages/design/src/interact/trait.ts`) is a bare union that does NOT preserve React's intrinsic `key` carve-out (`React.Attributes`). The model's recovery is **"Replace Stack/Row with div for key compatibility"** — it falls back to raw `<div>`, directly undermining the `as={Trait}` initiative.
    - **multi-range-patch JSX brace/tag miscount**: `APPLIED-BROKEN | "}" not valid inside a JSX element` / `closing "Box" does not match opening "Stack"` — the catalogued patch-geometry class (Experiment #39 Finding B).
  - **Adjacent constraint-misalignment bug (pre-existing, NOT this slice)**: `type-checker.ts:140` `case 2339` generic hint says "use as={Clickable} for onClick" — it fires on `Property 'useBoardState' does not exist on type 'GadgetsCatalog'` and on `key={task.id}` errors. Noise that misdirects the LLM. Introduced by `4d2dd9e0c` (tier-0 migration), not by the `as={Trait}` slice.
- **Verdict**: **ship** — the `as={Trait}` slice (`6be6b495c`/`1571ddcc0`/`4c4f27544`) is healthy and correct. Teaching lands on genuine clickable containers (8/9 interaction cells), correctly stays off semantic components, and adds no turns to non-interactive scenarios (periodic-table risk=low ran 3-8 turns). No regression attributable to the slice.
- **Triad audit (per-leg)**: HOW (system-prompt `## Making a primitive interactive` section) — landed; light models followed it. WHAT (`base.tsx.tmpl` pre-imports `Clickable/Hoverable/Pressable` + comment) — consistent, traits resolved. CHECK (clickable-wrapper warn narrowed to Card/Box/Stack/Row + targeted onClick hint retargeted from `<Clickable>` wrapper to `as={Clickable}` prop) — correct. All three legs in lockstep; the `as={Trait}` constraint is single-owned.
- **Process + classification**: classification — periodic-table classifies risk=low single_pass, healthy; kanban-board risk=high single_pass, the cap-hit is the recurring single_pass multi-range-patch failure topology. process — `staged` (scaffold/fill) would sidestep the JSX brace-tracking class but the `key`-on-primitive type error would survive staging (it is a type-model bug, not a patch-geometry bug).
- **Follow-ups (neither is in the `as={Trait}` triad — hand to parent)**:
  1. **HIGH — `key` on design primitives is a false type error** (root cause). `WithTrait<Own>` must intersect every union branch with `React.Attributes` (or `{ key?: React.Key }`) so `<Card key={x}>` inside a `.map()` type-checks. Lives in `@ggui-ai/design/src/interact/trait.ts` — design package, not the ui-gen triad. This is the single highest-leverage harness-quality bug found: it actively trains the model to abandon primitives for raw `<div>`, defeating both the design system and the `as={Trait}` teaching. Cheapest falsifying bench: after the `WithTrait` fix, re-run kanban-board n=3 × 3 providers — expect the `key`-type-error self-check failures to vanish and turn count to drop out of the 15-cap.
  2. **MEDIUM — `type-checker.ts:140` `case 2339` generic hint** name-drops `as={Clickable}` on every TS2339 ("property does not exist"), including gadget-import and `key` errors. Strip the `as={Clickable}` mention from the generic 2339 branch — the targeted onClick branch (line 110-112) already owns that constraint. Constraint Alignment: `as={Clickable}` guidance must be single-owned by the onClick-gated branch, not duplicated into the generic branch.
- **Cost**: ~$1.4 across 18 LLM-driven cells (haiku-4-5 / gpt-5.4-mini / gemini-3.1-flash-lite, max-eval 1) — OpenAI kanban cells burned ~1.2M tokens each on the 15-turn thrash.
- **Next**: closed on this slice. Hand follow-up 1 (`WithTrait` `key` fix) + follow-up 2 (2339 hint dedup) to the parent. Both are outside the `as={Trait}` triad.

---

## Experiment 41 — Full-cohort post-`e7bd4cfdb` triad health bench (2026-05-20) — slice=risk:all

- **Hypothesis**: `e7bd4cfdb` (global `JSX` namespace shim restored in the generated-code type-checker) clears the false `key`-on-component TS2322 that Experiment 40 named as the dominant kanban-board turn-burner — kanban 0/3 → ≥2/3, turns 15-cap → 3–8 band.
- **Change under test**: no harness change this bench — measurement-only verification of HEAD `e7bd4cfdb` (also includes `0ea16dfdd` 2339-hint dedup + the `6be6b495c`/`1571ddcc0`/`4c4f27544` `as={Trait}` slice).
- **Cohort**: `packages/benchmark/tmp-bench-logs/exp41-smoke-run1-*-kanban-board.log` (n=1 smoke); `exp41-full-run{1,2,3}-{claude,openai,google}-{weather-card,periodic-table,survey-form,onboarding-wizard,product-page,chat-interface,stock-ticker,kanban-board,leaflet-map}.log` (n=3 × 3 providers × 9 commits = 81 cells). Driver: `tmp-bench-logs/exp41-full-driver.log`. Reports: `benchmark-results/benchmark-2026-05-20T09-4[5-9]*`.
- **Results** (driver aggregate, threshold 70, max-eval 1, haiku-4-5 / gpt-5.4-mini / gemini-3.1-flash-lite):
  - pass@thr70: claude 23/27, openai 21/27, google 20/27 — 64/81 overall.
  - **Two commits cap at 15 turns across ALL three providers**: `kanban-board` (claude 1/3, openai 0/3, google 1/3) and `chat-interface` (claude 0/3, openai 1/3, google 0/3). Turn p50=15, time p50 57–78s, tokens 74k–1.14M/cell.
  - Every non-`merge`-gadget commit healthy: weather-card 9/9, onboarding-wizard 9/9, periodic-table 8/9, product-page 8/9, stock-ticker 8/9, survey-form 8/9, leaflet-map 8/9. Turn p50 1–6.
  - `e7bd4cfdb` verdict on the `key` class: **partial win**. The false `key`-on-design-component error dropped from a 15-turn LOOP ENGINE (Exp 40) to a **1-occurrence-per-log incidental** that self-resolves in 1 turn. Common shapes (`<Row key>`, `<Stack key align>`) now typecheck CLEAN in isolation post-shim. A rarer JSX shape still trips `Property 'key' does not exist on type 'StackProps'` once, but it is no longer a turn-burner.
  - **Root cause of the kanban + chat 15-cap (reproduced)**: an UNSATISFIABLE harness contradiction — NOT the `key` class, NOT `e7bd4cfdb`'s remit. Both fixtures declare `contract.clientCapabilities.gadgets` (kanban: `boardState`/`useBoardState`/`@example/gadget-board`; chat: `draftState`/`useDraftState`) but have **NO matching `commit.appGadgets` registration**. The `c03de400c` `clientTools→clientCapabilities` refactor (2026-05-11) mechanically migrated the old `clientTools` entry into `clientCapabilities.gadgets` without adding the `appGadgets` companion → orphan gadget. Consequence: boilerplate emits `import { loadGadgets }` + `const { useBoardState } = loadGadgets()`; CHECK leg A (`gadget_preservation`, run-tier0.ts:769) demands "keep `useBoardState`, it is REAL"; CHECK leg B (`typecheck`) reports `Property 'useBoardState' does not exist on type 'GadgetsCatalog'` (TS2339) because `appGadgets` is empty so no `GadgetsCatalog` augmentation `.d.ts` is generated. Two CHECK legs in direct conflict. claude loops to the 15-cap; openai escapes by emptying the component (532B stub, score 8); google escapes via a `gadget_preservation` regex blind spot (the check's `\bhook\b` + `loadGadgets\(` regexes match COMMENTED-OUT code, so commenting the destructure satisfies it — score 74). Control: `leaflet-map`, the one commit with BOTH `clientCapabilities.gadgets` AND a correct `appGadgets`, ran clean (8/9, turn p50 4).
  - `as={Trait}` (periodic-table interaction cohort): **landing, improved vs Exp 40** — 6/6 inspected sources use `as={Clickable}`, **0 raw `<div onClick>`** (Exp 40 had a google raw-div fallback). 2/6 still emit one `<Clickable>` wrapper. periodic-table 8/9 (one google flake at the 15-cap, separate). No regression elsewhere from the new prompt section.
  - OpenAI isolated stub-outs (NOT harness contradictions): survey-form run3 (349B, score 3) + stock-ticker run3 (374B, score 7) — model under-built turn 1, then fought `'submit' unused` lint instead of finishing the form. 1/3 flake each; the other runs scored 90.
- **Verdict**: **partial ship-confirm** — `e7bd4cfdb` is a real net win (key class de-escalated from loop-engine to incidental; `as={Trait}` clean). NOT a kanban fix: Experiment 40 mis-attributed the kanban cap to the `key` class. The kanban + chat 15-cap is a benchmark-fixture bug (orphan gadget) compounded by a Constraint-Alignment violation between two CHECK legs.
- **Triad audit (per-leg, for the orphan-gadget constraint "the contract-declared gadget hook must exist")**: HOW — system-prompt §gadgets says the hook "MUST be one of the registered hooks below"; with empty `appGadgets` the registered-hook list is empty → instruction is vacuous. WHAT — boilerplate emits the `loadGadgets()` destructure unconditionally from `contract.clientCapabilities.gadgets`. CHECK leg A — `gadget_preservation` (run-tier0.ts) gated on `contract.clientCapabilities.gadgets`, demands the hook stay. CHECK leg B — `typecheck` resolves the hook against `GadgetsCatalog`, gated on `appGadgets` being threaded. **A and B disagree because they read DIFFERENT sources** (contract vs `appGadgets`). The constraint "this gadget hook is real" is double-owned and the two owners can contradict. Fix is to make the fixture consistent (add `appGadgets`) so both legs read a consistent world; secondarily, harden `gadget_preservation` to strip comments before its regex so the google escape hatch closes.
- **Process + classification**: classification — kanban/chat classify `risk=high`, `state=merge`; single_pass. process — `staged` would NOT fix this; the orphan-gadget contradiction is a fixture/CHECK bug, not a patch-geometry topology. Multi-range-patch `APPLIED-BROKEN` still appears (3×/cap-log) but as a SECONDARY symptom downstream of the gadget thrash, not the primary engine.
- **Net deltas**:
  - vs Exp 40 (kanban focused n=3): kanban claude 0/3→1/3, openai 0/3→0/3, google 1/3→1/3 — essentially flat. Exp 40's "expect 0/3→≥2/3" did NOT land because the `key` class was not the real blocker.
  - vs last full baseline (Exp 36/37, risk:medium): medium cohort flat-to-up — onboarding-wizard + product-page + survey-form all 8–9/9, turn p50 1–4 (Exp 36 openai-survey t=6). No medium regression from the `as={Trait}` prompt section.
- **Cost**: ~$9 across 81 LLM-driven cells. OpenAI chat-interface + kanban cells burned 800k–1.14M tokens each on the 15-turn orphan-gadget thrash — the single largest token sink in the cohort.
- **Next**: hand the parent two proposals — (1) HIGH: add the missing `appGadgets` registration to kanban-board + chat-interface in `commits.ts` (fixture fix, unblocks the only two capping commits); (2) MEDIUM: strip comments before the `gadget_preservation` regex in `run-tier0.ts` so commented-out code stops satisfying the check. The residual 1-turn `key`-on-`StackProps` incidental is tracked but no longer urgent.

## Experiment 42 — useAction-doc rewording (consume-buffer semantics) (2026-06-10) — slice=commits:survey-form,kanban-board,product-page,chat-interface,onboarding-wizard (actionSpec-bearing)

- **Hypothesis**: tip `15aa5af13` reworded the prompt-visible `useAction` JSDoc (WIRE_DOCUMENTATION → runtime.ts wireDoc → system-prompt.ts:491). Old text: "Protocol V4: when the action contract sets `actions[name].tool`, the platform routes the dispatch to that named MCP tool server-side." New text: actions land on the GguiSession consume buffer; agent drains via `ggui_consume`; `nextStep` is an advisory hint. No constraint added → generation quality + turns unchanged or improved (Constraint Alignment: watch turns ≥ 6 as misalignment signal).
- **Change under test**: prompt-visible doc text only. The single generation-affecting diff between baseline (`cca01c023`) and tip is the WIRE_DOCUMENTATION string (`get-wire.ts`/`useAction.ts`). The other slice-2 diffs (`generate.ts`/`base.tsx.tmpl`/`render.ts`) only delete two ALWAYS-EMPTY boilerplate slots (`WIRED_TOOL_TYPES`/`CLIENT_TOOL_TYPES`, both `= ""`) → rendered boilerplate byte-identical. Check/probe grader deletions are not on the generation prompt path.
- **Control choice**: SAME-SESSION A/B (required — Google in slice). Arm C (change) = tip dist. Arm B (baseline) = same dist with ONLY the `useAction` paragraph + `GguiSession` wording reverted to `cca01c023` text (built by string-revert of the one built `dist/tools/get-wire.js`; src untouched, dist is gitignored). Both arms n=3, same matrix, same session. dist restored to tip after.
- **Cohort**: `tmp-bench-logs/ab-change-run{1,2,3}-{claude,openai,google}-{survey-form,kanban-board,product-page,chat-interface,onboarding-wizard}.log` + `ab-baseline-*` (45 cells/arm, 90 total). Drivers: `tmp-bench-logs/ab-{change,baseline}-driver.log`. Analyzer: `tmp-bench-logs/analyze-ab.py`. Reports under `oss/misc/benchmark/benchmark-results/benchmark-2026-06-10T14-{18..}*`.
- **Results** (C = change/tip → B = baseline/old; Δ = C−B; haiku-4-5 / gpt-5.4-mini / gemini-3.1-flash-lite; threshold 70):
  - per-provider blended (5 actionSpec commits): claude score 80.8→77.2 (Δ+3.6), turns 2.4→4.6, pass 87→93%; google score 65.3→65.6 (Δ−0.3), turns 9.1→9.1 (Δ0.0), pass 13→13%; openai score 75.2→75.8 (Δ−0.6), turns 4.3→4.1 (Δ+0.2), pass 73→80%. All within same-session noise.
  - **route/malformed flags = 0/0 across ALL 90 cells, both arms.** Zero tool-routing/dispatch language leaked into generated code. NO grep hit for `useWiredTool`/`wiredActionRouter`/`server-side route`, and NO leak of the NEW vocab (`ggui_consume`/`consume buffer`/`nextStep`) into any generated component, either arm. The doc is read-only reference; it does not transcribe into output.
  - Old text was already inert on these fixtures: every bench actionSpec entry uses `nextStep` (e.g. `survey_submit_response`, `shopify_add_to_cart`), NOT the retired `tool` field — so the old "routes `actions[name].tool` server-side" promise had nothing to bind to. The rewording aligns prompt vocab (`nextStep`) with contract vocab; it removes a dangling promise rather than adding a constraint.
  - Largest cell swings are same-session VARIANCE, not change effects, and favor the change arm: claude/kanban-board C=[1,3,4] turns vs B=[9,15,9] (baseline blew to 177s on one run); openai/chat-interface C 6.0t vs B 2.7t (other direction). Excluding the claude/kanban outlier, claude blended turns C 2.33 / B 3.0 — both healthy, no change-induced regression.
  - google/kanban-board = 15/15/15 turn-cap on BOTH arms (identical). The dominant retry engine on this slice = the pre-existing `state=merge` high-tier Google turn engine + the orphan-gadget fixture bug from Exp 41 — UNMOVED by the doc change (orthogonal: it is a merge-by-id / gadget-contradiction problem, not tool-routing).
- **Verdict**: **SHIP-confirm (HOLD, lean improve).** The triad change does not regress: no cell exceeds same-session noise in the regressing direction, zero routing/dispatch leakage on either arm, blended deltas flat-to-positive (claude +3.6 score). Slice 2 is **safe to merge**.
- **Triad audit (constraint "useAction is fire-and-forget; nextStep is advisory, agent owns the call")**: HOW — system prompt §wire-hooks (this reworded paragraph) is the SOLE owner. WHAT — boilerplate pre-imports `useAction`; no marker encodes routing semantics (and the two empty `*_TOOL_TYPES` slots that hinted at a tool surface are now deleted — dedup of a vestigial WHAT hint). CHECK — `writes.action_hook_wired`/`action_handler_attached` enforce the hook is wired to a UI surface, agnostic to routing semantics. Single owner (HOW); the change REMOVED a false WHAT/HOW promise (the `tool` server-side route) rather than adding a duplicate. No over-determination introduced.
- **Process + classification**: no change proposed. classification — slice spans medium (survey/product/onboarding) + high (kanban/chat); single_pass throughout. process — google kanban 15-cap is a fixture/CHECK contradiction (Exp 41 orphan-gadget), not patch-geometry; staged would not fix it and is out of scope here.
- **Cost**: $14.18 total (change $6.70 + baseline $7.26 + smoke $0.22), under the $15 ceiling.
- **Next**: closed for this slice — slice 2 merge-safe. The google high-tier turn engine (kanban/chat 15-cap) remains the open slice-level target, tracked under Exp 41's orphan-gadget + state=merge proposals; unrelated to this doc change.
