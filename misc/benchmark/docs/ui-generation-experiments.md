# UI Generation Experiments

> Running log of harness-engineering experiments on the UI generation pipeline
> (`core/src/harness/runtime.ts` + `core/src/coding-agent/tools.ts` +
> evaluation). Exists so we don't re-run dead experiments or misremember why
> something "felt better."
>
> Note: pre-Phase-5 entries reference `core/src/recipes/simple.recipe.ts` —
> that file was renamed to `core/src/harness/runtime.ts` and the surrounding
> `core/src/recipes/*` directory moved to `core/src/harness/*` when the
> recipe-era types were retired (`RecipeFragment` → `HarnessFragment`,
> `ComposedRecipe` → `ComposedHarness`, `RecipeResult` → `GenerationResult`).
> Historical log entries are preserved as written; only forward-looking
> headers/tables in this file are kept on the new paths.
>
> Benchmark target: average generation time ≤ 30s with high-quality UIs across
> cheap-tier models (Haiku 4.5, gpt-5.4-mini, Gemini 3.1 Flash-Lite).
>
> Canonical metric: **impl-turn pass rate** (how often the first LLM turn
> produces a component that passes preflight + tier-0 in one shot) + **avg
> generation time** per provider, **with Google filtered for transport noise**
> (generations with `compiled<500B` or `score<20` don't count as a real
> `impl-pass`).

---

## Framing Rule

**We do not reduce cross-provider divergence to "that model is worse."**
When Google or OpenAI Mini struggles, the question is always: what about the
harness is too heavy for that model's structured-output decoder / attention
budget? Transport-layer issues (malformed_tool_call, API 400s) are tracked
separately from code-quality failures.

---

## Experiment Log

Each entry: **date / change / hypothesis / cohort / result / decision**.

### 01 — Baseline (2026-04-12 early)

- **Change**: Initial state before any recipe iteration.
- **Hypothesis**: N/A (starting point).
- **Cohort**: `tmp-bench-logs/01-baseline.log` (8 commits × 3 providers).
- **Result**: Overall avg ~45-50s, Claude 39.95s. Baseline for everything below.
- **Decision**: Establish KPI structure.

### 02 — Triad v1 (pitfalls + common mistakes)

- **Change**: Added system-prompt pitfall guidance (`align/justify` enums,
  Badge variants, Stack/Row `padding` warning), added tier-0 multiline lint
  for the same patterns.
- **Hypothesis**: Recurring enum/prop mistakes costing turns will drop.
- **Cohort**: `02-triad-v1.log`, `03-triad-v2-codex-fixes.log`.
- **Result**: Some pitfall reductions, but Google `malformed_tool_call`
  jumped from ~1 to 7-11/run — adding prompt volume broke Flash-Lite's
  decoder.
- **Decision**: Keep most pitfall guidance. Note: Google is prompt-size
  sensitive.

### 03 — Preflight (syntax preflight before autoCommit)

- **Change**: `apply_changes` parses candidate via `esbuild.transform` before
  `workspace.write`. Failure returns `PATCH_INVALID`, workspace unchanged.
- **Hypothesis**: The 38 compile errors per run (broken JSX from diff
  patches) were polluting `auto-commit FAIL` stats and eating LLM turns.
  Catching them before commit will separate syntax errors from type/contract
  errors.
- **Cohort**: `04-preflight-v1.log`.
- **Result**: **0 compile errors made it to auto-commit** (was 38).
  Self-check fails dropped 52 → 16. Overall Claude 42s/75, Google 66s/67,
  OpenAI 68s/58. Confirmed measurement cleanup.
- **Decision**: Keep preflight.

### 04 — Preflight + centered error feedback

- **Change**: When `PATCH_INVALID` fires, retry slice is centered on
  esbuild's actual error line (`location.line`), not the LLM's first change
  range. New `◄── esbuild error here` marker.
- **Hypothesis**: OpenAI's retry loops were because Mini couldn't locate the
  error from the generic slice around the first change.
- **Cohort**: `05-preflight-v2-centered.log`.
- **Result**: **OpenAI 67.8s → 44.3s (-23s), score 58 → 72.** Claude mostly
  flat.
- **Decision**: Keep centered feedback.

### 05 — Escalation (2× PATCH_INVALID on same line → write)

- **Change**: Track last PATCH_INVALID signature (line/text). On consecutive
  mismatch, swap `apply_changes` → `write` tool for one rewrite turn. Reset
  after.
- **Hypothesis**: Retry loops on stuck line-patches burn turns.
- **Cohort**: `06-escalation.log`.
- **Result**: 4 escalations fired, conservatively. Some recovery, but
  OpenAI × product-page produced a 349B stub via escalated write (3/100
  score). Write tool was not behind preflight.
- **Decision**: Keep escalation but harden write (next entry).

### 06 — Hardened preflight (write + escalation)

- **Change**: Shared `preflightSyntax` helper covering both `apply_changes`
  and `write`. Same esbuild settings, same PATCH_INVALID shape. Escalation
  no-re-entry bug fix (`usedEscalationThisTurn`). `endLine` bounds check.
  Aggregate: `requested/successful/failed` labels (runs without breakdown
  no longer silently dropped).
- **Hypothesis**: Write-escalation can emit stubs → preflight should reject.
  Aggregate must not hide API-failure runs.
- **Cohort**: `07-hardened.log`, `08-run1/2/3.log` (3-run stability check).
- **Result**: Write preflight in place; no runaway writes. Time variance
  ±15-20s between runs even with identical code — the fleet is LLM-noise
  dominated at this size.
- **Decision**: Ship hardened pipeline. This becomes the **closest clean
  baseline cohort** for later prompt experiments.

### 07 — Hashline (per-line content hash anchoring)

- **Change**: `workspace.cat()` emits `N:hh| content` (ASCII pipe, 2-hex
  sha1 of trimmed line). `apply_changes` schema requires `startHash` +
  `endHash`. Executor recomputes, returns `ANCHOR_MISMATCH` on mismatch
  with current slice + actual hashes. Helper: `normalizeProvidedHash`
  with 8-reason taxonomy for LLM copy errors.
