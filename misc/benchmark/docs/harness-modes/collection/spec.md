# Collection Mode Spec

> **HISTORICAL (pre-Phase-5)**: The 3-mode classifier (display / form / collection) was retired in Phase 5 (2026-04-13). This spec is kept as a historical reference for the authoring patterns it describes; the canonical harness is now axis-based — see `../STATE.md` and `../MODES.md`. Naming conventions in this file (e.g. `agentTools`) predate the Sprint 2 rename to `wiredTools` / `useWiredTool`.

> The authoring pattern for **id-keyed entity state with merge**. One of three
> modes — see `../MODES.md`.

Mode is **programmatically derived** from contract shape. Not a contract field.

Primary target: **chat-interface + kanban-board avg ≤ 30s.**

---

## 1. Mode definition

**Authoring pattern:** seed live state from `props.items[]` (an `arr<obj>` with
an `id`), merge updates from `stream.events` and/or local mutations from
`ActionEntry` dispatches, render per-item UI with stable keys, and dispatch
per-item actions whose payloads reference the entity id.

**Commits under this mode:**

| Commit         | Sub-shape       | Drivers                                                                 |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| stock-ticker   | passive merge   | `stocks: arr<obj>` + `stream.priceUpdate`/`marketStatus`; no actions    |
| chat-interface | both            | `messages: arr<obj>` + `stream.message`/`typing` + `sendMessage` action |
| kanban-board   | active mutation | `tasks: arr<obj>` + `taskUpdate` action with `taskId`; optional stream  |

**NOT this mode:**

- props-driven render without entity merge (→ `display`)
- multi-field payload assembly with terminal submit (→ `form`)

---

## 2. Classifier criteria

```
isCollection = hasArrObjAnywhere(props) &&
               (streams.length >= 1 || entityIdInAnyActionPayload)
```

where `entityIdInAnyActionPayload` = action payload has a key like `id` /
`key` / `index` / `*Id` whose stem matches the singular of an `arr<obj>` prop
name (`taskId` ↔ `tasks`).

**Verified reclassification** (vs. current):

- `stock-ticker`: now collection (was display). `stocks: arr<obj>` + 2 streams.
- `chat-interface`: unchanged. `messages` + streams + `sendMessage`.
- `kanban-board`: unchanged. `tasks` + `taskUpdate{taskId,...}`.

---

## 3. Authoring recipe

Nine steps. Branches conditional on what the contract declares.

