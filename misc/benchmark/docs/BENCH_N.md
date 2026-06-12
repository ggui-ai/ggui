# bench:n — n-run wrapper for variance-aware iteration

Worker-pool wrapper around `bench.mjs` that expands the full matrix
into one process per (run × provider × commit) cell, with
kill-protected cells, streaming logs, and a per-(provider, commit)
aggregate that always reports BOTH score and time with std dev.

```
pnpm bench:n --tag <tag> --n 3 --provider claude,openai,google \
  --commit weather-card,survey-form,kanban-board,periodic-table,product-page,chat-interface,stock-ticker,onboarding-wizard \
  --max-turns 15 --max-eval 3 --quality fast --timeout 300000 --threshold 70
```

## Why

Single n=1 runs are too noisy on these fixtures (LLM variance ±15-20s,
±10-15 score). Decisions need n=3 minimum. Manual orchestration
(`for run in 1..3; do bench --provider …`) buffers stdout, can hang
on a single stuck cell, and doesn't aggregate cleanly.

## What it does

For each (run, provider, commit) cell:

1. Spawns an isolated single-commit `bench.mjs` child process (own
   heap, own report file).
2. Streams the child's stdout/stderr to
   `tmp-bench-logs/<tag>-run<i>-<provider>-<commit>.log`
   so the operator can `tail -f` while the cell runs.
3. Watches the log file for size growth — if no growth in `--heartbeat-sec`
   (default 90s; auto-bumped to `inner --timeout + 60s` when the inner
   timeout is larger), SIGKILLs the cell. Catches LLM SDK calls that
   can't be aborted by JS Promise.race.
4. SIGKILLs after `--cell-timeout-sec` (default 600s = 10min) regardless.
5. Parses the cell's stdout to find the `Report saved to` path and
   stores it (plus any `killReason`) in the manifest.

After all cells finish, writes a manifest (`<tag>-runs.json`) and
prints an aggregate with mean/std/min/max for both score AND time.

## Parallelism model

Cells are dispatched through a bounded worker pool —
`--max-concurrent` (default 12) cells in flight at once, no stagger.
The original 3-providers-in-1-process OOM'd at ~1.5GB shared heap;
the later per-(run, provider) design still OOM'd when 8 commits shared
one heap. One commit per process (~500MB own heap, no shared GC
pressure) eliminates the class, and the pool caps RAM (~12 × 500MB ≈
6GB) and per-provider request burst (12 / 3 providers = ≤4 simultaneous
calls per provider at n=3).

Wall-clock for n=3 × 3 providers × 8 commits ≈ ceil(72 / 12) × cell
time, bounded by API rate limits + system resources, not orchestration.

## Known harness-instrument fixes (2026-04-27)

### Report filename collision (FIXED)

`bench.mjs` previously generated report IDs as
`benchmark-<isoTimestamp>.json`. With 9 cells starting at the same
millisecond, two siblings produced identical filenames and one
overwrote the other — losing an entire run's data invisibly.

Fix: append `<pid>-<random4>` and a `<provider-tag>` to the report ID:

```
benchmark-2026-04-27T01-32-24-187Z-claude-openai-google-12345-ab7f.json
```

Both pid (cross-process unique) and 4-char random suffix (within-pid
unique on retry) eliminate the collision class.

### Per-task timeout 240s → 300s (FIXED)

Earlier runs used `--timeout 240000` (4 min). The `bench.mjs` default
is 300000 (5 min). Several "failed" cells were just hitting the
artificially-tight 240s budget on hard commits like `claude × stock-ticker`
which legitimately needs 100–115s and had a turn-14 retry pushing
total time over 240s.

Use 300000 (default) or 360000 (6 min) for hard-fixture work.

### Heartbeat-stall watcher (NEW)

The inner `bench.mjs` uses `Promise.race(withTimeout)` for per-task
budget. That fires reject on time but does NOT kill the underlying
work — if the LLM SDK call has uncancellable internals, the JS event
loop stays busy but no progress lands. Operator sees a process at
high CPU but no log growth.

Fix: heartbeat-stall watcher polls log file size every 5s. If size
doesn't grow for `--heartbeat-sec` (default 90s — single-commit cells
log steadily, so the old multi-commit 300s default is no longer
needed), SIGKILL the cell. Caught the 90+min hung cell in the v3
attempt that would otherwise have blocked the whole matrix.

### Heartbeat MUST exceed per-task timeout (FIXED 2026-04-27)

**The bug**: with `--heartbeat-sec 300` and `--timeout 360000` (inner
per-task), 3 of 9 cells in the v6 n=3 run got SIGKILLed at ~330s
(`heartbeat-stall 300s`) even though they were healthy.

**Why**: the inner bench fires N commits in parallel. When K
slow-commits simultaneously sit in a blocking LLM call (e.g. all 4
remaining OpenAI commits hitting their slowest path), the inner log
goes silent — no commit's turn returns, no progress writes. The
inner `Promise.race(withTimeout)` would eventually fire at 360s and
log `[benchmark] FAILED: Timeout after 360000ms`, but our heartbeat
killed the cell at 300s, ~60s too early.

**Fix**: when `--timeout <ms>` is forwarded to inner bench, the
wrapper now auto-bumps `heartbeatSec = max(default, ceil(ms/1000) +
60)` so the inner per-task timeout always has a chance to fire and
recover. Operator can still override with explicit `--heartbeat-sec`.

## Aggregate output format

Aggregates over ALL attempted cells — a SIGKILLed or crashed cell that
never wrote a report counts as a failure in `passed/attempted` (the
`reported/attempted` column discloses how many cells produced data;
score/time stats cover the reported subset only). `passed` is the
**runtime-probe outcome** (`[runtime-probe] … PASS`), not the aesthetic
score: probe FAIL, probe SKIP, and missing-report cells all count as
failures. The aesthetic score is informational telemetry alongside it.

```
provider | commit | reported/attempted | passed/attempted | score_mean ± std (min..max) | time_s_mean ± std (min..max) | turns_mean | probe_pass/n probe_ms_mean
claude   | kanban-board | 3/3 | 3/3 | 86.4 ±5.2 (81..91) | 28.8s ±3.4 (25.5..32.1) | 1.7 | 3/3 n/a
google   | kanban-board | 2/3 | 1/3 | 24.8 ±18.0 (5..43)  | 6.4s ±2.1 (4.5..8.5)    | 0.7 | 1/2 n/a
```

Wide std on score (>15 points) signals real variance; tight std with
low score signals systematic triad gap.

## Wrapper aggregate vs raw report JSON

The script's at-end aggregate is best-effort. For deeper analysis:

1. `<tag>-runs.json` lists every cell's report path
2. Each report is a full bench JSON at
   `oss/misc/benchmark/benchmark-results/benchmark-<id>.json`
3. Filter by timestamp window or by `<provider-tag>` in the filename
   to slice to a specific tag's data

The standalone helper `/tmp/aggregate-runs.mjs` (during sessions) does
the same shape if the wrapper is killed before its aggregate prints.
