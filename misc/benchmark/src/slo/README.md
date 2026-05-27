# `ggui_render` SLO — v0 seed harness

Thin, authoritative end-to-end benchmark for the user-facing render path.
SLO-first: measure the protocol surface users actually feel, let
per-dimension benches (A2UI, blueprint negotiation, ui-gen floors)
earn their existence by explaining movement here.

**This is not the full render bench.** It's the skeleton the dimension
benches will compose into. Do not widen it speculatively.

---

## Scope

### Branches (3 seed cases)

| path              | emitter               | simulates                                        |
| ----------------- | --------------------- | ------------------------------------------------ |
| `blueprint_hit`   | fast single-frame     | cached blueprint served near-instantly           |
| `generation_miss` | multi-frame streaming | generation loop with live preview                |
| `oss_miss`        | none wired            | OSS-only runtime with no hosted preview producer |

See `corpus.ts` for the exact configured behavior.

### Checkpoints (4 active + 1 reserved)

| field                | active in v0?           | source                                                         |
| -------------------- | ----------------------- | -------------------------------------------------------------- |
| `startedAt`          | yes                     | render-handler entry (always present)                          |
| `firstPreviewAt`     | yes                     | `ProvisionalPreviewOutcome.first-frame.firstFrameAt`           |
| `previewFinalizedAt` | yes                     | terminal outcome `finishedAt` (completed / failed / cancelled) |
| `finalCompiledAt`    | yes (see honesty below) | render-handler return clock                                    |
| `finalDomVisibleAt`  | no — reserved           | planned for v0.5 (renderer harness)                            |

---

## Why preview timestamps are nullable

**Preview absence is signal, not an error case.** At least two real
paths produce no preview frame:

1. OSS-only runtimes with no `provisionalPreview` deps wired → render
   completes successfully, no emitter ever ran.
2. Gate-skipped renders (MCP Apps path, disabled feature flag) →
   `onOutcome.skipped` fires and no frames are emitted.

If the harness coalesced null preview stamps to `finalCompiledAt`,
we'd lose the ability to distinguish "cached blueprint returned an
instant visual" from "no provisional preview ever appeared." Both
could show `timeToFirstPreview === 0ms`; only one is honest.

The downstream `SloPathSummary.previewExpectedButMissingCount` is the
regression signal: any run where the case expected a frame and the
outcome stream didn't land one is surfaced as a counted delta, not a
zero-filled latency.

---

## Why `finalInteractiveAt` is deferred

Interactivity requires driving a real React tree + polling for
handler attachment. Compared to the other four checkpoints — all
readable from wire-level events — adding it would make the SLO
harness itself the bottleneck of the bench.

Plan: land the four cheap checkpoints first, let them catch a real
regression, then add `finalInteractiveAt` in v0.5 once the reservation
placeholder is exercising muscle memory for "null is a real value."

---

## Why min/median/max, not p50/p95

With a 3-commit corpus and n=3–5 runs per case, p95 is noise. A
single cold-start outlier would swing the number 20%+ and produce
false regression alarms that drown the signal we actually care
about.

Stats discipline for v0:

- Report **min / median / max** per checkpoint, per branch path.
- Label the whole report `floorLabel: 'v0-seed'` so display-side
  formatters don't accidentally render it as an SLO dashboard.
- Promote to p50/p95 once the corpus is ≥15 cells with ≥10 runs
  each. Not before.

If you find yourself wanting "just one more commit so p95 stabilizes"
before the harness has caught a single real regression, that's the
signal the skeleton hasn't earned width yet.

---

## Honesty notes (v0 Slice A limits)

These apply to every v0 report; each is also embedded in `notes` on
the JSON so single files are self-describing.

- `finalCompiledAt` is the **handler-return clock**, not a
  post-compile clock. OSS Slice A defers per-render compilation
  (`render.ts` §24–40). Runs carry `tags.finalCompiledReliable: false`.
  When compile wiring lands in Slice B+, the flag flips and the
  stamp starts reflecting a real compile moment. **Do not treat fast
  `finalCompiledAt` as a win in v0.**
- `blueprint_hit` / `generation_miss` are **emitter-simulated**. The
  render handler doesn't yet read a blueprint-finder result on the
  component path. The SLO measurement infrastructure is in place so
  when real branch wiring lands the corpus evolves without touching
  the schema.
- `finalDomVisibleAt` is **always null** in v0. Schema reserves the
  slot; see "deferred" above.

---

## Running

```bash
pnpm --filter @ggui-ai/benchmark bench:slo
```

Writes a timestamped JSON under `core/src/benchmarks/slo/reports/`.
Run 3–5 times for median to mean anything; pipe into a comparison
tool once we have a baseline.

---

## When this harness has earned width

Two signs:

1. A real regression was caught here before any dimension bench did.
2. Null counts on `previewExpectedButMissingCount` moved against a
   code change — proving the "null as signal" convention is load-
   bearing, not cosmetic.

Until then: don't widen the corpus, don't add checkpoints, don't
promote stats.