> **Recipe steps are authoring order within a single generation turn, not turns.**
> In `single_pass` this all happens in one LLM turn. Step numbering is a
> cognitive scaffold ("identify entities → seed state → merge → derive → wire
> → render → self-check"), not a process-mode switch. Only if adaptive staged
> fallback later triggers do these split across turns.

### Step 1 — Enumerate the contract

- `props.properties`: identify the **entity collection(s)** — the `arr<obj>` whose items have an `id` (or stable key). Note supporting props (columns for kanban, currentUser for chat, etc.).
- `actions.actions`: each is an `ActionEntry`. Note its `tool` (this is the `wiredTool`), its example payload, and whether the payload references an entity id.
- `stream.events`: name + schema per event. Note which events touch entities.
- `sourceTools` (when available via contract context): tools that produced `props.items[]`. Affects later refresh/reload semantics — for now, knowing the source is a self-check hint only.
- `wiredTools`: exposed as `ActionEntry.tool` per action — already captured by the ActionEntry scan.
- `agentTools.tools` / `clientTools.tools`: on-demand fetch or state-introspection. Usually not on the critical render path; wire only if the prompt requires.

### Step 2 — Name the entity model

For each entity collection:

- **Collection name**: e.g., `tasks`, `messages`, `stocks`.
- **Entity id field**: the stable key (`id`, `symbol`, etc.).
- **Identity function**: `(item) => item.id` — used by every merge step.

### Step 3 — Seed live state

For each entity collection:

```ts
const [items, setItems] = useState<Props["items"]>(props.items);
```

Do **not** use `useMemo(() => props.items)` — state is the merge target. Do
**not** mirror non-entity props into state (e.g., `columns` stays from props).

### Step 4 — Stream merge (if `stream.events` exists)

For each stream event that touches entities:

- Determine the merge semantics from the event schema:
  - **Upsert by id**: event payload is a full entity → replace-or-append.
  - **Patch by id**: event payload is a partial with id → spread-update.
  - **Append**: event payload is a new entity (chat new message) → push.
  - **Delete by id**: event payload has `{id, deleted: true}` or similar → filter-out.

Example merge handler:

```ts
useStream("priceUpdate", (update) => {
  setItems((prev) => prev.map((it) => (it.symbol === update.symbol ? { ...it, ...update } : it)));
});
```

One handler per event name. No mixed handlers.

### Step 5 — Action dispatch (if `actions.actions` contains entity-id payloads)

For each entity-mutating `ActionEntry`:

1. Hook: `const {{actionName}} = useAction<{{PayloadType}}>('{{actionName}}')`.
2. The payload must carry the entity id matching the ActionEntry's `example`.
3. Optimistic local update + dispatch:

```ts
const moveTask = useAction<MoveTaskPayload>("taskUpdate");
const handleMove = (taskId: string, column: string) => {
  setItems((prev) => prev.map((t) => (t.id === taskId ? { ...t, column } : t)));
  moveTask({ action: "move", taskId, data: { column } });
};
```

**Payload shape must match `ActionEntry.schema` and `.example` exactly.** Keys,
types, nesting. The `tool` field (wiredTool) is what the agent dispatches —
the LLM doesn't need to include it in the payload unless the ActionEntry
schema requires it.

### Step 6 — Derived views

Groupings, filters, sorts. Always `useMemo`, never inline recomputation.

```ts
const itemsByColumn = useMemo(() => groupBy(items, "column"), [items]);
const filtered = useMemo(
  () => (query ? items.filter((m) => m.text.includes(query)) : items),
  [items, query]
);
```

Common derivations per sub-shape:

- **kanban**: `itemsByColumn`, `totalCount`, `completedCount`
- **chat**: grouped-by-sender-runs, formatted timestamps
- **stock-ticker**: sorted by symbol, formatted price/change

### Step 7 — Per-item render helper (conditional)

**Extract per-item JSX into a local `renderItem` function when** the per-item
UI is repeated and large or nested: ≥ ~30 lines of JSX, or 3+ primitives with
conditional logic, or multiple interactive controls per item.

**Skip the extraction** when per-item UI is small (1-2 primitives, no
conditionals). Passive-merge sub-shapes (e.g., stock-ticker) typically render
a flat card per entity and do not need extraction — forcing it adds
indirection without shortening the return body meaningfully.

Example (kanban task — extracted):

```ts
const renderTask = (task: Task) => (
  <Card key={task.id} padding="var(--ggui-spacing-3)">
    <Row justify="space-between">
      <Text variant="bodyMedium">{task.title}</Text>
      <Badge variant={priorityVariant(task.priority)}>{task.priority}</Badge>
    </Row>
  </Card>
);
```

**Rationale:** keeps the main return body short on the sub-shapes that need
it; reduces JSX nesting depth for patch operations on later turns (the
dominant cause of OpenAI kanban's 8-turn patch saturation per cohort-24
analysis). No benefit — and potentially harmful indirection — for light
per-item cases.

### Step 8 — Compose the layout

Use derived views and `renderItem` to build the page. Stable keys on every
mapped element: `key={item.id}`.

### Step 9 — Self-check against the contract

Mentally verify (the automated self-check in §5 does this in code):

- Every entity collection has `useState` seeded from props
- Every stream event has a handler that merges by id
- Every entity-mutating action has `useAction` and a wired handler
- Every `.map()` over entities uses `key={item.id}` (or the declared id field)
- Every `ActionEntry.tool` (wiredTool) is reachable from some interactive element
- Payload shapes match `ActionEntry.example`

---

## 4. Boilerplate injection

Collection currently has 4 section markers (`SHAPE_SECTIONS` in `simple.recipe.ts`). Cohort 23 n=3 showed collection −34.7% blended with sections; Google kanban 140s → 31s — the largest single mode-level win. **Keep.**

Proposed refinement — contract-derived marker content (not prewritten code):

```
  // ── Collection state ──
  // Seed from props. Entity: {{entityName}} keyed by {{idField}}.

  // ── Stream merge ──
  // {{for each stream event}}: handler merges by {{idField}} ({upsert|patch|append|delete}).

  // ── Action dispatch ──
  // {{for each entity action}}: optimistic local update + useAction('{{name}}') dispatch.

  // ── Derived views ──
  // Groupings / filters / sorts via useMemo. No inline recomputation.

  // ── Per-item render ──
  // Extract renderItem(item) if per-item JSX is non-trivial.
```

Five markers instead of four. The new `Per-item render` marker is the
OpenAI-kanban latency lever — explicit structural cue to extract, not inline.

**Safety check:** the current 4 markers shipped; adding a 5th minimal marker
should not regress (similar volume to cohort 23). If smoke bench shows
regression, drop the 5th and keep 4.

---

## 5. Self-check (hybrid)

Replaces generic tier-1/2 for collection. Runs after turn-1 compile.

> **All checks reference contract-normalized semantics, not variable names.**
> Entity collection name, id field, stream event name, action name, and
> ActionEntry payload shape come from the contract. Checks must not depend on
> the LLM naming a variable `tasks` vs `items` vs `taskList`. What matters is
> _what_ the code does (initializer reads `props.{entityProp}`, `.map()` uses
> `item.{idField}` as key, payload keys match `ActionEntry.schema`), not how
> anything is named.

### 5a. Deterministic (AST over generated `Component.tsx`)

| Check                                      | Fail condition                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `collection.state_seeded_from_props`       | No `useState` whose initializer reads `props.{entityProp}` for each entity collection.                |
| `collection.stream_handler_per_event`      | `stream.events.X` exists AND no `useStream('X', ...)` call.                                           |
| `collection.stream_merges_by_id`           | Inside each `useStream` handler body, no reference to the entity id field (merge is probably broken). |
| `collection.action_hook_per_entity_action` | For each ActionEntry with entity-id payload, no `useAction('X')` call.                                |
| `collection.action_handler_wired`          | `useAction` result assigned to a const that's never passed as a JSX prop.                             |
| `collection.map_key_is_id`                 | `.map()` over entities uses `key={index}` or no key — must be `key={item.{idField}}`.                 |
| `collection.no_hardcoded_entities`         | Array literals (`[{id:'1',...},{id:'2',...}]`) in the render body (should come from state).           |
| `collection.derived_view_memoized`         | Expensive derivations (filter/groupBy/sort over entities) inside render body, not in `useMemo`.       |

All deterministic; no LLM call. Fast (< 100ms).

### 5b. LLM semantic (one Haiku call, ~2-3s)

Prompt includes: the contract, the generated component, the entity names and id fields.

Questions:

1. **Stream merge semantics correct?** — for each stream event, does the handler perform the right merge (upsert/patch/append/delete) based on the event schema?
2. **Payload matches ActionEntry?** — for each `useAction` call site, does the payload include all required keys from `ActionEntry.schema` with correct types?
3. **wiredTool reachability** — is every `ActionEntry.tool` reachable from a user-visible interactive element in the render? (E.g., `todoist_update_task` needs a button/drag/control somewhere.)
4. **sourceTool semantics** — if `sourceTools` is declared, does the rendered UI reflect that data accurately? (No invented fields, no dropped required fields from the source schema.)
5. **Interactive controls named correctly?** — does the UI label interactive elements in line with their action's `label`? ("Move" button for `taskUpdate` with `action: 'move'`.)

Return: `{ merge_correct: bool, payload_correct: bool, wiredTools_reachable: bool, source_reflected: bool, labels_correct: bool, notes: string[] }`.

### 5c. Sub-shape filtering

The deterministic and LLM checks are gated by what the contract declares:

- **passive merge (no actions)**: skip action-related checks (`action_hook_*`, `payload_matches`, `wiredTools_reachable`).
- **active mutation (no streams)**: skip stream-related checks (`stream_handler_per_event`, `stream_merges_by_id`, `merge_correct`).
- **both**: run everything.

No generic tier-1/2 runs when `shape = collection`.

---

## 6. Process

**Default:** `single_pass`.

**Known failure mode** (cohort-24 evidence): OpenAI kanban saturates at 8
turns with stacked PATCH_INVALIDs on 200+ line JSX. The **Step 7 renderItem
extraction** in the recipe and the new boilerplate marker target this
directly. If that doesn't suffice, adaptive staged fallback becomes the next
lever — trigger signal candidates:

- turn-3+ outcome is `PATCH_INVALID` AND prev-turn `compiled ≥ 500B`
- any turn's generated source exceeds ~200 lines without `renderItem` extraction

**Deferred.** Implement + bench the recipe + self-check first; decide process
fallback based on the observed slow tail afterward.

---

## 7. Delta from current harness

| Axis            | Current                                                         | Proposed                                                                                            |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| System prompt   | Shared A4-lite v2 only                                          | + collection recipe addendum (compressed 7-9 numbered imperatives; same nouns as spec + self-check) |
| Boilerplate     | 4 section markers (generic)                                     | 5 contract-derived markers (add `Per-item render`)                                                  |
| Self-check      | Shared tier-0/1/2                                               | Tier-0 shared + tier-1/2 replaced by collection-specific deterministic + LLM checks                 |
| Classifier      | `actions≥1 AND (arrObj≥1 OR streams≥2)` — excludes stock-ticker | Pure shape: `hasArrObjAnywhere AND (streams≥1 OR entityIdInPayload)` — includes stock-ticker        |
| Commits covered | kanban, chat                                                    | stock-ticker, kanban, chat                                                                          |

---

## 8. Bench plan

Once §3-§5 are implemented:

- **Smoke**: n=1 on 3 collection commits × 3 providers = 9 runs. Inspect sources. **stock-ticker is the primary falsification target** — if the collection recipe helps kanban/chat but regresses stock-ticker, the recipe is biased toward active-mutation and must generalize.
- **Narrow**: n=3 × 3 × 3 = 27 runs. **Same-session baseline** (current collection harness) first, then with spec active. Compare:
  - kanban-board avg ms (target: ≤ 30s; current 60-90s)
  - chat-interface avg ms (target: ≤ 30s)
  - **stock-ticker avg ms (canary — hard gate, no regression tolerated beyond ±20% vs its cohort-24 display baseline; moves modes this cohort)**
  - pass@score≥50 overall (must not drop)
  - OpenAI kanban avg turns (target: ≤ 5; current 7-8)
- **Decision**: ship if (a) kanban/chat avg drops ≥25%, (b) stock-ticker doesn't regress >20%, (c) OpenAI kanban turns drop ≥2, (d) blended pass@50 flat-or-up.

Falsifies if: kanban avg doesn't move → recipe/self-check is the wrong lever, process fallback is the next thing to try. **OR if stock-ticker regresses → recipe is too active-mutation-biased; recipe needs to generalize before shipping.**
