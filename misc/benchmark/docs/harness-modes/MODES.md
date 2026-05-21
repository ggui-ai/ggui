# Axis-Slice Manifest (2026-04-13)

> The 3-mode manifest (display / form / collection) is retired. This file
> now catalogs the **axis slices** that harness-engineering sessions iterate
> on. A slice is a set of fixtures grouped by a shared axis value or risk
> tier.

Sub-agents and the main agent consult this for slice definitions, commit
membership, current target, and active harness settings. Changes here must
be mirrored in `packages/ui-gen/src/classifier/classifier.ts` + the fragment registry
in `packages/ui-gen/src/fragments/`.

## How to pick a slice

Three valid slice specs:

1. `slice=risk:<tier>` — `low` / `medium` / `high`
2. `slice=axis:<key>=<value>` — e.g., `state=merge`, `writes=submit`, `writeTrigger=drag`, `tooling=wired`, `tooling!=none`
3. `slice=commits:<csv>` — explicit fixture list

Pick the smallest slice that isolates the signal you're chasing. One slice
per sub-agent invocation.

---

## Risk-tier slices

### `risk:low`

- **Definition:** Passive props-driven UI. No writes, no streams, minimal/no local state. Bypassed past eval tier 1+2 by `Classification.riskTier === "low"`.
- **Commits:** `weather-card`, `periodic-table`
- **Target:** weather-card avg **≤ 15s**; `risk:low` bypass must have 0 false positives on medium/high slices.
- **Active harness settings:**
  - Fragments: `render=static` / `render=grid` (low-risk paths), all empty `promptText` — stable prefix only.
  - Axis-checks: universal only (prop_coverage, no_prop_mirror, no_phantom_useState).
  - Process: `single_pass`.

### `risk:medium`

- **Definition:** Single write path. `writes ∈ {commit, submit}`, no stream merge, no multi-step unless submit-flow.
- **Commits:** `product-page`, `survey-form`, `onboarding-wizard`
- **Target:** avg ≤ 30s across providers (primary); score ≥ 75 (secondary). Forms: stabilize first, optimize after.
- **Active harness settings:**
  - Fragments: `state=payload`, `state=draft`, `writes=submit`, `writes=commit`, `layout=multi-step` where applicable.
  - Axis-checks: universal + state-payload gates (hook_present, handler_attached, covers_submit) + writes gate (action_hook_wired, submit_disabled_path).
  - Extras: `layout=multi-step → state_present`.
  - Process: `single_pass`.

### `risk:high`

- **Definition:** Stream + write interaction, stateful merges, or gesture triggers. This is where latency budgets blow up.
- **Commits:** `kanban-board`, `chat-interface`, `stock-ticker`, `plan-my-week`, `inbox-triage`
- **Target:** avg **≤ 30s** across providers (aggressive). Currently 50–75s range — primary iteration target.
- **Active harness settings:**
  - Fragments: `state=merge` (boilerplateMarker), `realtime=mixed` (boilerplateMarker), `writeTrigger=drag` (boilerplateMarker), `writes=per-item`, `writes=compose`.
  - Axis-checks: universal + state-merge gates (seeded_from_props, no_hardcoded_entities, derived_view_memoized, map_key_is_id) + realtime gates (stream_handler_per_event, stream_merges_by_id) + writes gates.
  - Extras: `writeTrigger=drag → handlers_wired` (fail), `writeTrigger=swipe → handlers_wired` (fail), `writes=compose → cross_entity_ids` (warn), `realtime=mixed → handlers_per_event` (fail).
  - Process: `single_pass`. `staged` candidate for this tier under adaptive fallback (future).

---

## Axis slices (common ones)

### `axis:state=merge`

- **Commits:** `kanban-board`, `chat-interface`, `stock-ticker`, `plan-my-week`
- **Key fragments:** `state=merge` (prompt: "seed from props, merge by id"; marker: `── Live entity state (merge-by-id) ──`)
- **Key axis-checks:** `state.merge.*` — seeded_from_props, no_hardcoded_entities, derived_view_memoized.
- **Open questions:** Does the `merge-by-id` boilerplate marker meaningfully reduce turn count vs. prompt-only guidance on Google/OpenAI?

### `axis:writes=submit`

- **Commits:** `survey-form`, `onboarding-wizard`
- **Key fragments:** `writes=submit`, `state=payload`, `layout=multi-step`.
- **Key axis-checks:** `writes.submit.*`, `state.payload.*`, `layout.multi_step.state_present`.
- **Open questions:** Claude cohort 24 saw −23% on forms after dropping form-specific sections; does that hold post-Phase-5? Google transport failures — adaptive staged fallback candidate.

### `axis:writeTrigger=drag`

- **Commits:** `plan-my-week`
- **Key fragments:** `writeTrigger=drag` (boilerplateMarker: `── Drag state ──`).
- **Key extras:** `writeTrigger.drag.handlers_wired`.
- **Open questions:** Is the drag marker load-bearing, or can prompt-only guidance suffice?

### `axis:writeTrigger=swipe`

- **Commits:** `inbox-triage`
- **Key extras:** `writeTrigger.swipe.handlers_wired`.

### `axis:realtime=mixed`

- **Commits:** `chat-interface`, `stock-ticker`
- **Key fragments:** `realtime=mixed` (marker: `── Mixed stream handlers ──`).
- **Key extras:** `realtime.mixed.handlers_per_event`, `realtime.stream_handler_per_event`.

### `axis:writes=compose`

- **Commits:** `plan-my-week` (cross-entity composition)
- **Key extras:** `writes.compose.cross_entity_ids` (warn).

### `axis:layout=multi-step`

- **Commits:** `survey-form`, `onboarding-wizard`
- **Key extras:** `layout.multi_step.state_present`.

---

## Fixture-only (not yet in bench commits)

These live in `internal/benchmarks/src/multi-sdk/fixtures/` for classifier
snapshot tests and compose tests, but are not yet part of the
`commits.ts` bench matrix:

- `activity-feed`, `flight-status`, `place-search`, `uber-ride`

Promoting a fixture into the bench matrix requires adding it to
`internal/benchmarks/src/multi-sdk/commits.ts` with full contract + sample
props + expectedMinScore, then re-running classifier snapshot tests
(`pnpm --filter @ggui-ai/ui-gen test src/classifier/` once the snapshot
is restored — see STATE.md "missing classifier snapshot" note).

---

## Locked constraints (axis-era)

- No per-mode boilerplate sections. Boilerplate surface is the fragment
  registry's `boilerplateMarker` set, keyed on axis+value.
- No provider-specific fragments. `cacheTier` governs cache reuse, not
  provider.
- No fragments outside the 8 axes listed in
  `packages/ui-gen/src/classifier/axes.ts` without first extending the AxisVector.
- No fragment may have `boilerplateMarker` without a corresponding
  `base.tsx.tmpl` injection point (or the marker is dead weight).

## Evolution policy

- **Adding a fragment:** must name axis+value, cache tier, and rationale
  against cohort deltas. Follow the `benchmark-runner` skill Step 4.
- **Adding an axis value:** update `packages/ui-gen/src/classifier/axes.ts` + the
  classifier snapshot + this manifest in one PR.
- **Retiring a fragment:** require bench evidence that no commit depends
  on it. Same-session control required for any Google signal.
