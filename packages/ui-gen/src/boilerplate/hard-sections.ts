// packages/ui-gen/src/boilerplate/hard-sections.ts
//
// The HARD-CONTRACT sections of the coding-agent system prompt — the
// text that is identical in every `designMode`. Both prompt builders
// (`buildSystemPrompt` for `constrained`, `buildFreeDesignPrompt` for
// `free`) assemble from these constants, so the wire / contract / host /
// gadget / blueprint-reuse teaching cannot drift between the two arms.
//
// These strings were extracted VERBATIM from the pre-`designMode`
// `buildSystemPrompt` template; `design-mode.pin.test.ts` pins the
// constrained assembly byte-for-byte against the pre-extraction digest.
// Edit them here and both arms move together.

/** Wire-hook preservation rules (`wire_preservation` / `wire_undeclared`). */
export const PROTOCOL_NOTES = `## Protocol Notes
The boilerplate pre-declares every wire hook the contract requires (\`useAction\`, \`useStream\`, \`useGguiContext\`, plus capability hooks from \`@ggui-ai/gadgets\` when the contract declares \`clientCapabilities\`). Three rules:
1. **Do NOT delete any pre-declared hook.** \`self_check\` fails with \`wire_preservation:<kind>:<name>\` if you remove one.
2. **Consume every hook binding** somewhere in the component — in JSX, a callback, or an effect. Unused bindings fail lint with \`no-unused-vars\`.
3. **Do NOT invent new wire calls.** Every \`useAction('X')\`, \`useStream('X')\`, \`useGguiContext('X')\` etc. MUST correspond to a declared entry on the contract. Calling one that isn't declared fails \`self_check\` with \`wire_undeclared:<kind>:<name>\` because the runtime has no Context/registration for it and would throw at first paint. If you need a new wire surface, that's a contract authoring step the agent owns — your job is to honor what's declared.

Renaming a binding is fine — the wiring is the string-literal argument, not the identifier.`;

/** The four specs + two catalogs, the actions-vs-context placement rule and the data-vs-behavior split. */
export const CONTRACT_SURFACE = `## Contract surface — four specs + two catalogs

A \`DataContract\` declares everything a GguiSession exchanges with the outside world. **Four typed specs** for the four data-flow directions, **two reference catalogs** for tool / hook lookups:

| Surface              | Direction                  | Role                                                                 |
| -------------------- | -------------------------- | -------------------------------------------------------------------- |
| \`propsSpec\`         | server → UI (one-shot)     | Initial render values delivered once at \`ggui_render\`              |
| \`streamSpec\`        | agent → UI (many)          | Typed channels for live updates via \`ggui_emit\`                    |
| \`actionSpec\`        | UI → agent (events)        | Discrete events driving the agent's next turn (consumed via \`ggui_consume\`) |
| \`contextSpec\`       | UI → server (state mirror) | UI state the agent observes between turns                            |
| \`agentCapabilities.tools\`     | catalog                    | Tools the contract references via \`actionSpec[*].nextStep\` and \`streamSpec[*].source.tool\` |
| \`clientCapabilities.gadgets\` | catalog                    | Browser-capability gadget hooks the component code mounts (e.g., \`useGeolocation\`) |

**Placement rule for inbound specs**: actions drive turns; context observes state. There is no third category.

**Data vs behavior**: the contract describes data flow; the component code describes behavior. Scroll, focus, toast, animation, clipboard write — all component code, never contract fields.`;

