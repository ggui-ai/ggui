# Triad Alignment Matrix — risk:high harness (2026-04-14)

> Pure analysis. No code changes. Scoped to the active risk:high path
> (kanban-board, chat-interface, stock-ticker). Column schema as agreed
> with Codex: constraint · prompt source · context source · eval source ·
> retry feedback source · duplicate/conflict count · owner layer · target
> tier.
>
> Builds the groundwork for the four step-2 refactors listed at the tail.
> Do not re-litigate specific fragment wording here — that is downstream
> of whether the alignment schema itself is sound.

---

## TL;DR

- **The P0/P1/P2 taxonomy already exists** in `core/src/evaluation/criteria.ts` (`Priority = 'P0' | 'P1' | 'P2'`). It flows into the system prompt via `buildCodingCriteriaSummary()`.
- **It does NOT flow into**: (a) HarnessFragment promptText, (b) axis-checks, (c) preflight/PATCH_INVALID retry feedback, (d) tier-0 self-check violation strings. Those five sites use four different vocabularies.
- **The fixed-point retry loop** (e.g. `ranges=47-47, 71-75, 89-89, 124-124, 168-180` firing 6× in B0-run1) is _not caused by missing rules_ — it's caused by the retry path stripping the P-tier labeling _off_ rules the model already knows from the prompt. The LLM sees `esbuild error: Unexpected "}"` and has no hook to prioritize it against its P0 obligations.
- **Three duplication clusters** over-specify `useAction/useStream/useWiredTool`. **Three missing-owner gaps** have no enforcing leg. **Two vocabularies** need flattening onto P-tiers.

---

## The Matrix

