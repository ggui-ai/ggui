# Form Mode — Experiments

Mode manifest: `../MODES.md` (form section).
Shared state: `../STATE.md`.

Latency target: **stabilize first** (no worse than cohort-13 baseline on Claude/OpenAI; Google transport errors acceptable pending adaptive staged fallback). Optimize only after stability is earned.

## Open questions (first explorer dispatch)

1. Cohort 24 Claude form −23% blended was real. Is that prompt-level, boilerplate-level, or eval-level?
2. Google form transport failures (onboarding) — what runtime signal should trigger adaptive staged fallback? Candidates: turn-1 `malformed_tool_call`, compiled <400B, repeat PATCH_INVALID on same range.
3. Should form-specific eval checks exist (step-flow integrity, submit payload completeness)? Or does shared tier-0/2 already catch enough?

## Banned

- Form-specific boilerplate comments (cohort 23 regressed Google badly). Forms describe a well-known pattern; comment sections add tokens without information.

---

<!-- Append entries below using the format in STATE.md. First experiment numbering starts at form-01. -->

## Experiment form-01 — Cohort 24 post-mortem & Google abort-signal mining (2026-04-12)

- **Hypothesis**:
  1. Cohort 24 Claude form "−23% blended" is partly a baseline artifact (cohort-13 survey-form has one 85s / score-3 stub that inflates the denominator). Real improvement is closer to −14% and within session noise.
  2. Google form catastrophic runs share a common runtime signature BEFORE the bad generation is committed: **turn-1 ends in PATCH_INVALID or SELF_CHECK_FAIL, then turn-2 emits no tool call** → `compiled (fallback): 0B`, score ≤ 10.
  3. Form-specific eval checks (step-flow, submit payload) are not needed — observed eval-fix failures are JSX geometry and shared tier-0/2 issues, not form-semantics issues.
- **Change under test**: no change — measurement / log analysis only.
- **Cohort**: `tmp-bench-logs/24-form-run{1,2,3}.log`, `tmp-bench-logs/13-a4lite-v2-clean-run{1,2,3}.log`, `tmp-bench-logs/23-shape-full-run{1,2,3}.log`, `tmp-bench-logs/20-router-google-run{1..6}.log`. JSONs via `compare.py --mode form`.
- **Results**:
  - Claude form 13 vs 24 (compare.py): 55.4s → 42.5s (−23.3% blended).
  - Claude form 13 vs 24, score-filter applied uniformly (drop 85s/score-3 stub from baseline): 49.5s → 42.5s (−14%) — within session variance.
  - Claude turn-mix 13 → 24: patches/task 3.2→1.8, evalFix/task 1.3→0.8, patchInvalid/task 2.0→1.3, selfCheckFail/task 1.5→0.5. Same system prompt, same (empty) form boilerplate, same eval. → **improvement is non-determinism, not triad-level.**
  - OpenAI form 13 vs 24: 35.8s → 33.6s (−6%). Flat.
  - Google form 13 vs 24: base 20.5s → 69.9s (+241%) but `[n_cells=1]` — only survey-form had one passing run in each cohort. Dominated by session variance; cohort-13 is stale.
  - Google cohort 20 (staged process, reference only): survey 21s→61s (+41s but pass@≥50 went 1/3→3/6, onboarding pass@≥50 3/3→3/5). Staged raises pass rate, not speed.
  - Google form 24 runs — three catastrophic (score ≤ 10, compiled 0B) abort traces:
    - run2 onboarding: turn-1 impl=SELF_CHECK_FAIL (compiled 0B at turn start), turn-2 no tool call → 0B fallback. Signal at 14.8s.
    - run3 onboarding: turn-1 PATCH_INVALID (`line=139 "}" not valid inside a JSX element`), turn-2 no tool call → 0B fallback. Signal at 10.4s.
    - run3 survey: turn-1 PATCH_INVALID (`Unexpected EOF`), turn-2 no tool call → 0B. Signal at 10.4s.
  - Cohort 24 form PATCH_INVALID classes: JSX tag mismatch 23%, JSX unescaped brace 18%, TS-in-JS colon 14%. Geometry, not form semantics.
  - Eval-fix failures observed: "unused import", JSX tag geometry, duplicate declaration. No form-specific semantic failures (no step-flow, submit-payload, or validation-bug fix turns observed in cohort 24).
- **Verdict**: inconclusive on "Claude −23% is real" (most of it is outlier-driven + noise); **confirmed** that Google form catastrophic runs share a runtime signal — turn-1 ends non-PASS _and_ turn-2 emits no tool call — that fires early (~10-15s) and is therefore a cheap trigger for adaptive staged fallback. Form-specific eval checks are **not** justified on current evidence.
- **Next**: propose process-level adaptive staged-fallback trigger (runtime-signal-gated, provider-agnostic): if turn-1 outcome ∈ {PATCH_INVALID, SELF_CHECK_FAIL} AND turn-2 emits no tool call (i.e., the silent-abort pattern), restart the task in staged mode for a bounded retry budget (1 restart). Bench via narrow n=3 on both form commits, all three providers. This is NOT provider-gated and NOT banned (no provider vendor check, no fixed-layout scaffold).
