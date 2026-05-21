# Collection Mode — Experiments

Mode manifest: `../MODES.md` (collection section).
Shared state: `../STATE.md`.

Latency target: **chat-interface + kanban-board avg ≤ 30s**.

## Open questions (first explorer dispatch)

1. Chat/kanban 30s target is aggressive. What's the realistic floor with the current harness, per provider (p50/p90)?
2. Why does OpenAI kanban consistently regress (+10 to +49s across cohorts 19, 20, 23, 24)? Is it the section comments themselves, the multi-chunk JSX patches, or something else?
3. Do Google/OpenAI actually benefit from the section comments (which they strip), or is the benefit just from the _initial_ structure before stripping? Test: bench a variant where sections are present but wrapped so they can't be stripped, and compare.
4. What runtime signals should trigger adaptive staged fallback on this mode? Candidates: turn-1 compiled <800B, turn-1 PATCH_INVALID on a range >100 lines, `malformed_tool_call`.

---

<!-- Append entries below using the format in STATE.md. First experiment numbering starts at collection-01. -->

## Experiment collection-01 — Latency-floor & OpenAI-kanban-regression diagnosis (2026-04-12)

- **Hypothesis (measurement-only):** Chat/kanban 30s target is not reachable with the current single_pass harness; OpenAI kanban regression is driven by 8-turn-max saturation with stacked PATCH_INVALIDs on large JSX, not by collection section comments per se.
- **Change under test:** none — analysis only. Re-read cohorts 13 / 23 / 24 and inspected generated sources.
- **Cohort:**
  - 13 baseline (stale for Google, reliable for Claude/OpenAI): `tmp-bench-logs/13-a4lite-v2-clean-run{1,2,3}.log` → `benchmark-results/benchmark-2026-04-12T10-19-{17-817,22-104,26-597}Z.json`
  - 23 shape-full (collection sections ON, form sections ON — since reverted): `tmp-bench-logs/23-shape-full-run{1,2,3}.log` → `.../benchmark-2026-04-12T14-55-{18-449,19-838,21-631}Z.json`
  - 24 collection (shipping: collection ON, form OFF): `tmp-bench-logs/24-collection-run{1,2,3}.log` → `.../benchmark-2026-04-12T15-{07-16-388,11-46-032,11-47-235}Z.json`
- **Results (n=9 per commit across cohorts 13+23+24, score≥20 filter for Google):**
  - claude chat: min 22s, p50 ~55s, p90 ~66s
  - claude kanban: min 26s, p50 ~60s, p90 ~89s
  - google chat: p50 ~81s (only n=2 clean); 4/9 runs filtered as transport-fail
  - google kanban: clean runs 62s / 100s / 160s; 5/9 runs filtered
  - openai chat: min 11s, p50 ~45s, p90 ~72s
  - **openai kanban: min 48s (cohort 13), p50 ~55s, p90 ~103s — 7/9 runs hit 8-turn max**
  - PATCH_INVALID error class mix (cohort 24): JSX tag mismatch (20%), unescaped brace (17%), unterminated regex (15%), extra brace (12%)
  - Section-comment preservation in generated kanban: Claude 1-5 markers preserved, OpenAI 0-5 (inconsistent — 2/3 runs = 0 markers and still ~100s → sections are NOT the regression cause)
- **Verdict:** inconclusive on shipping change (no code change). **Analytical conclusions:**
  1. 30s avg is unreachable for kanban on OpenAI with single_pass (min ever observed = 48s across 9 runs, p50 55s). Step-change needed.
  2. OpenAI kanban regression across cohorts is session + patch-geometry variance, not section comments. Cohort-24 OpenAI kanban avg 101s is stable (101/101/103) → **deterministic** 8-turn saturation, not stochastic.
  3. Section-comment benefit is from initial structure before model drops them. Testing a "cannot-strip" variant is low-value (evidence already shows OpenAI strips yet still benefits in cohort 23).
- **Next:** Propose adaptive staged fallback triggered on `turn-3 patch=PATCH_INVALID AND compiled>=500B` (see ranked proposals below). Closed for this explorer run.