/** Guarding absent / late-arriving props, streams and context slots. */
export const DEFENSIVE_CODING = `## Defensive coding for absent / late-arriving data

Props arrive at mount and may be partial on first render; later prop changes reach the SAME mounted component via \`ggui_amend\` (in-place repaint) on the live channel. Stream channels start empty and fill over time. Context slots start at their declared default (often \`null\`). **Never assume a field exists before you read it.**

- **Optional contract props**: a \`Props\` field marked \`?\` in the boilerplate may be omitted by the agent ENTIRELY — the wire gate only enforces \`required: true\` entries, and the harness verifies your component with those props stripped. Guard them (\`?? default\`, \`?.\`, or an empty-state branch) from the FIRST render.
- **Array iteration**: always default to \`[]\` before \`.map\`/\`.filter\`/\`.length\`. Use \`(props.items ?? []).map(...)\` not \`props.items.map(...)\`. Same for stream.all, stream.latest, etc.
- **Object access**: optional-chain through nested fields. \`props.user?.name ?? 'Anonymous'\` not \`props.user.name\`.
- **Number ops**: default before arithmetic. \`(props.count ?? 0) + 1\` not \`props.count + 1\`.
- **Stream latest**: \`useStream\` returns \`{latest: T | null, all: T[], isComplete: boolean}\`. The default \`all\` is \`[]\` so it's safe to map; \`latest\` is null until the first frame arrives — guard before reading \`.foo\`.
- **Stream reconciliation**: when a stream event carries an \`action\` discriminant (e.g. \`create | move | edit | delete\`), the channel is a CRUD feed — your handler MUST branch on EVERY value: append on \`create\`, drop on \`delete\`, replace-by-id on \`move\` / \`edit\`. Merging only the "edit" case silently loses created and deleted items. Reconcile into the SAME state that seeds from \`props\` (e.g. \`useState(() => props.tasks ?? [])\`) so the seed data and the live feed render as one list — and handle an event whose id is not yet present (a \`create\` for an unknown item) by inserting it, not ignoring it.
- **Props re-sync on repaint**: props the agent owns are the source of truth for display — prefer rendering DIRECTLY from \`props\` (controlled, no local copy). When local optimistic state genuinely needs a prop seed (a click bumps a count before the agent confirms), it MUST re-sync on prop change — \`useEffect(() => setCount(props.count ?? 0), [props.count])\` — or a \`ggui_amend\` repaint applies the new props while the display keeps the stale local value. BAD: \`const [count, setCount] = useState(props.count ?? 0)\` alone. GOOD: the same seed + the one-line re-sync effect.
- **Loading state**: while data is still absent, render \`<Skeleton>\` placeholders — never a blank screen. \`<Skeleton variant="text" />\` for a text line, \`variant="circle"\` for an avatar slot, default \`rect\` for a block.
- **Empty state**: when a list or results array is empty, render \`<EmptyState title="…" description="…" />\` — a region that renders nothing when empty looks broken to the user.

Unhandled \`Cannot read properties of undefined\` errors trip the iframe error boundary and the user sees "Something went wrong" — a regression class the runtime can't recover from.`;

/** Which wire surface each user gesture maps to (actions, context, gadgets, links, fullscreen). */
export const GESTURE_ROUTING = `## Picking the right primitive for user gestures

Choose by what the user is DOING, not where the result goes — the runtime handles the routing.

| Gesture intent | LLM writes | Notes |
| -------------- | ---------- | ----- |
| Fire a server-side action | \`useAction(name)\` + call \`dispatch(name, payload)\` | Every action is agent-routed. The runtime emits an event on \`ggui_consume\`; the agent reacts on its next turn. If the contract entry declares \`nextStep: 'X'\`, that names the tool the agent SHOULD call next — advisory hint forwarded as event metadata. |
| Surface state to the agent's context | the auto-generated \`setSlotName\` setter (from the boilerplate's \`useGguiContext\` line) | The runtime owns useState + Provider; the boilerplate emits one \`const [slot, setSlot] = useGguiContext<T>('slot')\` line per declared \`contextSpec\` slot. Write plain JSX, no \`useState\`, no Provider wrap. Every value change auto-flows to the host LLM (debounced). One-way client → agent — see "Observable state via \`contextSpec\`" below. |
| Use a browser capability (camera, mic, geolocation, clipboard, file picker, notifications) | call the hook the contract declared, e.g., \`const loc = useGeolocation();\` and \`await loc.start()\` | The contract's \`clientCapabilities.gadgets\` declares which gadget exports the UI uses. The hook implementations live in \`@ggui-ai/gadgets\` (or a third-party package named in the \`Package\` column). Read \`status\` ("idle" / "prompting" / "active" / "completed" / "denied" / "error") to gate UI, and thread the resolved \`value\` into a contextSpec slot or actionSpec payload if the agent needs to see it. |
| Open external link | Plain \`<a href="https://...">\` (or \`target="_blank"\`) | External cross-origin clicks are intercepted and routed through the host (security warnings, app-internal navigation, audit). Same-origin links and \`#fragment\` jumps stay native. |
| Toggle fullscreen / chrome | Plain \`el.requestFullscreen()\` / \`document.exitFullscreen()\` | The native browser API is intercepted; the host adjusts iframe chrome accordingly. Returns a resolved promise so \`.then()\` / \`await\` chains don't break. |

Every gesture fires a uniform server-side audit envelope (\`ggui_runtime_submit_action\`) so operators see all three patterns in RenderInspector with the same shape.

**Don't import wire hooks for link / display-mode.** \`useAction\` is the only wire hook for user gestures; links and fullscreen use plain HTML / browser APIs.

**All actions are agent-routed.** Every action emits an event the agent reacts to on its next turn via \`ggui_consume\`. The optional \`nextStep: '<tool>'\` field on an \`actionSpec\` entry is a HINT naming the tool the agent SHOULD call next — the contract author's recommendation, NOT a binding directive. The agent decides whether to honor it. If you want to declare a tool catalog entry the contract references, add it to \`agentCapabilities.tools[<name>]\` with input/output schemas; the cross-ref linter rejects dangling \`nextStep\` values that don't resolve to a declared catalog entry.`;

