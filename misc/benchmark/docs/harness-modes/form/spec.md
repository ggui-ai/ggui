# Form Mode Spec

> **HISTORICAL (pre-Phase-5)**: The 3-mode classifier (display / form / collection) was retired in Phase 5 (2026-04-13). This spec is kept as a historical reference for the authoring patterns it describes; the canonical harness is now axis-based — see `../STATE.md` and `../MODES.md`. Naming conventions in this file (e.g. `agentTools`) predate the Sprint 2 rename to `wiredTools` / `useWiredTool`.

> The authoring pattern for **multi-field payload assembly with terminal
> submit**. One of three modes — see `../MODES.md`.

Mode is **programmatically derived** from contract shape. Not a contract field.

Current target: **stabilize first** (no worse than cohort-13 baseline on
Claude/OpenAI; Google transport errors acceptable pending adaptive fallback).
Optimize only after stability is earned.

---

## 1. Mode definition

**Authoring pattern:** accumulate field values across the UI, validate per
field, navigate steps (if multi-step), assemble a multi-key payload, and
dispatch a single terminal `ActionEntry`. State machine over field values +
step index + validation errors.

**Commits under this mode:**

| Commit            | Sub-shape         | Drivers                                                                                                              |
| ----------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| survey-form       | multi-step wizard | 4 steps (text → radios → checkboxes → textarea), `submit` action with 5-key payload                                  |
| onboarding-wizard | multi-step wizard | 3 steps (profile → prefs → review), `complete` action with 6-key payload, optional `initialProfile` prop for editing |

**NOT this mode:**

- props-driven render without payload assembly (→ `display`)
- id-keyed entity state with merge (→ `collection`)
- single small-payload action on a detail view (→ `display` with commit branch)

---

## 2. Classifier criteria

```
isForm = !isCollection &&
         actions.length >= 1 &&
         anyActionPayloadHasMultipleScalarKeys  // >= 3 distinct scalar keys
```

where:

