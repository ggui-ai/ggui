# A2UI bench — v0 seed harness

Thin, protocol-level benchmark for the provisional-preview /
`_ggui:preview` path. Exercises the real deterministic emitter over
the real `ProvisionalPreview` orchestrator, intercepts every frame
with `parseServerMessage`, and reports timing + frame accounting +
parse pass/fail per intent shape.

**This is not the full preview bench.** It's the skeleton that
surfaces preview health distinct from ui-gen quality. Pair it with
the render SLO (`../slo/`) for the end-to-end picture.

---

## Scope

### 3-case seed corpus

| case               | shape     | exercises                                                    |
| ------------------ | --------- | ------------------------------------------------------------ |
| `form-feedback`    | `form`    | intent hits form-regex → emitter returns form shell          |
| `list-todos`       | `list`    | intent hits list-regex → emitter returns list shell          |
| `minimal-greeting` | `minimal` | intent matches NEITHER regex → emitter returns skeleton only |

The `minimal` case is v0's stand-in for "legitimately produces no preview or
only a minimal one." The deterministic emitter still emits 4 frames,
but the structural shell is empty — which is a meaningfully different
shape from a full form/list preview.

### Checkpoints (3 active + 1 reserved)

| field                | active? | source                                                         |
| -------------------- | ------- | -------------------------------------------------------------- |
| `startedAt`          | yes     | runner entry (always present)                                  |
| `firstFrameAt`       | yes     | `ProvisionalPreviewOutcome.first-frame.firstFrameAt`           |
| `previewFinalizedAt` | yes     | terminal outcome `finishedAt`                                  |
| `handoffGapMs`       | no      | reserved — requires hosted `finalizeProvisionalPreview` caller |

### Frame accounting

Every intercepted frame runs through `parseServerMessage` BEFORE the
transport acks it. Three counters per run:

- `frameCount` — total frames the emitter produced
- `parsePassCount` — frames that parsed cleanly
- `parseFailCount` — frames that failed to parse

**Invariant:** `frameCount === parsePassCount + parseFailCount`.

Parse-fail samples (up to 3 per run) are attached so triage doesn't
require a re-run with verbose logging.

---

## Why preview timestamps are nullable

Same discipline as the render SLO: **absence is signal**. Coalescing
null preview timestamps to any fallback (e.g., to `startedAt` or to
`finalizeObserved` moment) would hide the regression shape we exist
to catch:

- `previewExpected && !previewObserved` — the primary regression
- `finalizeObserved && firstFrameAt === null` — "emitter ran but
  never landed a frame" (rare but legitimate)

`parsePassRate` is specifically `null` when `frameCount === 0`. We
do NOT synthesize 1.0 from 0/0 — "no frames to parse" is different
from "every frame parsed."

---

## Why `handoffGapMs` is reserved, not active

`finalizeProvisionalPreview` exists (`provisional-preview.ts:662`)
and is wired through the registry seam, but **no OSS call site
invokes it today**. The hosted post-compile handoff handler is
where the call site lives — that code hasn't landed yet.

Synthesizing handoff timing by calling finalize from the bench
ourselves would fabricate a signal that says nothing about real
behavior. v0 reserves the schema slot (`handoffGapMs: null` on every
result) and waits. When the hosted handler lands, this field turns
on with zero schema migration.

---

## Why min/median/max, not p50/p95

Corpus is 3 cases × whatever n you pass. That's not enough samples
for p95 to be anything but the max with extra steps. Stats promote
to p50/p95 once the corpus is ≥15 cells with ≥10 runs each — until
then, min/median/max + `nullCount` is the honest read.

---

## What v0 does NOT measure

- **Renderer fidelity** — whether a parsed frame actually paints. v0.5
  work (requires a renderer harness).
- **Visual delta preview → final** — deferred per the "not nearly
  free" guardrail.
- **Haiku producer** — not wired yet. Deterministic is today's only
  producer.
- **Handoff gap** — see above.
- **End-to-end render timing** — that's the render SLO's job (`../slo/`).

---

## Running

```bash
pnpm --filter @ggui-ai/benchmark bench:a2ui
```

Writes a timestamped JSON under `core/src/benchmarks/a2ui/reports/`.

Optional flags (mirror the SLO entry):

- `--runs <n>` — runs per case (default 3)
- `--cases <csv>` — subset of case ids (default all)

---

## When this harness has earned width

- A real regression in the deterministic emitter / parser gets
  caught here before anyone else files it.
- Parse-fail counters move against a real code change, proving
  `parseFailCount` is load-bearing signal, not cosmetic.
- The hosted handoff handler lands → `handoffGapMs` flips on → this
  README's "reserved" caveat becomes "active."

Until then: don't widen the corpus, don't add checkpoints, don't
promote stats.