/** `as={Trait}` mechanics + the never-nest-two-interactive-elements rule in design-package vocabulary (constrained mode only — `free` mode restates the invariant for raw elements). */
export const INTERACTIVE_TRAITS = `## Making a primitive interactive — \`as={Trait}\`

Structural primitives (\`Box\`, \`Stack\`, \`Row\`, \`Card\`) have NO \`onClick\` by default. Add interactivity with the \`as\` prop — a trait, not a wrapper:

\`\`\`tsx
<Card as={Clickable} onClick={() => dispatch('select', { id })}
      hoverStyle={{ boxShadow: 'var(--ggui-shape-shadow-lg)' }}>…</Card>
\`\`\`

- \`as={Clickable}\` → \`onClick\` + keyboard activation (Enter/Space) + \`role="button"\` + \`hoverStyle\`/\`activeStyle\`/\`cursor\`.
- \`as={Hoverable}\` → \`hoverStyle\` only (no click). \`as={Pressable}\` → \`onPress\` + \`pressStyle\`.

\`as={Trait}\` is a PROP — it does NOT re-nest the JSX. Never write \`<Clickable>…</Clickable>\` around a primitive; put \`as={Clickable}\` on the primitive itself. The trait carries the keyboard + ARIA wiring, so don't hand-write \`onKeyDown\` / \`role\`. Trait components (\`Clickable\`, \`Hoverable\`, \`Pressable\`) import from \`@ggui-ai/design\` like everything else — the boilerplate already imports them.

**Semantic components are already interactive** — \`Button\` (\`onClick\`), \`Link\` (\`href\`), \`Input\` / \`Select\` (\`onChange\`). Use their own props; never put \`as\` on them. \`Text\` picks its element with \`is\` (\`<Text is="label">\`), not \`as\`.

**Never nest two interactive elements.** Interactive content MUST NOT contain other interactive content — a gesture on the inner control bubbles to the outer one and fires BOTH handlers (one user click → the action dispatched twice). Do NOT put a \`Button\`, \`Checkbox\`, \`Input\`, \`Select\`, \`Link\`, or another \`as={Clickable}\` primitive inside a \`Card\` / \`Box\` / \`Row\` / \`Stack\` that is itself \`as={Clickable}\`. Wire each \`useAction\` callback to exactly ONE surface: EITHER the whole card is the trigger (interactive container, no interactive children) OR an inner control is the trigger (plain container, no \`as={Clickable}\`) — never both. A row with a checkbox: put the action on the \`Checkbox onChange\` and leave the row plain.

**\`Text\` / \`Heading\` accept NO event handlers and NO \`as\` — only \`style\` / \`className\` plus their own typed props.** \`onClick\`, \`onDoubleClick\`, \`as={Clickable}\`, \`color\` are all type errors on \`Text\`. When the request says a label is "clickable", "editable", "edit on click / double-click", or "tap to …", do ONE of these — never put the handler on \`Text\`:

\`\`\`tsx
// Click-to-edit a label: wrap the Text in a Clickable structural primitive.
<Box as={Clickable} onClick={() => setEditingId(task.id)}
     style={{ cursor: 'pointer' }}>
  <Text weight="semibold">{task.title}</Text>
</Box>

// Or pair the label with an explicit edit Button (clearer affordance).
<Row gap="xs" align="center">
  <Text weight="semibold">{task.title}</Text>
  <Button variant="ghost" size="xs" aria-label="Edit title"
          onClick={() => setEditingId(task.id)}>Edit</Button>
</Row>

// In edit mode, swap the Text for an Input.
{editingId === task.id
  ? <Input value={draftTitle} onChange={setDraftTitle} label="Task title" />
  : <Text weight="semibold">{task.title}</Text>}
\`\`\``;

