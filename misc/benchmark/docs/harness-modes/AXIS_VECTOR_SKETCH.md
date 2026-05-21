# Multi-Axis Architecture — Design Sketch (historical)

> **STATUS UPDATE (2026-04-13)**: Implemented in Phase 5 with modifications from
> this sketch. Canonical differences:
>
> - Axis count: final system has **8 axes** (this sketch proposed 6; final
>   adds `writeTrigger` and `tooling`).
> - Tool naming: canonical is `wiredTools` / `useWiredTool` end-to-end — not
>   the `agentTool*` names this sketch uses throughout.
> - Source of truth: `core/src/classifier/axes.ts` (code), `STATE.md` (docs).
>
> Kept for historical design rationale. Do not use this file's axis/naming
> examples as current spec.
>
> Specifically: every reference to `core/src/recipes/`, `simple.recipe.ts`,
> `RecipeFragment`, or `composeRecipe` in this sketch (notably §"Recipe
> composition" and §"File layout if we commit") is superseded by the
> realised harness module. Canonical paths/types: `core/src/harness/`,
> `core/src/harness/runtime.ts`, `HarnessFragment`, `ComposedHarness`,
> `core/src/harness/compose.ts::compose()`. See `STATE.md`.

Original header: **brainstorm / sketch**. Not implemented. Subject to iteration before commit.

Supersedes the single-label 3-mode taxonomy (display | form | collection) for
authoring-pattern classification. See `STATE.md` for current mode system.

---

## Why axes, not modes

A component's authoring pattern is **multi-dimensional**. The Uber ride
scenario illustrates: spatial render + live stream merge + multi-commit
writes + overlay layout — no single label describes it, but a vector does.

Gesture (drag/swipe) is a **trigger method**, not a mode. It's a property of
the write axis, not its own axis.

The contract was designed to express data + capability + realtime — which
maps to 4–5 of the 6 axes deterministically. Presentation axes (render,
layout) aren't in the contract, and shouldn't be — same contract can render
as list or map depending on blueprint/prompt.

---

## The 6 axes

### 1. `render` — how data is visually presented

```ts
type RenderShape =
  | "static" // single-entity detail card (weather card, product page, profile)
  | "list" // items as rows/cards (task list, inbox, forecast strip)
  | "grid" // 2D tile layout (icon grid, periodic table, image gallery)
  | "spatial" // geo/coord-driven (map, floor plan, room layout)
  | "timeline" // temporal axis (schedule, activity feed, git history)
  | "chart" // numeric → visual (line, bar, pie, candle)
  | "master-detail"; // list + adjacent detail panel (inbox + email, explorer)
```

### 2. `state` — what local state the component owns

```ts
type StateShape =
  | "none" // props → JSX, no useState
  | "ui-affordance" // filter text / selected id / active tab / quantity
  | "merge" // live entity state: useState(props.X) + useStream merge
  | "payload" // accumulating form data with validation/step
  | "draft"; // editing ONE item in-place (title editing in kanban)
```

### 3. `writes` — what write surface exists

```ts
type WriteShape =
  | "none" // read-only
  | "commit" // single small-payload action (product-page: addToCart)
  | "multi-commit" // multiple unrelated single-commits (Uber: cancel/change/contact)
  | "per-item" // entity list with per-row actions (todoist toggle)
  | "submit" // terminal form submit with assembled payload
  | "compose"; // one trigger → action whose payload references ids from
// multiple entity collections (plan-my-week: drag task → event)
```

### 3b. `writeTrigger` — orthogonal to writes

```ts
type WriteTrigger =
  | "click" // standard button
  | "drag" // drag-drop (libraries, coord tracking, visual feedback)
  | "swipe" // gesture → one of N actions
  | "keystroke" // keyboard shortcut
  | "auto"; // effect-driven (autosave, debounced)
```

`writeTrigger` is independent of `writes`. Drag can fire per-item, compose,
or commit. Same for swipe.

### 4. `realtime` — stream semantics

```ts
type RealtimeShape =
  | "none"
  | "merge" // stream payload has id → update entity by id
  | "append" // new entity added (chat new message)
  | "status" // singleton state replace (market open/closed, ride status)
  | "presence" // ephemeral per-user state (typing, cursor, online)
  | "mixed"; // multiple streams of different kinds (Uber: merge+status)

type StreamEventKind = "merge" | "append" | "status" | "presence" | "other";
```

For `mixed`, carry per-event detail:

```ts
streamKinds?: Record<string /* event name */, StreamEventKind>;
```

### 5. `fetch` — on-demand data loading

```ts
type FetchShape =
  | "none"
  | "pagination" // loadMore / nextPage (agentTool.requestSchema has cursor/offset)
  | "search" // query → results (request has `query`)
  | "drill-down" // click entity → fetch detail (request has `id`)
  | "refresh"; // pull-to-refresh / periodic poll
```

### 6. `layout` — structural composition

```ts
type LayoutShape =
  | "single" // one screen
  | "multi-step" // wizard/stepper
  | "master-detail" // list + detail panel (two-column split)
  | "overlay" // controls on top of content (Uber map with action bar)
  | "modal"; // dialog / sheet / drawer
```

---

## The vector

```ts
interface AxisVector {
  render: RenderShape;
  state: StateShape;
  writes: WriteShape;
  writeTrigger: WriteTrigger;
  realtime: RealtimeShape;
  streamKinds?: Record<string, StreamEventKind>; // present when realtime='mixed'
  fetch: FetchShape;
  layout: LayoutShape;
}

// Provenance — which signal source decided each axis (for debugging + telemetry)
interface AxisProvenance {
  render: "contract" | "blueprint" | "prompt" | "llm" | "default";
  state: "contract"; // always contract
  writes: "contract" | "blueprint" | "prompt";
  writeTrigger: "contract" | "blueprint" | "prompt" | "default";
  realtime: "contract"; // always contract
  fetch: "contract"; // always contract
  layout: "blueprint" | "prompt" | "default";
}

interface Classification {
  vector: AxisVector;
  provenance: AxisProvenance;
  confidence: number; // 0-1, weighted by how many axes used fallback/LLM
}
```

---

## The classifier — source hierarchy per axis

```ts
function classifyAxes(input: ClassifyInput): Classification {
  const { contract, prompt, blueprint } = input;
  const s = inspect(contract);  // existing signal computation

  // Contract-deterministic axes (never need fallback)
  const state = inferState(s);          // payload/merge/ui-affordance/none
  const realtime = inferRealtime(contract);
  const fetch = inferFetch(contract);

  // Mostly contract-deterministic with blueprint override for gesture
  const writes = inferWrites(s);
  const writeTrigger =
    blueprint?.mechanic === 'drag'  ? 'drag'
  : blueprint?.mechanic === 'swipe' ? 'swipe'
  : inferTriggerFromPrompt(prompt)
  ?? 'click';

  // Axes needing hierarchy
  const render =
    blueprint?.mechanic && mapMechanicToRender(blueprint.mechanic)  // authoring hint
  ?? inferRenderFromContract(contract)                              // geo-coords → spatial
  ?? inferRenderFromPrompt(prompt)                                  // "on a map"
  ?? 'static';                                                      // default

  const layout =
    blueprint?.layoutHint && mapLayoutHint(blueprint.layoutHint)
  ?? inferLayoutFromPrompt(prompt)
  ?? inferLayoutFromWrites(writes)
  ?? 'single';

  return { vector: {...}, provenance: {...}, confidence };
}
```

### Per-axis inference details

**`inferState(s)`**

```
s.hasAction && s.hasMultiFieldPayload               → 'payload'
s.hasStream && s.hasEntityList                      → 'merge'
s.hasEntityList && s.actionTargetsEntity            → 'merge'   (optimistic update)
s.hasAction && (promptMentions search|tab|filter)   → 'ui-affordance'
default                                             → 'none'
```

**`inferWrites(s)`**

```
!s.hasAction                                        → 'none'
s.hasMultiFieldPayload                              → 'submit'
s.actionCount >= 2 && payloadsSpanMultipleEntities  → 'compose'
s.actionTargetsEntity                               → 'per-item'
s.actionCount >= 2                                  → 'multi-commit'
default                                             → 'commit'
```

**`inferRealtime(contract)`**

```
for each stream.events.{name}:
  kinds[name] = inferEventKind(schema)

inferEventKind(schema):
  has id field matching arr<obj> prop stem          → 'merge'
  has enum field                                    → 'status'
  has boolean + user-id semantic                    → 'presence'
  default                                           → 'append'

distinctKinds.size === 0                            → { shape: 'none' }
distinctKinds.size === 1                            → { shape: kind }
distinctKinds.size > 1                              → { shape: 'mixed', kinds }
```

**`inferFetch(contract)`**

```
for each agentTools.tools.{name}.requestSchema.properties:
  has cursor | offset | page | before | after       → 'pagination'
  has query | q | search                            → 'search'
  has id | *Id                                      → 'drill-down'
  otherwise                                         → 'refresh'
```

**`inferRenderFromContract(contract)`**

```
any prop has {lat, lng} | {latitude, longitude}     → 'spatial'
any arr<obj> items have timestamp as primary axis   → 'timeline'
any arr<obj> items are {x: number, y: number}      → 'chart'
hasMultipleEntityLists                              → 'master-detail'
hasEntityList                                       → 'list'
has nested single-object prop (like 'product')      → 'static'
default                                             → undefined  (falls through)
```

**`inferRenderFromPrompt(prompt)`**

```
/on\s+a\s+map|location|gps/i                        → 'spatial'
/chart|graph|trend/i                                → 'chart'
/timeline|activity\s+feed|history/i                 → 'timeline'
/grid|tile\s+layout/i                               → 'grid'
/list|rows/i                                        → 'list'
default                                             → undefined
```

**`inferLayoutFromPrompt(prompt)`**

```
/multi[- ]step|wizard|step\s*\d/i                   → 'multi-step'
/overlay|on\s+top/i                                 → 'overlay'
/modal|dialog|sheet|drawer/i                        → 'modal'
/master[- ]detail|split\s+view|sidebar\s+\+/i       → 'master-detail'
default                                             → undefined
```

---

## Recipe composition — fragments, not prose

```ts
interface RecipeFragment {
  axis: keyof AxisVector;
  value: string;
  order: number; // authoring step position (1..100)
  promptText: string; // what the LLM sees (compressed, imperative)
  boilerplateMarker?: string; // optional section comment in base.tsx.tmpl
}

export function composeRecipe(v: AxisVector): RecipeFragment[] {
  return [
    ...renderFragments(v.render),
    ...stateFragments(v.state),
    ...realtimeFragments(v.realtime, v.streamKinds),
    ...writesFragments(v.writes, v.writeTrigger),
    ...fetchFragments(v.fetch),
    ...layoutFragments(v.layout),
  ].sort((a, b) => a.order - b.order);
}
```

Fragment examples:

```ts
// render=spatial (order: 10 — sets up the layout container)
{
  axis: 'render', value: 'spatial', order: 10,
  promptText: 'Render as a map using <Map>. Place <Marker> per item at props.{item}.lat/lng. Use geoBounds to fit.',
  boilerplateMarker: '  // ── Spatial: map container + markers ──',
}

// state=merge (order: 20 — defines state shape)
{
  axis: 'state', value: 'merge', order: 20,
  promptText: 'Seed state from props: `const [items, setItems] = useState(props.items)`.',
  boilerplateMarker: '  // ── Live state (seeded from props) ──',
}

// realtime=mixed (order: 30 — wires streams)
{
  axis: 'realtime', value: 'mixed', order: 30,
  promptText: 'Wire ONE useStream per event. For entity-id events merge by id; for enum-status events replace state.',
  boilerplateMarker: '  // ── Stream handlers (per-event semantics) ──',
}

// writes=multi-commit (order: 40)
{
  axis: 'writes', value: 'multi-commit', order: 40,
  promptText: 'For each ActionEntry, add useAction. Each handler invokes its action with the correct small payload.',
  boilerplateMarker: '  // ── Actions (multi-commit) ──',
}

// layout=overlay (order: 80 — affects JSX composition, late)
{
  axis: 'layout', value: 'overlay', order: 80,
  promptText: 'Position action controls absolute, layered above the content. Use z-index + pointerEvents.',
  boilerplateMarker: '  // ── Overlay controls (positioned over content) ──',
}
```

Ordering rule: setup (imports, types) → state → streams → actions → render JSX → layout polish.

---

## Axis-checks (replaces mode-checks)

Each check is gated by specific axis values. Checks run only when their gate axis value is present.

```ts
interface AxisCheck {
  id: string;
  gates: Partial<AxisVector>;  // required axis values
  check: (input: CheckInput) => EvalIssue[];
}

const CHECKS: AxisCheck[] = [
  // state
  { id: 'state.merge.seeded_from_props',
    gates: { state: 'merge' },
    check: ... },
  { id: 'state.payload.covers_submit',
    gates: { state: 'payload' },
    check: ... },
  { id: 'state.ui_affordance.no_prop_mirror',
    gates: { state: 'ui-affordance' },
    check: ... },

  // realtime
  { id: 'realtime.merge.handler_merges_by_id',
    gates: { realtime: 'merge' /* also fires if mixed and any event is merge */ },
    check: ... },
  { id: 'realtime.status.handler_replaces_singleton',
    gates: { realtime: 'status' },
    check: ... },

  // writes
  { id: 'writes.per_item.map_key_is_id',
    gates: { writes: 'per-item' },
    check: ... },
  { id: 'writes.submit.disabled_until_valid',
    gates: { writes: 'submit' },
    check: ... },
  { id: 'writes.compose.payload_references_correct_entities',
    gates: { writes: 'compose' },
    check: ... },

  // fetch
  { id: 'fetch.pagination.has_loader_trigger',
    gates: { fetch: 'pagination' },
    check: ... },
  { id: 'fetch.drill_down.opens_detail',
    gates: { fetch: 'drill-down' },
    check: ... },

  // render
  { id: 'render.spatial.uses_map_primitive',
    gates: { render: 'spatial' },
    check: ... },
  { id: 'render.list.has_stable_keys',
    gates: { render: 'list' /* and grid */ },
    check: ... },

  // layout
  { id: 'layout.multi_step.has_step_state',
    gates: { layout: 'multi-step' },
    check: ... },
];

export function runAxisChecks(v: AxisVector, input: CheckInput): EvalIssue[] {
  return CHECKS
    .filter(c => matchGates(c.gates, v))
    .flatMap(c => c.check(input));
}
```

~20 checks total. Each is small and focused on one axis value. No modes, no sub-shapes.

---

## Bypass becomes declarative

Current inlined bypass:

```ts
shape === "display" && actions === 0 && streams === 0;
```

Becomes:

```ts
v.state === "none" && v.writes === "none" && v.realtime === "none" && !modeChecks.hasBlocking;
```

Reads naturally.

---

## Verification — existing 8 commits map to vectors

| Commit         | render         | state         | writes   | trigger | realtime                | fetch         | layout     |
| -------------- | -------------- | ------------- | -------- | ------- | ----------------------- | ------------- | ---------- |
| weather-card   | static         | none          | none     | —       | none                    | none          | single     |
| periodic-table | grid           | ui-affordance | none     | click   | none                    | none          | single     |
| product-page   | static         | ui-affordance | commit   | click   | none                    | none          | single     |
| survey-form    | static         | payload       | submit   | click   | none                    | none          | multi-step |
| onboarding     | static         | payload       | submit   | click   | none                    | none          | multi-step |
| stock-ticker   | list (or grid) | merge         | none     | —       | mixed (merge+status)    | drill-down(?) | single     |
| chat-interface | list           | merge         | per-item | click   | mixed (append+presence) | pagination    | single     |
| kanban-board   | grid (columns) | merge         | per-item | drag(?) | merge                   | none          | single     |

And the Uber scenario:

| Uber ride | spatial | merge | multi-commit | click | mixed (merge+status) | drill-down | overlay |
| --------- | ------- | ----- | ------------ | ----- | -------------------- | ---------- | ------- |

Each vector tells the recipe composer exactly what to emit.

---

## Benchmark implications

**Current benchmark (8 commits) partially covers the axis space:**

- render covers: static, grid, list (and spatial via stock-ticker if we infer from symbol). Missing: **spatial (map)**, **timeline**, **chart**, **master-detail**.
- state covers: none, ui-affordance, merge, payload. Missing: **draft**.
- writes covers: none, commit, per-item, submit. Missing: **multi-commit**, **compose**.
- writeTrigger: only click. Missing: **drag**, **swipe**.
- realtime covers: none, mixed. Missing isolated: **status**, **presence** (subsumed in mixed).
- fetch: only none.
- layout: single, multi-step. Missing: **master-detail**, **overlay**, **modal**.

To benchmark the axis architecture honestly, we need 4-6 new commits:

1. **uber-ride** — spatial + merge + multi-commit + mixed realtime + overlay
2. **plan-my-week** — grid/timeline + merge + compose + drag trigger + master-detail
3. **inbox-triage** — list + merge + per-item + swipe trigger + modal
4. **place-search** — spatial + ui-affordance + none + search fetch + master-detail
5. **flight-status** — static + merge + none + mixed realtime + single (widget)
6. **activity-feed** — timeline + merge + none + append realtime + pagination + single

These cover the axis values our current 8 miss.

---

## File layout if we commit

```
core/src/classifier/
  axes.ts                 ← axis enums + AxisVector + Classification types
  inspect.ts              ← existing inspect function, carried over
  classifier.ts           ← classifyAxes()
  infer-state.ts
  infer-writes.ts
  infer-realtime.ts
  infer-fetch.ts
  infer-render.ts
  infer-layout.ts
  classifier.test.ts      ← replaces recipes/classifier.test.ts

core/src/recipes/
  fragments/
    render.ts             ← render{static,list,grid,spatial,...} fragments
    state.ts
    writes.ts
    realtime.ts
    fetch.ts
    layout.ts
    order.ts              ← step ordering rules
  compose.ts              ← composeRecipe()
  simple.recipe.ts        ← consumes composed recipe

core/src/evaluation/
  axis-checks/
    state.ts
    writes.ts
    realtime.ts
    render.ts
    fetch.ts
    layout.ts
    index.ts              ← exports CHECKS[]
  tiers.ts                ← runAxisChecks replaces runModeChecks

core/docs/axes/
  render.md               ← per-axis spec
  state.md
  writes.md
  realtime.md
  fetch.md
  layout.md
  README.md               ← overview replacing STATE.md's mode section
```

Old files that retire:

- `core/docs/harness-modes/{display,form,collection}/spec.md` — consolidated into per-axis docs
- `core/src/evaluation/mode-checks/{display,form,collection}.ts` — split into axis checks
- `core/src/harness/runtime.ts::classifyShape` — replaced by `classifier/classifier.ts`

Old work that migrates (not discarded):

- All content in display/form/collection specs maps into per-axis value-specific content
- All existing mode-checks map into axis-checks (just re-keyed)
- The pure-passive-display bypass becomes the axis-vector gate

---

## Open questions before implementation

1. **Is `writeTrigger` a real axis or a hint?** If the contract doesn't carry it and prompt/blueprint always does, is it worth treating as an axis? Alternative: drop it from AxisVector, keep as a flag on the writes fragment.

2. **Should `streamKinds` be exposed or hidden?** If `realtime=mixed`, downstream consumers need per-event detail. Exposing adds API surface. Hiding forces consumers to re-inspect.

3. **How does `writes: 'compose'` detection work rigorously?** Need `crossEntityAction` signal — "action payload has id-keys matching 2+ different arr<obj> prop names." That's deterministic. But semantic "one drag fires multiple tools" is blueprint-level (`fires: []` advisory).

4. **Migration strategy** — flag-gated cutover (both classifiers run, compare outputs) or full replace? Flag-gated is safer but doubles work for N sessions.

5. **LLM fallback scope** — do we invoke Haiku for ambiguous render/layout on every task (cached by contractHash)? Or only in Pass 3+ when we have real cross-mode benchmarks?

6. **Benchmark expansion timing** — add new commits (uber-ride, plan-week, inbox-triage) BEFORE the axis refactor or AFTER?

---

## Estimated cost

| Piece                                                            | Effort                          |
| ---------------------------------------------------------------- | ------------------------------- |
| Type definitions + classifier                                    | 1 day                           |
| Per-axis inference functions (6) + tests                         | 2 days                          |
| Recipe fragment library (6 axes × ~5 values = ~30 fragments)     | 2 days                          |
| Recipe composer + simple.recipe.ts integration                   | 1 day                           |
| Axis-check dispatcher + migration from mode-checks               | 2 days                          |
| Per-axis spec docs (6)                                           | 1 day                           |
| New benchmark commits (uber-ride, plan-week, inbox-triage, etc.) | 1-2 days                        |
| Benchmark analysis tooling (per-axis stats)                      | 0.5 day                         |
| **Total**                                                        | **~10-12 days of focused work** |

This is Pass 3 territory. Too big to land during a Pass 2 tuning session.

---

## Recommendation

1. **Commit to the multi-axis direction architecturally** (this sketch).
2. **Before refactor: expand the benchmark** with at least 3 new axis-diverse commits (uber-ride, plan-my-week, inbox-triage). Validate the current 3-mode architecture doesn't break on them (or document how it breaks).
3. **Build the classifier behind a feature flag** so the old classifier keeps running in parallel for 1 session (validation phase).
4. **Migrate mode-checks to axis-checks** once classifier outputs stabilize.
5. **Retire the mode-specs** and write per-axis specs in parallel.

Alternative: **ship Pass 2 first** (close the 30s target on current benchmark using the 3-mode architecture), then kick off multi-axis in a fresh session. Cleaner commit history, less cognitive load.

My vote: **alternative.** Pass 2 has momentum and real wins left (collection triad alignment unfired). The axis architecture deserves a clean session without the collection 30s target pressure. But the design here is ready to commit to once Pass 2 closes.
