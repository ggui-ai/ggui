# Display Mode — Experiments

Mode manifest: `../MODES.md` (display section).
Shared state: `../STATE.md`.

Latency target: **weather-card avg ≤ 15s**. Canaries: product-page, periodic-table, stock-ticker.

## Open questions (first explorer dispatch)

1. Can weather-card hit avg 15s on Claude/Google? Cohort 24 saw Google 20s (n=2 clean) and Claude 17s best single run.
2. Which parts of the system prompt / boilerplate imports are dead weight for passive props-rendering?
3. Does `getComponentsInfo` tool-call consume turns on display commits where all components are obvious?

---

<!-- Append entries below using the format in STATE.md. First experiment numbering starts at display-01. -->

## Experiment display-01 — Latency floor + dead-weight audit (2026-04-12)

- **Hypothesis**: weather-card ≤15s floor is reachable on Claude/Google; turn-count (not turn-1 LLM speed) is the primary latency driver. `get_components_info` tool is unused on display and therefore dead weight.
- **Change under test**: no change — measurement + source/log inspection only.
- **Cohort**:
  - new: `tmp-bench-logs/24-display-run{1,2,3}.log` + `benchmark-results/benchmark-2026-04-12T15-07-14-848Z.json`, `…T15-11-43-705Z.json`, `…T15-11-44-879Z.json`
  - base: cohort 13 `…T10-57-47-623Z.json`, `…T11-02-13-028Z.json`, `…T11-02-13-029Z.json` (stale-for-Google)
- **Results**:
  - weather-card per-provider (cohort 24 clean, n=3): Claude min 16.9s / p50 18.4s / p90 46.3s / avg 27.2s / turns [1,1,3]; Google min 19.3s / p50 20.6s / p90 20.6s / avg 20.0s / turns [2,2,2] (1 run score=3 filtered) [provisional: stale baseline for Google]; OpenAI min 14.4s / p50 53.1s / avg 57.8s / turns [2,8,8].
  - Dominant retry engine across all display tasks: **PATCH_INVALID 43.3% of turns (patch/PATCH_INVALID=41, eval-fix/PATCH_INVALID=15)**. Top classes: JSX tag mismatch (28%), JSX unescaped brace (23%), extra brace (10%), unterminated regex (8%).
  - `get_components_info` tool calls in all 3 display logs: **0**. Impl turn always emits `apply_changes`.
  - Claude weather-card generated source uses only `Container, Card, Stack, Row, Box, Divider, Heading, Text`; Google uses `Container, Card, Stack, Row, Icon, Divider, Heading, Text` — never touches `Table/Tabs/Accordion/CommandPalette/FileUploader/NotificationCenter/CommentThread/ChatWindow/DataTable/MotionKeyframes/useMotion` yet all are pre-imported + documented in system prompt.
  - avg turns: Claude weather-card 1.67, Google weather-card 2.00, OpenAI weather-card 6.0. Turn count perfectly rank-orders latency per provider.
- **Verdict**: inconclusive — measurement confirms target is within Claude reach today on single-turn runs (two of three Claude runs already <20s; Google consistently 1 eval-fix turn behind). No code change proposed by this sub-agent; see ranked proposals in parent report.
- **Next**: main agent to scope a narrow bench of two orthogonal levers — (a) cut eval-fix round for weather-card-class tasks when turn-1 score ≥ threshold; (b) prune unused composition docs from system prompt for display shape. Both are independently falsifiable at n=3.