/** Retired contract identifiers the linter rejects. */
export const ANTI_PATTERNS = `## Anti-patterns — DO NOT WRITE

The following identifiers / shapes are RETIRED from the contract surface as of 2026-05-11. Pre-2026-05-11 examples in your training data may include them; do not reproduce. The linter / CI grep gate rejects:

- \`useWiredTool\`, \`useClientTool\` — retired hooks. Replace with \`useAction\` (events) and the named hook from \`@ggui-ai/gadgets\` (browser capabilities).
- \`dispatch: { kind: 'tool', tool: '...' }\` / \`dispatch: { kind: 'agent', intendedTool: '...' }\` — retired discriminated-union. Use the flat optional \`nextStep?: '<tool>'\` instead.
- \`mode: 'host-routed'\` / \`mode: 'tool'\` — retired \`mode\` field. Same fix: flat \`nextStep?\`.
- \`broadcast: {...}\` on the contract — retired top-level field. Use \`streamSpec[channel].source: {tool, args?}\` to declare a tool-fed channel.
- \`wiredTools\` / \`agentTools\` (top-level) — retired catalog names. Use \`agentCapabilities.tools\`.
- \`clientTools\` / \`clientCapabilities.capabilities\` — retired catalog shapes. Use \`clientCapabilities.gadgets\` (entries declare hooks, not RPC).
- \`@ggui-ai/client-tools\` — retired package name. Import gadget hooks from \`@ggui-ai/gadgets\`.
- \`intendedTool\` — retired. Use \`nextStep\` (flat).
- \`props: { properties: {...} }\` as a CONTRACT field — retired. The contract field is \`propsSpec\` (the wire \`props\` field on render / update still carries VALUES).`;

/** `nextStep` / `source.tool` catalog cross-refs. */
export const CROSS_REFERENCE_RULES = `## Cross-reference rules

When you declare a reference, also declare the catalog entry it points at:

- \`actionSpec[X].nextStep = 'fetch_inbox'\` → \`agentCapabilities.tools.fetch_inbox = { toolInfo: { inputSchema, description?, outputSchema? }, usage?, example? }\` MUST exist. Cross-ref code: \`CTR_REF_NEXT_STEP\`.
- \`streamSpec[X].source.tool = 'list_messages'\` → \`agentCapabilities.tools.list_messages\` MUST exist. Cross-ref code: \`CTR_REF_STREAM_SOURCE\`.
- The catalog entry's schemas MUST be a superset of the referencing spec's schema. Cross-ref code: \`CTR_SCHEMA_INCOMPAT\`.`;

/** `clientCapabilities` — the registered gadget catalog table (rendered per app). */
export function renderGadgetCatalogSection(gadgetsSection: string): string {
  return `## clientCapabilities — registered catalog

${gadgetsSection}

Each hook conforms to \`GadgetHook<TOutput, TOptions>\`: call \`start(opts?)\` to fire, read \`{value, status, error, stop?}\`. \`status\` walks through \`idle → prompting → active|completed\` or routes to \`denied\` / \`error\` on failure.

3rd-party plugins (Leaflet maps, Mapbox, Stripe, Chart.js, …) are registered via \`createGguiGadget\` from \`@ggui-ai/gadgets\` and surface in this same table when the operator has added them to \`App.gadgets\`. Reference any registered hook by name — render validation rejects hooks not in this catalog with \`gadget_not_registered\`.`;
}

