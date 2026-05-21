# Display Mode Spec

> **HISTORICAL (pre-Phase-5)**: The 3-mode classifier (display / form / collection) was retired in Phase 5 (2026-04-13). This spec is kept as a historical reference for the authoring patterns it describes; the canonical harness is now axis-based — see `../STATE.md` and `../MODES.md`. Naming conventions in this file (e.g. `agentTools`) predate the Sprint 2 rename to `wiredTools` / `useWiredTool`.

> The authoring pattern for **props-driven UIs with optional local UI state and
> optional single commit action**. One of three modes — see `../MODES.md`.

Mode is **programmatically derived** from contract shape. Not a contract field.

---

## 1. Mode definition

**Authoring pattern:** render `props` as the source of truth, add `useState`
only for user-interaction affordances (filter text, selected id, active tab,
commit draft), and optionally wire one small-payload action to one interactive
element. No id-keyed entity merge, no multi-field payload assembly.

**Commits under this mode:**

| Commit         | Sub-shape         | Drivers                                                      |
| -------------- | ----------------- | ------------------------------------------------------------ |
| weather-card   | pure render       | props only, no actions, no streams                           |
| periodic-table | UI-state render   | `elements: arr<obj>` + filter/select affordance              |
| product-page   | UI-state + commit | `product` obj + `addToCart` action (`{productId, quantity}`) |

**NOT this mode:**

- multi-field payload assembly (→ `form`)
- id-keyed entity list merged from streams or per-item actions (→ `collection`)

---

## 2. Classifier criteria

Derived from contract shape only. See `../classifier.md` for the shared
inspector. Display matches when **both**:

```
!isCollection  // no id-keyed entity merge
!isForm        // no multi-field payload assembly
```

where:

```ts
isCollection = hasArrObjAnywhere(props) && (streams.length >= 1 || entityIdInAnyActionPayload);

isForm = !isCollection && actions.length >= 1 && anyActionPayloadHasMultipleScalarKeys; // >= 3
```

**entityIdInAnyActionPayload** = any action's example payload has a key matching
`id`/`key`/`index`/`*Id` where the stem is the singular of an `arr<obj>` prop
name (e.g., `taskId` ↔ `tasks: arr<obj>`). This is what distinguishes
product-page's `productId` (prop is `product: obj`, not `products: arr<obj>` →
doesn't count) from kanban's `taskId` (prop is `tasks: arr<obj>` → counts).

---

## 3. Authoring recipe

Seven steps. Each step references contract entities; branches are conditional
on what the contract actually declares.

> **Recipe steps are authoring order within a single generation turn, not turns.**
> In `single_pass` this all happens in one LLM turn. Step numbering is a
> cognitive scaffold, not a process-mode switch.

### Step 1 — Enumerate the contract

List what exists. Everything downstream branches on this list.