- **Hypothesis** (Bölük's blog + Codex review): anchored patches catch
  stale targeting and may reduce retry loops; his benchmark shows
  6.7%→68.3% wins on Grok Code Fast 1.
- **Cohort**: `09-hashline-v0-unicode.log` (unicode `│`, many copy errors
  due to small-model tokenization), `09-hashline-v1.log` (ASCII pipe +
  lenient), `10-hashline-instrumented.log` (+subtype/collision/recovery
  telemetry).
- **Result**:
  - Claude: 53 matches / 13 off_by_1 / 0 hash_not_present. Haiku produces
    **real stale-targeting** bugs that the harness catches.
  - OpenAI Mini: 71 matches / 0 mismatches / 72 clean normalizations.
    Near-perfect compliance. 1 anchor mismatch vs 19 PATCH_INVALID —
    hashline is essentially free but not load-bearing.
  - **Google Flash-Lite: CATASTROPHIC regression.** Scores ≥50 dropped
    from ~5-8/run (pre-hashline) to **0 / 0 / 2 across 3 runs**.
    `malformed_tool_call` rate tracked prompt bloat — the `N:hh|`
    prefix pushed Flash-Lite's structured-output decoder past budget.
  - Tax: ~5% input tokens.
- **Decision**: **Hashline reverted.** Correct engineering (collision-
  aware, real bug catching), but not the lever for the 30s target on
  our fleet. Bölük's magnitude didn't transfer — his benchmark was
  mutation repair on existing React code, ours is fresh generation.

### 08 — A4-lite v1 (prompt reframing — "permission to hedge")

- **Change**: Turn-1 user prompt from `Implement the COMPLETE component`
  to priority-tiered framing with `Allowed to simplify (tier 4):
placeholders OK`.
- **Hypothesis** (from impl-failure mining): impl-turn 1 was overloading
  cheap models; ~64% failed on complex commits. Framing as "structure
  first, polish later" should reduce turn-1 PATCH_INVALIDs.
- **Cohort**: `11-a4lite-run1/2/3.log` (3 runs, hashline-on).
- **Result**: Mixed. Some commits gained (onboarding +11pp, periodic +8pp),
  some lost (weather -11pp, survey -10pp). OpenAI simple: 33% → 17% —
  Mini took "placeholders OK" as permission to under-complete simple
  commits it would have nailed.
- **Decision**: Fail. Codex: "don't force drafting, don't give permission
  to hedge core work." → A4-lite v2.

### 09 — A4-lite v2 (non-negotiable core, omit polish)

- **Change**: Turn-1 prompt restructured:
  - **Required** (non-negotiable): parseable JSX + every required prop +
    every wired hook.
  - **Allowed to simplify** (ONLY flourishes): animations, rare empty
    states, layout refinements.
  - **If flourish risks broken syntax/types: OMIT entirely** (no
    placeholders, no TODOs, no stubs).
- **Hypothesis**: Core work should be non-negotiable; the "permission"
  should only apply to polish, and the fallback should be omit-not-stub.
- **Cohort (hashline-on)**: `12-a4lite-v2-run1/2/3.log`.
- **Cohort (clean baseline)**: `13-a4lite-v2-clean-run1/2/3.log`.
- **Result (closest cohort — 07/08×3 baseline vs 13×3):**
  - **OpenAI: 12.9% → 41.7% impl-pass (+29pp), 66.5s → 39.2s (-27s)**.
    Complex commits: 7% → 42%. Simple: 12% → 67%.
  - **Google: 23.3% → 28.6% impl-pass, 72.6s → 45.7s (-27s),
    `malformed_tool_call` 5-10/run → 0/0/0.** Full transport recovery.
  - **Claude: 37.5% → 29.2% (-8pp), 39.9s → 40.6s (flat).** Sampling-noise
    magnitude at n=24/32 (95% CI for 37.5% spans 21%-56%).
- **Decision**: **SHIP.** Real harness-engineered win for blended cheap-
  tier fleet. Same models, one prompt change, two providers transformed.
  Claude regression within sampling noise at current n — investigate
  with more runs if we need high confidence.

### 10 — A4-lite v3 (falsification — "prompt bloat is the cause")

- **Change**: Collapse v2 to 3 sentences (~60 words from ~250). Drop all
  bullets, drop "rare empty states" wording specifically (hypothesized
  onboarding culprit).
- **Hypothesis (Codex, framed as leading-hypothesis-not-proven)**: v2's
  extra framing is noise for Haiku; shorter prompt should let Claude
  recover without losing OpenAI/Google wins.
- **Cohort**: `14-a4lite-v3-run1/2/3.log`.
- **Result**: **Falsified.**
  - OpenAI impl-pass: 41.7% → 16.7% (-25pp, back to baseline).
  - OpenAI time: 39.2s → 58.4s (+19s).
  - OpenAI complex: 42% → 8% (-34pp) — the +29pp headline win erased.
  - Claude didn't recover (still 29.2%).
  - Google: similar (0 malformed, but impl-pass dipped).
- **Diagnosis**: **v2's structure was load-bearing for OpenAI**, not its
  length. The numbered priority tiers + explicit simplify scope gave Mini
  scaffolding to focus its output. Flat 3-sentence version lost that.
- **Decision**: Revert to v2. Good falsification — we now know
  "prompt bloat = problem" was wrong for this harness.

### 11 — A4-lite v2.1 (fallback wording — "minimal visible fallback")

- **Change**: Replace v2's omission-oriented "Allowed to simplify" bullets
  with fallback-oriented wording. Key phrases:
  - "Simplify: elaborate animations → plain CSS transitions; fancy layout
    → simpler grid/stack." (drops "rare empty states → skip")
  - "For validation, empty states, and review sections — use a minimal
    visible fallback (e.g., `{items.length === 0 && <Text>…</Text>}`,
    `{error && <Alert>…</Alert>}`) rather than omitting the branch."
  - "Behavior the contract implies must remain observable to the user."
- **Hypothesis**: Source-level diff on onboarding-wizard (exp #9 diagnostic)
  showed Haiku dropping inline validation UI under v2's "skip entirely"
  license. Fallback-oriented wording should retain behavior while keeping
  v2's core rule intact.
- **Cohort (narrow pilot)**: 3×Claude-only × {onboarding, weather}.
  - Weather-card: 33% → **67%** (+34pp) ✅
  - Onboarding-wizard: 0% → 0% (flat, patch count slightly lower)
- **Cohort (full)**: `15-a4lite-v2_1-run1/2/3.log` (3 runs × 3 providers × 8 commits).
- **Full-bench result — mixed / not a blended win**:
  - OpenAI impl-pass: 41.7% → 41.7% (tied) ✅
  - OpenAI time: 39.2s → 55.6s **(+16s regression)** ❌
  - Google malformed: 0/0/0 (preserved) ✅
  - Google impl-pass: 28.6% → 22.2%, time 45.7s → 75.8s **(+30s)** ❌
  - Claude impl-pass: 29.2% → 33.3% (modest gain) ✅
  - Claude simple: 17% → **0%** ❌
- **Per-commit shape analysis (vs v2 clean cohort)**:
  - Stateful/multi-step shapes: **onboarding +44pp, chat +37pp, kanban +29pp** ✅
  - Heavy-rendering shapes: **product-page -45pp, periodic -23pp, stock -22pp** ❌
  - Simple display: weather-card -12pp
- **Diagnosis**: The fallback-wording insight is real — it unlocks
  stateful/multi-step shapes (Haiku retains validation UI). But the same
  wording hurts rendering commits (Haiku spends tokens on fallbacks it
  doesn't need). **Different shapes need different scaffolding. Prompt
  wording alone can't carry both universally.**
- **Decision**: **Revert to v2.** Per Codex's pre-registered rule
  ("if not a clear blended win, revert"). Move to A2 (per-shape boilerplate
  scaffolding) — the right layer to carry shape-specific help.

---

### Experiment #12 — A2 full kanban scaffold (2026-04-12)

- **Change**: `generateBoilerplate()` detects kanban shape
  (`props.tasks[].column` + `props.columns` + `taskUpdate` action) and
  injects pre-wired state + stream merge + derived grouping + handleMove
  /handleMoveNext + inline add form state + a fully rendered layout
  (summary bar, per-column Card, task rows with priority Badge/Avatar
  /dueDate/Move button, inline add form with Input+Select+Buttons).
  Narrow detection — only kanban-board fires. Also widened `taskUpdate`
  action with explicit schema (`data: {column, title, priority, assignee,
dueDate}`) so the action type accepts create/edit payloads.
- **Hypothesis**: Pre-seeding the full structure + handlers removes
  kanban's chronic 0-29% impl-pass ceiling by compressing what the model
  has to produce in one turn.
- **Cohort**: `16-a2-kanban-run1/2/3.log` (n=3), 2 commits × 3 providers
  (kanban-board as target, weather-card as canary).
- **Result**:
  - **Google kanban: +28.9pp score (47→75.9), −67s time (~99s→31.7s).** ✅
  - **Claude kanban: −20.3pp score (72.1→51.8), time flat.** ❌
  - **OpenAI kanban: −18.5pp score (57→38.5), time flat.** ❌
  - Weather canary: flat ±3pp / ±10s on all providers. Detector properly
    narrow.
  - pass@score≥50 blended: baseline 62.5% → A2 full 44.4%.
- **Diagnosis**: Pre-rendered controls created a ceiling for Claude/OpenAI
  — eval flagged `MISSING: task title editing`, `MISSING: move dropdown`.
  They preserved the scaffold instead of extending it to meet prompt
  requirements. Meanwhile Google won big — it couldn't produce those
  patterns from scratch in one turn.
- **Decision**: Not a blended win. Ship only if the non-visual structural
  help can be kept without the visible completion cues. Next: #13 (A2a).

### Experiment #13 — A2a strip visible completion cues (2026-04-12)

- **Change**: Keep non-visual scaffold (state, stream merge, tasksByColumn
  memo, totalTasks/completedTasks). Strip all interactive JSX (Move
  button, priority Badge/Avatar/dueDate row, inline add form, +Add Task
  button) and the draft-state/submitAdd/openAddForm/handleMoveNext
  /handleMove helpers. Per-task render minimal — just `<Text>{task.title}
</Text>`.
- **Hypothesis** (Codex): structural/non-visual help keeps working without
  capping Claude/OpenAI. Visible elements alone were the ceiling.
- **Cohort**: `17-a2a-strip-run1/2/3.log` (n=3), same 2-commit slice.
- **Result**:
  - **Claude kanban: +22pp vs A2 (51.8→74.3), back ABOVE baseline 72.1.** ✅
  - **Google kanban: 0B compiled on ALL 3 runs — `malformed_tool_call`
    retries (129s + 65s) + SELF_CHECK_FAIL. BROKE completely.** ❌
  - OpenAI kanban: flat vs A2 (38.5→36.5), still below baseline 57. OpenAI
    produced full implementations but eval caught real functionality bugs
    (hardcoded `column:'todo'` on create). Scaffold was never OpenAI's
    ceiling.
  - Weather canary: **also regressed on Google** (80→49.8 avg, 2/3 bad runs
    including one 0B compiled). Variance, not scaffold — weather path has
    zero scaffold code.
  - pass@score≥50 blended: A2 full 44.4% → A2a strip 33.3%.
- **Diagnosis** — the asymmetry we surfaced:
  - **Claude**: visible scaffold = ceiling → A2a unblocks.
  - **Google**: visible scaffold = transport ballast (small-patch
    enablement). Strip it and Google tries to emit the whole UI in one
    turn → JSON encoder dies. The visible JSX wasn't decoration, it was
    compression.
  - **OpenAI**: indifferent to scaffold shape — kanban failures are
    logic-quality (inferred data flow), not structure.
- **Decision**: **No single shape-scaffold wins blended.** Baseline's
  62.5% pass rate beats both A2 (44%) and A2a (33%). Per-shape hardcoded
  UI scaffolds are a research dead-end for shipping. **Revert and pivot
  to generic opt-in logic helpers** (see Current Decisions).

### Experiment #35 — apply_changes range cap + state=merge promptText delete (2026-04-13)

- **Change** (bundled, since proposals were independent):
  - **Proposal 1 (WHAT-leg)**: `core/src/coding-agent/tools.ts` early-rejects
    patches with `> 2` disjoint ranges, returning a structured
    `PATCH_REJECTED_TOO_MANY_RANGES` hint instructing the model to merge
    nearby ranges OR sequential single-range commits.
  - **Proposal 3 (HOW-leg)**: deleted `state.merge.promptText`
    (5 numbered rules) and `realtime.merge.promptText` (1 sentence) per
    Constraint Alignment — the merge-by-id constraint was already enforced
    by the boilerplateMarker (FREE) + 3 axis-checks (state.merge.\*,
    realtime.stream_merges_by_id). 8 restatements across triad+tests
    were collapsed to 1 (CHECK).
- **Hypothesis** (from benchmark-runner agent): 18/25 PATCH_INVALID failures
  in cohort 34 baseline were multi-range edits. Capping at 2 should drop
  OpenAI patch turns from 11-12 to ≤6, compressing avgMs 80s → ≤55s. Prompt
  deletion should free ~400 tokens cached prefix per high-risk gen with
  neutral score impact.
- **Cohort**: `35-risk-high-change-v1-run{1,2,3}.log`. Slice = risk:high
  (kanban-board, chat-interface, stock-ticker) × 3 providers × n=3 (27 gens).
  Same-session control: cohort 34 baseline.
- **Result** — DID NOT DELIVER:
  - Avg ms (baseline → change):
    - Claude: 40.8s → 51.9s (**+27% slower**)
    - OpenAI: 80.1s → 61.1s (**−24% faster** ✅)
    - Google: 78.3s → 121.7s (**+55% slower**, variance-heavy)
  - Mean score: 67.0 → 65.4 (**−1.6**, near noise)
  - **Critically: `PATCH_REJECTED_TOO_MANY_RANGES` fired ZERO times**
    in change runs. LLMs naturally emit ≤2 ranges in this cohort. The
    multi-range pattern the agent saw was rarer than diagnosed — driven
    by run2 of OpenAI baseline outlier (`ranges=36-36, 45-47, 49-50, 51-54`).
  - Implication: Proposal 1 was effectively a no-op. The latency deltas
    are entirely attributable to Proposal 3 (HOW prose deletion).
  - Single-range patches still fail with the same patterns
    (`Unterminated regular expression`, `Unexpected end of file`,
    `}" not valid inside JSX`). The model's structural reasoning is the
    bottleneck, NOT the patch shape.
- **Diagnosis**: The benchmark-runner agent over-extrapolated from one
  outlier run. The actual JSX surgery failures are within-range, not
  cross-range. Proposal 3 (prompt deletion) helped OpenAI but hurt Claude
  — the merge prose was apparently load-bearing for Claude's structural
  planning despite being "redundant" with the boilerplateMarker. This is
  a Constraint Alignment lesson: deduplication isn't always a win when
  different providers weigh the same constraint differently.
- **Decision**: **Revert both.** Net regression on 2/3 providers + score
  flat-down. Per Codex's "honest checker" principle: don't ship changes
  that regress on aggregate even when one provider improves.
- **Forward note**: The next harness iteration on this slice should
  target structural reasoning directly — staged process (plan → execute)
  for risk:high, OR scaffolding hints inside the boilerplate that
  pre-place common JSX nesting patterns.

---

### Experiment #14 — Targeted PATCH_INVALID retry hints (2026-04-12)

- **Change**: Added `classifyPatchError(errText)` in
  `core/src/coding-agent/tools.ts` preflight handler. Classifies esbuild
  errors into ~15 classes (JSX tag mismatch, unescaped brace, TS-in-JS
  colon, extra `}`, regex-in-JSX, misplaced comma, unmatched paren,
  unterminated string, duplicate decl, unexpected EOF, tag unclosed,
  reserved-as-name, bracket mismatch). Appends one-line hint to the
  retry message alongside existing centered-slice + error marker. No
  prompt, boilerplate, or eval changes.
- **Hypothesis**: The dominant retry engine is PATCH_INVALID (115/200
  turns in cohort 13 = 57% retry rate). Top 6 classes cover 70% of
  occurrences. Class-specific hints should unstick the LLM from
  repeating the same failure mode, cutting retries without architecture
  change.
- **Cohort**: `18-patch-hints-run1/2/3.log` (n=3). Narrow slow-tail
  slice: weather-card + survey-form + periodic-table + kanban-board +
  chat-interface × 3 providers. Baseline = cohort 13 filtered to the
  same 5 commits.
- **Result**: Fails all success criteria except transport-error parity.
  - PATCH_INVALID/task: 1.60 → 1.56 (flat, −2.5%)
  - Avg turns: 4.04 → 4.11 (+0.07 — flat)
  - **Avg ms: 53.7s → 61.8s (+15.2%)** — regression
  - **pass@score≥50: 80.0% → 68.9%** — quality drop
  - Per-class: unescaped brace 0.12→0.02 ✅, misplaced comma 0.10→0.00
    ✅, TS-in-JS colon 0.22→0.16 ✅; JSX tag mismatch 0.31→0.31 flat
    (the dominant class was NOT helped); unterminated regex
    0.11→0.16 regressed; "other" unclassified 0.47→0.69 regressed
    (hints may induce new error patterns).
  - Per provider: Claude ms −5.8s, turns −0.73 (small win); Google
    noisy, 2 transport errors preserved; **OpenAI ms +27.7s, turns
    +1.20, kanban 54s→152s** (big loss).
- **Diagnosis**: The dominant class (cross-range JSX tag mismatch) is
  not a retry-wording problem — it's a **patch-geometry** problem. The
  model is bad at repairing large nested JSX patches when the tag span
  exceeds the patch range. A one-line hint doesn't help because the
  LLM's next patch is still constrained by the same partial-range
  model. Additionally, the extra hint line appears to confuse OpenAI's
  retry planning, possibly adding reasoning overhead without actionable
  steering.
- **Decision**: **Revert.** Hints barely moved the target signal,
  latency regressed, and OpenAI got materially worse — failure pattern
  is A2-like (helps one provider, hurts another). Points straight at
  A1 (scaffold → fill multi-turn split) as the next real lever: if the
  bottleneck is patch geometry on large JSX trees, a structural first
  pass with smaller subsequent patches should attack the root cause.

---

### Experiment #36 — WRITE_TOOL on turn 1 alongside apply_changes (2026-04-13)

- **Change** (commit `466207ba`, cherry-picked from worktree `a7f4c849`):
  `core/src/harness/tools/coding-tools.ts` + `run-coding-turn.ts`. Adds
  `WRITE_TOOL` — a flat `{code, commit_message}` 2-string schema — to the
  turn-1 tool set alongside `APPLY_CHANGES_TOOL`. Turn 2+ unchanged
  (`[APPLY_CHANGES_TOOL, GET_ICONS_TOOL]`). Executor reuses the pre-existing
  `write` case. No provider branch; no system-prompt change.
- **Hypothesis** (from harness-engineer run `a8b6ee35`): Google's
  `malformed_tool_call` quadrupling post-#137 (3/9 → 13/9) was driven by
  `apply_changes`' 4-level-nested schema
  (`changes: [{startLine, endLine, code: string[], description}]`). A flat
  alternative lets Gemini pick the shape it can serialize reliably on
  turn 1.
- **Cohort** (all n=3, same-session, 3 providers × 3 commits): risk:high
  slice (kanban-board, chat-interface, stock-ticker).
- **Result** — SHIPPED:
  | Provider | Baseline ms | Final ms | Δ | Baseline score | Final score | Δ | Malformed |
  | -------- | ----------- | -------- | ------- | -------------- | ----------- | ------ | --------- |
  | Google | 135000 | 60000 | −56% | 46.6 | 76.2 | +30pt | 10/9 → 0/9 |
  | Claude | ~55000 | ~47000 | −15% | ~74 | ~81 | +7pt | 0/9 → 0/9 |
  | OpenAI | ~55000 | ~66000 | +21% | ~69 | ~72 | +3pt | 0/9 → 0/9 |
  The +21% OpenAI kanban outlier was flagged but (in retrospect; see
  #37) the fixture-level audit was not rigorous. The Google malformed
  collapse was large enough to be safely out-of-noise at n=3.
- **Mechanism validated**: not by token count or boilerplate size. Iter 1
  (shorten `useWiredTool` hook-comment: -5% chars) moved malformed 10→9
  (noise). Iter 2 (`MAX_MALFORMED_RETRIES` 3→1) crashed Google score
  46.6→37.5 — scoped `≤20 line` fallback can't bootstrap a scaffold on
  turn 1. **The root cause was schema complexity, not boilerplate size
  and not retry count.** Only the tool-shape alternative unlocked the
  Google gain.
- **Regression test**: `core/src/harness/coding/run-coding-turn.test.ts`
  (commit `f0b793a9`). Pure `selectTurnTools(turnsUsed)` helper extracted
  and unit-tested — asserts turn 1 = apply_changes + write, turn 2+ =
  apply_changes + get_available_icons. Locks the invariant.
- **Decision**: **Ship.** Cherry-picked to main.

---

### Experiment #37 — Scoped retry after multi-range PATCH_INVALID (2026-04-13)

- **Change** (commit `4b8be2d9` on worktree `a4be34a4`, NOT cherry-picked):
  When a turn fails with a multi-range `PATCH_INVALID`, force
  `APPLY_CHANGES_TOOL_SCOPED` (maxItems:1) as primary on the retry turn,
  so the retry schema fits the JSON ceiling. Same mechanism as
  Experiment #32's runtime fallback but gated on multi-range structure
  rather than transport error.
- **Hypothesis** (from harness-engineer run `a4be34a4`): repeat-chain
  multi-range failures are the slowest tail on risk:high. Narrowing the
  retry schema should cut turn count on the chain.
- **Cohort**: `B0-risk-high-baseline-run{1,2,3}.log` vs
  `C1-scoped-retry-run{1,2,3}.log` on worktree `a4be34a4`. n=3,
  same-session.
- **Claimed result (provider-averaged)**:
  - Claude −10.8% avg ms, OpenAI −22.9%, Google flat — "no regression"
  - Multi-range fraction on retries: 93% → 52%. Max repeat-chain: 6 → 4.
  - Mechanism fires as designed.
- **Fixture-level audit (independent Explore verification)** — **BUSTED**:
  | Provider | Fixture | Baseline ms | C1 ms | Δ |
  | -------- | ---------- | ----------- | ------ | ------- |
  | Google | chat | 62000 | 32000 | **−48%** |
  | Google | kanban | 23000 | 40000 | **+74%** |
  | Google | stock | 59000 | 72000 | **+23%** |
  | Google | (aggregate)| 48000 | 48000 | "flat" |
  | OpenAI | kanban | 68000 | 75000 | +10.6% (single 104s run in C1 inflating) |

  Google's aggregate "flat" is **chat −48% canceling kanban +74% and
  stock +23%**. With n=3 and OpenAI baseline variance of 52–114s,
  confidence bands on Claude and OpenAI overlap — the −13% aggregate
  sits at the edge of statistical ambiguity. C1 Google variance (34–62s)
  is wider than baseline (46–50s): mechanism adds variance.

- **Mechanism sound, implementation suspect**: the PATCH*INVALID
  multi-range fraction change (93%→52%) is real and fires on retries
  across the corpus. But scoping ALL post-multi-range retries to
  `maxItems:1` is too broad — on kanban/stock the narrower schema costs
  more turns than the full multi-range retry it replaces. The \_approach*
  (schema-narrowing on repeat failures) is not falsified; the _trigger
  condition_ is wrong.
- **Reverted side-experiments** (iters 2-4):
  - Eval-round cap=2 on risk:high fast: Google/Claude big wins but
    OpenAI +43% — the extra rounds compensate for OpenAI reasoning
    hangs on kanban. Implementation artifact, not approach failure.
  - Per-criterion 15s timeout (Promise.race → pass): fired only 2/27
    gens, net flat, slight Claude regression. Implementation mis-
    scoped — 15s is too aggressive for most criteria.
  - Rules-of-hooks docs rewrite on `useAnimationKey`: violation count
    unchanged 3 → 3. LLM is synthesizing the antipattern from the task
    shape, not miscopying the example. Docs are the wrong leg — this
    needs a tier-0 AST lint or a scaffold-injected
    `const xKey = useAnimationKey(...)` slot.
- **Decision**: **Do NOT cherry-pick `4b8be2d9`.** Worktree preserved as
  evidence.
- **Reasoning lessons (for future ralphs — encoded into agent brief)**:
  1. **Fixture-level audit is mandatory before ship.** Aggregate averages
     hide opposite-signed fixture moves. A provider "flat" on 3 fixtures
     where one is −48% and two are +20-80% is not a safe ship.
  2. **Separate approach validity from implementation correctness.** Two
     failure classes exist: _wrong approach_ (mechanism doesn't fire or
     doesn't move the intended metric) vs _right approach, wrong
     implementation_ (mechanism fires but trigger/threshold is off). The
     scoped-retry approach is NOT falsified by this experiment; only the
     too-broad trigger is. Don't discard the approach because of an
     implementation miss.
  3. **Per-run outlier flagging.** The 104s OpenAI kanban single run in
     C1 inflates the mean; it should surface as a flagged outlier in the
     report, not hide inside the provider average.
  4. **n=3 confidence bands overlap at ~±15%.** Ambiguous results need
     n=5 before any claim, or a much sharper single-fixture story.

---

### Misdiagnosis Log #1 — "preflight parser bug" (2026-04-14)

Not an experiment — a correction of a ralph #4 finding. Logged here so
future ralphs don't re-claim the phantom bug.

- **Observation** (ralph #4, experiment #38 in its worktree log):
  OpenAI emitted 3 `apply_changes: PATCH_INVALID (preflight failed)`
  events on risk:high, all with error text `Unterminated regular
expression` at specific line numbers (24, 183, 211) in OpenAI's
  generated candidates.
- **False diagnosis**: ralph #4's agent reported this as
  _"preflight parser bug on template-literal JSON serialization"_ and
  recommended a standalone fix in `core/src/coding-agent/tools.ts:398`
  (the `esbuild.transform` call).
- **Verification attempt** (main agent, same day): direct `esbuild.transform`
  probe with 7 candidate TSX patterns — template literals with embedded
  `/`, regex literals, division, JSX text with slashes, comments with
  URLs, etc. All passed. Only **genuinely unterminated regex** reproduces
  the error (e.g. `const r = /foo` with no closing `/`).
- **Corrected conclusion**: the preflight is working correctly. The 3
  events were **real syntactic failures in OpenAI-generated source** —
  the LLM occasionally emits TSX with an unterminated regex literal on
  its own, and preflight catches it as designed. There is no parser bug.
- **No fix to ship.** The phantom root-cause recommendation in ralph #4's
  report is retracted.
- **Real follow-up (optional, not a bug fix)**: if we want to compress
  these recovery turns, the place to look is the existing retry-feedback
  path at `core/src/coding-agent/tools.ts:437` where esbuild's error +
  line slice already get surfaced back to the LLM. A sharper retry
  (tighter slice, more explicit "your regex is unterminated" guidance)
  could reduce the retry-turn count. That is a future hypothesis, not a
  bug fix.
- **Reasoning lesson** (for future ralphs + the harness-engineer brief):
  when a ralph cites an error-string pattern as evidence of a
  specific-class bug, **probe the system directly before accepting the
  diagnosis.** The agent's claim was confident and plausible-sounding but
  never actually exercised the claimed failure path in isolation. The
  fixture-level audit discipline (Experiment #37 lessons) addresses
  "aggregate masking fixture-level signal" but does NOT address
  "mechanism observation misattributed to a phantom bug." That is a
  separate failure class worth tracking.

---

### Experiment #38 — Preflight retry feedback v1 (2026-04-14)

Ralph #5. Branch `harness-ralph-5` (discarded; NOT shipped). Change kept
as reference in the worktree's bench logs.

- **Change proposed**: In `core/src/coding-agent/tools.ts` `apply_changes`
  preflight catch block — append error-class-specific hints for 4
  common failure classes (JSX tag mismatch, duplicate declaration,
  unterminated regex, brace/paren imbalance), plus a top-level wrapper
  `"Your submitted ranges: X-Y, ..."` echoing the LLM's own changed
  ranges so the model sees what it just submitted. ±5-line slice around
  the error preserved as baseline comparator. 116 lines of regression
  tests included; 21/21 unit tests green.
- **Hypothesis**: Preflight feedback is under-informative. The LLM
  receives error text + a narrow slice but no class-specific guidance
  and no echo of what it submitted. Sharper feedback → fewer repeat
  `PATCH_INVALID` events → fewer wasted turns.
- **Baseline (B0)**: `tmp-bench-logs/B0-preflight-baseline-run{1,2,3}.log`
  — main HEAD, no change. 27 cells complete (3 providers × 3 fixtures ×
  n=3).
- **Change cohort (C1)**: `tmp-bench-logs/C1-preflight-hints-v1-run{1,2,3}.log`
  — same-session, with v1 stash applied. 27 cells complete.
- **Audit (6-rule discipline applied)**:

  | Provider | Fixture | B0 ms | C1 ms | Δms%        | Δscore | Flag |
  | -------- | ------- | ----- | ----- | ----------- | ------ | ---- |
  | claude   | kanban  | 69496 | 61608 | −11.4%      | +2.4   |      |
  | claude   | chat    | 54833 | 51294 | −6.5%       | −5.0   |      |
  | claude   | stock   | 47577 | 47979 | +0.8%       | +1.0   |      |
  | openai   | kanban  | 76866 | 62425 | **−18.8%**  | +3.6   | \*   |
  | openai   | chat    | 67633 | 66072 | −2.3%       | +4.0   |      |
  | openai   | stock   | 64043 | 58542 | −8.6%       | +9.0   |      |
  | google   | kanban  | 24801 | 55561 | **+124.0%** | −3.0   | \*\* |
  | google   | chat    | 63659 | 51033 | **−19.8%**  | +7.0   | \*   |
  | google   | stock   | 61960 | 53786 | −13.2%      | −2.2   |      |

- **Mechanism firing check — FAILED**: `"Your submitted ranges:"` (the
  top-level wrapper) fired **0 times** across all 3 C1 runs. Only the
  inner class-specific hints fired:
  - "tag does not match" hint: 38 firings
  - "has already been declared" hint: 5 firings
  - "Unterminated regular expression" hint: ~3 firings
  - brace/paren hint: ~9 firings

  The intended feedback-loop mechanism was partially dead code. Granular
  hints were live; the wrapper that echoes the LLM's submitted ranges
  was never reached on the production path.

- **PATCH_INVALID rate**: **+25.5% WORSE** (B0 mean 36.7 → C1 mean 46.0).
  The exact metric the change was designed to reduce went up.
- **Opposite-signed check**: ✅ No provider had >15% opposite-signed
  moves across fixtures.
- **Outliers**: 4 runs flagged >1.5× cell median (dominated by Google
  chat-interface variance; Claude run had one 81s spike).
- **Catastrophic regression**: Google kanban +124% ms with score −3pt.
  Blocks ship independently of everything else.
- **Classification**: **APPROACH FALSIFIED.** Not just wrong trigger —
  the core hypothesis (more hints → fewer repeat PATCH_INVALID) was
  contradicted by the +25.5% rate increase. The partially-dead mechanism
  means we can't even cleanly evaluate "would it have worked if it
  fired," but the signal we DID get (higher failure rate) argues against
  the hypothesis regardless.
- **Decision**: **Revert.** Worktree discarded. No cherry-pick.
- **Forward note**:
  - The wrapper-didn't-fire bug is real. If someone wants to revisit
    this approach, start by root-causing why `"Your submitted ranges:"`
    never reached the LLM despite being in the returned `result` string.
    Possible causes: the retry path stripping the wrapper, the LLM
    receiving only the first N chars of the result, or the integration
    point being in a different code path than we patched.
  - The Google kanban +124% is unexplained and interesting — worth
    isolating as its own bug hunt before any future preflight-feedback
    work.
  - n=3 Google chat-interface variance (2.86× baseline, 2.35× change)
    shows the Flash-Lite short-circuit floor is still a significant
    noise source. Any risk:high bench claiming small wins needs either
    n=5 or a short-circuit filter.

---

### Experiment #39 — Priority-labeled retry feedback (R1 + R1-narrow) (2026-04-14)

Not a ralph. Main-agent session driven by the triad **ALIGNMENT** pass
(see `core/docs/harness-modes/ALIGNMENT.md`). Logged here so the
vocabulary-alignment hypothesis doesn't get re-run on the wrong theory.

- **Thesis** (Codex + main agent): the retry path at
  `core/src/coding-agent/tools.ts:251` emits `[${category}]` which
  _strips the P0/P1/P2 priority_ that already exists in `criteria.ts`.
  The LLM sees tier-0 violations with no hook to rank against the
  system prompt's priority schema → fixed-point retry loops (observed
  in B0-run1: `ranges=47-47, 71-75, 89-89, 124-124, 168-180` firing 6×).
- **R1 (both label sites)** — `[P0-*]` prefix on both the tier-0 self-check
  retry formatter AND the preflight `PATCH_INVALID` message. Added
  `priority: Priority` field on `EvalIssue` + `priorityForIssue()`
  derivation helper. Zero other behaviour change.
- **R1-narrow (preflight only)** — tier-0 retry formatter reverted to
  `[${category}]`, preflight kept `[P0-compile]`. Isolates the two
  label sites for A/B disambiguation.
- **Baseline (B0)**: `tmp-bench-logs/B0-risk-high-baseline-run{1,2,3}.log`.
  Same-session with both change cohorts.
- **R1 cohort**: `tmp-bench-logs/R1-priority-labeled-run{1,2,3}.log`.
- **R1-narrow cohort**: `tmp-bench-logs/R1-narrow-preflight-only-run{1,2,3}.log`.
  One `happy-dom` / Tooltip.tsx flake mid-run required a run2 redo; final
  data is clean n=3 on 26/27 cells, n=2 on openai×stock.

- **Mechanism firing (R1 and R1-narrow, both)**: PATCH_INVALID across 3
  runs dropped from **58 → 0**. The B0 duplicate-range fingerprints
  (`ranges=47-47, 71-75, ...`) did not recur once. `[P0-types]` / `[P0-imports]`
  tags appeared 41× in R1 retry logs. **Preflight labeling is the load-
  bearing mechanism for PATCH_INVALID elimination on all three providers.**
- **Provider aggregate avg ms (3-cohort)**:
  | Provider | B0 | R1-full | R1-narrow | R1-narrow vs B0 |
  | -------- | ------ | ------- | --------- | --------------- |
  | claude | 58,938 | 64,760 | 52,962 | **−10.1%** |
  | openai | 83,540 | 92,202 | 58,519 | **−29.9%** |
  | google | 47,996 | **31,039 (−35%)** | 58,588 | **+22.1%** |

  → The tier-0 self-check labeling is **asymmetrically load-bearing**:
  **Google needs it on the tier-0 surface** (isolated effect: removing
  it costs google its R1-full win, +89% vs R1-full). **OpenAI is hurt
  by it on the tier-0 surface** (isolated effect: removing it saves
  openai ~33%). **Claude** responds modestly to its removal (−10%).

- **Per-cell ship gates (R1-narrow, pre-registered)**:
  - ❌ **Gate 1 (Google keeps broad win)**: google×kanban 22,987 → 52,734
    ms (**+129%**), chat score −5.9pt (>3pt threshold). R1-narrow
    _loses_ google's R1-full win completely.
  - ✅ Gate 2 (OpenAI no opposite-signed >15% within provider): all
    three fixtures same-signed (all wins).
  - ❌ **Gate 3 (Claude no new catastrophic cell)**: claude×stock score
    82.0 → 65.3 = **−16.7pt** (>10pt threshold).
  - ✅ Gate 4 (Blended score ±5pt): 71.07 → 69.63 = −1.44pt.
- **Decision**: **REVERT both R1 and R1-narrow.** 2/4 gates fail on R1-narrow;
  R1 failed the opposite-signed rule on its own. Per pre-registered
  stop rule: "If it's still mixed, revert, log #39, move to R3.
  No R2 layering, no further vocabulary tweaks first."
- **What stays**: `Priority` import + `priorityForIssue()` helper +
  `priority?: Priority` field on `EvalIssue` (in `core/src/evaluation/tiers.ts`
  and `axis-checks/helpers.ts`). These are infrastructure R3 will use.
  They are dormant — no code path currently reads `.priority`.
- **Worktree artifacts**: preserved crash logs at
  `tmp-bench-logs/{R1-priority-labeled,R1-narrow-preflight-only}-run*-CRASHED.log`
  for forensics on the happy-dom infra flake.

**Reasoning lessons** (encoded for future sessions):

1. **The vocabulary-alignment hypothesis was correct in aim, wrong in
   assumption of uniform benefit.** Priority labels ARE load-bearing;
   but different providers derive benefit from them at different
   sites. The prompt-cache + attention-budget tradeoffs are
   provider-specific. No uniform treatment of the retry surface can
   win for all three providers simultaneously.
2. **Uniform retry-feedback policy has a measurable ceiling.** What
   #39 _proved_ is that a single-shape retry surface can't win on all
   three providers simultaneously — one isolated A/B shows the two
   label sites carry opposite-signed effects for different providers.
   What #39 _justifies_, not proves, is provider-sensitive context
   policy as an R3 design direction. One experiment should inform the
   architecture, not ossify into a permanent law — keep room for a
   later finding that a different uniform shape (e.g., tag-balance
   feedback, diff-based file view) closes the asymmetry without
   per-provider branches.
3. **A/B split with pre-registered gates works.** R1-narrow isolated
   the mechanism site cleanly. We now know _which_ label site carries
   which effect — impossible to determine from R1 alone.
4. **"Mechanism fires" ≠ "ship it."** R1 and R1-narrow both eliminated
   PATCH_INVALID (mechanism validated). Both failed ship gates on
   different fixtures for different reasons. The `6-rule audit +
pre-registered gate` discipline from the wind-down note held up
   — this is the first experiment the discipline correctly gated.

---

### Experiment #40 — Provider-asymmetric context override (2026-04-14)

First exercise of R3 (`HarnessPolicy` + `ContextPolicy` + two-stage
policy resolution). Scope: ship a named experiment profile that
realizes #39's surface finding — Google benefits from tier-0 priority
labeling, other providers don't. Implemented as
`EXPERIMENT_40_PROFILE` inside `core/src/harness/policy.ts`'s
`resolveRunPolicyForProfile()`, gated behind the `GGUI_POLICY_PROFILE`
env var (explicitly NOT a default, per Codex's C2 tightening).

- **Hypothesis** (from #39 decomposition): the provider-optimal policy
  on risk:high is `labeledPreflight: true` universally + `labeledTier0:
true` for Google only. #39 predicted ~25% blended improvement if
  shipped.
- **Architecture**: C1 laid the `HarnessPolicy` infrastructure
  (dormant); C2 plumbed `ContextPolicy.labeledTier0` through
  `autoCommit`'s tier-0 retry formatter and threaded `resolvedPolicy`
  onto `CodingSession` so dispatch-time provider-aware resolution could
  fire. The actual experiment override lived in exactly one function
  (`resolveRunPolicyForProfile`) branching on profile string.
- **Baseline** (same-session): `tmp-bench-logs/exp40-baseline-run{1,2,3}.log`.
  Same risk:high slice + providers as #39.
- **Override cohort**: `tmp-bench-logs/exp40-override-run{1,2,3}.log`
  (`GGUI_POLICY_PROFILE=experiment-40-provider-asymmetric`). One
  openai×stock cell on override run2 hung mid-generation — n=2 for
  that cell, n=3 elsewhere.
- **Gating probe** (single-provider disambiguation):
  `tmp-bench-logs/exp40-probe-openai-only.log`. OpenAI-only with
  profile on emitted ZERO `[P0-*]` labels — confirms
  `labeledTier0: runtimeCtx.provider === "google"` gates correctly.
  Parallel-log attribution in the 3-provider runs was confused by log
  interleaving; single-provider probe disambiguated.

- **Per-cell result (n=3, Google short-circuits: 0 drops)**:

  | Provider | Fixture | B0 ms | Ov ms       | Δms%      | B0 sc | Ov sc | Δsc      |
  | -------- | ------- | ----- | ----------- | --------- | ----- | ----- | -------- |
  | claude   | chat    | 62432 | 70224       | +12.5     | 69.7  | 78.2  | +8.5     |
  | claude   | kanban  | 59531 | 42213       | **−29.1** | 57.7  | 63.7  | +6.0     |
  | claude   | stock   | 59776 | 63456       | +6.2      | 78.8  | 83.7  | +4.9     |
  | google   | chat    | 50668 | 45158       | −10.9     | 74.1  | 74.5  | +0.3     |
  | google   | kanban  | 58214 | 31603       | **−45.7** | 75.9  | 71.1  | −4.7     |
  | google   | stock   | 68442 | 61726       | −9.8      | 83.0  | 74.1  | **−8.9** |
  | openai   | chat    | 69340 | 61686       | −11.0     | 74.4  | 69.3  | −5.1     |
  | openai   | kanban  | 77199 | 75057 (n=2) | −2.8      | 52.3  | 56.0  | +3.7     |
  | openai   | stock   | 64997 | 87520 (n=2) | **+34.7** | 76.5  | 75.0  | −1.5     |

- **Pre-registered ship gates (4)**:
  - ❌ **Gate 1 (Google keeps broad win — all 3 fixtures ≥20% faster,
    no score drop > 3pt)**: only google×kanban hit ≥20% (−45.7%).
    google×chat (−10.9%) + google×stock (−9.8%) missed. **google×stock
    score −8.9pt** (> 3pt).
  - ✓ Gate 2 (Claude no regression): all within ±15% except
    claude×kanban (−29% — a WIN, not a regression). No score drops.
  - ❌ **Gate 3 (OpenAI no regression)**: openai×stock **+34.7% ms**
    (> 15% regression). openai×chat score −5.1pt just over 5pt
    threshold. Caveat: n=2 for openai×stock due to override-run2 crash.
  - ✓ Gate 4 (Blended score ±5pt): mean 71.36 → 71.73 = +0.37pt.

- **Decision**: **2 of 4 gates fail → revert per preregistered stop
  rule.** The specific `EXPERIMENT_40_PROFILE` constant + its gate
  branch removed from `policy.ts`. The R3 framework
  (`HarnessPolicy`/`ContextPolicy`, `resolveRunPolicyForProfile`
  skeleton, C2 tier-0 plumbing, dispatch env-var hook) stays — all
  behavior-identical to main without a named profile.

- **What this validated (architecture)**:
  - Two-stage policy resolution works end-to-end.
  - Named experiment profile via env var is the right surface — zero
    production footprint, trivial to bench-gate, trivial to revert.
  - The abstraction made the experiment cheap to ship AND cheap to
    unship. Total code delta for the override: ~20 lines in one file.

- **What this falsified (hypothesis)**:
  - #39's provider-asymmetric finding (Google wants tier-0 labels,
    others don't) did NOT reproduce at fresh n=3. The ~25% blended
    improvement predicted by #39 surfaced as +0.37pt blended (within
    noise). **Codex's concern was correct: "the asymmetry #39 saw may
    have been n=3 noise within ±15% CI."** This is the right kind of
    experimental result to have logged.

- **Reasoning lessons**:
  1. **Per-cohort asymmetric findings need replication before shipping
     even as a gated override.** #39's asymmetry was one data point;
     #40 was the replication — and it disconfirmed. Always bench the
     hypothesis, not just the mechanism.
  2. **The framework cost was worth it even on a failure.** R3 C1 +
     C2 shipped as dormant infrastructure. #40 proved the plumbing
     works end-to-end. Future experiments (when new hypotheses
     emerge) will use this framework rather than reinventing it.
  3. **Single-provider probes disambiguate parallel-log attribution.**
     The 3-provider bench logs had interleaved P0-labels that were
     hard to attribute back to their source provider. A 5-min
     single-provider probe with the profile on cut through the
     ambiguity. Worth adding to the harness-engineer skill checklist.

---

### Experiment #41 — Duplicate-patch break (2026-04-14)

Second exercise of the R3 profile framework. Attacks the concrete
failure mode observed in B0-run1: the LLM re-submitted a byte-identical
`apply_changes` patch 6× in one generation, each time failing with the
same esbuild error. The retry prompt was similar enough across turns
that the model's output became a fixed point.

- **Mechanism**: fingerprint each PATCH_INVALID turn on `(sorted
ranges, normalized code payload, error-class bucket)` via SHA-256.
  On match with the prior patch turn's fingerprint, flip
  `forceWriteNextTurn` so the next turn is restricted to `write` with
  an explicit `[DUPLICATE_PATCH]` retry preface. Patch turns only
  (no eval-fix). One-shot + cooldown=3. Implementation:
  `core/src/harness/coding/dupe-break.ts` + detection in
  `run-coding-turn.ts`.
- **Gate**: `ContextPolicy.breakDuplicatePatch` (off by default),
  enabled via `GGUI_POLICY_PROFILE=break-dup-patch`.
- **Baseline**: `tmp-bench-logs/exp41-baseline-run{1,2,3}.log`.
- **Override**: `tmp-bench-logs/exp41-override-run{1,2,3}.log`.
  Run 1 crashed at cell 2 (uncaught `TypeError: Cannot read properties
of null (reading 'messages')` inside an onClick handler during
  runtime-render probe — forced-write produced null-unsafe code).
  Runs 2 + 3 each completed 7/9 cells.

- **Pre-registered ship gates (4)**:
  - ✓ Gate 1 (mechanism fires): `DUPLICATE_PATCH_BREAK` logged
    **1×/run across 3 runs** (3 firings total).
  - ✓ Gate 2 (PATCH_INVALID drops): baseline 116 vs override 67 =
    **−42%**. Strong — the mechanism IS compressing loops.
  - ⚠ Gate 3 (blended wall-clock): Δ = −1.2% but uneven n (B=27,
    O=16). Not reliably interpretable.
  - ❌ **Gate 4 (no catastrophic cell)**: 3 cells failed:
    - claude×chat: score **−13.9pt** (forced-write quality drop)
    - google×chat: **+74% ms** (n=1 due to sample loss)
    - openai×kanban: **+43.8% ms**

- **Decision**: revert profile branch per stop rule. Keep fingerprint
  - detection + plumbing as dormant infrastructure. Mechanism is
    correct; the escape hatch (full-file write) introduces new failure
    modes. A smarter escape path (scoped retry with maxItems=1, or
    intermediate retry budget before full rewrite) could reuse the
    detection.

- **What this validated (mechanism)**:
  - Fingerprint-based duplicate detection works — fired when expected,
    compressed PATCH_INVALID events by 42%.
  - Cooldown prevents oscillation — none of 3 firings produced
    secondary cycles.
  - Error-class bucket in the fingerprint (Codex tweak #2) didn't
    cause false non-matches; all 3 firings were legitimate dupes.

- **What this falsified (the specific escape path)**:
  - Forced full-file `write` produces code with new correctness gaps.
    Run 1's crash: onClick handler dereferenced `response.messages` on
    null. claude×chat: write-generated component missing
    prompt-required features → −14pt score.
  - Echoes #05/#06 from early April: "Write tool was not behind
    preflight... escaped write produced 349B stub (3/100 score)."
    Same pattern, different trigger.
  - **The mechanism is right, but `write` is the wrong escape tool.**

- **Reasoning lessons**:
  1. **"Mechanism works" is necessary but not sufficient.** The
     loop-breaker must produce BETTER output, not just DIFFERENT
     output. Dupe-break's swap to `write` broke the loop structurally
     but regressed quality on ~1/9 cells.
  2. **Sample loss from uncaught runtime errors is a recurring
     hazard.** The happy-dom/onClick TypeError that killed run 1 is
     the same class of infra flake that hit earlier benches. Worth a
     runtime-probe error boundary as independent pre-bench hardening.
  3. **The R3 framework made this experiment cheap to ship AND
     unship** (second confirmation after #40). One commit adds
     mechanism + plumbing + profile; revert removes only the profile
     branch and keeps the mechanism dormant for a smarter escape.

### Experiment #42 — Duplicate-patch break with scoped escape (2026-04-14)

Continuation of #41. The detector was good (−42% PATCH_INVALID, fired
1×/run across n=3) — the **escape tool** was wrong. Full-file `write`
produced fragile code (null-unsafe handlers, missing features). This
experiment keeps the detector and swaps the escape to
`APPLY_CHANGES_TOOL_SCOPED` (`maxItems=1`, `endLine - startLine ≤ 20`)
so the LLM can only touch one narrow region. Rest of the file stays
intact.

- **Mechanism**: same fingerprint detector as #41 (sorted ranges +
  normalized code + error-class bucket, SHA-256). On dupe-match, flip
  `forceEscapeNextTurn` + cooldown=3; next turn forced to
  `APPLY_CHANGES_TOOL_SCOPED` only. New retry text: "next turn is
  FORCED to a scoped single-change apply*changes (one change,
  ≤20 lines). Target the minimal failing region — do not retry the
  full patch. The rest of the file is correct."
  Implementation: `run-coding-turn.ts::selectTurnTools(*, forceEscape)`returns`[APPLY_CHANGES_TOOL_SCOPED]` when forceEscape=true.
- **Second mechanism check (Gate 1b)**: `SCOPED_ESCAPE_USED` logged
  when the forced turn emits a conforming scoped call (1 change,
  ≤20 lines). `scopedEscapeUsedCount` must equal `firedCount` for the
  detector→tool pipeline to be judged wired end-to-end. Added because
  #41's log confirmed the detector fired but didn't validate the
  escape path was actually engaged.
- **Gate**: `ContextPolicy.breakDuplicatePatch` (off by default),
  enabled via `GGUI_POLICY_PROFILE=break-dup-patch-scoped`. Flips only
  `breakDuplicatePatch`; `labeledPreflight` + `labeledTier0` stay at
  baseline so this is a one-dimensional experiment.
- **Cohort**: risk:high same-session — kanban-board, chat-interface,
  stock-ticker × claude, openai, google × n=3.

- **Pre-registered ship gates (4)**:
  1. Mechanism fires (both): `DUPLICATE_PATCH_BREAK ≥ 2` across n=3 **AND**
     `SCOPED_ESCAPE_USED count == DUPLICATE_PATCH_BREAK count`.
  2. `PATCH_INVALID` count non-regression: override ≤ baseline (expect
     −30–42% like #41).
  3. Blended wall-clock non-regression: Δ ≤ +0%, strict +5% ceiling.
  4. No catastrophic cell: no (provider × fixture) with Δms > +30% OR
     Δscore < −10pt.

- **Sample-loss rule (pre-registered)**: any run completing < 7/9 cells
  is discarded and re-fired once. If ≥ 2 re-fires still short → abort
  - flag runtime-probe hardening as prerequisite.

- **Baseline**: `tmp-bench-logs/exp42-baseline-run{1,2,3}.log`.
  Run 2 originally crashed (happy-dom probe `response.messages` null
  TypeError mid-cell); re-fired per pre-registered sample-loss rule.
  Final 3/3 baselines completed 9/9 cells.
- **Override**: `tmp-bench-logs/exp42-override-v3-run{1,2,3}.log`.
  Required two iterations of the override bench:
  - v1 had **0 firings** because the original (#41-inherited) detector
    gate excluded `eval-fix` turns. The dominant dupe pathway in
    risk:high logs is `eval-fix → patch` with a byte-identical patch +
    same preflight error — those crossed the phase boundary the old
    gate suppressed. **Fix**: removed the `isPatchPhaseTurn` check;
    detector now spans patch + impl + eval-fix. The fingerprint already
    keys on (sorted ranges, normalized code, error class), so cross-phase
    detection is well-defined and provider-neutral.
  - v2 added the cross-phase detector but Google **crashed all 3 cells
    every run** with `c.code.map is not a function`. Root cause: Google
    Gemini occasionally emits `apply_changes.changes[i].code` as a
    single string instead of `string[]` despite the JSON Schema saying
    array-of-strings. The fingerprint code assumed array. **Fix**:
    `PatchChange.code` widened to `readonly string[] | string`;
    `computePatchFingerprint` normalizes both shapes (single string →
    one-element array). New unit test asserts `code: "x"` and
    `code: ["x"]` produce the same fingerprint.
  - v3 (final): all three runs completed 9/9 cells.

- **Result (n=3 v3)**:

  Per-provider blended (avg ms):
  - Claude: 60077 → 61245 (**+1.9%**)
  - Google: 41786 → 40008 (**−4.3%**)
  - OpenAI: 73319 → 68802 (**−6.2%**)
  - Blended: 58394 → 56685 (**−2.9%**)

  PATCH_INVALID totals: baseline 120 → override **132 (+10.0%)**.
  Mechanism counters: 2 fires + 2 SCOPED_ESCAPE_USED across n=3 (run 1: 2 fires; runs 2 + 3: 0 fires — natural absence of consecutive byte-identical dupes after a non-failing turn cleared the fingerprint).

- **Gate verdict**:
  | Gate | Status | Detail |
  |---|---|---|
  | 1. Mechanism fires (both) | ✓ | 2 fires + 2 scoped uses across n=3 (minimum bar) |
  | 2. PATCH_INVALID drops | ❌ | **+10.0%** (120 → 132) |
  | 3. Blended wall-clock | ✓ | −2.9% blended; per-provider all within +5% |
  | 4. No catastrophic cell | ❌ | claude×stock-ticker score **−12.2pt**; openai×stock-ticker ms **+43.1%** |

  **2/4 fail → REVERT per pre-registered stop rule.**

- **What this falsified**: the "narrower escape tool" hypothesis. The
  intuition was that #41's quality regression came from the full-file
  rewrite producing fragile code, so a scoped single-change escape
  should preserve quality while still breaking the loop. Instead:
  - PATCH_INVALID went UP, not down. Forcing one change at a time when
    the loop has multiple broken regions just means the LLM patches one
    piece, fails again on the others, and the next dupe-pair is across a
    different fingerprint (cooldown=3 + chain-clear-on-success).
  - Quality regressed catastrophically on stock-ticker for both Claude
    and OpenAI — same failure SHAPE as #41 but on different cells. The
    fix-one-region-only constraint is itself the problem: when the LLM's
    real intent involves coordinated changes across regions, scoping it
    to one region produces an incoherent partial patch.

- **What this validated** (kept regardless of revert):
  - **Cross-phase dupe detection is correct**. The original phase
    exclusion was over-restrictive; eval-fix turns can absolutely
    fingerprint into the same chain as patch turns when the LLM
    converges on a fixed-point patch. Bug fix lands on main.
  - **Google `code: string` schema deviation is real and recurring**.
    The fingerprint normalizer is a runtime-defensive fix. Worth
    auditing other call sites that consume `apply_changes.changes[].code`
    directly — at least one (us) was broken; could be more.
  - **Telemetry from #42's overrides has clean baselines for future
    detector experiments**. PATCH_INVALID 120 across n=3 risk:high =
    same order as #41's 116. Stable signal.

- **Decision summary**:
  1. Revert profile branch (`break-dup-patch-scoped` removed from
     `resolveRunPolicyForProfile`).
  2. Keep the cross-phase detector fix on main (genuine bug — was
     hiding all cross-phase dupes).
  3. Keep the `code: string | string[]` tolerance on main (genuine
     bug — Google deviates and we crashed Google's 3/9 cells before
     the fix).
  4. Keep `breakDuplicatePatch` flag dormant. The detector is correct;
     forcing a tool swap (whether scope-narrow or scope-wide) is the
     wrong intervention. Future dupe-break attempts should target the
     LLM's reasoning state directly: e.g., dump the full file with
     line numbers + name the failing region as required-attention,
     rather than restricting tools.

- **Reasoning lessons**:
  1. **"Detector + tool swap" is not a generic loop-breaker.** Both
     #41 (write) and #42 (scoped) failed gate 4 with the same shape:
     forcing the LLM into a different tool produces patches that
     don't satisfy the LLM's actual intent. The dupe loop is a
     symptom of being stuck on WHAT to change; restricting HOW to
     change doesn't fix that.
  2. **Iteration discipline still wins**. v1 found the cross-phase
     bug. v2 found the Google shape bug. v3 ran clean and gave us a
     real signal to revert against. Three benches; bench-gate
     mechanism worked exactly as intended each time.
  3. **Two bug-fixes shipped on main while the experiment failed.**
     The detector + Google-shape tolerance both improve the harness
     for future experiments even though #42 itself reverts. Net infra
     gain on a falsified hypothesis — the R3 framework continues to
     pay for itself.

---

### Experiment #43 — Duplicate-patch break with diagnostic context (2026-04-14)

Continuation of #41/#42. Both prior dupe-break experiments shared the
same failure SHAPE: tool-swap intervention (full write in #41, scoped
single-change in #42) forced the LLM into a tool surface that produced
patches not satisfying its actual intent. The dupe loop is a symptom
of being stuck on **what** to change; restricting **how** to change
doesn't fix that.

This experiment keeps the same proven detector and changes the
intervention from tool-surface to **reasoning state**: when a dupe
fires, the next retry prompt is rewritten to a focused, structured
template that gives the LLM the information it needs to actually
escape the loop. The tool surface is **unchanged** — same
`apply_changes` + `get_icons`. Codex pre-registered this design,
2026-04-14.

- **Mechanism (intervention, post-detection)**:
  - Build a focused excerpt of the failing region (±15 lines around
    the most recent failing range) with **prefixed line numbers**
    (`0047: const x = ...`). LLM mis-counts line numbers in #41/#42
    logs; this kills the indexing-error class.
  - Enumerate the prior 2 failed fingerprints inline:
    `Attempt 2: ranges=[47-47, 71-75] error="unexpected }" fp=ab12cd34`.
  - Require a **structured one-line diagnosis** in `commit_message`
    (no schema change — uses an existing required field):
    `DIAG: why=<≤80 chars> | next=<≤80 chars> | lines=<X-Y>`. Short
    and auditable, not essay-writing (per Codex tweak).
  - Explicit rule: "your next apply_changes MUST differ materially
    from the prior failed patch." Re-emitting the same patch is "not
    allowed."
  - Tools UNCHANGED. Intervention is purely on the prompt/context
    leg — `selectTurnTools` does not gain a new branch.

- **Telemetry (3 new counters in `DupeBreakState`)**:
  - `diagnosticFiredCount` — count of diagnostic prompt renders
    (Gate 1; should equal `firedCount` under this profile).
  - `diagnosticReturnedCount` — count of next-turn responses where
    `commit_message` parses as `DIAG:...` (engagement signal).
  - `diagnosticBrokeLoopCount` — count of next-turn outcomes that
    were NOT byte-identical to the dupe (PASS, DIFF_FAIL,
    SELF_CHECK_FAIL, or PATCH_INVALID with different fingerprint).
    **This is Gate 5's lever** — if this lags `diagnosticFiredCount`,
    the lever didn't change reasoning state.

- **Gate**: `ContextPolicy.breakDuplicatePatch=true` AND
  `dupeBreakAction="diagnostic"`, both flipped together via
  `GGUI_POLICY_PROFILE=break-dup-patch-diagnostic`. Both default off;
  profile is the only way to flip them on main.

- **Cohort**: same as #41/#42 — risk:high same-session
  (kanban-board, chat-interface, stock-ticker × claude, openai,
  google × n=3).

- **Pre-registered ship gates (5 — Codex's extra gate)**:
  1. **Mechanism fires**: `DUPLICATE_PATCH_BREAK fired` ≥ 2 across
     n=3 (same threshold as #42).
  2. **PATCH_INVALID count non-regression**: override total ≤
     baseline total × 1.05.
  3. **Blended wall-clock non-regression**: Δ ≤ +0%, strict +5%
     ceiling.
  4. **No catastrophic cell**: no (provider × fixture) with Δms >
     +30% OR Δscore < −10pt. Watchlist (carries from #41/#42
     casualties): claude×chat, openai×kanban, claude×stock-ticker,
     openai×stock-ticker.
  5. **Patch fingerprint changes after diagnostic** (Codex's gate):
     `diagnosticBrokeLoopCount / diagnosticFiredCount ≥ 0.7`. If the
     model still emits the same patch after the diagnostic prompt,
     the lever didn't change reasoning state — REVERT regardless of
     other gates passing. If `diagnosticFiredCount === 0` (no fires
     this run), Gate 5 is N/A — relies on Gate 1 to fail first.

- **Sample-loss rule (pre-registered, same as #42)**: any run
  completing < 7/9 cells is discarded and re-fired once.

- **Baseline**: reuse `tmp-bench-logs/exp42-baseline-run{1,2,3}.log`.
  Same harness state as #42 baseline — the only thing that changed
  on main since then is the new `dupeBreakAction` field (default
  `"escape"`, no behavioral change when `breakDuplicatePatch=false`).
- **Override**: `tmp-bench-logs/exp43-override-run{1,2,3}.log`.
  Run 2 originally crashed at cell 4 (3rd happy-dom probe
  `response.messages` null TypeError today). Re-fired per pre-
  registered sample-loss rule. Final 3/3 completed 9/9 cells.

- **Result (n=3)**:

  Per-provider blended (avg ms):
  - Claude: 65138 → 62511 (**−4.0%**)
  - Google: 51998 → 50463 (**−3.0%**)
  - OpenAI: 67161 → 78128 (**+16.3%**)
  - Blended: 61432 → 63701 (**+3.7%**)

  PATCH_INVALID totals: baseline 120 → override **146 (+21.7%)**.

  **Mechanism counters**:
  - DUPLICATE_PATCH_BREAK fired: 8 across n=3 (>>2 minimum)
  - DUPE_DIAGNOSTIC_RETURNED true: **8/8 (100%)** — every fire
    returned a parseable `DIAG: why=... | next=... | lines=...`
    in `commit_message`. The LLM consistently engaged with the
    structured diagnosis request.
  - DUPE_DIAGNOSTIC_BROKE_LOOP true: **8/8 (100%)** — every fire
    produced a next-turn outcome that was not byte-identical to
    the dupe (PASS, DIFF_FAIL, SELF_CHECK_FAIL, or PATCH_INVALID
    with different fingerprint). Gate 5 lever **passes by a wide
    margin** (≥ 0.7 threshold).

- **Gate verdict**:
  | Gate | Status | Detail |
  |---|---|---|
  | 1. Mechanism fires | ✓ | 8 fires across n=3 |
  | 2. PATCH_INVALID drops | ❌ | **+21.7%** (120 → 146) |
  | 3. Blended wall-clock | ⚠ | +3.7% blended (within +5% strict ceiling); openai +16.3% per-provider |
  | 4. No catastrophic cell | ❌ | google×chat **+68.8% ms** (score barely changed); openai×kanban **−17pt score** + +21% ms |
  | 5. Patch fingerprint changes | ✓ | **8/8 = 100%** (DIAG returned: 100%; loop broken: 100%) |

  **2/5 fail (Gates 2 + 4) → REVERT per pre-registered stop rule.**

- **What this validated** (genuinely new evidence — first positive
  signal in the dupe-break family):
  - **The diagnostic-context lever DOES change reasoning state.**
    Gate 5 = 100% across all 8 fires. Every single time the LLM
    saw a focused excerpt + line numbers + prior fingerprints + a
    structured diagnosis request, it (a) emitted a parseable
    structured diagnosis and (b) produced a different patch on
    the next turn. This is the cleanest mechanism wiring of any
    dupe-break experiment to date.
  - **Structured short diagnosis (`DIAG: why=... | next=... |
lines=...`) is a viable forcing function** that doesn't
    devolve into essay-writing. Codex's tweak (replace free-form
    `<reasoning>` with 3-field structured line) was correct.
    `commit_message`-as-channel works without a schema change.
  - **Outcome scoring is feasible without changing the response
    format.** `awaitingDiagnosticOutcome` flag + post-tool
    fingerprint comparison gave us a precise per-fire success
    metric. This pattern generalizes to other reasoning-state
    interventions.

- **What this falsified** (the SPECIFIC version of the lever, not
  the family):
  - **The "must differ materially" coercion is too strong.** PI
    +21.7% is the smoking gun: the LLM escapes the loop, but the
    "your next patch MUST differ" rule pushes it to try
    _alternative_ patches that are themselves wrong. Loops break,
    but new failures appear in their place.
  - **openai×kanban −17pt is the same failure SHAPE we saw in
    #41/#42** (forced intervention → quality drop on a specific
    cell), just with a different cause. In #41 the cause was
    full-file rewrite producing fragile code. In #42 it was
    scoped patches missing other broken regions. In #43 it's
    "differ materially" forcing wrong-direction alternatives. The
    common pattern: **any intervention that compels the LLM
    against its prior approach risks producing alternative-but-
    worse output**.

- **What the next experiment should test** (clean candidate for #44):
  - **Same diagnostic context, drop the "must differ materially"
    rule.** Hypothesis: the _information_ (focused excerpt + line
    numbers + prior fingerprints) is what unlocked Gate 5; the
    _coercion_ ("differ materially") is what broke Gates 2 + 4.
    If true, #44 should pass all 5 gates because the LLM gets
    enough information to fix the bug correctly without being
    pushed toward different-but-wrong alternatives. If false (PI
    still rises or quality still drops), then the diagnostic-
    context mechanism itself has a structural problem, and
    dupe-break as a family may not be a winnable lever — pivot.
  - Lower-priority follow-up: per-provider gating. Claude and
    Google were neutral-or-positive; openai was the casualty. A
    Claude+Google-only diagnostic profile may pass all gates as
    a stepping stone, but per `ALIGNMENT.md` per-provider gating
    is a smell — first try removing the coercion.

- **Decision summary**:
  1. Revert profile branch (`break-dup-patch-diagnostic` removed
     from `resolveRunPolicyForProfile`).
  2. Keep `dupeBreakAction` field, `pendingDiagnosticTurn` /
     `awaitingDiagnosticOutcome` state, the focused-excerpt
     prompt template, and outcome-scoring counters on main as
     dormant infrastructure. All gated by the flag — no
     behavioral change with default policy.
  3. Keep this audit as a positive-signal reference. First
     experiment in the dupe-break family that produced ANY
     successful gate beyond mechanism firing.
  4. Next iteration candidate: #44 = same context, no compulsion.
     Expected value > #43; cost identical (same scaffolding +
     small text deletion in the prompt template).

- **Reasoning lessons**:
  1. **A lever can wire perfectly and still fail ship gates.**
     Gate 5 = 100% is the cleanest mechanism signal we've ever
     gotten on a dupe-break experiment. But Gates 2 + 4 still
     fail, because mechanism wiring ≠ ship quality. The 4-gate
     discipline correctly catches this.
  2. **Information is helpful; compulsion is risky.** All three
     dupe-break failures involve compelling the LLM _against_
     its prior choice (different tool, scoped tool, different
     patch). A reasoning-state intervention that _informs_
     without _constraining_ may be the missing form factor.
  3. **The negative result on Gate 2 is the most important
     finding.** PI count rising under an intervention that
     successfully breaks loops means the loop-breaking is
     accidentally creating new failure paths. This is a
     precondition discovery that didn't exist before #43 — any
     future dupe-break design must measure both loop-break rate
     AND PI count delta together.

---

### Experiment #44 — Diagnostic context, no must-differ coercion (FAMILY-FINAL ABLATION) (2026-04-14)

Codex pre-registered this as the **family-final ablation** for
dupe-break on risk:high. The variable space across #41/#42/#43 is
now well-bounded:

- #41 tool-swap full (WRITE_TOOL): quality fails
- #42 tool-swap scoped (APPLY_CHANGES_TOOL_SCOPED): PI + quality fails
- #43 reasoning-state with coercion: PI + quality fails,
  BUT Gate 5 = 100%
- #44 reasoning-state without coercion: ONLY untested variant

**Family stop rule (pre-registered with Codex)**: if #44 fails Gates
2 OR 4, retire the entire dupe-break family on risk:high. No further
iterations until a different architectural attack surface is on the
table (e.g. multi-agent diagnose-then-patch topology, or a different
slice).

This isolates exactly one variable: same focused-excerpt + line
numbers + prior fingerprints + structured DIAG request. **Drop only**
the "must differ materially" rule. Hypothesis: the _information_ is
what unlocked Gate 5 in #43; the _coercion_ is what broke Gates 2

- 4. If true, #44 passes all 5. If false, dupe-break-as-family is
     falsified on risk:high.

* **Mechanism (intervention, post-detection)**: identical to #43
  except the prompt's "What to emit on this turn" step 2 is rewritten
  from:

  ```
  Then call apply_changes with a patch that **differs materially**
  from your prior failed attempt — different ranges OR meaningfully
  different code at the same range. Re-emitting the same patch is
  not allowed.
  ```

  to:

  ```
  Then call apply_changes. The information above (line numbers +
  prior fingerprints) should let you see exactly what's wrong. If
  your patch turns out to be the same one you tried before, that's
  fine — but make sure you've verified line-by-line against the
  focused excerpt that the patch is actually correct.
  ```

  Net change: ~3 lines of prompt text. Same mechanism, same
  scaffolding, same telemetry counters.

* **Gate**: `ContextPolicy.breakDuplicatePatch=true` AND
  `dupeBreakAction="diagnostic-noforce"`, both flipped together via
  `GGUI_POLICY_PROFILE=break-dup-patch-diagnostic-noforce`. Both
  default off.

* **Cohort**: same as #41/#42/#43 — risk:high same-session
  (kanban-board, chat-interface, stock-ticker × claude, openai,
  google × n=3).

* **Pre-registered ship gates** (same 4 hard gates as #42/#43,
  plus Gate 5 as soft diagnostic — see note below):
  1. **Mechanism fires**: `DUPLICATE_PATCH_BREAK fired` ≥ 2 across n=3.
  2. **PATCH_INVALID count non-regression**: override total ≤
     baseline total × 1.05.
  3. **Blended wall-clock non-regression**: Δ ≤ +0%, strict +5%
     ceiling.
  4. **No catastrophic cell**: no (provider × fixture) with Δms >
     +30% OR Δscore < −10pt.
  5. **(Soft, diagnostic only)** Patch fp changes ≥ 0.5. Without
     the "differ materially" rule, the LLM may legitimately
     re-emit the same patch if it thinks it was correct, so a
     drop in this metric is _expected_ and is not by itself a
     failure. Useful only for interpretation.

* **FAMILY STOP RULE (pre-registered with Codex)**:
  - **If Gates 2 OR 4 fail → retire the entire dupe-break family
    on risk:high.** Detector + diagnostic plumbing + outcome
    counters stay on main as dormant infrastructure (in case a
    different architectural surface — multi-agent topology,
    different slice — opens new options) but no further iterations
    on the existing surface.
  - **If all 4 hard gates pass → ship as the new active profile**
    (still profile-gated, not default; defaults only flip after
    a follow-up commit per Codex's "don't smuggle findings into
    defaults" discipline).

* **Sample-loss rule (same as #42/#43)**: any run completing < 7/9
  cells is discarded and re-fired once.

* **Baseline**: reuse `tmp-bench-logs/exp42-baseline-run{1,2,3}.log`.
  Same harness state — only thing that changed since #43 was the
  added `"diagnostic-noforce"` action variant; default behavior
  byte-identical when `breakDuplicatePatch=false`.
* **Override**: `tmp-bench-logs/exp44-override-run{1,2,3}.log`.
  Run 1 originally crashed (happy-dom `response.messages` null
  TypeError). Re-fired per pre-registered sample-loss rule; re-fire
  also crashed (different error: `window is not defined` from
  Tooltip's `setTimeout` firing after the render probe torn down).
  Per the rule's `≥ 2 re-fires still short → abort` clause, one
  more attempt was permitted; that re-fire completed 9/9 cells.
  All 3 final runs completed 9/9 cells. (3 happy-dom probe crashes
  in one session is a recurring infra hazard — flagged for
  pre-bench hardening as separate task.)

* **Result (n=3)**:

  Per-provider blended (avg ms):
  - Claude: 65138 → 66029 (**+1.4%**)
  - Google: 51998 → 61163 (**+17.6%**)
  - OpenAI: 67161 → 55971 (**−16.7%**)
  - Blended: 61432 → 61054 (**−0.6%**)

  PATCH_INVALID totals: baseline 120 → override **120 (±0.0% EXACT)**.

  **Mechanism counters**:
  - DUPLICATE_PATCH_BREAK fired: 5 across n=3
  - DUPE_DIAGNOSTIC_RETURNED true: 3/5 (**60%**) — vs #43's 100%
  - DUPE_DIAGNOSTIC_BROKE_LOOP true: 3/5 (**60%**) — vs #43's 100%

  Engagement and loop-break dropped from 100% → 60% as expected:
  without the "must differ" rule, the LLM can choose to repeat its
  prior patch, and ~40% of the time it does. Soft Gate 5 (≥ 0.5
  threshold) still passes.

* **Gate verdict**:
  | Gate | Status | Detail |
  |---|---|---|
  | 1. Mechanism fires | ✓ | 5 fires across n=3 |
  | 2. PATCH_INVALID drops | ✓ | **±0.0% EXACT** (120 → 120) |
  | 3. Blended wall-clock | ⚠ | −0.6% blended OK; google +17.6% per-provider |
  | 4. No catastrophic cell | ❌ | **3 cells**: google×chat **+56.3% ms**; openai×chat **−26.5pt score**; openai×kanban **−13.5pt score** |
  | 5. Loop-break (soft) | ✓ | 60% (vs ≥ 0.5 threshold) |

  **Gate 4 fails → Family stop rule triggers → RETIRE THE DUPE-BREAK
  FAMILY ON RISK:HIGH.**

* **What this confirmed (Codex's coercion hypothesis)**:
  Removing the "must differ materially" rule **exactly** zeroed out
  the PI inflation #43 caused: 120 → 120 vs #43's 120 → 146 (+21.7%).
  This is a clean, isolated proof that the coercion was the PI
  driver. Codex was right to suspect compulsion as the failure
  vector for Gate 2.

* **What this falsified (the full information-only hypothesis)**:
  Removing the coercion did NOT fix Gate 4 — it produced a
  DIFFERENT failure pattern. #43 had 2 catastrophic cells with
  one severe (-17pt). #44 has 3 catastrophic cells with one
  severe (-26.5pt) and one moderate (-13.5pt). The information
  alone (focused excerpt + line numbers + prior fingerprints +
  structured DIAG) is not enough to consistently produce
  ship-quality patches when the LLM is in a dupe loop. The
  intervention itself — regardless of whether it compels — alters
  the coding distribution in ways that hurt specific cells.

* **Decision**: revert profile branch. Trigger family-retirement
  per pre-registered stop rule (see family note below).

---

## DUPE-BREAK FAMILY RETIREMENT NOTE (2026-04-14)

After 4 systematic ablations on risk:high (kanban-board,
chat-interface, stock-ticker × claude/openai/google × n=3),
covering the full intervention design space:

| Exp | Intervention shape        | Gate 1 | Gate 2    | Gate 4 | Note                               |
| --- | ------------------------- | ------ | --------- | ------ | ---------------------------------- |
| #41 | tool-swap, full WRITE     | ✓      | ✓ (−42%)  | ❌     | claude×chat −13.9pt                |
| #42 | tool-swap, scoped (1 chg) | ✓      | ❌ (+10%) | ❌     | claude+openai × stock-ticker       |
| #43 | reasoning + coercion      | ✓      | ❌ (+22%) | ❌     | openai×kanban −17pt; Gate 5 = 100% |
| #44 | reasoning − coercion      | ✓      | ✓ (±0%)   | ❌     | openai×chat −26.5pt + 2 more       |

**Pattern**: every intervention shape produces quality regressions on
at least one (provider × fixture) cell, regardless of mechanism. The
specific cells that regress vary by intervention, but the family-level
property "guaranteed catastrophic cell" holds across all 4 shapes.

**Conclusion**: dupe-break-as-a-family is structurally unable to
deliver ship-quality on this slice with this fixture set. The
detector + fingerprint + diagnostic plumbing + outcome-scoring
counters all stay on main as **dormant infrastructure** (~400 lines)
— reusable when a different architectural attack surface opens up:

- Multi-agent diagnose-then-patch topology (one agent diagnoses,
  a different agent patches with the diagnosis as input — could
  avoid the "intervention contaminates the original LLM's
  distribution" failure mode)
- Different slice (risk:medium dupes might respond differently —
  the catastrophic-cell pattern may be specific to risk:high
  fixture complexity)
- Different cohort composition (if a future fixture set has
  different dupe-loop characteristics, retest)

**No further iteration on the existing surface.** The 4 experiments
already paid for: ~$25 in bench cost, ~6 hours of session time, and
two genuine bug fixes that ship on main (cross-phase detector +
Google `code: string` shape tolerance, both from #42's debug
process).

**Net retirement state on main**:

- `resolveRunPolicyForProfile`: no active profiles
- `ContextPolicy.{breakDuplicatePatch, dupeBreakAction}`:
  dormant, default off, no behavioral change
- `DupeBreakState`: full state machine present but `firedCount`
  stays 0 with default policy
- Detector + fingerprint code in `dupe-break.ts` and
  `run-coding-turn.ts`: present, gated, never fires
- Diagnostic prompt template: present, gated, never renders
- Outcome scoring: present, gated, never increments

Net latency vs pre-#41 main: zero.
Net infrastructure: ~400 lines of bench-tested, dormant
dupe-break machinery + 2 ship-quality bug fixes.

**Next harness work should target a different family or slice.**
The dupe-break attack surface is exhausted on risk:high under the
current architecture.

---

### Experiment #45 — Axis-keyed primitives doc slice (2026-04-14)

First fresh family after dupe-break retirement. Context-shaping, not
retry-intervention. `PRIMITIVES_DOCUMENTATION` was ~128 KB injected
into every first-turn system prompt regardless of which primitives
the fixture used. Slice the monolith by axis-derived allowlist; keep
cross-cutting guidance sections always.

**Profile-gated**: `GGUI_POLICY_PROFILE=ctx-slice-primitives-v1`.
Default stays `"full"` — byte-identical to pre-#45.

**Scope** (Codex tightening): medium-first + 1 high canary
(kanban-board). Did NOT touch design-system docs, retry context, or
eval criteria in the same pass.

**Triad alignment audit** (user-flagged mid-session — caught 2 real
bugs before the ship-bench):

1. `Badge` referenced unconditionally in system-prompt "Common
   Pitfalls" ("Badge variant accepts...") but not in CORE. Added.
2. **Critical**: slicer `^### (\S+)` regex was dropping guidance
   sections (`### onChange Behavior (CRITICAL)`,
   `### Import Constraints`, `### Elevation System`) whose first
   word wasn't in the allowlist. The "do NOT add new imports" rule
   lives in `### Import Constraints` — silent drop could have
   caused exactly the class of symptom (LLM mis-imports → PATCH_INVALID
   loops) that #45 aimed to prevent. Fix: slicer now distinguishes
   KNOWN_PRIMITIVE_SECTIONS from guidance; guidance always kept.

**Pre-bench cache probe** (Codex Gate 2): 1 fixture × Claude
confirmed within-session caching works identically (turn 1 creates
25698 tokens, turns 2+ all cache-hit). Cache mechanics unchanged.

**Result — MEDIUM (primary, 5/5 gates PASS)**:

| Gate                   | Status | Detail                                                                     |
| ---------------------- | ------ | -------------------------------------------------------------------------- |
| 1 mechanism fires      | ✓      | **58.4%** byte drop (≥ 40% required)                                       |
| 2 cache stable         | ✓      | pre-bench verified                                                         |
| 3 wall-clock           | ✓      | **−10.5%** blended; Claude −14.3%, Google −4.7%, OpenAI −15.2% (all 3 win) |
| 4 no catastrophic cell | ✓      | ZERO (no cell > +30% ms or < −10pt score)                                  |
| 5 score flat           | ✓      | **+2.18 pt** (actually improved)                                           |

PATCH_INVALID on medium: 114 → 68 (**−40%**) — side-benefit of less
confusing context.

**Result — CANARY kanban-board (informational, mixed)**:

| cell          | Δms        | ΔScore       |
| ------------- | ---------- | ------------ |
| claude×kanban | −9.7%      | +6.0 ✓       |
| google×kanban | **+71.6%** | −1.5 ❌      |
| openai×kanban | −19.3%     | **−15.8** ❌ |

Kanban axes (`state=merge` + `writes=per-item` + `realtime=merge`)
don't trigger Input/TextArea in the allowlist, but the fixture needs
inline-edit primitives. Slice structurally under-serves this fixture.

**Decision**: SHIP THE PROFILE (active branch, default stays `"full"`).
Per Codex's "don't smuggle findings into defaults" — this commits the
mechanism + bug fixes + profile branch without touching any default.
Follow-up (#46) can refine the allowlist for `state=merge` to include
inline-edit primitives.

**Why ship despite canary regression**:

1. Medium is the primary target slice (5/5 gates pass cleanly)
2. Profile is opt-in only — production never flips it without explicit
   env var
3. Two genuine triad-alignment bugs ship regardless of experiment outcome
4. Canary data informs #46 scope, not a false-ship-block

**Commits on main**:

- Profile branch + `computePrimitiveAllowlist` + slicer + preserved-
  guidance fix + Badge-in-CORE fix + telemetry (`primitive-doc-bytes`)
- All dormant default behavior. −10.5% wall-clock on medium when profile
  is on.

**Lessons**:

1. **Triad alignment audit before bench is non-negotiable**. Would have
   silently dropped `### Import Constraints` → LLM confused on imports
   → false canary regression blamed on the hypothesis instead of the bug.
2. **Non-primitive guidance headers are a real category** in structured
   docs. Anyone slicing similar monoliths in the future should assume
   any `### X` whose X isn't in a known entity list is guidance.
3. **Clean failure mode**. Unlike dupe-break (family-level catastrophic
   cell property), context-shaping fails by under-serving specific
   fixture complexity. Tractable: tweak the allowlist, don't rearch.
4. The 5-gate structure worked exactly as designed — medium cleared,
   canary surfaced narrow concern without false-blocking the ship.

---

### Ralph-loop wind-down note (2026-04-14)

After ralph #5's BLOCK, stopping the harness iteration loop for this
session. Pattern across ralphs #2-#5: hypothesis sounds plausible →
mechanism partially fires or fires too rarely → one provider improves
modestly → Google variance or catastrophic single-cell regression
blocks ship → classification goes in the "approach/implementation
falsified" bucket.

That pattern means the current search space has stopped producing
clean, independent, high-information experiments. More iterations now
would fit to noise, not discover levers. The right move is to stop,
consolidate, and only come back when a genuinely new lever is on the
table (e.g. the architect/coder topology fully wired, or a different
attack surface like eval-round caching).

Session tally:

- **Shipped**: Experiment #36 (WRITE_TOOL turn-1) — Google malformed 10→0,
  −56% ms, +30pt. Clean win. Regression test locks the invariant.
- **Shipped**: STAGED-workflow dispatch guard (quarantine, not delete).
- **Discipline encoded**: 6-rule fixture-level audit + probe-before-
  claiming-specific-class-bug + misdiagnosis log format + this wind-down
  rule. All in `.claude/agents/harness-engineer.md` + the postmortem
  checklist at the tail of that file.
- **Live hypothesis classes preserved** (not falsified, just implementation-
  wrong or unverified):
  1. Narrower scoped-retry trigger (Experiment #37) — only on 2nd+ multi-
     range failure, or size-based trigger.
  2. Narrower runtime-gated staged (Experiment #38 in worktree log) —
     different trigger than turn-1 PATCH_INVALID; possibly gated on
     SELF_CHECK_FAIL as well.
  3. Staged workflow topology with real architect/coder runners (Track 4
     arch work — not a ralph-sized iteration).
  4. Preflight feedback with fully-wired wrapper (this experiment #38 —
     requires a root-cause fix on why the wrapper didn't fire before
     retry).
- **Misdiagnoses logged**: #1 (phantom "preflight parser bug" from ralph #4).

---

## Current Decisions (active state)

| Decision                                                  | Status                      | File                                                                                              |
| --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------- |
| Use A4-lite v2 as turn-1 prompt                           | **ACTIVE**                  | `core/src/harness/runtime.ts`                                                                     |
| Syntax preflight on apply_changes + write                 | **ACTIVE**                  | `core/src/coding-agent/tools.ts`                                                                  |
| Centered PATCH_INVALID feedback                           | **ACTIVE**                  | ditto                                                                                             |
| Escalation (2× same-line PATCH_INVALID → write)           | **reverted** in latest code | —                                                                                                 |
| Hashline (`N:hh\|` display + anchor validation)           | **REVERTED**                | N/A                                                                                               |
| Pitfall lints for Stack/Row align/justify                 | **ACTIVE**                  | `core/src/evaluation/tiers.ts`                                                                    |
| A2 per-shape kanban scaffold (`detectShape` + `KANBAN_*`) | **REVERTED** (#12/#13)      | N/A                                                                                               |
| `taskUpdate` action schema (kanban contract)              | **ACTIVE**                  | `core/src/benchmarks/multi-sdk/commits.ts` — kept as a real contract improvement, not A2-specific |

### Architectural boundary (agreed with Codex, 2026-04-12)

- **Per-shape UI scaffolds are experimental probes only.** We are NOT
  shipping fixed-layout, commit-shaped UI scaffolds in production.
- **Generic opt-in logic helpers also rejected.** An early pitch extracted
  the A2a "ingredients" (`useStreamMergeById`, `useGroupedBy`) into
  `@ggui-ai/wire`, but on review: plain `useStream` + `useMemo` already
  does this work, the helpers add API surface without measurable
  generation-quality benefit, and shipping them as recommended tooling
  biases the LLM toward a narrow pattern when the problem is model-side
  JSX accuracy, not runtime API ergonomics. Deleted, not parked.
- **Correct direction = process-level routing** (provider × contract
  shape), not API additions. See Experiment #20 (staged-mode router).
- If someone reads the #12/#13 kanban results later and concludes "we
  should add helpers or more scaffolds" — that is **not** the direction.
  Neither layout-specific scaffolds nor ingredient-specific helpers
  earned their cost on benchmark.

## Open Questions

1. ~~**A2 scaffolding for stateful/multi-step/board shapes.**~~ Closed by
   #12 (A2 full) and #13 (A2a strip). Per-shape UI scaffolds proved the
   insight _and_ proved they're the wrong shipping form — no single
   scaffold wins blended. Succeeded by generic opt-in helpers (see
   Architectural boundary above).
2. ~~**kanban-board specifically**~~ Covered by #12/#13 findings.
   Next data point: benchmark the generic helpers
   (`useStreamMergeById`, `useGroupedBy`) on kanban + chat-interface +
   onboarding-wizard once implemented.
3. **Claude production-default vs benchmark-blended-prompt.** v2 is best
   for blended-tier benchmark KPI. Whether Claude-first production should
   use v2 or the original `Implement the COMPLETE component` depends on
   whether the -8pp is sampling noise or real. Verify with more runs
   (n ≥ 24 Claude-only) before choosing a production default.
4. **onboarding-wizard Claude 0% impl-pass under v2** — even v2.1 narrow
   pilot showed this is not wording-solvable for Haiku (+44pp blended but
   still 0/3 on Claude-only pilot). A2 scaffolding territory.

---

### Experiment #46 — Infra cleanup: probe infinite-loop guard + setState-effect exhaustive-deps + CLI max-turns (2026-04-14)

Not a TRIAD change — three infra fixes surfaced while doing cap-hit
diagnostic on the full baseline. Documents the baseline shift caused by
the fixes so future deltas have a clean reference point.

**Fixes (commit `781d6118`)**:

1. **Probe infinite-loop guard** (`core/src/harness/check/runtime-render/render-check.ts`): install `console.error` spy that detects React's `Maximum update depth exceeded` / `Too many re-renders` / `Rendered more hooks than…` signatures and throws synchronously to break the render stack. Adds 5000ms Promise.race timeout as async-hang safety net. Previously, one bad component could burn 99% CPU for minutes (observed: run2 of `full-ctx-slice-v1-*` burned 12 min before manual kill).

2. **`exhaustive-deps` promotion** (`core/src/adapters/tools.ts`): when the code contains `set[A-Z]\w*(…)` or `dispatch(…)` AND the `react-hooks/exhaustive-deps` message indicates missing-dep / unstable-ref class, promote the diagnostic from warning (routed to `typeWarnings`, non-blocking) to blocking `issues`. Narrow — inline-object warnings on passive effects stay advisory.

3. **CLI `--max-turns` honored** (`core/src/adapters/generation-dispatch.ts`): removed silent `Math.min(params.maxAttempts ?? 8, 8)` inner clamp. Default stays 8 via `?? 8`; CLI `--max-turns 30` (the bench.mjs default) now actually reaches the runner.

**Bench**: same 8 commits × 3 providers, n=2 post-fix (run3 crashed on new `setTimeout→setState after probe teardown` infra bug — tracked separately).

| Metric       | Baseline (n=72) | Post-fix (n=48) |        Δ |
| ------------ | --------------: | --------------: | -------: |
| Mean gen     |           50.3s |           56.8s | **+13%** |
| Score        |            77.5 |            76.8 |     −0.7 |
| Cap-hit (≥8) |             24% |             23% |        ≈ |

**The wall-clock regression is not a regression.** Baseline's 50.3s was artificially compressed by the 8-turn clamp cutting runs short. Turn distribution reveals the truth:

```
baseline  turns: 1:16  2:11  3:7  4:7  5:8  6:2  7:4  8:17  ← piled at clamp
post-fix  turns: 1:19  2:7  4:2  5:4  6:1  7:4  9:1  11:2  12:3  13:1  30:4
                                         ↑ previously hidden ↑ true stuck
```

4 runs hit 30 (new honest cap). Those are the real over-constrained cells.

**Per-cell deltas:**

- `survey-form × claude`: 50→20s **(−60%)**
- `chat-interface × openai`: 145→72s **(−50%)** — the 295s outlier gone
- `periodic-table × google`: 45→12s **(−75%)**
- `onboarding-wizard × openai`: 93→51s **(−45%)**
- **Regressions surfacing true stuck:** `kanban-board` all 3 providers (+54/+17/+87%), `stock-ticker × claude` (+71%), `chat-interface × claude` (+184%, hits new cap)

**Guard fire count** on the 48 completed cells: zero exhaustive-deps promotions, zero probe loop-detections. Both are preventive — they didn't fire because the LLM didn't produce bad code in this cohort. They're a safety net for future iterations.

**Known residual infra bug**: generated components using `setTimeout` / `setInterval` can fire `setState` after probe teardown, hitting `window is not defined` unhandled → process crash. Caused run3 failure. Separate fix: bound setTimeout, install unhandled-exception handler, OR clear timers in teardown.

**Canonical cohort**:

- `tmp-bench-logs/full-baseline-2026-04-14-run{1,2,3}.log` — baseline (pre-fix)
- `core/tmp-bench-logs/post-probe-guard-2026-04-14-run{1,2}.log` — post-fix (n=2; run3 crashed)

**Lesson for future TRIAD work**: cap-hit analysis on the _artificially clamped_ baseline was already directionally correct (pointed at state=merge × realtime=merge/mixed), but the new cohort is the proper reference. TRIAD iterations from here target the cells that hit turn=30 under honest budget: **kanban-board, stock-ticker, chat-interface × claude**.

---

### Experiment #47 — Staged process routing for state=merge × realtime=merge|mixed (FALSIFIED 2026-04-14)

First TRIAD iteration after the #46 infra baseline shift. Targeted the 3 cells that genuinely hit turn=30 under honest budget: kanban-board, chat-interface, stock-ticker.

**Hypothesis**: scaffold → fill (staged process mode) shrinks per-turn AST scope. Structural diagnosis on #46 identified that single_pass patching against the full nested JSX tree runs out of visibility — tag-pair mismatches compound. Staged should give the LLM a working skeleton first, then fill sections in smaller patches.

**Mechanism** (profile reverted; `HarnessPolicy.processMode` field retained as dormant framework):

- New `HarnessPolicy.processMode?: ProcessMode` field.
- Profile `staged-merge-realtime-v1` in `resolveHarnessPolicy`: if classification matches `state=merge ∧ realtime ∈ {merge, mixed}`, set `processMode = "staged"`.
- `create-harness.ts` reads `policy.processMode ?? "single_pass"` when building `ProcessLeg`.

**Pre-registered gates**:

1. Mechanism fires — staged A1 scaffold→fill log markers on the 3 target commits.
2. Target turn count drops — staged < prior single_pass.
3. No catastrophic cell — no cell regresses >+30% ms or <−10pt score.
4. Blended non-regression — mean ms + score hold or improve.

**Result**: Gate 1 passed. **Gates 2, 3, 4 all failed.**

Apples-to-apples (post-probe-guard n=2 control vs staged-profile n=3 change, same 30-turn cap, same probe guards, 3 commits × 3 providers):

| Metric          | Control | Staged |           Δ |
| --------------- | ------: | -----: | ----------: |
| Mean turns      |     8.8 |   17.6 | **DOUBLED** |
| Mean ms         |   99.4s | 136.7s |        +38% |
| Mean score      |    71.9 |   60.1 |   **−11.7** |
| Timeouts @ 300s |    3/18 |   4/27 |          +1 |
| Turns ≥ 30      |   small |  12/27 |      +worse |

Per-cell catastrophes (Gate 3 fails on 5+ cells):

- `openai × kanban-board`: score −28.5
- `openai × chat-interface`: score −34.0
- `google × chat-interface`: score −26.4
- `google × kanban-board`: score −18.1
- `claude × kanban-board`: ms +269%, 1 timeout
- `openai × stock-ticker`: ms +256%, 2 timeouts

**Root cause of falsification**: the hypothesis was wrong about where the per-turn AST-scope pain lives. The FILL phase still does patch operations against the **full** scaffold, so it inherits the entire original patch-visibility problem and adds scaffold overhead on top. Staged compresses initial render time but expands repair time — net-net worse for this error class.

**What was confirmed**: Gate 1 proved the mechanism fires cleanly — `A1: scaffold compiled → entering fill phase` appeared on every target cell. Staged dispatch works.

**What was learned**:

- Process topology (single_pass vs staged) is orthogonal to the near-synonym tag-mismatch error class. Structural pain is at the patch-tool × full-file-view boundary, not at the turn-topology boundary.
- Scaffold helps the LLM see the skeleton, but the fill phase inherits the full file for patching — so none of the repair-visibility benefit transfers.
- **For this error class, Lever A (WHAT-layer scaffold narrowing) remains the remaining candidate** — reduce structural depth / near-synonym surface so fewer tag-pair mistakes are possible per patch.

**Revert action**: profile branch deleted from `resolveHarnessPolicy`. Dormant `processMode` field retained.

**Cohort**:

- Control: `tmp-bench-logs/exp47-control-run{1,3}.log` (run2 crashed on pre-fix teardown bug)
- Change: `tmp-bench-logs/exp47-change-run{1,2,3}.log` (all complete, 4 timeouts on target cells)
- Apples-to-apples reference: `core/tmp-bench-logs/post-probe-guard-2026-04-14-run{1,2}.log`

**Infra bug fixed in same window**: delayed `uncaughtException` handler removal by 100ms in `render-check.ts` so React 19's concurrent scheduler can drain any deferred `useWiredTool.call → dispatchSetState` between cells without crashing the process. Separate commit from profile revert.

---

### Experiment #53 — hashline-v2 (FALSIFIED universal, ASYMMETRIC SIGNAL, 2026-04-14)

Commit `a87579b4`. Profile `GGUI_POLICY_PROFILE=hashline-v2`. Default stays OFF.

**Hypothesis**: inject 2-char content hashes beside line numbers (`N:hh│content`) and require the LLM to echo them in `apply_changes` refs. Mismatched hash → reject edit with `HASHLINE_STALE`. Based on blog.can.ac/2026/02/12/the-harness-problem/ which reported +60pp on Grok Code Fast 1 and +5-14pp on Gemini 3 Flash.

Repo's earlier hashline experiments (09-13) were reverted due to high anchor-mismatch rates cascading. We retested atop the never-revert default (`4b86e8f4`) + state-machine tool selection (`ff90eac9`) which give the LLM room to iterate through stale-reject events without catastrophic cascades.

**Implementation**:

- `core/src/harness/hashline.ts` — pure helper (`computeLineHash`, `formatWithHashlines`, `parseHashlineRef`, `validateHashlineRefs`) + 18 unit tests
- `APPLY_CHANGES_HASHLINE_TOOL` — string-typed `startLine` / `endLine` as `"N:hh"`
- `ContextPolicy.hashline: "off" | "v2"` + profile branch in `resolveHarnessPolicy`
- `run-coding-turn.ts` formats file view with `formatWithHashlines()` and advertises the hashline tool when the profile is on
- `tools.ts` apply_changes handler: parses string refs, validates hashes, rejects pre-apply on mismatch

**Pre-registered gates**:

1. Mechanism fires (HASHLINE_STALE logged)
2. HASHLINE_STALE rate < 5% of apply_changes (revert threshold — previous reverts hit high rates)
3. No catastrophic cell (>+30% ms or <−10pt score)
4. Blended metrics hold or improve

**Result (n=3, 3 cells × 3 providers)**:

| Gate                    | Result                                            | Verdict  |
| ----------------------- | ------------------------------------------------- | -------- |
| 1. Mechanism fires      | 33 HASHLINE_STALE events across 3 runs            | ✅ PASS  |
| 2. Stale rate < 5%      | **14.9%** (33/221)                                | ❌ FAIL  |
| 3. No catastrophic cell | `google × chat −48.5` score, +202% ms             | ❌ FAIL  |
| 4. Blended              | ms −12% (99→87s), pass +3pp (56%→59%), score −4.0 | ⚠️ mixed |

**Per-provider breakdown** (the real signal):

| Provider    | Δms vs control | Δscore |
| ----------- | -------------: | -----: |
| google      |       **−38%** |  mixed |
| openai-mini |       **−32%** | **+9** |
| claude      |           +39% |     −3 |

Confirms the blog's claim that hashline primarily helps light models with brittle tool-call serialization (Grok, Gemini Flash; our Google = Flash-Lite, OpenAI = GPT-5-mini). Claude tracks line numbers already; the hash-check is pure overhead for it.

**Revert action**: per pre-registered stop rule, **don't flip default**. Profile stays dormant (env-gated, opt-in only). No code reverted — the plumbing is ready for #54.

**Next step (Experiment #54, not started)**: provider-conditional hashline — activate only on Google + OpenAI, not Claude. Implementation in `resolveRunPolicyForProfile` (which sees `runtimeCtx.provider`), not `resolveHarnessPolicy`. Pre-registered gates will check that the asymmetry materially improves blended ms + pass-rate without the Claude regression.

**Cohort**:

- exp53 n=3: `tmp-bench-logs/exp53-hashline-run{1,2,3}.log`, reports `benchmark-2026-04-14T17-22-*.json`
- exp52 state-machine (prior control): `benchmark-2026-04-14T16-57-09-*.json`
- Earliest control: `core/tmp-bench-logs/post-probe-guard-2026-04-14-run{1,2}.log`

---

### Experiment #55 — Tool-driven primitive docs (PRE-REGISTERED, 2026-04-15)

Profiles `GGUI_POLICY_PROFILE=tool-driven-primitives-names` / `tool-driven-primitives-props`. Default stays OFF. Two sub-profiles are A/B-tested against the same control.

**Hypothesis**: the ~130 KB `PRIMITIVES_DOCUMENTATION` monolith dumped into the first-turn system prompt is wasted context. Typical fixtures reference 5-10 primitives; the rest is prefix pollution. Replace with a compact ~7-9 KB name+description index; advertise `get_components_info(names[])` on every coding turn so the LLM fetches full prop APIs on demand.

This is the first **context-shaping family** experiment that introduces a fetch-turn trade: spend 1-N extra tool calls to save ~122 KB of turn-1 input. Net win condition = input-token savings × (provider cache-miss cost) outweighs fetch-turn cost.

**Implementation** (branch-less, pre-bench):

- `core/src/harness/primitive-index.ts` — parses `PRIMITIVES_DOCUMENTATION` markdown, emits compact index with two modes. System Conventions section (onChange, motion, elevation, import constraints) preserved verbatim in both modes.
- `GET_COMPONENTS_INFO_TOOL` exported from `harness/tools/coding-tools.ts` (handler already existed in `coding-agent/tools.ts::get_components_info`).
- `selectTurnTools` extended: when `primitiveIndexMode !== "off"`, pushes `GET_COMPONENTS_INFO_TOOL` alongside `apply_changes`.
- `ContextPolicy.primitiveIndex: "off" | "names-only" | "with-props"` + two profile branches in `resolveHarnessPolicy`.
- `generation-dispatch.ts` swaps full doc for index in `systemPromptOverride` when profile active. Logs `primitive-index-bytes` telemetry.

**Measured byte reduction (static, pre-bench)**:

| Mode            |   Bytes | Reduction |
| --------------- | ------: | --------: |
| full (baseline) | 128,515 |        0% |
| names-only      |   6,965 |     94.6% |
| with-props      |   8,993 |     93.0% |

**Pre-registered gates** (applied to EACH arm independently — names-only and with-props each measured against control):

1. **Mechanism fires** — `get_components_info` called ≥1× per typical run (>=80% of runs).
2. **Turn count non-regression** — mean turns increases by ≤ +1.0 vs control (fetch overhead must be paid back in reduced patch-repair cycles).
3. **No catastrophic cell** — no (provider × fixture) cell with ms +30% or score −10 vs control.
4. **Blended non-regression** — pass-rate, score, and ms each within ±5% of control or better. Tie-breaker for ship: whichever arm has larger turn-1 input-token drop AND lower or equal total turns wins.

**Slice**: risk:medium (5 fixtures — survey-form, onboarding-wizard, product-page, periodic-table, weather-card). Medium is the cleanest A/B — low-risk hits template-match bypass, high-risk has cap-hit noise that masks context-shaping signal.

**Risk log**:

- Over-fetching: LLM fetches every primitive → turn-cost swamps context savings. Mitigated by batched fetch (one call, N names).
- Gemini `malformed_tool_call` on the extra tool: adds tool-call surface; may trigger Google's tool-call brittleness on the non-authoring tool. If fetch-tool malformed_tool_call rate exceeds 10% on Google, kill that arm before full bench.
- Cache invalidation: changing the prompt prefix is a one-time cost — amortizes across turn-2+ patches in the same run, but the first turn pays the miss. Expected net win still positive.
- Tie-breaker precedence: if both arms fail a gate, keep infrastructure dormant and analyze fetch-turn distribution for diagnosis; DO NOT flip default.

**Status**: plumbing in place, typecheck clean, 161 harness unit tests pass. Bench not yet fired.

**Result (n=3, 4 medium fixtures × 3 providers × 3 runs × 3 arms = 108 cells)**:

| Gate                                 | Expected                        | names-only                            | with-props                            | Verdict         |
| ------------------------------------ | ------------------------------- | ------------------------------------- | ------------------------------------- | --------------- |
| 1. Mechanism fires (fetch ≥80% runs) | `get_components_info` called    | **0 calls / 108 cells**               | **0 calls / 108 cells**               | ❌ FAIL         |
| 2. Turn count non-regression (≤+1)   | Claude ~11.2 turns/cell control | 15.8 (+41%)                           | 21.3 (+90%)                           | ❌ CATASTROPHIC |
| 3. No catastrophic cell              | no +30% ms / −10pt score        | Claude +10%, OpenAI +52%, Google +26% | Claude +30%, OpenAI +98%, Google +30% | ❌ FAIL         |
| 4. Blended non-regression (±5%)      | match control                   | ms +23%, more thrash                  | ms +37%, worst arm                    | ❌ FAIL         |

**Per-provider avgMs across arms** (lower = better):

| Provider | control |    names-only |    with-props |
| -------- | ------: | ------------: | ------------: |
| Claude   |   66.5s |  73.2s (+10%) |  86.6s (+30%) |
| OpenAI   |   40.2s |  61.0s (+52%) |  79.7s (+98%) |
| Google   |  130.0s | 165.4s (+27%) | 170.3s (+31%) |

**Root cause**: zero fetches means the hypothesis's feedback loop never closed. The LLM saw the compact index, assumed it had complete information, and **guessed prop enum values wrong**. Claude specifically thrashes on self-check type errors (`'var(--ggui-font-size-sm)' not assignable to 'sm' | 'md' | ...`) — prop enum values are the error class, and the index doesn't include them. The with-props arm is worse than names-only: prop names without enum values create _false confidence_ that the LLM has enough to write correct JSX. Names-only at least doesn't bait the LLM into thinking it's informed.

Observed tail: Claude × several fixtures hit 40-59 patch-turns per cell (vs 2-8 in control). Self-check failure loop on prop enum mismatches, never converging.

**Revert**: per pre-registered stop rule, **both profiles stay dormant**. No code change needed (defaults already OFF). Profile branches + `ContextPolicy.primitiveIndex` + index builder stay as dormant infra — reusable if a different attack surface materializes (e.g. forced turn-1 fetch, or index that includes enum values).

**Lessons (falsification value, not implementation)**:

1. **The 130 KB primitive doc was load-bearing, not prefix pollution.** Enum value documentation (Text `size`, Button `variant`, Heading `level`) IS the signal that prevents Claude's self-check loop on the state=draft + form slice.
2. **LLMs don't fetch when they think they know.** Tool-driven context needs either (a) mandatory fetch semantics (force N fetches on turn 1) or (b) an index rich enough that fetching is genuinely optional.
3. **Prop names aren't the error class.** Prop _values_ (enums, CSS var vs literal) are. A context-shaping experiment that keeps prop names and drops enum values attacks the wrong surface.

**Next-lever candidates (if revisited)**:

- Rich index with enum values inline: `Text(size: 'xs'|'sm'|'base'|'lg'|'xl'|'2xl'|'3xl'|'4xl', weight: 'normal'|'medium'|'semibold'|'bold')`. Bigger than names/props (~15-20 KB estimated) but may still cut 80%+ vs baseline and unblock enum mismatches.
- Forced fetch-on-turn-1: harness inserts a synthetic `get_components_info` call before turn 1 based on classification, feeding Axis-keyed docs. Hybrid between #45 slicing and #55 fetching.
- Measure #45 axis-keyed slice (already shipped as opt-in profile) as the middle-ground — it cuts ~60% vs full and keeps enum values intact.

**Cohort**:

- exp55 control n=3: `tmp-bench-logs/exp55-control-run{1,2,3}.log`
- exp55 names n=3: `tmp-bench-logs/exp55-names-run{1,2,3}.log`
- exp55 props n=3: `tmp-bench-logs/exp55-props-run{1,2,3}.log`

---

### Experiment #55b — Tool-driven primitives + SYSTEM-PROMPT fetch instructions (PROVIDER-ASYMMETRIC, 2026-04-15)

Follow-up to #55. #55 failed Gate 1 because LLM had the fetch tool but no instructions on when/how to use it. #55b prepends explicit fetch-before-writing rules to the compact index (`FETCH_INSTRUCTIONS` preamble in `primitive-index.ts`).

**Gate evaluation** (n=3 × 4 fixtures × 3 providers = 36 cells per arm):

| Gate                    | control (full docs)   | names-only                    | with-props                        |
| ----------------------- | --------------------- | ----------------------------- | --------------------------------- |
| 1. Mechanism fires      | n/a                   | 7.2 fetches/cell ✓            | 5.2 fetches/cell ✓                |
| 2. Turn ≤+1 vs control  | 4.6/4.6/4.0           | 23.8/6.8/2.7 ❌ Claude        | 16.2/4.6/3.7 ❌ Claude            |
| 3. No catastrophic cell | baseline              | google -27% ms ✓              | google -63% ms ✓                  |
| 4. Blended ±5%          | 102s / 1.69 pass/cell | 78s / 1.58 (-24% ms, -7% q) ⚠ | **54s / 1.54 (-47% ms, -9% q)** ⚠ |

**Fetch frequency per provider** (how often each provider used the tool):

| Arm   |         Claude |     OpenAI |          Google |
| ----- | -------------: | ---------: | --------------: |
| names | **0.2** / cell | 6.5 / cell | **18.4** / cell |
| props | **1.4** / cell | 3.0 / cell |     11.7 / cell |

**Provider-asymmetric finding** (identical pattern to hashline #53):

- **Claude**: essentially ignores fetch tool; when forced to index-only, guesses wrong prop enums then thrashes. Quality regresses.
- **OpenAI (GPT-5-mini)**: fetches moderately, wins modest ms + quality.
- **Google (Flash-Lite)**: fetches aggressively, wins big on ms (-63% with props arm). Structured-output decoder appears to benefit from denser input.

**Decision**: **DON'T flip default**. Same 4-gate stop rule as #53. Props arm's blended ms (-47% vs control) is the largest single win measured, but Claude's quality pass-rate drop (-7pp) blocks the ship. Provider-conditional is the obvious follow-up.

**What ships/stays**: plumbing dormant, profile opt-in only. Plan-turn ablations (#56-#58 below) built on this scaffolding.

**Cohort**: `tmp-bench-logs/exp55b-{control,names,props}-run{1,2,3}.log`

---

### Experiment #56 — Fetch → plan → write pipeline (FALSIFIED, 2026-04-15)

Profile `tool-driven-primitives-fetch-plan`. Turn 1 = `get_components_info` only; turn 2 = `write_plan` only; turn 3+ = normal write tools. Tests whether forced phase transition closes Claude's "ignores fetch" gap from #55b.

**Mechanism fired cleanly** on Claude smoke (survey-form: 5 turns, 71s, score 85/100 — vs #55d Step A 26 turns, 109s). But aggregate across 3-arm bench:

| Arm            | Claude ms / score / pass | OpenAI          | Google             |
| -------------- | ------------------------ | --------------- | ------------------ |
| control        | 43s / 85 / 100%          | 80s / 80 / 100% | 195s / 73 / 75%    |
| props (#55b)   | 47s / 78 / 100%          | 58s / 81 / 100% | 115s / 66 / 33% ❌ |
| **fetch-plan** | 44s / **42 / 50%** ❌    | 56s / 79 / 100% | **84s / 67 / 67%** |

**Verdict**: the ms win on Google (-57% vs control) hid a catastrophic Claude quality collapse (42/100 score, 50% pass rate). This was missed initially because we looked at ms first — reinforces: **always check pass rate alongside ms**. Falsified per gate 3 (no catastrophic cell) on the Claude slice.

**Cohort**: `tmp-bench-logs/exp56-{control,props,fetchplan}-run{1,2,3}.log`

---

### Experiment #57 — Option A: TS-interface processed full docs (SHIPPED DEFAULT 2026-04-15)

Profile `primitives-ts-format`. Replace verbose markdown tables with TS-interface format. Same info, 55% byte reduction: 128KB → 59KB / 35K → 16K tokens. No fetch tool needed — LLM has everything inline.

**Process**: `packages/design/scripts/generate-primitives-docs-ts.ts` parses types.ts AST (interfaces + type aliases via Omit/Pick resolution) and emits compact TS output. Critical for correctness: the generator now handles `type RowProps = Omit<StackProps, 'direction'>` and similar — previously Row was missing from BOTH markdown and TS docs (pre-existing triad misalignment surfaced during #57 audit).

**Per-provider results** (n=3 × 4 × 3):

| Provider | control          | ts-format           | Δ                                 |
| -------- | ---------------- | ------------------- | --------------------------------- |
| Claude   | 46s / 85 / 100%  | **38s / 79 / 100%** | ms -17%, score -6, pass equal     |
| OpenAI   | 61s / 80 / 100%  | **45s / 81 / 100%** | **ms -26%**, score +1, pass equal |
| Google   | 167s / 73 / 100% | 141s / 66 / 75%     | ms -16%, score -7, pass -25pp ⚠   |

Initial n=3 showed Google pass rate 33% — looked like catastrophic regression. **n=6 Google re-bench revealed sample noise**: real figures 69% for both control AND ts-format. No catastrophic cell.

**Triad audit pre-ship** (mandatory per 2026-04-14 rule):

- Row missing in both docs (fixed — generator handles type aliases)
- `runtime.ts:479` "Stack/Row do NOT accept padding" pitfall: TS format consistent (no padding prop shown) ✓
- `runtime.ts:482` "Badge variant accepts ..." pitfall: TS format shows same enum ✓
- Preamble adds NEW rule "enum strings, not CSS variables" — additive, fills pre-existing gap
- No contradictions HOW/WHAT/CHECK

**Decision**: **FLIPPED DEFAULT** to `primitiveDocFormat: "ts"` in `DEFAULT_CONTEXT_POLICY`. Legacy accessible via profile `primitives-markdown-format` (to be added if regression investigation needed). Net: context cost halved, quality holds, mild ms win on light providers.

**Cohort**: `tmp-bench-logs/exp57-{control,tsformat,fetchplan}-run{1,2,3}.log`, `exp58g-{control,tsformat}-run{1-6}.log` (Google re-bench)

---

### Experiment #58 — TS-format + plan→impl pipeline (FALSIFIED 2026-04-15)

Profile `tsformat-plan-impl`. Combines #57 TS docs (no fetch tool) with forced turn-1 plan. Simplest constrained pipeline tested: plan then write.

**Gate table** (n=3 × 4 × 3):

|                  | control    | tsformat   | **tsplan**                 |
| ---------------- | ---------- | ---------- | -------------------------- |
| Blended ms       | 90s        | 75s (-17%) | **65s (-27%)**             |
| Claude ms / pass | 41s / 100% | 37s / 100% | 50s / 100% (turns 4.5→6.6) |
| OpenAI ms / pass | 61s / 100% | 45s / 100% | 61s / **83%** ❌           |
| Google ms / pass | 167s / 75% | 141s / 75% | **84s / 67%** ⚠            |

**Verdict**: plan-turn helps Google's weak tool-call serializer (-50% ms, +50% recovery) but hurts the stronger providers — OpenAI loses 17pp pass rate, Claude adds overhead without benefit. Same provider-asymmetric pattern.

**Decision**: DON'T flip default for plan-turn. Context-shaping (tsformat) alone is universal; phase forcing is provider-conditional. If future need: implement `primitives-provider-optimized` profile via `resolveRunPolicyForProfile` that reads `runtimeCtx.provider`.

**Cohort**: `tmp-bench-logs/exp58-{control,tsformat,tsplan}-run{1,2,3}.log`

---

### Experiment #59 — Hashline + regex-constrained schema (PROVIDER-ASYMMETRIC, DORMANT 2026-04-15)

Retest of hashline with added JSON schema `pattern: "^\\d+:[0-9a-f]{2}$"` on `startLine`/`endLine`. Hypothesis: schema-level regex constraint forces provider decoders to emit matching format, reducing HASHLINE_STALE rejections and malformed_tool_call.

**Results** (n=3 × 4 × 3):

| Provider | control                        | hashline+pattern                   | Δ                                    |
| -------- | ------------------------------ | ---------------------------------- | ------------------------------------ |
| Claude   | 34s / 79 / 100% / 0 malformed  | 73s / 72 / **71%** / 0             | ms +113% ❌, pass -29pp              |
| OpenAI   | 80s / 67 / 67% / 0             | 98s / 80 / **100%** / 0            | ms +23%, pass **+33pp** ✓            |
| Google   | 144s / 54 / 40% / 22 malformed | 111s / 62 / 45% / **15 malformed** | ms -23% ✓, pass +5pp, malformed -32% |

HASHLINE_STALE fired 40× in hashline arm. Regex pattern reduced Gemini malformed by ~32% but did not prevent Claude quality regression (Claude doesn't emit malformed strings — pattern is moot for it).

**Decision**: Same provider-asymmetric pattern as original hashline #53. DON'T flip default. Profile dormant. The pattern addition itself is a valid sub-mechanism (free tightening for future experiments).

**Cohort**: `tmp-bench-logs/exp59-{control,hashline}-run{1,2,3}.log`

---

### Experiment #60 — Flat `code: string` schema (SHIPPED DEFAULT 2026-04-15)

**THE big unlock** — user's intuition about the `code: string[]` design. Handler already accepted both `string[] | string` (tools.ts:444), so tool schemas were the only blocker.

**Hypothesis**: the 4-level-nested JSON schema (`changes: [{startLine, endLine, code: string[], description}]`) is what trips Gemini Flash-Lite's structured-output decoder, causing 5-22 malformed_tool_call events per run. Flattening to 3 levels (`code: string` with `\n` separators) should eliminate the dominant failure mode.

**Two profile variants tested**:

- `numberline-flat`: `code: string` + numeric line refs (no hashline)
- `hashline-v2-flat`: `code: string` + `N:hh` hashline refs

**Results** (n=3 × 4 × 3, SAME-SESSION control):

| Provider | control                            | numberline-flat                     | hashline-v2-flat      |
| -------- | ---------------------------------- | ----------------------------------- | --------------------- |
| Claude   | 38s / 77 / 100% / 0 malformed      | **33s / 79 / 100% / 0** ✓           | 64s / 74 / 80% / 0 ❌ |
| OpenAI   | 80s / 74 / 88% / 0                 | **62s** / infra-artifact† / 0       | 98s / 80 / 100% / 0   |
| Google   | **153s / 60 / 60% / 33 malformed** | **23s / 76 / 75% / 0 malformed** 🔥 | 40s / 69 / 80% / 0 ✓  |

**The Google numbers are the headline**:

- **ms: 153s → 23s (-85%)**
- **score: 60 → 76 (+16 points)**
- **pass: 60% → 75% (+15pp)**
- **malformed_tool_call: 33 → 0 (eliminated)**

**Per-fixture Google ms** (verifies the win is not weather-card-only):

| Fixture           | control | numberflat | Δ        |
| ----------------- | ------: | ---------: | -------- |
| survey-form       |    227s |        40s | **-83%** |
| onboarding-wizard |     79s |        18s | **-77%** |
| product-page      |    176s |        16s | **-91%** |
| kanban-board      |    156s |    **15s** | **-90%** |

Kanban — the historical worst-case for Gemini `malformed_tool_call` — is now the 2nd-fastest Google fixture. The win holds across complexity tiers, not just simple cases.

**Per-provider ms also improves universally**: Claude is flat or faster on every fixture (survey-form -33%, onboarding flat, product-page -24%, kanban +7% noise); OpenAI is faster on every fixture (-13% / -32% / -27% / -21%).

**† The "OpenAI quality regression" was a bench-infra artifact, NOT a real regression.**

Initial mining showed OpenAI score 74→57, pass 88%→50%. Investigation traced this to `evaluateAesthetics` in `core/src/benchmarks/multi-sdk/post-eval.ts:125` throwing an Anthropic SDK "browser-like environment" error. The runtime-render probe imports happy-dom, which sets `window`/`document` globals; the SDK's browser-detection heuristic then misfires and throws before emitting the aesthetic score. That omission dropped the `score: N/100` field from the bench result line → silent filter in mining.

Unscored OpenAI cells per arm: control 1/10, numberflat 5/12, hashflat 3/11. Per-fixture ms (which is recorded regardless of the aesthetic phase) is reliable and confirms numberflat wins on OpenAI.

Fix landed same commit: `dangerouslyAllowBrowser: true` on the aesthetic-eval Anthropic client (safe — key is in `process.env`, never exposed to a real browser). Next bench will have full score coverage.

**hashline-v2-flat** compounds flat with hashline but loses vs plain flat on Google (40s vs 23s) — hashline adds no value once schema is flat. Claude regression returns (pattern + hash-check overhead on a provider that doesn't need either). Dormant.

**Decision**: **FLIPPED DEFAULT** to `codeFormat: "flat"` in `DEFAULT_CONTEXT_POLICY`. This is the largest single-knob win measured in the #39-#60 run. The `APPLY_CHANGES_TOOL_FLAT` schema becomes the default authoring tool; old `APPLY_CHANGES_TOOL` accessible via profile `legacy-code-array`.

**Triad audit** (post-ship):

- HOW leg: no prompt references to `code: string[]` format (tool description carries the format)
- WHAT leg: no boilerplate refs
- CHECK leg: handler accepts both shapes (line 444) — zero consumer impact
- Only `APPLY_CHANGES_TOOL_SCOPED` fallback still uses `string[]`. Low priority — fires rarely now that malformed_tool_call is nearly eliminated on flat default.

**Lesson**: we spent experiments #32 (scoped-tool fallback) + #53 (hashline) + #59 (hashline+pattern) working around Gemini's decoder weakness on nested JSON. The actual fix was removing the nesting. The handler already accepted both formats; only the schema declaration was forcing the problematic shape.

**Cohort**: `tmp-bench-logs/exp60-{control,numberflat,hashflat}-run{1,2,3}.log`

---

### Experiment #61 — Structured pitfalls + batch-fix retry (REVISED by #66, 2026-04-15)

Two linked changes, benched together. `core/src/harness/pitfalls.ts` introduces a structured registry (append-only, replaces hardcoded 5-pitfall block in system prompt). Three new pitfalls added from exp60 OpenAI kanban error mining: `usestate-type-annotation`, `stream-latest-null-guard`, `null-vs-undefined`. Plus: patch-repair retry prompt gains "fix EVERY issue in THIS single apply_changes call" emphasis.

**Initial n=3 bench on risk:medium**: blended −19% ms (pitfalls-only 30.8s vs flat-only 40.8s). Headline looked like a win.

**n=3 follow-ups showed unstable results**: exp63 narrow (pitfalls+code:string format fix) measured 50.2s, exp65 with neutral format text measured 54.6s — both on nearly-identical prompts. Suggested large variance or genuine regression; couldn't distinguish at n=3.

**Result deferred to #66**.

**Cohort**: `tmp-bench-logs/exp61-{control,names,props,batchonly,pitfallsonly,control}-run{1,2,3}.log`, `exp63-narrow-run{1,2,3}.log`, `exp65-neutral-run{1,2,3}.log`.

---

### Experiment #62 — System-prompt cleanup (FALSIFIED 2026-04-15)

6 edits intended as rigor + alignment cleanup:

1. Fix stale `code: array of strings` → `code: single string` (correctness)
2. Delete Protocol Notes section, migrating 2 rules into Pitfalls
3. Trim `Reference: Design System` block (duplicate CSS vars)
4. Gate batch-fix retry at N≥2 errors
5. Split self-check-fail vs eval-fix closing instructions (strong vs soft)

**Result**: blended 42.5s vs pitfalls-only 30.8s — WORSE. Investigation revealed:

- **Deleting Protocol Notes removed load-bearing repetition.** `useStream.latest` null-guard existed in BOTH Protocol Notes and Pitfalls; the duplication was emphasis, not redundancy. Removing from Protocol Notes dropped attention weight on the rule.
- **Gated batch-fix still too aggressive** on complex fixtures. Claude × product-page regressed 20s/1.7t → 62s/11t in the full8+batch arm.

**Lesson**: "one leg owns" from constraint-alignment.md doesn't mean "never repeat." Strategic repetition across prompt sections is emphasis weighting. Applied too aggressively in #62.

**Cohort**: `tmp-bench-logs/exp62-combined-run{1,2,3}.log`.

---

### Experiment #64 — OpenAI gpt-5.4-nano comparison (FALSIFIED 2026-04-15)

Replaced default `openai/gpt-5.4-mini` with `openai/gpt-5.4-nano` to test whether the cheaper/faster OpenAI tier is viable for this task surface.

**Result**: blended 149s — **3× slower** than mini. Nano cannot complete complex fixtures cleanly:

- survey-form: 94s / 10 turns
- onboarding-wizard: 290s / 14 turns
- kanban-board: 134s / 13 turns

Nano is too weak for the fixtures — high turn count reflects thrashing on complex state machines (kanban) and multi-step forms (onboarding-wizard).

**Decision**: stay on mini. Nano may be viable for simpler UIs (weather-card class) but not for the benchmark corpus.

**Cohort**: `tmp-bench-logs/exp64-openai-nano-run{1,2,3}.log`.

---

### Experiment #66 — Full 3×2 factorial: pitfalls × batch-fix (CANONICAL BASELINE, 2026-04-15)

The rigorous n=6 same-session same-codebase factorial that settled exp61/63/65. 6 arms × 6 runs × 4 commits × 3 providers = ~432 cells.

**Arms** (using env toggles `GGUI_PITFALLS` + `GGUI_BATCH_FIX`):

| Arm                     | Pitfalls                    | Batch-fix |
| ----------------------- | --------------------------- | --------- |
| no-pitfalls + batch-off | 0                           | off       |
| legacy5 + batch-off     | 5                           | off       |
| full8 + batch-off       | 8 (5 legacy + 3 from exp61) | off       |
| no-pitfalls + batch-on  | 0                           | on        |
| legacy5 + batch-on      | 5                           | on        |
| full8 + batch-on        | 8                           | on        |

**3×2 blended ms** (n=6 per cell):

| pitfalls    |    batch-off | batch-on | row avg |
| ----------- | -----------: | -------: | ------: |
| no-pitfalls |        44.4s |    43.4s |   43.9s |
| **legacy5** | **29.3s** 🏆 |    45.1s |   37.1s |
| full8       |        38.1s |    45.5s |   41.8s |
| col avg     |    **37.2s** |    44.7s |       — |

**Main effects**:

- Pitfalls: legacy5 < full8 < no-pitfalls on ms. The 5 legacy rules are load-bearing (−15s vs 0); the 3 new rules dilute attention (+9s vs legacy5).
- Batch-fix: uniformly worse (+7.5s). No combination where it helps blended.

**Per-provider optimal configs** (different for each provider):

| Provider | Best arm               |        ms | Turns | Pass% |
| -------- | ---------------------- | --------: | ----: | ----: |
| Claude   | legacy5 + batch-off    | **24.2s** |   2.3 |   82% |
| OpenAI   | legacy5 + batch-off    | **27.1s** |   2.8 |   71% |
| Google   | no-pitfalls + batch-on | **32.0s** |   4.0 |   85% |

Picking best-per-provider → blended 27.8s (under 30s target).

**Why they differ**:

- **Claude**: strongest base-tier, extra rules dilute. Minimal + no coercion.
- **OpenAI**: 5 legacy rules catch specific errors; more rules dilute. Narrow set + no coercion.
- **Google**: brittle tool-call decoder, sensitive to prompt bulk. Minimal prompt + explicit retry hint.

**Decisions**:

1. Revert the 3 exp61 pitfalls (useState/stream/null-vs-undefined) — documented as "tried + falsified" in `pitfalls.ts`.
2. Leave batch-fix default off. `GGUI_BATCH_FIX=on` preserved as env-opt-in.
3. Universal default ships with legacy 5 pitfalls = 29.3s blended. Provider-conditional path via `resolveRunPolicyForProfile` is the next lever (gets to 27.8s) — not implemented this session.

**Methodology this established** (see `harness-baseline-2026-04-15.md`):

- n=6 minimum same-session for marginal-delta claims
- Include a zero-arm (no-pitfalls) for calibration
- Full factorial, never 1-at-a-time
- Decompose per-provider, not just blended
- Variance floor: Δ < 1 SE at n=6 = don't ship

**Cohort**: `tmp-bench-logs/exp66-{nopitfalls,legacy5,full8}{,batch}-run{1..6}.log`.

---

## Canonical Benchmark Cohorts

For apples-to-apples experiments, use only logs within the same cohort.

| Cohort                                   | Files                                                                  | Harness state                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Historical baseline**                  | `01-baseline.log`                                                      | Pre-triad, pre-preflight, pre-hashline. Reference only.                                                                  |
| **Triad evolution**                      | `02-triad-v1`, `03-triad-v2-codex-fixes`                               | Pitfall guidance added. Reference only.                                                                                  |
| **Preflight evolution**                  | `04-preflight-v1`, `05-preflight-v2-centered`                          | Syntax preflight + centered retry. Reference only.                                                                       |
| **Escalation / hardened**                | `06-escalation`, `07-hardened`, `08-run1/2/3`                          | Final pre-hashline pre-A4-lite state.                                                                                    |
| **Closest clean baseline**               | **`07-hardened` + `08-run1/2/3`** (n=4)                                | Use THIS for A4-lite v2 comparisons. Clean harness, no hashline, pre-prompt-change.                                      |
| **Hashline experiments**                 | `09-hashline-v0-unicode`, `09-hashline-v1`, `10-hashline-instrumented` | Hashline ON. Reverted; reference only.                                                                                   |
| **A4-lite v1 (hashline)**                | `11-a4lite-run1/2/3`                                                   | Hashline ON + A4-lite v1. Reference.                                                                                     |
| **A4-lite v2 (hashline)**                | `12-a4lite-v2-run1/2/3`                                                | Hashline ON + A4-lite v2. Reference.                                                                                     |
| **A4-lite v2 (clean)**                   | **`13-a4lite-v2-clean-run1/2/3`**                                      | No hashline + A4-lite v2. **Compare to closest clean baseline.**                                                         |
| **A4-lite v3 (clean)**                   | `14-a4lite-v3-run1/2/3`                                                | No hashline + v3 (falsification). Reverted.                                                                              |
| **A4-lite v2.1 (clean)**                 | `15-a4lite-v2_1-run1/2/3`                                              | No hashline + v2.1 (fallback wording). Not a blended win — reverted. Stateful-shape signal preserved.                    |
| **A2 full kanban scaffold**              | `16-a2-kanban-run1/2/3`                                                | Per-shape scaffold probe (#12). Reverted; kept for reference.                                                            |
| **A2a strip (non-visual only)**          | `17-a2a-strip-run1/2/3`                                                | Non-visual scaffold probe (#13). Reverted; kept for reference.                                                           |
| **Patch hints (targeted PATCH_INVALID)** | `18-patch-hints-run1/2/3`                                              | Executor-side classifier + one-line hint (#14). Reverted; barely moved retries, OpenAI regressed. Narrow 5-commit slice. |

## Methodology Notes

1. **Always use the closest-cohort comparison** for a new prompt/harness
   experiment. Mixing across eras confounds the effect under test.
2. **Google runs need a quality filter.** Flash-Lite's `malformed_tool_call`
   can produce "pass" results with 0-500B compiled code and score <20.
   Drop those from impl-pass counts; track `malformed_tool_call` rate as a
   separate transport metric.
3. **n=3 parallel runs** is the minimum for a benchmark decision. Single
   runs have ±15-20s time variance.
4. **95% binomial CI at n=24** is roughly ±20pp for a 30% success rate.
   Don't over-interpret single-log pass-rate swings within that band.
5. **Tests go with code changes.** If a helper is added and later reverted
   (e.g. `lineHash`), remove the helper's test file in the same revert.

## Tools for Analysis

- `/tmp/mine-hashline-baseline.py` — edit `COHORT` to compute stats per cohort.
- `/tmp/mine-impl-v2.py` — per-commit impl-pass rate across logs.
- Logs saved in `tmp-bench-logs/` (gitignored but preserved across sessions).