/** `contextSpec` — auto-generated `useGguiContext` slots, one-way client → agent. */
export const CONTEXT_SPEC_SECTION = `## Observable state via \`contextSpec\`

When the contract declares \`contextSpec\`, the boilerplate auto-generates one \`useGguiContext\` call per slot at the top of your component. The runtime owns the underlying \`useState\` and the Provider tree — **you do NOT write \`useState\` or any \`<Provider>\` wrap yourself**:

\`\`\`tsx
import { useGguiContext } from '@ggui-ai/wire';

export default function Component(props: Props) {
  // AUTO-GENERATED — do not remove or rename:
  const [currentStep, setCurrentStep] = useGguiContext<number>('currentStep');
  const [draftText, setDraftText] = useGguiContext<string>('draftText');

  // Plain JSX. No Provider wrap. The runtime already wrapped your
  // component in nested SingleSlotProviders before this code ran.
  return (
    <Container>
      <Text>Step {currentStep}</Text>
      <Input value={draftText} onChange={(e) => setDraftText(e.target.value)} />
      <Button onClick={() => setCurrentStep((s) => s + 1)}>Next</Button>
    </Container>
  );
}
\`\`\`

For every declared slot you have **\`slotName\` + \`setSlotName\`** in scope:
- **Read** the value to render: \`<Text>Step {currentStep}</Text>\`
- **Write** via the setter: \`setCurrentStep(s => s + 1)\` (in callbacks, effects, anywhere)

Every value change is mirrored to the host LLM's context automatically (debounced, default 300ms — adjustable per-slot via \`entry.debounceMs\` in the contract). The agent sees the user's interaction state — drafts, current step, hover, selection — without you calling any API.

**When to use the auto-generated state.** Any slot the contract declared. If \`contextSpec.draftText\` exists, bind \`<Input value={draftText} onChange={e => setDraftText(e.target.value)}>\` so the agent sees the typing live. If \`contextSpec.currentStep\` exists, render the step indicator from \`currentStep\` and bump it via \`setCurrentStep\` in your "next" callback.

**When NOT to use it.** Local UI state the contract did NOT declare — \`isDropdownOpen\`, hover flags, animation phase, ephemeral toggles. For those, use a plain \`useState\` directly. The runtime ignores undeclared state.

**\`contextSpec\` direction is one-way: client → agent.** The agent uses \`propsSpec\` (via \`ggui_amend\` for in-place repaints of this mount, or \`ggui_update\` when it mints a new history card) and \`streamSpec\` (via the live channel) to push state TO the client. Don't try to write to the agent via \`contextSpec\` — there is no return path.

**Schema mismatches drop silently.** If you set a value that doesn't match the slot's schema (e.g. a string into a \`{type: 'number'}\` slot), the runtime logs a dev \`console.warn\` and skips the post. Make sure your setter calls produce values that match the declared shape.`;

/** Blueprint-reuse contract — request data as defaulted props, exported typed `Props`. Identical in both modes. */
export const DATA_PARAMETERIZATION = `## Data Parameterization (CRITICAL)

Generated components are CACHED blueprints reused across requests. NEVER hardcode request-specific data (names, cities, numbers, dates) into the component body. Define data as default prop values so the blueprint works for ANY similar request:

\`\`\`tsx
// BAD — hardcoded, only works for Tokyo
const city = "Tokyo";
const temp = 18;

// GOOD — parameterized via props with defaults from the request
interface Props {
  city?: string;
  temperature?: number;
}
export default function WeatherCard({ city = "Tokyo", temperature = 18 }: Props) {
  // A controller can override for Seoul, Paris, etc.
}
\`\`\`

Rules:
1. All request-specific data → props with defaults. City names, tickers, user names, dates, counts.
2. Layout and styling are universal. Colors, spacing, structure — these are the reusable part.
3. Default values come from the current request — so the component renders correctly standalone.
4. Props interface must be typed and exported.`;

/** Helper-component structure guidance (JSX depth 3–5, helpers above `Component`). Identical in both modes. */
export const COMPONENT_STRUCTURE = `## Component Structure

Keep JSX nesting depth to 3–5 levels. When deeper, extract repeated/complex sections into helper components — named functions defined above the main Component in the same file. Helpers take data + callbacks via props; they don't own state.

\`\`\`tsx
import { useState } from 'react';
import { Container, Card, Stack, Text, Button, Input } from '@ggui-ai/design';

interface Props {
  onSubmit?: (data: unknown) => void;
}

function ItemCard({ item, onEdit }: { item: Item; onEdit: (id: string) => void }) {
  return <Card padding="md">…</Card>;
}

export default function GeneratedComponent({ onSubmit }: Props) {
  return (
    <Container>
      {items.map((item) => <ItemCard key={item.id} item={item} onEdit={handleEdit} />)}
    </Container>
  );
}
\`\`\``;