- `anyActionPayloadHasMultipleScalarKeys` = at least one `ActionEntry.example`
  has ≥ 3 top-level scalar keys (strings, numbers, booleans, enums).
  Single-level-nested objects count their top-level shape; deeply nested
  objects (like kanban's `{action, taskId, data: {...}}`) do not, because
  those indicate entity mutations.

**Verified against current commits:**

- `survey-form`: example `{name, email, satisfaction, features, comments}` — 5 scalar keys (+ 1 array). Not a collection (no arr<obj>). **→ form.**
- `onboarding-wizard`: example `{name, email, avatar, role, emailNotifications, theme}` — 6 scalar keys. **→ form.**
- `product-page`: example `{productId, quantity}` — 2 keys. **→ display** (falls through; not enough payload to be a form).
- `kanban-board`: example `{action, taskId, data: {...}}` — entity-mutation shape, caught earlier by `isCollection`. **→ collection.**

---

## 3. Authoring recipe

Nine steps. Branches conditional on what the contract declares.

> **Recipe steps are authoring order within a single generation turn, not turns.**
> In `single_pass` this all happens in one LLM turn. Step numbering is a
> cognitive scaffold, not a process-mode switch.

### Step 1 — Enumerate the contract

- `props.properties`: identify option lists (`arr<str>` → radios/checkboxes/dropdowns), initial-values objects (preload edit state), and any supporting props (labels, limits).
- `actions.actions`: find the **terminal submit** `ActionEntry` — the one whose payload is the assembled form data. Note its `label` (submit button text), `example` (payload shape), `schema` (validation contract), and `tool` (wiredTool endpoint).
- `stream.events`: rare for forms; usually none. If present, often status signals (e.g., server-side validation) — wire only if the prompt requires.
- `sourceTools`: relevant only if the form edits existing data (an initial-values object in props came from a tool). Drives the initial state seeding step.
- `wiredTools`: the submit `ActionEntry.tool` — the endpoint that receives the payload.

### Step 2 — Derive the submit payload schema

The assembled payload IS the state shape. Extract from `ActionEntry.schema`
(preferred) or `ActionEntry.example` (fallback). Every key in the payload
must have a corresponding field in the UI.

Example (onboarding-wizard):

```
Submit payload: { name, email, avatar, role, emailNotifications, theme }
→ 6 fields to collect across the UI
```

This derivation anchors everything downstream. Fields missing from the payload
shape should not have UI affordances. Fields in the payload shape that lack a
UI affordance are a bug.

### Step 3 — Design field state

One `useState` per field **or** one `useState<FormState>` holding the whole
payload. Pick the shape that keeps update code simplest — whole-object state
is usually cleaner for 4+ fields.

Seed from `props.initial{X}` if provided (e.g., `initialProfile`). If absent,
use schema-appropriate defaults (empty string, 0, false, first option).

```ts
const [form, setForm] = useState<FormState>({
  name: props.initialProfile?.name ?? "",
  email: props.initialProfile?.email ?? "",
  // ... every payload key
});
```

Never omit a payload key from state — even optional ones need a slot.

### Step 4 — Decide step navigation (if multi-step)

If the prompt describes multiple steps:

```ts
const [step, setStep] = useState(0);
const totalSteps = 3; // inferred from prompt structure
```

If single-step (no step indicator mentioned), skip step state entirely.

### Step 5 — Validation rules + error state

Per-field validation derived from the prompt and `ActionEntry.schema`:

- `required: true` → non-empty check
- `type: 'string'` + format hint (email, url) → format regex
- `enum: [...]` → membership check
- Length limits (from prompt or schema) → length check

```ts
const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});

const validateStep = (s: number): boolean => {
  const errs: typeof errors = {};
  if (s === 0) {
    if (!form.name) errs.name = "Name is required";
    if (!/\S+@\S+\.\S+/.test(form.email)) errs.email = "Valid email required";
  }
  // ... per step
  setErrors(errs);
  return Object.keys(errs).length === 0;
};
```

### Step 6 — Submit handler

```ts
const submit = useAction<SubmitPayload>("submit");
const handleSubmit = () => {
  if (!validateAll()) return;
  submit(form); // payload shape matches ActionEntry exactly
};
```

**Payload shape must match `ActionEntry.schema` and `.example`.** This is the
non-negotiable. Omitting a key, adding an extra key, or typing a value wrong
breaks the form.

### Step 7 — Render step-by-step UI

Per step:

- Step indicator (progress bar or "Step N of M" text) — if multi-step
- Fields for this step's subset of the payload
- Inline error messages below each field
- Navigation: Back (disabled on step 0), Next / Submit (disabled until step valid)

Final step for multi-step wizards typically shows a **review** — read-only
summary of every collected field before submit.

### Step 8 — Wire navigation + validation

- `Next` button: `() => validateStep(step) && setStep(step + 1)`
- `Back` button: `() => setStep(step - 1)`
- `Submit` button: `handleSubmit()` (only on final step)
- Disable Next/Submit when current step's required fields are invalid

### Step 9 — Self-check against the contract

Mentally verify:

- Every key in `ActionEntry.example` has a UI field
- Every field has a validation rule if `schema` or prompt says so
- Submit handler builds payload with every required key
- Payload shape exactly matches the ActionEntry
- `wiredTool` (ActionEntry.tool) is reachable via the submit button

---

## 4. Boilerplate injection

**`SHAPE_SECTIONS` stays empty for form.**

Cohort 23 n=3 showed form-specific section markers regressed Google badly
(survey-form 64→160s, onboarding 61→109s) — and did not help Claude/OpenAI.
Forms describe a well-known pattern; marker comments add token volume without
information.

The recipe + contract-derived self-check carry the mode-specific load for
forms. Boilerplate stays minimal. If the recipe+self-check still underperforms
after benching, revisit boilerplate — but only with contract-derived marker
content, never with generic comment scaffolding.

---

## 5. Self-check (hybrid)

Replaces generic tier-1/2 for form. Runs after turn-1 compile.

> **All checks reference contract-normalized semantics, not variable names.**
> ActionEntry payload shape, schema constraints, and prop-derived option lists
> come from the contract. Checks must not depend on the LLM naming state
> `form` vs `values` vs `data`. What matters is _what_ the code does
> (`useState` initializer covers every payload key, submit call passes a value
> matching `ActionEntry.schema`), not how anything is named.

### 5a. Deterministic (AST over generated `Component.tsx`)

| Check                          | Fail condition                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `form.submit_hook_present`     | `ActionEntry` exists AND no `useAction('{{actionName}}')` call.                                                     |
| `form.submit_handler_attached` | `useAction` result assigned to a const but never passed as a JSX `onClick` / `onSubmit` prop.                       |
| `form.state_covers_payload`    | Union of `useState` initializer keys (across all state vars) does not include every key from `ActionEntry.example`. |
| `form.initial_values_seeded`   | `props.initial{X}` (object prop) exists AND no `useState` initializer reads from it.                                |
| `form.option_lists_consumed`   | `arr<str>` props (option lists) declared AND not mapped over in JSX (should drive radio/select/checkbox options).   |
| `form.step_nav_state_present`  | Prompt implies multi-step AND no integer-typed `useState` tracking step.                                            |
| `form.submit_disabled_path`    | Submit button has no conditional `disabled` expression (suggests no validation gate).                               |
| `form.no_orphan_payload_key`   | Payload keys in `ActionEntry.example` that never appear as state-reads or state-writes in the body.                 |

### 5b. LLM semantic (one Haiku call, ~2-3s)

Prompt includes: the contract (ActionEntry + props), the generated component,
the derived payload shape.

Questions:

1. **Payload coverage** — does the value passed to the submit `useAction` call include every required key from `ActionEntry.schema` with correct types and enum values?
2. **Validation correctness** — does the form's validation match the contract constraints (required fields, format, enum, length)? Does the prompt's stated validation appear in the code?
3. **Step coherence** — if multi-step, does the step structure match the prompt? Are fields assigned to the step the prompt puts them in? Is there a review/summary step if the prompt asks for one?
4. **wiredTool reachability** — is `ActionEntry.tool` reachable via a user-visible submit button, and is the submit button labeled to match `ActionEntry.label`?
5. **Initial values** — if `props.initial{X}` exists, are those values visibly reflected as pre-filled fields in step 1 (not just seeded but also shown)?

Return: `{ payload_covers: bool, validation_correct: bool, steps_coherent: bool, wiredTool_reachable: bool, initial_values_reflected: bool, notes: string[] }`.

### 5c. Sub-shape gating

- **single-step form**: skip `form.step_nav_state_present` and step-coherence LLM check.
- **multi-step wizard**: run everything.

No generic tier-1/2 runs when `shape = form`.

---

## 6. Process

**Default:** `single_pass`.

**Known failure mode** (cohort-24 evidence): Google forms hit a silent-abort
cliff — turn-1 outcome non-PASS + turn-2 `no tool call` → 0B compiled at
~10-15s. Cohort-20 staged process improved Google form reliability (pass@≥50
from ~1/3 → 3/5 without latency cost). Adaptive fallback on this runtime
signature is a plausible next process lever.

**Deferred.** Implement + bench recipe + self-check first. The form explorer's
runtime-signal spec (turn-1 non-PASS + turn-2 no tool call + 0B compiled) is
the known trigger if we need it — but form stability may come from the recipe

- self-check alone. Measure first.

---

## 7. Delta from current harness

| Axis            | Current                                                 | Proposed                                                                                      |
| --------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| System prompt   | Shared A4-lite v2 only                                  | + form recipe addendum (compressed 7-9 numbered imperatives; same nouns as spec + self-check) |
| Boilerplate     | Empty `SHAPE_SECTIONS`                                  | Empty (unchanged — cohort 23 confirmed form markers regress Google)                           |
| Self-check      | Shared tier-0/1/2                                       | Tier-0 shared + tier-1/2 replaced by form-specific deterministic + LLM checks                 |
| Classifier      | `actions≥1 AND arrStr≥1 AND arrObj=0 AND promptLen>500` | `!isCollection AND actions≥1 AND multiFieldSubmit` — no promptLen, no arrStr requirement      |
| Commits covered | survey-form, onboarding-wizard                          | survey-form, onboarding-wizard (unchanged)                                                    |

---

## 8. Bench plan

Once §3-§5 are implemented:

- **Smoke**: n=1 on 2 form commits × 3 providers = 6 runs. Inspect sources. Verify both commits still classify as form under new classifier. Verify Google doesn't silent-abort more often than baseline (stability gate).
- **Narrow**: n=3 × 2 × 3 = 18 runs. **Same-session baseline** (current form harness) first, then with spec active. Compare:
  - survey-form / onboarding-wizard avg ms per provider (stabilize, not optimize — target: no regression ±15%)
  - pass@score≥50 per commit per provider (must not drop; ideally rise on Claude/OpenAI)
  - Google `malformed_tool_call` rate (must not rise; ideally stay 0 if cohort 24 baseline was 0)
- **Decision**: ship if (a) no provider regresses >15% blended, (b) pass@50 flat-or-up on Claude/OpenAI, (c) Google transport noise doesn't rise. Latency gains on Claude form from cohort-24 artifact resolved (symmetric score filter) should manifest as real parity, not false improvement.

Falsifies if: Claude/OpenAI pass@50 drops → recipe is over-constraining. If Google gets worse → next lever is adaptive staged fallback on the silent-abort signature, not more recipe tuning.