Constraints chosen because they drive retries/latency on risk:high (per B0 logs + #36/#37/#38 post-mortems). No archaeology.

| #   | Constraint                                                                | A. System prompt (runtime.ts)                                                                                              | B. Fragment promptText                                                                   | C. Boilerplate / typed scaffold                                                                     | D. Eval check                                                                                                                                                    | E. Retry feedback                                                              | Dup ×                                                                           | Owner layer                                                                                | Target tier                                                                     |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 1   | Parseable JSX / TS                                                        | runtime.ts:487 `"JSX tags must be complete pairs"`                                                                         | —                                                                                        | base.tsx.tmpl shape + `DO NOT EDIT` markers (runtime.ts:342)                                        | criteria.ts:42-52 `id:'compile'`; preflight in tools.ts:404-465                                                                                                  | tools.ts:456-464 `PATCH_INVALID: ... esbuild error: ${errText}`                | 3 (prompt + preflight + eval)                                                   | **CHECK (preflight)** — compiler is the authority                                          | **P0**                                                                          |
| 2   | Render every Props field                                                  | (implicit via criteria summary, line 469)                                                                                  | —                                                                                        | runtime.ts:340-343 auto-generated `interface Props` + `DO NOT EDIT`                                 | criteria.ts:55-61 `id:'render-props'`; axis-checks/universal.ts:18-39 runPropCoverage                                                                            | tools.ts:249-251 `[${category}] ${description}` — P-tier stripped              | 2 (criteria + axis-check)                                                       | **WHAT (types) + CHECK (prop-coverage)**                                                   | **P0**                                                                          |
| 3   | Wire every contract hook (useAction/useStream/useWiredTool/useClientTool) | runtime.ts:472-476 (3 sentences)                                                                                           | tooling.ts:21-29 (`wired`, `client` promptText) + writes.ts:32 (per-item wiring rules)   | runtime.ts:366-387 (generated hook body + inline call-signature comments)                           | criteria.ts:64-70 `id:'wire-hooks'`; tiers.ts:354-399 (4 parallel loops); tooling.ts axis-checks (×3)                                                            | tools.ts:249-251 same generic `[category]` flattening                          | **6 (!!)** prompt + 2 fragments + scaffold + criteria + tiers loop + axis-check | split 3 ways — **typed scaffold should own WHAT, axis-check owns CHECK, prompt leaves it** | **P0**                                                                          |
| 4   | Stream validity: null-guard `.latest`, merge-by-id for `state=merge`      | runtime.ts:475 `useStream('name').latest is T                                                                              | null — always null-guard`                                                                | state.ts:26-27 (merge); realtime.ts:18-19 (merge), 42-47 (mixed)                                    | state.ts:28-33 boilerplateMarker; realtime.ts:48-53 marker; runtime.ts:256-259 hook comment shows `.latest: T                                                    | null`                                                                          | criteria.ts:115-141 `id:'crash'`; realtime.ts axis-check runStreamMergesById    | `[category]` flattening                                                                    | **5** (prompt + 2 fragment prose + 2 markers + 2 axis-checks + crash criterion) | **WHAT (marker)** owns the merge pattern; **CHECK (crash + stream_merges_by_id)** enforces; remove prose from HOW | **P0 (merge) + P1 (null-guard)** |
| 5   | No hardcoded data                                                         | — (no direct prompt rule)                                                                                                  | —                                                                                        | `DO NOT EDIT Props` marker + generated interface                                                    | criteria.ts:82-89 `id:'security'` (eval/fetch/window) + `id:'functionality'` via "ALL Props fields rendered"; state-merge.ts runNoHardcodedEntities (line 39-64) | Missing — surfaces as `functionality` verdict only at eval time, not preflight | 1 (state-merge axis-check) but **ambiguous ownership**                          | **CHECK** should own; currently no P0 reinforcement at preflight                           | **P1** (non-crashing but wrong)                                                 |
| 6   | Do not edit generated `interface Props`                                   | — (relies on DO NOT EDIT comment)                                                                                          | —                                                                                        | runtime.ts:342 `// DO NOT EDIT — generated from data contract. Changing this will fail validation.` | tiers.ts (contract validation) catches signature drift                                                                                                           | Surfaces through contract validation as tier-0 fail                            | 1 (boilerplate + contract validation)                                           | **WHAT** (the marker) is the only owner — sufficient                                       | **P0**                                                                          |
| 7   | Minimal-but-complete first pass (A4-lite v2 semantics)                    | runtime.ts:469 via `buildCodingCriteriaSummary()` → `P0: Must (compile+complete), P1: Should (safety), P2: Nice (quality)` | Implicit in each fragment's scope (e.g., `writes=commit`: "one action, fire-and-forget") | —                                                                                                   | criteria.ts tier structure (P0 fail-hard, P1 fail-hard, P2 warn-only) enforces it                                                                                | Retry doesn't cite P-tier — the LLM can't tell P0-fail from P2-warn            | 2 (prompt summary + criteria definitions)                                       | **HOW** owns the wording; **CHECK** owns the tier severity                                 | **Meta — the priority taxonomy itself**                                         |

### Column-E observation (the key gap)

The `[${i.category}]` formatter at `tools.ts:251` strips the priority. What the LLM sees on a retry is:

```
[compile] Component failed to compile
  Fix: ...
[wire-hooks] useWiredTool 'updateTask' is declared but never used
  Fix: ...
```

The P-tier is gone. Both issues look equal to the model. The system prompt said "P0 first, then P1, then P2" — but the retry feedback doesn't reinforce that prioritization. **This is where fixed-point determinism comes from**: the model has no way to rank its next patch against the prompt's priority schema because the retry vocabulary doesn't name it.

---

## Vocabulary Translation Table

Four dialects collapsed onto the single P0/P1/P2 axis:

| Current dialect                                                                      | Where it lives                      | Maps to                                                             | Rename/relabel action                                        |
| ------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| `[compile] [imports] [security] [tokens] [wire-hooks] [render-props]`                | tools.ts:251 retry string formatter | P0 (compile/imports/security/wire-hooks/render-props) · P1 (tokens) | Change formatter to `[P0-compile]` / `[P1-tokens]`           |
| `severity: fail                                                                      | warn`                               | tiers.ts tier-0 checks                                              | P-tier isn't severity — fail≈P0, warn≈P1/P2 but not 1:1      | Keep severity for blocking, add explicit priority field |
| `PATCH_INVALID: ... esbuild error: ...`                                              | tools.ts:458 preflight message      | Always P0 (non-parseable = broken compile)                          | Prefix retry header `P0: candidate failed syntax preflight.` |
| `Shape Guidance` + fragment prose (e.g. `State: merge (live entity reconciliation)`) | runtime.ts:470 + fragments/\*.ts    | Mix of P0 (merge-by-id keying) and P2 (memoize derived views)       | Fragment text must tag each rule: `(P0)`, `(P1)`, `(P2)`     |

There are no new words to learn — we are unifying onto a vocabulary that already exists in the codebase (`criteria.ts:19`). This is relabeling, not redesign.

---

## Top 3 Duplication Clusters to Prune

### Cluster A — `useWiredTool` wiring (rule restated 6 times)

The same "wire every contract tool" rule appears in:

1. `runtime.ts:472-476` (system prompt: "If a contract action has a `tool` field...")
2. `runtime.ts:304-306` (generated hook body comment: `// .call(...): Promise<...>, .data: ... | null, .isPending, .error`)
3. `tooling.ts:21-22` (fragment promptText: "Each `wiredTools` entry in the contract must be wired via `useWiredTool<Input, Output>('name')`")
4. `criteria.ts:64-70` (codingGuidance + evalInstruction for `wire-hooks`)
5. `tiers.ts:376-387` (tier-0 loop over `contracts.wiredTools` doing regex match)
6. `tooling.ts::runWiredHookWired` + `runWiredHandlerAttached` (axis-checks)

**Prune decision:** the **typed scaffold (#2) + axis-check (#6)** is sufficient. The compiler catches the hook at #2 if the generic is wrong, the axis-check catches omission at #6. Drop the prose at #1 (system prompt), keep #3 (the axis-value-gated fragment) since it carries the `writes=per-item` payload-shape rule that #6 doesn't check. Criterion #4 and tier-0 loop #5 are redundant once #6 fires — delete one.

### Cluster B — Stream `merge-by-id` (rule restated 5 times)

The "merge stream events by id, never append" rule appears in:

1. `state.ts:26-27` promptText (full 5-rule block)
2. `state.ts:28-33` boilerplateMarker (`// ── Live entity state (merge-by-id) ──`)
3. `realtime.ts:18-19` promptText (realtime=merge axis)
4. `realtime.ts:48-53` boilerplateMarker (realtime=mixed axis)
5. `realtime.ts::runStreamMergesById` axis-check

**Prune decision:** Experiment #35 already tried deleting #1 — it hurt Claude even though #2/#3/#4/#5 existed. That's the **Constraint Alignment lesson**: Claude's structural reasoning depends on the HOW prose. Keep #1 (as the canonical HOW statement). Keep #5 (the CHECK). Delete #3 (`realtime=merge` axis fragment's prose is fully redundant with #1 when they co-fire on risk:high). Keep #2/#4 (markers — free, inline in scaffold).

Net: 5 → 3, with owner clearly on HOW (#1) + CHECK (#5) + WHAT markers (#2, #4).

### Cluster C — Wire-hook declared-but-unused (rule restated 4 times)

1. `criteria.ts:64-70` (`wire-hooks` criterion)
2. `tiers.ts:354-387` (4 parallel loops — one per hook type — doing the same "declared but never used" regex)
3. `tooling.ts` (3 axis-checks doing the same for wiredTools + clientTools)
4. `llm-evaluator.ts:106-108` (functionality eval prompt: "ALL useStream hooks have their .latest data rendered")

**Prune decision:** consolidate #2 into **one** generic loop (iterate all four hook kinds from contract). Remove #3's overlap with #2 (keep axis-check only for the payload-shape side: `updateTask` must carry `{id, ...}`). Remove #4's repeat (functionality criterion already covers it via the tier-1 loop). Net: 4 restatements → 2 (one tier-0 regex + one axis-check for payload shape).

---

## Top 3 Missing-Owner Gaps

### Gap #1 — "No hardcoded data" has no P0 enforcement

Currently only enforced by:

- `state-merge.ts::runNoHardcodedEntities` (axis-check, fires only on `state=merge`)
- `functionality` LLM criterion (tier 1, soft)

For commits like `chat-interface` (`state=merge` fires ✓) this is covered. For `stock-ticker` or future non-merge stateful commits, a hardcoded `const prices = [...]` passes tier-0 and only trips at the LLM eval round — wasting 10-30s of eval latency to catch something the preflight should have flagged.

**Owner proposal:** add a tier-0 AST check `has-hardcoded-entity-literals` at `evaluation/tiers.ts`, gated by `state !== 'none'`. Not axis-specific — any stateful commit.

### Gap #2 — Retry feedback owns no priority vocabulary

`tools.ts:251` emits `[${category}]`. This is the only place the LLM sees tier-0 violations between turns. It should echo the priority. Currently no owner for "tell the LLM which P-tier a violation belongs to."

**Owner proposal:** add a `priority?: Priority` field to the Tier0Issue type and the retry formatter.

### Gap #3 — Context / retry file view is uncached and unprioritized

On every retry, the LLM gets the full current-file text (uncached) + the esbuild slice (uncached). There is no abstraction for "what file context does this priority of failure need?" A P0 JSX-tag-mismatch needs wide tag-balance context. A P1 missing-hook-wiring doesn't need the file at all — just the contract excerpt.

No current leg owns `contextPolicy`. `workspace.cat()` is hardcoded at one turn-wrap site. This is the gap that Codex's `HarnessProfile.contextPolicy` abstraction fills.

**Owner proposal:** introduce `ContextPolicy` as a new fifth leg — see "Future schema" below.

---

## 2-3 Concrete First Refactors (for step 2)

These are pure renaming/relabeling + one small config change. No behavior changes, no bench gate. Each is ≤1 hour of work.

### Refactor R1 — Thread `priority` through tier-0 violations

**File:** `core/src/evaluation/tiers.ts` + `core/src/coding-agent/tools.ts`

1. Add `priority: Priority` field to `Tier0Issue` (import from `criteria.ts`). Default to the criterion's existing priority.
2. Change `tools.ts:249-251` retry formatter from:
   ```ts
   .map(i => `[${i.category}] ${i.description}\n  Fix: ${i.fix}`)
   ```
   to:
   ```ts
   .map(i => `[${i.priority}-${i.category}] ${i.description}\n  Fix: ${i.fix}`)
   ```
3. Change preflight result at `tools.ts:458` from `PATCH_INVALID: candidate failed syntax preflight` to `[P0-compile] PATCH_INVALID: candidate failed syntax preflight`.

**Expected:** zero behavior change; every retry message now cites the priority. Cheapest possible alignment move. Sets up every future ralph to iterate against shared vocabulary.

### Refactor R2 — Tag fragment promptText with P-tiers

**File:** `core/src/harness/fragments/*.ts`

For each fragment with `promptText`, prefix each rule with its P-tier. Example for `state.ts:26-27`:

```
Before:
## State: merge (live entity reconciliation)
1. Seed `const [items, setItems] = useState(props.items ?? [])`.
2. On stream updates: setItems(prev => prev.map(...)) — merge by id, do NOT append.
3. Memoize derived views (grouping/sorting/filtering) with useMemo.
...

After:
## State: merge (live entity reconciliation)
(P0) Seed `const [items, setItems] = useState(props.items ?? [])`.
(P0) On stream updates: setItems(prev => prev.map(...)) — merge by id, do NOT append.
(P2) Memoize derived views (grouping/sorting/filtering) with useMemo.
...
```

**Expected:** zero behavior change; the model's input now has consistent priority labels from prompt → fragment → retry. Sets up Cluster B pruning (#3 in Cluster B goes once it's visible every line is duplicated at P0).

### Refactor R3 — Introduce `HarnessProfile` type stub (no migration yet)

**File:** new `core/src/harness/profile.ts`

```ts
export interface HarnessProfile {
  name: string;
  promptDelta: HarnessFragment[];
  contextPolicy: {
    fileViewOnRetry: "full" | "diff-since-last" | "error-slice-only";
    includeDocs: "all" | "axis-relevant" | "none";
  };
  evalPolicy: { tiers: Priority[]; bypassScoreFloor?: number };
  retryPolicy: {
    maxTurns: number;
    onDuplicatePatch: "escalate-write" | "fail-fast" | "continue";
    feedbackTaxonomy: "esbuild-raw" | "priority-labeled";
  };
  targetFixtures: string[];
  successMetric: { deltaMs: number; deltaScore: number };
}
```

Not wired to the dispatch path yet. Purpose: document the schema so every future ralph's iteration produces a `HarnessProfile` artifact instead of a patch grab-bag. Acts as the forcing function for step 5 (resume ralphs).

**Guardrail enforced by the type:** `evalPolicy.tiers` is typed as `Priority[]` — a new harness cannot invent a new priority vocabulary. It can only select which of P0/P1/P2 to enforce.

---

## Out of Scope

Explicitly NOT part of step 1:

- Rewriting any fragment prose
- Any bench run
- Any runtime behavior change (R1/R2/R3 are label-only)
- Wiring `HarnessProfile` into dispatch
- Any axis-check addition/deletion
- The "duplicate-patch break" lever (L1 from the pre-ALIGNMENT brainstorm) — stays deferred until the vocabulary is aligned and ralph iterations can be apples-to-apples

## What step 2 should look like after this

Once R1 + R2 land:

1. Rerun the B0 baseline cohort with priority-labeled retry feedback (no other change). Expect directional improvement on fixed-point retry rate — the `ranges=47-47, ...` duplicate class should break more often because the model now sees `[P0-compile]` on every repeat and can distinguish "blocking" from "noise" violations.
2. If R1 moves the dupe-loop rate, the alignment thesis is validated. If not, the gap is elsewhere (context, not vocabulary) and we move to R3's ContextPolicy work.
3. Then prune Clusters A/B/C one at a time, each gated by same-session n=3 on risk:high.

Only after vocabulary + duplication cleanup should any ralph resume chasing specialized levers.

---

_Authored 2026-04-14 by main agent, after the ralph-loop wind-down (experiments #36-#38). Source evidence: runtime.ts, fragments/_.ts, evaluation/criteria.ts, evaluation/tiers.ts, coding-agent/tools.ts, and axis-checks registry — traced by a scoped Explore pass, no archaeology.\*