- `props.properties` (recursive): required scalars, optional scalars, nested objects, arrays
- `actions.actions`: name, tool, example payload shape, schema
- `stream.events`: names, schemas (display only sees these if the contract has them but they pass the collection gate — usually won't happen here)
- `agentTools.tools`, `clientTools.tools`: names, request/response shapes

### Step 2 — Decide local state

**Only** for user-interaction affordances. Never mirror props into state.

Branch on contract + prompt:

| Affordance    | When                                     | State shape                                                  |
| ------------- | ---------------------------------------- | ------------------------------------------------------------ | ------------ |
| Filter/search | arr prop + prompt mentions search/filter | `const [query, setQuery] = useState('')`                     |
| Selection     | arr prop + prompt mentions click/detail  | `const [selectedId, setSelectedId] = useState<string         | null>(null)` |
| Active tab    | prompt mentions tabs                     | `const [activeTab, setActiveTab] = useState('first-tab-id')` |
| Commit draft  | action present, UI collects small input  | `const [quantity, setQuantity] = useState(1)`                |

Do **not** add `useState` for fields the user doesn't modify. Derived values go
in `useMemo` or inline.

### Step 3 — Group props into render sections

Walk the prop tree, identify visual sections:

- Top-level scalars → header/summary
- Nested objects → detail sections
- Arrays → list/grid sections (mapped, no id-keyed state)

Example (product-page): `product.name/price/rating` → header; `product.description` → description tab; `product.specifications[]` → specs tab; `product.reviews[]` → reviews tab.

### Step 4 — Render using primitives only

Allowed: `<Text>`, `<Stack>`, `<Row>`, `<Grid>`, `<Card>`, `<Badge>`,
`<Button>`, `<Input>`, `<Select>`, `<Icon>`. No compositions (`Modal`,
`ChatWindow`, `DataTable`, etc.) unless the contract genuinely needs them.

Use design tokens (`var(--ggui-*)`) for colors/spacing.

### Step 5 — Inline format helpers

Currency, date, percentage formatters go inline as `const` inside the
component. Extract only if referenced 3+ times.

### Step 6 — Wire commit action (conditional)

**If** `actions.length >= 1`:

1. Hook: `const {{actionName}} = useAction<{{PayloadType}}>('{{actionName}}')` — type inferred from contract.
2. Handler: `const handleCommit = () => {{actionName}}({{payload built from local state}})`
3. Attach `handleCommit` to **exactly one** interactive element — typically a button whose label matches the action label.
4. Payload keys and types must match the action's `example` / `schema`.

### Step 7 — Self-check against the contract

Mentally verify (the automated self-check runs this in code, see §5):

- Every `required: true` prop is referenced in the render
- If action present, handler is wired to exactly one control
- Payload keys match the action's example
- No phantom `useState` (every `setX` must be called)

---

## 4. Boilerplate injection

**Current:** `SHAPE_SECTIONS` is empty string for display. Keep this for pure-render.

**Proposed (conditional, based on contract):**

```
// If hasCommitAction (actions.length >= 1), inject after WIRE_HOOKS:
  // ── Commit action ──
  // Attach {{actionName}} handler to the relevant control.
  // Payload shape: {{inferred from contract action.example}}
```

Keep minimal. No scaffolds, no prewritten UI. Just a structural cue where the
commit wiring goes. One-line comment max.

**Rationale:** Cohort 23 collection sections (4 markers) gave collection a −35%
blended win; cohort 23 form sections (similar volume) regressed Google forms
badly. Display is between these — richer than pure-render (1 affordance + 1
action) but shallow vs collection's merge/mutation story. **One-line**
conditional marker is the conservative increment, falsifiable.

---

## 5. Self-check (hybrid)

Replaces generic tier-1/2 for display. Runs after turn-1 compile.

### 5a. Deterministic (AST over generated `Component.tsx`)

| Check                             | Fail condition                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `display.prop_coverage`           | A `required: true` prop's name doesn't appear in JSX or any assignment.                                                           |
| `display.no_prop_mirror`          | `useState(props.X)` exists AND no corresponding `setX` call in the body.                                                          |
| `display.action_hook_wired`       | `actions.X` exists AND `useAction('X')` is not called.                                                                            |
| `display.action_handler_attached` | `useAction` result is assigned to a const but that const is never passed as a JSX prop (`onClick={...}`, `onChange={...}`, etc.). |
| `display.no_phantom_useState`     | `useState(...)` whose variable is never read in JSX or assignments (suggests dead state).                                         |
| `display.unused_required_prop`    | `required: true` prop declared but only referenced in destructuring, never rendered.                                              |

All deterministic; no LLM call. Fast.

### 5b. LLM semantic (one Haiku call, ~2-3s)

Prompt: "Given this contract and this generated component, answer these questions:"

1. **Action wired to correct control?** — if `actions.addToCart` exists and its label is "Add to Cart", is the `addToCart` handler attached to a button labeled "Add to Cart" (or equivalent) rather than, say, a navigation link?
2. **Payload semantics match?** — does the payload passed to the action make sense given its label/description? (e.g., `quantity` from state, not a hardcoded `1`)
3. **Rendered data matches intent?** — does the UI actually surface the data the user prompt asked for? Any required data silently omitted?
4. **UI-state usage justified?** — if local `useState` exists, is it justified by the prompt (filter/select/tab/draft)? Or is it gratuitous?

Return structured JSON: `{ wiring_correct: bool, payload_correct: bool, data_covered: bool, state_justified: bool, notes: string[] }`.

### 5c. No generic tier-1/2

When `shape = display`, the generic LLM eval (criteria.ts tier-1/2) is skipped
in favor of §5a + §5b. This is the "coherent triad" unlock — mode-specific
recipe paired with mode-specific checks, not generic categories that misfire on
passive cards (e.g., flagging `interactivity: WARN` on a card with zero actions).

---

## 6. Process

**Default:** `single_pass`.

**Fallback:** defer — decide only after the recipe + self-check are landed and
benched. Adaptive fallback would trigger on a runtime signal (turn-1 compile
fail + turn-2 no tool call, or similar), and gate on shape. Out of scope for
this spec.

---

## 7. Delta from current harness

| Axis            | Current                                                                              | Proposed                                                                         |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| System prompt   | Shared A4-lite v2 only                                                               | + display recipe addendum (compact, ~150 words)                                  |
| Boilerplate     | Empty `SHAPE_SECTIONS`                                                               | Empty for pure-render; 1-line comment for commit-action sub-shape                |
| Self-check      | Shared tier-0/1/2                                                                    | Tier-0 shared + tier-1/2 replaced by display-specific deterministic + LLM checks |
| Classifier      | `actions≥1 AND arrStr≥1 AND arrObj=0 AND promptLen>500` form-gate → display fallback | Recursive arrObj + stream presence + entityId payload scan, no promptLen         |
| Commits covered | weather-card, periodic-table, product-page, stock-ticker                             | weather-card, periodic-table, product-page (stock-ticker → collection)           |

---

## 8. Bench plan

Once §3-§5 are implemented:

- **Smoke**: n=1 on 3 display commits × 3 providers = 9 runs. Verify no crashes, inspect sources. No regression gate here.
- **Narrow**: n=3 × 3 × 3 = 27 runs. Same-session baseline first (current harness), then with display spec active. Compare:
  - weather-card avg ms (target: ≤ 15s)
  - periodic-table avg ms (canary; stay within ±15% of baseline)
  - product-page avg ms (canary; stay within ±15%)
  - pass@score≥50 overall (must not drop)
- **Decision**: ship if (a) weather-card avg drops ≥20%, (b) no canary regresses >15%, (c) blended pass@50 flat-or-up.

Falsifies: weather-card doesn't move → prompt recipe isn't the weather-card lever; something else (eval, process, tool-call count) is.
