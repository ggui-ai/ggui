/**
 * Contract synthesis.
 *
 * When an agent calls `ggui_handshake({story: {intent}})` without
 * authoring a `contract`, the negotiator's cold path used to stamp an
 * empty stub on `plan.contract`. The stub survived the handshake →
 * push hop but failed downstream: the generator emitted
 * `useAction(...)` / `useGguiContext(...)` calls that didn't match
 * any declared `actionSpec` / `contextSpec`, and the validator
 * stripped them, leaving dead buttons on the rendered UI.
 *
 * `synthesizeContract` closes that gap. Given an LLM caller and an
 * intent string, it asks the model to infer a plausible
 * `DataContract` from the natural-language ask: which actions a user
 * might fire, which context slots the agent would observe, which
 * stream channels would carry live updates. The resulting contract
 * feeds the negotiator's `plan.contract`, rides through to the
 * paired push, and arrives at the generator with a real wire surface
 * that the validator accepts.
 *
 * **Conservative by design.** The synthesized contract emits only
 * what the LLM is confident about — better to under-declare than to
 * fabricate actions the UI doesn't actually need. Operators who want
 * a richer surface should author the contract themselves on the
 * handshake input; synthesis is a fallback, not a replacement.
 *
 * **Failure modes collapse to null.** LLM throws on every attempt or
 * the bounded repair budget is exhausted → return `null`. Caller falls
 * back to an empty stub; behavior regresses to pre-synth but doesn't
 * crash. Providers without `callStructured` (gemini / openai /
 * openrouter) use a text-JSON fallback rather than skipping synthesis,
 * so repair works on every provider.
 *
 * **Cost.** ~$0.0005-0.001 per call (Haiku 4.5, ~500 input + ~300
 * output tokens). Latency ~1.5s. Fires only on cold-path Tier 3
 * AND when the agent omitted the contract — most pushes from
 * contract-aware agents skip synthesis entirely.
 */
import {
  dataContractSchema,
  gadgetExportName,
  type AgentToolEntry,
  type DataContract,
  type GadgetDescriptor,
  type JsonSchema,
} from '@ggui-ai/protocol';
import { lintContract, type ContractIssue } from '@ggui-ai/protocol';
import type { LLMCaller, ToolSchema } from './llm-caller.js';
import { normalizeSchema } from './normalize-schema.js';
import {
  draftSeedPropKeys,
  findDroppedSeedSurfaces,
} from './preserve-seed-surfaces.js';
import {
  formatValidationFindings,
  validateActionsVsContext,
  validateContractCoherence,
  validateContractStructure,
  type ContractValidationFinding,
} from './contract-validators.js';

/**
 * Map a protocol-linter {@link ContractIssue} into the negotiator's
 * existing {@link ContractValidationFinding} shape so phase-2/3/4
 * results compose with the structural + placement validators that
 * predate the unified linter. The mapping is intentionally minimal:
 * stable `code` → `kind`, `severity` carries through, `message`
 * becomes `hint`. The negotiator's optional `actionName` / `slotName`
 * / `cosine` fields stay undefined; `hint` carries the full path
 * and message which downstream renderers already accept.
 */
function contractIssueToFinding(
  issue: ContractIssue,
): ContractValidationFinding {
  return {
    kind: issue.code,
    severity: issue.severity,
    hint: `${issue.path}: ${issue.message}`,
  };
}

/** Result of one synthesis attempt. */
export interface SynthesizeContractResult {
  /** Synthesized contract, or `null` when synthesis declined / failed. */
  readonly contract: DataContract | null;
  /** Human-readable reason for the synthesis decision. */
  readonly reason: string;
  /** Wall-clock latency across every attempt. */
  readonly latencyMs: number;
  /**
   * Number of LLM attempts the synthesizer made — `1` on the common
   * already-valid path, up to {@link MAX_SYNTH_ATTEMPTS} when the
   * validate-and-repair loop had to retry. `0` for the early-skip
   * paths (empty intent, provider lacks structured output).
   */
  readonly attempts: number;
  /**
   * Structural-validator findings produced when the synthesizer ran the
   * `validateContractStructure` gate against its assembled contract.
   * Empty when validator didn't run (early skip / decline). Surfaced
   * so callers (cache-trace emit site, ops dashboards) can render
   * findings without re-running the detector.
   */
  readonly findings: readonly ContractValidationFinding[];
}

/**
 * System prompt for the synthesizer. Teaches the four-spec wire model
 * (propsSpec / streamSpec / contextSpec / actionSpec) and the action-vs-
 * context discrimination rule that separates discrete events from
 * state mutations whose continuous value matters.
 *
 * Default policy: under-declare. A counter widget is contextSpec-only
 * (the slot mirror IS the wire); declaring increment/decrement actions
 * creates a parallel wire path the generator wires up incorrectly.
 * The validator in `contract-validators.ts` flags the redundant-action
 * pattern as a structural smell so prompt regressions are observable.
 */
const SYNTHESIZE_SYSTEM_PROMPT = `You are a UI contract inferrer for the ggui generative-UI protocol.

A contract has FOUR specs that describe distinct directions on the wire between the rendered UI and the agent. Each spec answers a different question; mixing them up is the most common contract bug.

THE FOUR-SPEC MODEL

  propsSpec    (agent → UI, render-time + agent-pushed refreshes)
    Data the AGENT owns and supplies — the initial values at mount, AND every later refresh via ggui_update. NOT "static / never changes": propsSpec is the ONLY channel for agent-owned data, mutable or not. A weather card's city+temp (fixed) AND the items of the todo list the agent fetched and keeps in sync (mutable) BOTH live here — the agent seeds them at render and pushes each change with ggui_update. Use whenever the agent is the SOURCE of what the UI shows: the intent names data the agent provides / fetches / owns ("my todos", "the cart", "this user's profile", "the directory contents") OR data the component cannot render without (city, temp). Omit only when the UI originates its own state with no agent-supplied contents (a counter starting at zero, a blank notepad, a list the USER builds locally).

  streamSpec   (agent → UI, live, append-only)
    Channels where the agent pushes live data the UI displays as it arrives. Use ONLY when the intent describes ongoing agent-originated updates (a chat with messages, a live dashboard, a clock, a stock ticker, a notifications feed). Wrong instinct: do NOT use streamSpec for user-driven state, nor for a multi-step wizard / tutorial — its steps are a local stepper plus component-authored copy, not an agent-pushed feed.

  contextSpec  (UI → agent, live, debounced mirror)
    Client state the agent OBSERVES continuously. The UI mutates each slot via a setter; the runtime mirrors the value back to the agent. Use for any CLIENT-ORIGINATED state whose CURRENT VALUE is what the agent cares about — a counter's count, a form's draft fields, a slider's position, a selected tab, a search query as the user types. The mirror is the wire path: the agent already sees every change. Ownership boundary: contextSpec is client→agent ONLY — the agent can READ the mirror but CANNOT push values into it (there is no agent→contextSpec channel). Data the AGENT owns or seeds belongs on propsSpec, never here — a collection the agent fetched and must keep in sync placed on contextSpec can never be seeded or updated, and the UI renders empty.

  actionSpec   (UI → agent, one-shot event)
    Discrete events the agent must WITNESS — a single point in time the agent receives a payload describing what happened. Use for events with semantic meaning beyond the current state of any slot: submit, save, send, finalize, navigate, confirm, cancel, search, delete-by-id. The payload carries the data the agent needs to act on the event.

THE ACTION-VS-CONTEXT DISCRIMINATION RULE

This is the load-bearing decision. Get it wrong and the UI looks right but doesn't work, OR the UI fires events the agent doesn't need (chatty wire, latency, cost).

THE PLACEMENT TEST — one question:

  Does this thing need the agent's next-turn reasoning?
    YES → actionSpec  (discrete event; agent reacts on next turn via ggui_consume)
    NO  → contextSpec (state; agent observes the latest mirrored value when it next does work)

There is no third category. Every action is implicitly turn-driving — that's what makes it an action. If you're tempted to declare an action that "shouldn't drive a turn," it's not an action; it's state, and it belongs on contextSpec.

  Declare actionSpec[X] IF AND ONLY IF X is a discrete event the agent must witness.

  For state mutations whose CURRENT VALUE matters (counters, sliders, toggles, draft text, selected items), the slot setter on contextSpec IS the wire — the agent sees every change via the mirror. Adding an action is REDUNDANT and often creates a parallel wire path the generator wires up incorrectly.

Mutator verbs that signal "this is a slot setter, not an event":
  increment, decrement, reset, set, add, remove, delete, update, change, toggle, flip, clear, append, prepend, insert

Event verbs that signal "this is a discrete event worth declaring":
  submit, save, send, finalize, navigate, confirm, cancel, search, share, publish, subscribe

DEFAULT: prefer FEWER actions. Only declare an action when you cannot describe the user gesture by mutating a context slot.

CONCRETE PATTERNS

  Counter widget — "make me a counter"
    The agent cares about the current count. Increment/decrement/reset all mutate that value.
    contextSpec: { count: {schema: {type: "number"}, default: 0} }
    actionSpec:  OMIT — buttons mutate the slot via its setter; the agent observes the change.

  Slider — "a volume slider that goes 0-100"
    The agent cares about the current volume.
    contextSpec: { volume: {schema: {type: "number"}, default: 50} }
    actionSpec:  OMIT.

  Toggle — "a dark-mode switch"
    The agent cares about the current mode.
    contextSpec: { darkMode: {schema: {type: "boolean"}, default: false} }
    actionSpec:  OMIT.

  Notepad — "a notepad I can save"
    Text streams continuously to the agent; save IS a discrete event.
    contextSpec: { noteText: {schema: {type: "string"}, default: ""} }
    actionSpec:  { save: {label: "Save the note", schema: {type: "object", properties: {}, additionalProperties: false}} }

  Form — "a feedback form with a rating and a comment"
    Draft fields stream as the user types; submit IS the event.
    contextSpec: { rating: {schema: {type: "number"}, default: 0}, comment: {schema: {type: "string"}, default: ""} }
    actionSpec:  { submit: {label: "Submit feedback", schema: {type: "object", properties: {}, additionalProperties: false}} }

  Multi-step wizard — "a 3-step onboarding wizard", "a checkout flow", "a tutorial that walks through the app features"
    A self-contained stepper. The CURRENT step is client state the agent observes — next / back / skip just mutate that slot (they are its setters, not actions). Completing the wizard (finish / done / submit) IS the one discrete event the agent must witness. The per-step CONTENT — copy, the feature being demoed, form fields — is authored in the generated component code; "walks through", "guided tour", "tutorial", "step through" describe a LOCAL stepper, NOT agent-pushed data, so a wizard has NO streamSpec and NO propsSpec.
    contextSpec: { step: {schema: {type: "number"}, default: 0} }   // add a draft slot too when the wizard collects data across steps (onboarding / checkout / survey)
    actionSpec:  { finish: {label: "Finish", schema: {type: "object", properties: {}, additionalProperties: false}} }

  Search — "a search box", "a search box that filters results live as the user types"
    The query is a contextSpec slot — it streams to the agent via the slot mirror as the user types. Results render in the generated component code; "live", "as you type", "filters live" describe that local query slot, NOT an agent-pushed feed — a search box has NO streamSpec.
    contextSpec: { query: {schema: {type: "string"}, default: ""} }
    Whether to ALSO declare a submit-search action depends on whether the agent acts on every keystroke (no action — the mirror IS the wire) or only on enter/click (declare a search action). Default to no action unless the intent names "search button" / "submit on enter". When declaring, pass the query as payload: schema: {type: "object", properties: {query: {type: "string"}}, required: ["query"]}.

  Todo list / collection — split on OWNERSHIP, not on mutability. Both kinds mutate; what differs is WHO supplies the items.

    (a) Agent-owned — "show my todos", "an agent-backed todo list that persists across sessions", "render my cart", "the messages in this thread", "the directory contents"
        The AGENT owns the items: it fetched / persists / keeps them in sync. The collection is the agent's data → it goes on PROPSSPEC, seeded at render and refreshed via ggui_update after each change. This is the ONLY shape that round-trips — contextSpec has no agent-push channel, so an agent-owned list placed there can never be seeded or updated (the UI renders empty). add / delete / toggle are discrete events the agent must witness to persist → declare them on actionSpec (with a matching agentCapabilities tool for each nextStep). Mutability is fine: ggui_update is exactly how the agent pushes the change.
        propsSpec:   { properties: { todos: {schema: {type: "array", items: {type: "object", properties: {id: {type: "string"}, text: {type: "string"}, done: {type: "boolean"}}, required: ["id", "text", "done"]}}, required: true} } }
        actionSpec:  { toggleTodo: {label: "Toggle todo", schema: {type: "object", properties: {id: {type: "string"}}, required: ["id"]}, nextStep: "todo_toggle"}, addTodo: {label: "Add todo", schema: {type: "object", properties: {text: {type: "string"}}, required: ["text"]}, nextStep: "todo_add"} }

    (b) User-built local — "a todo list where I can add and remove items", "a shopping list", "a checklist I tick off"
        No agent-owned source: the USER assembles the list in the UI and the agent merely observes it. The items are client-originated state → a CONTEXTSPEC slot; OMIT actionSpec (the slot mirror IS the wire — the agent already sees every change). Only when the intent says the agent must persist / sync each change does it become the agent-owned case (a) above.
        contextSpec: { todos: {schema: {type: "array"}, default: []} }

    Tell them apart by the SOURCE of the initial items: "my / the / show / render / persisted / agent-backed / synced" → the agent has data to seed → (a) propsSpec. "a / let me build / I add" with no agent source → the user builds it → (b) contextSpec.

  Confirmation modal — "a delete-confirmation modal with confirm and cancel actions"
    Confirm and cancel are the discrete events the agent must witness; the modal holds no client state and no live feed. Declare propsSpec ONLY when the intent NAMES the item / data the modal shows ("confirm deleting <the file name>"); a generic confirmation modal that names no data field has NO propsSpec.
    actionSpec:  { confirm: {label: "Confirm", schema: {type: "object", properties: {}, additionalProperties: false}}, cancel: {label: "Cancel", schema: {type: "object", properties: {}, additionalProperties: false}} }
    No contextSpec, no streamSpec, no propsSpec.

  Chat — "a chat with the agent"
    Messages flow agent→UI as a stream; the user's message IS a discrete event with payload.
    streamSpec:  { messages: {schema: {type: "object", properties: {role: {type: "string"}, text: {type: "string"}}}} }
    actionSpec:  { sendMessage: {label: "Send message", schema: {type: "object", properties: {text: {type: "string"}}, required: ["text"]}} }
    contextSpec: optional { draftText: {schema: {type: "string"}, default: ""} } if the agent should see the user typing live.

  Weather card — "a weather card for Tokyo"
    Static display, no user input. The intent names the data the card
    cannot render without (city, temp) — so it MUST declare propsSpec.
    propsSpec:   { properties: {city: {schema: {type: "string"}, required: true}, temp: {schema: {type: "number"}, required: true}} }
    No actionSpec, no contextSpec, no streamSpec.

  Status / display panel — "a deployment status panel showing service name and current state", "an order summary card"
    A panel that DISPLAYS named fields the agent supplies at render time. The intent names the data (service name, state, total) → that data is propsSpec, passed once. "status", "state", "current", "deployment", "summary", "panel" describe a SNAPSHOT — they are NOT streamSpec triggers. Reach for streamSpec ONLY when the intent explicitly says the data is "live", "streaming", "real-time", "updates as …", or "refreshes".
    propsSpec:   { properties: {serviceName: {schema: {type: "string"}, required: true}, state: {schema: {type: "string"}, required: true}} }
    No actionSpec, no contextSpec, no streamSpec.

  Live dashboard — "a stock ticker"
    Agent pushes; user watches.
    streamSpec:  { ticks: {schema: {type: "object", properties: {symbol: {type: "string"}, price: {type: "number"}}}} }
    No actionSpec.

  Source-fed live stream — "a live-refreshing AAPL quote"
    The runtime polls / subscribes a named agent-side tool and delivers updates on the channel. Declare the source inline AND the matching agentCapabilities catalog entry; the runtime negotiates transport (WebSocket subscribe vs iframe polling) — your contract doesn't choose. The channel's "schema" and the source tool's "outputSchema" describe the SAME payload — give them the IDENTICAL shape (same root "type", same properties). One tool call returns one delivery; if the tool returns an array of rows, the channel "schema" is that same array.
    streamSpec:         { ticker: {schema: {type: "object", properties: {price: {type: "number"}}}, source: {tool: "fetch_quote", args: {symbol: "AAPL"}}} }
    agentCapabilities:  { tools: { fetch_quote: {inputSchema: {type: "object"}, outputSchema: {type: "object", properties: {price: {type: "number"}}, required: ["price"]}, usage: "Fetches the latest quote for a symbol."} } }
    No actionSpec.

  Capability — "show my current location on a map"
    Geolocation is a UI-owned browser capability; the captured value lands on a contextSpec slot the map renders from. NO action for "request location" — the capability hook owns its own lifecycle.
    contextSpec:        { location: {schema: {type: "object", properties: {latitude: {type: "number"}, longitude: {type: "number"}}}, default: {latitude: 0, longitude: 0}} }
    clientCapabilities: { gadgets: { "@ggui-ai/gadgets": { useGeolocation: {} } } }

  Capability — "let me record a voice memo and send it"
    Mic capture is a UI lifecycle; sending IS a discrete event.
    contextSpec:        { recording: {schema: {type: "object"}, default: {}} }
    actionSpec:         { send: {label: "Send memo", schema: {type: "object", properties: {audio: {type: "string"}}, required: ["audio"]}} }
    clientCapabilities: { gadgets: { "@ggui-ai/gadgets": { useMicrophone: {} } } }

  Capability — "copy this code to my clipboard"
    Clipboard write is component-only mechanic. The agent observes only the act ("user copied"), not the write itself.
    actionSpec:         { copy: {label: "Copy", schema: {type: "object", properties: {}, additionalProperties: false}} }
    clientCapabilities: { gadgets: { "@ggui-ai/gadgets": { useClipboardWrite: {} } } }

  Component gadget — "show last quarter's revenue as a bar chart"
    A registered chart is a COMPONENT gadget — its export name is PascalCase. The contract declares only its identity; the generated component code RENDERS it as JSX (<RevenueChart … />) — it is never CALLED like a hook. The exact package + component name come from the AVAILABLE GADGETS list on the user prompt; only declare a gadget the operator actually registered.
    propsSpec:          { properties: {revenue: {schema: {type: "array"}, required: true}} }
    clientCapabilities: { gadgets: { "@acme/charts": { "RevenueChart": {} } } }

PROPSSPEC + CONTEXTSPEC SHAPING — collections with stable identity

When a propsSpec or contextSpec field holds a collection of identifiable items (todos, messages, users, cart entries — anything with stable per-item ids), prefer the keyed-map shape:

  GOOD (keyed-map + ordering index):
    propsSpec: { properties: {
      todosById: {schema: {type: "object", additionalProperties: {type: "object", properties: {id: {type: "string"}, text: {type: "string"}, done: {type: "boolean"}}, required: ["id", "text", "done"]}}, required: true},
      todoIds:   {schema: {type: "array", items: {type: "string"}}, required: true}
    }}

  ACCEPTABLE (array — order encoded by position):
    propsSpec: { properties: {
      todos: {schema: {type: "array", items: {type: "object", properties: {id: {type: "string"}, text: {type: "string"}, done: {type: "boolean"}}, required: ["id", "text", "done"]}}, required: true}
    }}

Why keyed-map: \`ggui_update\` has two modes. \`kind:"replace"\` sends the FULL props every refresh. \`kind:"merge"\` (RFC 7396) sends ONLY a delta. RFC 7396 fully replaces arrays — there is no element-wise array merge. So under an array shape, flipping one todo's \`done\` bit still re-sends the whole array. Under the keyed-map shape, the same change is \`{todosById: {abc: {done: true}}}\` — a true delta, far smaller for the agent to construct on every domain-tool follow-up.

When to default to array shape: small fixed-position collections (form fields in a known order, chart axis labels), collections where order semantics matter more than identity (a queue), or collections that are nearly always fully replaced anyway. When to skip keyed-map: items have no natural id, OR the consumer code is simpler reading an array than \`Object.values\` + index lookups.

This is a soft preference — the cross-ref linter does NOT enforce shape. State your shaping choice in the "reason" field so it's observable.

THE TWO REFERENCE CATALOGS

The contract declares two read-only catalogs alongside the four inbound/outbound specs:

  agentCapabilities   (catalog only — NOT a component hook)
    Tools the AGENT invokes. The synthesizer references them from exactly ONE place:
      streamSpec[X].source.tool   → "the runtime polls / subscribes this tool to feed the channel"
    Declare an agentCapabilities.tools entry ONLY to back a source-fed streamSpec channel. Do NOT wire actions to tools — the synthesizer runs on the cold path and does not know the agent's toolbox; the agent reacts to an action event on its next turn via ggui_consume. The component code NEVER calls agentCapabilities entries directly. There is no useWiredTool hook.

  clientCapabilities  (registered gadgets the component imports)
    Gadgets the COMPONENT imports — browser-capability HOOKS (e.g., useGeolocation, useCamera, useClipboardWrite, useMicrophone, useFilePicker, useClipboardPaste, useNotifications) AND operator-registered COMPONENT gadgets (charts, maps, rich-text editors — PascalCase exports the component renders as JSX). The wire map "gadgets" is PACKAGE-KEYED two-level: clientCapabilities.gadgets[<packageName>][<exportName>] = {}. The npm package name keys the outer map; the export name keys the inner map (a "use"-prefixed key is a hook the component CALLS, a PascalCase key is a component the component RENDERS as JSX). The wire carries identity only — no "version", no "permission".
    Gadget values reach the agent ONLY when the component code threads them into a contextSpec slot or an actionSpec payload.

ANTI-PATTERNS — DO NOT EMIT

Several retired field/hook names appear in older training data. The cross-ref linter rejects them at push:
  - wiredTools / agentTools / clientTools             (retired catalog names; use agentCapabilities.tools / clientCapabilities.gadgets)
  - clientCapabilities.capabilities                    (retired inner key; use clientCapabilities.gadgets)
  - useWiredTool(...) / useClientTool(...) / useAgentTool(...)  (retired hooks; the contract layer doesn't reference these at all)
  - "@ggui-ai/client-tools" as a package import        (retired package; use @ggui-ai/gadgets)
  - PushStory / story.* on handshake input             (retired wire shape; handshake input is flat — {sessionId, intent, contract?, hint?, forceCreate?})
  - story.adapters / declaredAdapters                  (retired adapter gate; permissions are a registry-side descriptor field — the wire clientCapabilities.gadgets map carries identity only)
  - dispatch: {kind: 'tool', tool: ...}               (retired discriminated union on actionSpec entries — actions carry NO tool wiring)
  - dispatch: {kind: 'agent', intendedTool: ...}      (retired — same; do not wire actions to tools)
  - actionSpec[X].nextStep                            (the synthesizer does NOT emit nextStep — the cold path has no agent toolbox to point at; the agent reacts to the action on its next turn)
  - mode: 'host-routed'                                (retired; all actions are agent-routed)
  - interaction: 'display' | 'collect' | 'converse' | 'broadcast' | 'flow'   (retired top-level field; the four specs ARE the model — there is no interaction-mode enum)
  - broadcast: { ... }                                 (retired top-level field; use streamSpec[X].source)
  - props: { properties: ... } as a CONTRACT field    (retired contract-side spelling; the contract field is propsSpec — note the wire field on push/update is still "props" carrying VALUES)

OUTPUT RULES

1. Output exactly ONE tool call carrying the synthesized contract.

2. All four specs are optional. Omit any spec the intent does not justify — under-declaration is the safe default; the agent can author a richer contract on the next push if needed.

3. For actionSpec entries, "label" is a short imperative phrase ("Submit the form"). For payload-carrying actions (send, search, delete-by-id), declare the fields under {type: "object", properties: {…}, required: […]}. For payload-less event actions (submit, save, cancel, confirm, finalize), use {type: "object", properties: {}, additionalProperties: false}.

4. For contextSpec entries, "schema" matches the slot's data shape ({type: "number"} for a count, {type: "string"} for text, {type: "array"} for a list) and "default" is a sensible initial value.

5. For streamSpec entries, "schema" describes the payload shape per delivery. When a channel declares a "source", its "schema" MUST be the same shape as the source tool's agentCapabilities outputSchema — a mismatch is rejected at push (CTR_SCHEMA_INCOMPAT).

6. Every "schema" you emit — on ANY spec — must be valid JSON Schema. The "type" field is exactly ONE of these seven strings: "string", "number", "integer", "boolean", "array", "object", "null". Never invent a type ("list", "feed", "enum", "any") and never emit "type" as an array of strings. A field limited to a fixed set of values keeps a real base type and lists the values separately: {type: "string", enum: ["waiting", "playing", "done"]} — NOT {type: "enum"}. A nullable field is just its base type: {type: "string"} — NOT {type: ["string", "null"]}. An invalid schema makes the whole contract fail validation and the synthesizer declines.

7. Declare agentCapabilities.tools entries ONLY to back a source-fed streamSpec channel — i.e. when streamSpec[X].source.tool names the tool. Every source.tool reference MUST resolve to a catalog entry on the same contract — the cross-ref linter rejects dangling references at push. Catalog entries declare {inputSchema?, outputSchema?, usage?}; the agent owns the call. Do NOT declare agentCapabilities for any other reason.

8. Declare clientCapabilities entries ONLY when the intent names a gadget the UI imports — a browser capability (camera, mic, geolocation, clipboard, file picker, notifications) OR an operator-registered gadget shown in the AVAILABLE GADGETS list on the user prompt (a chart, a map, a rich-text editor). The v1 stdlib catalog from @ggui-ai/gadgets ships these hooks: useGeolocation, useClipboardWrite, useClipboardPaste, useNotifications, useFilePicker, useMicrophone, useCamera — declare them under clientCapabilities.gadgets["@ggui-ai/gadgets"][<hookName>] = {}. Operator-registered gadgets (hooks OR PascalCase components) declare under their own package key — clientCapabilities.gadgets[<package>][<exportName>] = {} — using the exact package + export names from the AVAILABLE GADGETS list. Package name keys the outer map, export name keys the inner map.

9. The "reason" field is a short operator-facing explanation for why these specs were chosen. Mention the discrimination rule explicitly when it bears: "counter is contextSpec-only because the slot mirror IS the wire; no action needed."`;

/**
 * Tool schema the synthesizer's structured-output call uses. The
 * shape mirrors `DataContract` but stays loose at the ToolSchema
 * layer — Anthropic's tool-use adapter doesn't enforce nested
 * required-field rules deeply, and we re-validate on the return path.
 */
export const SYNTHESIZE_TOOL: ToolSchema = {
  name: 'submit_inferred_contract',
  description:
    'Submit your inferred contract. Include only the four-spec fields the intent explicitly justifies; omit the rest.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      actionSpec: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            schema: { type: 'object' },
          },
          required: ['label'],
        },
        description:
          'Map of action name → {label, schema?}. Each action becomes a useAction(name) hook the generator can wire to UI elements.',
      },
      contextSpec: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            schema: { type: 'object' },
          },
          required: ['schema'],
        },
        description:
          'Map of slot name → {schema, default?}. Each slot mirrors back to the agent\'s context via a useGguiContext(name) hook.',
      },
      streamSpec: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          properties: {
            schema: { type: 'object' },
            source: {
              type: 'object',
              description:
                'Optional source declaration when the channel is fed by a polling / subscribing agentCapabilities.tools entry. Declare for live-refreshing data sources (ticker, polling table, dashboard). The runtime negotiates transport (WebSocket subscribe vs iframe polling).',
              properties: {
                tool: {
                  type: 'string',
                  description:
                    'agentCapabilities.tools[*] key — MUST be declared on the same contract.',
                },
                args: {
                  type: 'object',
                  description:
                    'Arguments passed to the source tool on each invocation.',
                },
              },
              required: ['tool'],
            },
          },
          required: ['schema'],
        },
        description:
          'Map of channel name → {schema, source?}. Each channel becomes a useStream(name) hook the agent pushes to via ggui_emit OR the runtime feeds from source.tool. Only declare for live-update UIs (chat, dashboard, broadcast, clock, ticker).',
      },
      agentCapabilities: {
        type: 'object',
        properties: {
          tools: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                inputSchema: { type: 'object' },
                outputSchema: { type: 'object' },
                usage: { type: 'string' },
              },
            },
            description:
              'Per-tool map: name → {inputSchema?, outputSchema?, usage?}. Catalog only — the agent owns invocation. Declare an entry for EVERY tool a nextStep / source points at: each actionSpec[X].nextStep AND each streamSpec[X].source.tool — referencing an undeclared tool fails the cross-reference check.',
          },
        },
        description:
          'Catalog of agent-invoked tools the contract references. The component code does NOT call these directly. Required whenever any actionSpec.nextStep or streamSpec.source.tool names a tool.',
      },
      clientCapabilities: {
        type: 'object',
        properties: {
          gadgets: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  description: {
                    type: 'string',
                    description:
                      'Optional intent-specific override of the registered export description.',
                  },
                  usage: {
                    type: 'string',
                    description:
                      'Optional intent-specific override of the registered usage hint.',
                  },
                },
              },
              description:
                'Per-package export map: exportName → {description?, usage?}. The export name is the key — `use`-prefixed for a hook, PascalCase for a component.',
            },
            description:
              'Package-keyed two-level map: packageName → exportName → {description?, usage?}. The npm package name keys the outer map; the export name keys the inner map (e.g. {"@ggui-ai/gadgets": {"useGeolocation": {}}}). The component imports the export and threads the result into a contextSpec slot or actionSpec payload.',
          },
        },
        description:
          'Catalog of browser-capability gadgets the component code mounts (camera, mic, geolocation, clipboard, file picker, notifications). Declare ONLY when the intent names a browser capability.',
      },
      propsSpec: {
        type: 'object',
        properties: {
          properties: {
            type: 'object',
            additionalProperties: {
              type: 'object',
              properties: {
                schema: { type: 'object' },
                required: { type: 'boolean' },
              },
              required: ['schema'],
            },
            description:
              'Per-prop map: name → {schema, required?}. Declares the initial render data the agent passes at push time.',
          },
        },
        description:
          'Agent-OWNED data the UI displays — the initial values seeded at render, refreshed any time after via ggui_update. NOT static-only: mutable collections the agent owns / fetched / keeps in sync (my todos, the cart, this thread\'s messages, a directory listing) go here too — propsSpec is the ONLY agent→client data channel. Use whenever the agent is the SOURCE of the displayed data (weather card → city/temp; profile → name/avatar; "my todos" → todos). Omit only when the UI originates its own state with no agent-supplied contents (a counter, a blank notepad, a list the user builds locally).',
      },
      reason: {
        type: 'string',
        description:
          'Brief explanation — one sentence — for why these specs were chosen. Operator-facing.',
      },
    },
    required: ['reason'],
  },
};

interface SynthesizeToolInput {
  readonly actionSpec?: Record<
    string,
    { label: string; schema?: unknown }
  >;
  readonly contextSpec?: Record<string, { schema: unknown; default?: unknown }>;
  readonly streamSpec?: Record<
    string,
    {
      schema: unknown;
      source?: { tool: string; args?: Record<string, unknown> };
    }
  >;
  readonly propsSpec?: {
    properties?: Record<string, { schema: unknown; required?: unknown }>;
  };
  readonly agentCapabilities?: {
    tools?: Record<
      string,
      { inputSchema?: unknown; outputSchema?: unknown; usage?: string }
    >;
  };
  readonly clientCapabilities?: {
    // The wire `clientCapabilities.gadgets` is a PACKAGE-KEYED
    // two-level map — `Record<packageName, Record<exportName,
    // GadgetExportUse>>`. The export NAME is the inner key (its grammar
    // discriminates kind: `use`-prefixed = hook, PascalCase =
    // component). The only wire-authored payload per export is optional
    // `description` / `usage` override prose — no `version`, no
    // `permission`, no `hook`/`component` field.
    gadgets?: Record<
      string,
      Record<string, { description?: string; usage?: string }>
    >;
  };
  readonly reason: string;
}

/**
 * Synthesis attempt budget — 1 initial call + up to 4 feedback-driven
 * repair retries. The retry fires only on the rare path where an
 * attempt fails the validation gate, so the extra calls cost nothing
 * on the common (already-valid) path.
 */
const MAX_SYNTH_ATTEMPTS = 5;

/**
 * Compose the repair note appended to the next attempt's user prompt:
 * the rejected contract plus the precise failure reason. Feeding the
 * model its own output and the validator's verdict lets it correct the
 * exact problem — the synthesizer's self-check feedback loop. The
 * contract JSON is capped so a pathological contract can't blow the
 * prompt budget.
 */
function buildRepairNote(rejected: unknown, failure: string): string {
  const json = JSON.stringify(rejected);
  const capped = json.length > 3000 ? `${json.slice(0, 3000)}…` : json;
  return [
    'YOUR PREVIOUS ATTEMPT was rejected. You returned this contract:',
    capped,
    '',
    `Reason — ${failure}`,
    '',
    'Emit a corrected contract that fixes exactly this problem. Keep every other spec unchanged.',
  ].join('\n');
}

/**
 * PATCH-MODE preamble (L2) — prepended to the system prompt ONLY on the
 * repair path (a draft is present). The cold-path system prompt is an
 * "infer a contract from intent" authoring brief; reusing it verbatim
 * for repair invites the model to RE-AUTHOR and reshape a near-correct
 * draft (e.g. move a propsSpec collection to contextSpec). This preamble
 * reframes the task as a minimal patch, which — together with the
 * deterministic preservation gate — keeps the repair faithful.
 */
const REPAIR_PREAMBLE = `PATCH MODE — you are REPAIRING a contract the agent already authored, NOT writing a new one from scratch.
- Change as LITTLE as possible. Fix ONLY the specific findings listed in the user message.
- PRESERVE every spec the agent declared — ESPECIALLY every propsSpec property (agent-owned render-time seed data the UI needs). Never drop it.
- Do NOT move data between specs (e.g. propsSpec → contextSpec) unless a finding explicitly requires it. A collection the agent supplies on propsSpec STAYS on propsSpec.
- Keep the agent's names, shapes, and structure intact wherever the findings do not force a change.
The four-spec model and placement rules below still hold — but in PATCH MODE they are guardrails for the fix, not a license to re-author.`;

/**
 * Preservation-failure repair note (L1) — drives a corrective retry when
 * a VALID candidate dropped an agent-owned propsSpec seed surface. Names
 * the exact missing keys so the model restores them, rather than the
 * generic "fix this validation error" note (the candidate IS valid; the
 * problem is round-trip fidelity the gate can't express).
 */
function buildPreservationRepairNote(
  rejected: unknown,
  dropped: readonly string[],
): string {
  const json = JSON.stringify(rejected);
  const capped = json.length > 3000 ? `${json.slice(0, 3000)}…` : json;
  return [
    'YOUR PREVIOUS ATTEMPT dropped agent-owned render-time data. You returned this contract:',
    capped,
    '',
    `The agent's draft declared these on propsSpec (agent-owned seed data the UI renders): ${dropped.join(', ')}. Your contract no longer carries them as propsSpec properties — so the agent can no longer seed them at render. contextSpec has NO agent seed channel, so moving them there leaves the UI empty.`,
    '',
    `Re-emit the contract with ${dropped.join(', ')} restored as propsSpec properties (agent-owned, seeded at render and refreshed via ggui_update). Keep every other spec unchanged.`,
  ].join('\n');
}

/**
 * Compose the FIRST-attempt repair note for the forgiving-handshake
 * path: the agent PROPOSED a contract that failed deterministic
 * validation. Unlike {@link buildRepairNote} (which frames the input as
 * "your previous attempt"), this frames it as the AGENT'S draft to be
 * repaired in place — preserve intent + structure, fix exactly the
 * listed findings. The draft JSON is capped to bound the prompt.
 */
function buildDraftSeedNote(
  draft: unknown,
  findings: readonly { code: string; path: string; message: string }[],
): string {
  const json = JSON.stringify(draft);
  const capped = json.length > 3000 ? `${json.slice(0, 3000)}…` : json;
  const findingsText =
    findings.length > 0
      ? findings.map((f) => `[${f.code}] ${f.path}: ${f.message}`).join('; ')
      : '(unspecified — re-derive a valid contract for the intent)';
  return [
    'The agent PROPOSED this contract, but it failed deterministic validation:',
    capped,
    '',
    `Validation findings — ${findingsText}`,
    '',
    "Repair it: keep the agent's intent and as much of their structure (spec names, schemas, labels) as possible, fix EXACTLY these findings, and return a valid contract. Do not add unrelated specs.",
  ].join('\n');
}

/**
 * Invoke the synthesize tool — structured output when the provider
 * supports it, else a text-JSON fallback. Forced tool use is
 * Anthropic / Bedrock-only today; gemini / openai / openrouter callers
 * reach this via the text path (the model emits one JSON object, which
 * we regex-extract + parse). Lower reliability than forced tool use,
 * but the bounded validate-and-repair loop catches malformed output and
 * retries — so repair works on every provider instead of no-op'ing
 * off-Anthropic.
 */
async function callSynthesizeTool(
  llm: LLMCaller,
  system: string,
  user: string,
): Promise<unknown> {
  if (typeof llm.callStructured === 'function') {
    return llm.callStructured<SynthesizeToolInput>(
      system,
      user,
      SYNTHESIZE_TOOL,
      1024,
    );
  }
  const text = await llm.call(
    system,
    `${user}\n\nRespond with ONE JSON object only (no prose, no code fence) carrying the synthesized contract: {actionSpec?, contextSpec?, streamSpec?, propsSpec?, agentCapabilities?, clientCapabilities?, reason}. Every spec entry wraps its JSON Schema under a "schema" field.`,
    1024,
  );
  return extractJsonObject(text);
}

/**
 * Thrown by {@link extractJsonObject} when the text-fallback response
 * carries no parseable JSON object — distinct from a transient network
 * throw so the repair loop knows to feed a corrective "emit pure JSON"
 * note (a network retry re-sends the same prompt instead).
 */
class SynthesizeTextParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SynthesizeTextParseError';
  }
}

/**
 * Robustly extract one JSON object from a possibly-prose-wrapped model
 * response. A naive greedy `/\{[\s\S]*\}/` over-captures (first `{` to
 * LAST `}`), throwing on "prose with a brace before the JSON" or "two
 * objects". This tries, in order: (1) parse the trimmed text directly;
 * (2) parse the contents of a ```json fence; (3) scan from the first `{`
 * for the BALANCED closing `}` (string/escape aware). Throws only when
 * nothing parses — the bounded validate-and-repair loop then retries
 * with a corrective note.
 */
function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  // Scan each balanced {...} from each '{' and return the FIRST that
  // parses — robust against prose braces BEFORE the JSON (e.g. "{your
  // widget}: {...}") and a trailing second object.
  let searchFrom = 0;
  for (;;) {
    const start = trimmed.indexOf('{', searchFrom);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break; // unbalanced from here on
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // not valid JSON from this '{' — advance and try the next one
    }
    searchFrom = start + 1;
  }
  throw new SynthesizeTextParseError(
    `synthesize text-fallback: no parseable JSON object in response (length ${text.length})`,
  );
}

/**
 * Drop `actionSpec` entries the structural validator flags as
 * `redundant-action` — an empty-payload action whose name is a
 * mutator of an existing context slot (e.g. `increment` alongside a
 * `count` slot). By the actions-vs-context placement rule those are
 * not actions at all: the slot setter IS the wire, and a parallel
 * action entry is one the generator wires up incorrectly. Pruning is
 * purely subtractive, so the contract stays schema-valid. Returns the
 * contract unchanged when nothing is redundant.
 */
function pruneRedundantActions(contract: DataContract): DataContract {
  const actionSpec = contract.actionSpec;
  if (actionSpec === undefined) return contract;
  const redundant = new Set<string>();
  for (const f of validateContractStructure(contract).findings) {
    if (f.kind === 'redundant-action' && typeof f.actionName === 'string') {
      redundant.add(f.actionName);
    }
  }
  if (redundant.size === 0) return contract;
  const kept: NonNullable<DataContract['actionSpec']> = {};
  for (const [name, entry] of Object.entries(actionSpec)) {
    if (!redundant.has(name)) kept[name] = entry;
  }
  const next: DataContract = { ...contract };
  if (Object.keys(kept).length > 0) {
    next.actionSpec = kept;
  } else {
    delete next.actionSpec;
  }
  return next;
}

/**
 * Run the synthesizer for a contract-less cold-path handshake.
 *
 * Empty / whitespace intent short-circuits to null with a reason —
 * no contract can be inferred from nothing.
 *
 * Providers without `callStructured` (gemini / openai / openrouter) use
 * a text-JSON fallback (the validate-and-repair loop catches malformed
 * output and retries) rather than skipping synthesis.
 *
 * When `options.draft` is supplied, the loop REPAIRS that draft in
 * place (seeded with the agent's contract + the deterministic findings)
 * instead of synthesizing from `intent` alone — the forgiving-handshake
 * path.
 *
 * Each attempt is self-checked against the validation gate; a failure
 * feeds the precise error back for up to {@link MAX_SYNTH_ATTEMPTS}
 * attempts (a transient `callStructured` throw re-runs the same
 * prompt). Only when the budget is exhausted does it collapse to null
 * — the caller then falls back to an empty contract stub.
 */
export async function synthesizeContract(
  deps: { readonly llm: LLMCaller },
  intent: string,
  options?: {
    /**
     * Per-app gadget catalog (`App.gadgets`) — when bound, synth
     * emits an "AVAILABLE GADGETS" section on the user prompt (NOT
     * the system prompt, so the system-prompt cache stays warm)
     * listing each registered package's exports — hook AND component
     * — with description + usage. The LLM uses this to decide which
     * (if any) `clientCapabilities.gadgets[<package>][<export>]`
     * entries to declare on the synthesized contract. Per-export
     * budget ~300 chars; total budget ~3 KB.
     *
     * When omitted, synth still uses the static stdlib hint baked
     * into SYNTHESIZE_SYSTEM_PROMPT (preserves behavior on the OSS
     * no-app-registry path).
     */
    readonly appGadgets?: readonly GadgetDescriptor[];
    /**
     * Repair-in-place seed. When provided, the synthesizer does NOT
     * synthesize from `intent` alone — it starts from the agent's
     * proposed `draft` and the deterministic findings that rejected it,
     * and the validate-and-repair loop corrects exactly those problems
     * while preserving the agent's intent + structure. This is the
     * forgiving-handshake path: an invalid agent draft is the loop's
     * SEED rather than a thrown error. Absent ⇒ classic
     * synthesize-from-intent (cold path). Typed `unknown` because the
     * agent's draft is untrusted — it may not be a valid DataContract
     * (that's the whole point of repairing it).
     */
    readonly draft?: unknown;
    /**
     * Deterministic validation findings that rejected {@link draft}
     * (from `lintContract(draft).errors`). Fed into the first repair
     * note so the model corrects the precise problems. Ignored when
     * `draft` is absent.
     */
    readonly draftFindings?: readonly {
      readonly code: string;
      readonly path: string;
      readonly message: string;
    }[];
  },
): Promise<SynthesizeContractResult> {
  const startedAt = Date.now();
  const trimmed = intent.trim();
  if (trimmed.length === 0) {
    return {
      contract: null,
      reason: 'synthesize-skip: empty intent',
      latencyMs: Date.now() - startedAt,
      attempts: 0,
      findings: [],
    };
  }

  const gadgetsSection = composeAvailableGadgetsSection(
    options?.appGadgets,
  );
  const baseUserPrompt = `INTENT: ${trimmed}${gadgetsSection ? `\n\n${gadgetsSection}` : ''}`;

  // Bounded validate-and-repair loop. Each attempt is self-checked
  // against the gate below (schema parse + structural / placement /
  // linter validators); on failure the precise error AND the rejected
  // contract are fed back into the next call so the model can correct
  // the exact problem. A `callStructured` throw (transient network)
  // re-runs the same prompt. This mirrors the ui-gen self-check
  // harness shape — there is no patch layer because a DataContract is
  // small enough that a full re-emit IS the surgical edit. Budget
  // exhausted → decline exactly as the one-shot path did (caller falls
  // back to an empty contract stub).
  // Repair-in-place seed: when the caller passed the agent's rejected
  // draft, the loop's FIRST attempt repairs that draft (not a blank
  // synthesis). Later attempts overwrite this via buildRepairNote.
  let repairNote: string | undefined =
    options?.draft !== undefined
      ? buildDraftSeedNote(options.draft, options.draftFindings ?? [])
      : undefined;
  let lastReason = 'synthesize-fail: exhausted repair attempts';
  let lastFindings: readonly ContractValidationFinding[] = [];

  // L2 — repair path uses the PATCH-MODE preamble (minimal patch, no
  // re-author); cold path uses the bare authoring prompt.
  const systemPrompt =
    options?.draft !== undefined
      ? `${REPAIR_PREAMBLE}\n\n${SYNTHESIZE_SYSTEM_PROMPT}`
      : SYNTHESIZE_SYSTEM_PROMPT;

  // L1 — the agent-owned seed surfaces the repaired contract MUST keep,
  // and the best valid-but-non-preserving candidate to fall back on so
  // preservation never makes the result WORSE than the validity-only gate.
  const draftSeedKeys =
    options?.draft !== undefined ? draftSeedPropKeys(options.draft) : [];
  let lastValidContract: DataContract | null = null;

  for (let attempt = 1; attempt <= MAX_SYNTH_ATTEMPTS; attempt++) {
    const userPrompt =
      repairNote === undefined
        ? baseUserPrompt
        : `${baseUserPrompt}\n\n${repairNote}`;

    let toolInput: unknown;
    try {
      toolInput = await callSynthesizeTool(
        deps.llm,
        systemPrompt,
        userPrompt,
      );
    } catch (err) {
      lastReason = `synthesize-fail: callSynthesizeTool threw — ${err instanceof Error ? err.message : String(err)}`;
      // Distinguish causes: an UNPARSEABLE text-path response (model
      // emitted prose/non-JSON — common on gemini/openai via the text
      // fallback) gets a corrective note so the next attempt emits pure
      // JSON. A transient NETWORK failure re-sends the SAME prompt
      // (nothing to correct) — preserving the retry semantics.
      if (err instanceof SynthesizeTextParseError) {
        repairNote =
          'Your previous response could not be parsed as JSON. Respond with EXACTLY ONE JSON object and nothing else — no prose, no explanation, no markdown code fence.';
      }
      continue;
    }

    const parsed = parseToolInput(toolInput);
    if (!parsed) {
      lastReason =
        'synthesize-fail: tool input did not match expected shape';
      repairNote =
        'YOUR PREVIOUS ATTEMPT did not produce a usable submit_inferred_contract call. Call the tool exactly once with a well-formed contract.';
      continue;
    }

    // `buildContract` normalizes every emitted schema (invalid `type`
    // spellings → canonical JSON Schema) before the gate sees it.
    const contract = buildContract(parsed);

    // Defensive gate: re-validate the assembled contract against the
    // canonical schema. Catches LLM outputs that pass the loose tool
    // input_schema but produce structurally invalid contracts. Without
    // this, a garbage contract would flow through plan.contract → push
    // → registry, polluting the operator surface and downstream
    // validators with shape they can't reason about.
    const validated = dataContractSchema.safeParse(contract);
    if (!validated.success) {
      const errText = validated.error.message.slice(0, 400);
      lastReason = `synthesize-fail: assembled contract failed schema validation — ${errText.slice(0, 200)}`;
      repairNote = buildRepairNote(
        contract,
        `it failed JSON Schema validation: ${errText}`,
      );
      continue;
    }

    // Programmatic safety detectors. The structural validator catches
    // over-specified contracts the schema layer can't reason about;
    // the actions-vs-context validator catches placement-rule
    // violations; the protocol linter catches CTR_REF_* / CTR_DUP_NAME
    // / CTR_RESERVED_NAME / CTR_SCHEMA_INCOMPAT errors + LINT_* warns.
    // Warnings ride along on the reason string; errors trigger a
    // repair retry.
    // Deterministically prune redundant mutator-actions before the
    // validators run — enforces the actions-vs-context placement rule
    // (a counter is contextSpec-only) without depending on the LLM to
    // get it right every draw. Subtractive, so the contract stays
    // schema-valid.
    const validatedContract = pruneRedundantActions(
      validated.data as DataContract,
    );
    const structureSafety = validateContractStructure(validatedContract);
    const placementSafety = validateActionsVsContext(validatedContract);
    // Intent-aware coherence — the one validator that reads `trimmed`.
    // Catches the degenerate "actionSpec-only, no data surface"
    // contract; its error finding drives a repair retry.
    const coherenceSafety = validateContractCoherence(
      validatedContract,
      trimmed,
    );
    const linterResult = lintContract(validatedContract);
    const allFindings: ContractValidationFinding[] = [
      ...structureSafety.findings,
      ...placementSafety.findings,
      ...coherenceSafety.findings,
      ...linterResult.errors.map(contractIssueToFinding),
      ...linterResult.warnings.map(contractIssueToFinding),
    ];
    const errorFindings = allFindings.filter((f) => f.severity === 'error');
    if (errorFindings.length > 0) {
      const errText = formatValidationFindings({ findings: errorFindings });
      lastReason = `synthesize-fail-validator: ${errText}`;
      lastFindings = allFindings;
      repairNote = buildRepairNote(
        validatedContract,
        `it failed contract validation: ${errText}`,
      );
      continue;
    }

    // L1 — preservation gate (best-effort). The candidate is VALID, but
    // a repair must not silently drop an agent-owned seed surface the
    // draft declared on propsSpec (the valid-but-round-trip-broken
    // reshape lintContract + the placement validators can't see).
    // Deterministic + model-independent: it drives a corrective retry.
    if (draftSeedKeys.length > 0) {
      const dropped = findDroppedSeedSurfaces(options?.draft, validatedContract);
      if (dropped.length > 0) {
        // Remember the best VALID candidate so an exhausted budget never
        // returns WORSE than the validity-only gate did (a valid contract).
        lastValidContract = validatedContract;
        lastReason = `synthesize-preservation: candidate dropped agent-owned propsSpec seed surface(s) [${dropped.join(', ')}]`;
        lastFindings = allFindings;
        repairNote = buildPreservationRepairNote(validatedContract, dropped);
        continue;
      }
    }

    const findingsSuffix =
      allFindings.length > 0
        ? ` — validator: ${formatValidationFindings({ findings: allFindings })}`
        : '';
    const repairedSuffix =
      attempt > 1 ? ` (repaired on attempt ${attempt})` : '';

    return {
      contract: validatedContract,
      reason: `synthesize-ok${repairedSuffix}: ${parsed.reason}${findingsSuffix}`,
      latencyMs: Date.now() - startedAt,
      attempts: attempt,
      findings: allFindings,
    };
  }

  // Budget exhausted. If preservation retries never landed a contract
  // that kept every seed surface, fall back to the best VALID candidate
  // we did produce (never worse than the validity-only gate). Only when
  // no valid candidate ever appeared do we decline with `null`.
  return {
    contract: lastValidContract,
    reason:
      lastValidContract !== null
        ? `${lastReason}; returned best valid candidate (preservation retries exhausted)`
        : lastReason,
    latencyMs: Date.now() - startedAt,
    attempts: MAX_SYNTH_ATTEMPTS,
    findings: lastFindings,
  };
}

function parseToolInput(raw: unknown): SynthesizeToolInput | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const reason = typeof obj['reason'] === 'string' ? obj['reason'] : '';

  const actionSpecRaw = obj['actionSpec'];
  const actionSpec =
    typeof actionSpecRaw === 'object' &&
    actionSpecRaw !== null &&
    !Array.isArray(actionSpecRaw)
      ? (actionSpecRaw as Record<string, { label: string; schema?: unknown }>)
      : undefined;

  const contextSpecRaw = obj['contextSpec'];
  const contextSpec =
    typeof contextSpecRaw === 'object' &&
    contextSpecRaw !== null &&
    !Array.isArray(contextSpecRaw)
      ? (contextSpecRaw as Record<
          string,
          { schema: unknown; default?: unknown }
        >)
      : undefined;

  const streamSpecRaw = obj['streamSpec'];
  const streamSpec =
    typeof streamSpecRaw === 'object' &&
    streamSpecRaw !== null &&
    !Array.isArray(streamSpecRaw)
      ? (streamSpecRaw as Record<string, { schema: unknown }>)
      : undefined;

  // propsSpec is wrapper-shaped: {properties: {name: {schema, required?}}}.
  // Extract `properties` defensively — LLMs sometimes flatten the wrapper.
  // The tool-schema field is `propsSpec` (matching the contract field);
  // reading `props` here silently dropped every synthesized propsSpec.
  const propsRaw = obj['propsSpec'];
  let propsProperties:
    | Record<string, { schema: unknown; required?: unknown }>
    | undefined;
  if (typeof propsRaw === 'object' && propsRaw !== null && !Array.isArray(propsRaw)) {
    const inner = (propsRaw as { properties?: unknown }).properties;
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      propsProperties = inner as Record<
        string,
        { schema: unknown; required?: unknown }
      >;
    }
  }

  // agentCapabilities is wrapper-shaped: {tools: {name: {inputSchema?, outputSchema?, usage?}}}.
  // Extract `tools` defensively so the synthesized contract surfaces the catalog
  // when the LLM emits it (previously dropped silently — caused empty
  // agentCapabilities even when the LLM authored entries).
  const agentCapsRaw = obj['agentCapabilities'];
  let agentTools:
    | Record<string, { inputSchema?: unknown; outputSchema?: unknown; usage?: string }>
    | undefined;
  if (typeof agentCapsRaw === 'object' && agentCapsRaw !== null && !Array.isArray(agentCapsRaw)) {
    const inner = (agentCapsRaw as { tools?: unknown }).tools;
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      agentTools = inner as Record<
        string,
        { inputSchema?: unknown; outputSchema?: unknown; usage?: string }
      >;
    }
  }

  // clientCapabilities is wrapper-shaped:
  // {gadgets: {packageName: {exportName: {description?, usage?}}}}.
  // The wire map is PACKAGE-KEYED two-level — the outer key is
  // the npm package name, the inner key is the export name. Extract
  // `gadgets` defensively so the synthesized contract surfaces the
  // browser-capability gadgets the LLM declared.
  const clientCapsRaw = obj['clientCapabilities'];
  let gadgets:
    | Record<
        string,
        Record<string, { description?: string; usage?: string }>
      >
    | undefined;
  if (typeof clientCapsRaw === 'object' && clientCapsRaw !== null && !Array.isArray(clientCapsRaw)) {
    const inner = (clientCapsRaw as { gadgets?: unknown }).gadgets;
    if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
      gadgets = inner as Record<
        string,
        Record<string, { description?: string; usage?: string }>
      >;
    }
  }

  return {
    ...(actionSpec ? { actionSpec } : {}),
    ...(contextSpec ? { contextSpec } : {}),
    ...(streamSpec ? { streamSpec } : {}),
    ...(propsProperties ? { propsSpec: { properties: propsProperties } } : {}),
    ...(agentTools ? { agentCapabilities: { tools: agentTools } } : {}),
    ...(gadgets ? { clientCapabilities: { gadgets: gadgets } } : {}),
    reason,
  };
}

/**
 * Reconcile source-fed `streamSpec` channels with their backing tool.
 *
 * When a channel declares `source.tool`, the runtime feeds that tool's
 * output straight onto the channel — the channel's `schema` and the
 * tool's `outputSchema` describe one and the same payload. The LLM
 * occasionally emits them with mismatched root types (channel `object`
 * vs tool `array`), which the cross-ref linter rejects as
 * `CTR_SCHEMA_INCOMPAT`. Sync them deterministically: the tool's
 * `outputSchema` is authoritative (the tool IS the data source); when
 * only the channel carries a shape, propagate it to the tool. Mutates
 * `input` in place — a freshly-parsed object owned by the caller.
 */
function reconcileSourceSchemas(input: SynthesizeToolInput): void {
  const streams = input.streamSpec;
  const tools = input.agentCapabilities?.tools;
  if (streams === undefined || tools === undefined) return;
  for (const channel of Object.values(streams)) {
    const toolName = channel?.source?.tool;
    if (typeof toolName !== 'string') continue;
    const tool = tools[toolName];
    if (tool === undefined || tool === null || typeof tool !== 'object') {
      continue;
    }
    if (tool.outputSchema !== undefined && tool.outputSchema !== null) {
      channel.schema = tool.outputSchema;
    } else if (channel.schema !== undefined && channel.schema !== null) {
      tool.outputSchema = channel.schema;
    }
  }
}

function buildContract(input: SynthesizeToolInput): DataContract {
  // Sync source-fed channels with their backing tool BEFORE building,
  // so the channel schema and the tool outputSchema are emitted from
  // one shared shape — eliminates CTR_SCHEMA_INCOMPAT deterministically.
  reconcileSourceSchemas(input);
  const contract: DataContract = {};
  if (input.actionSpec && Object.keys(input.actionSpec).length > 0) {
    const built: Record<
      string,
      { label: string; schema: unknown;  }
    > = {};
    for (const [name, entry] of Object.entries(input.actionSpec)) {
      // Honor the synthesizer's declared schema when present — the
      // intent might call for a payload (chip text, query, item id)
      // and the LLM correctly inferred it. Fall back to a payload-
      // less object schema when the LLM didn't supply one (most
      // pure-UI buttons like increment/reset/submit don't carry data).
      // The contract validator requires a schema field on every
      // actionSpec entry so the fallback is the only safe default.
      const supplied = normalizeSchema(entry.schema);
      const schema = isObjectSchema(supplied)
        ? supplied
        : { type: 'object', properties: {}, additionalProperties: false };
      built[name] = { label: entry.label, schema };
    }
    contract.actionSpec = built as DataContract['actionSpec'];
  }
  if (input.contextSpec && Object.keys(input.contextSpec).length > 0) {
    const built: Record<string, { schema: unknown; default?: unknown }> = {};
    for (const [name, entry] of Object.entries(input.contextSpec)) {
      built[name] = {
        schema: normalizeSchema(entry.schema),
        ...(entry.default !== undefined ? { default: entry.default } : {}),
      };
    }
    contract.contextSpec = built as DataContract['contextSpec'];
  }
  if (input.streamSpec && Object.keys(input.streamSpec).length > 0) {
    const built: Record<
      string,
      {
        schema: unknown;
        source?: { tool: string; args?: Record<string, unknown> };
      }
    > = {};
    for (const [name, entry] of Object.entries(input.streamSpec)) {
      // Defensive: skip entries without a usable schema. Channel
      // delivery validation requires a schema; emitting `{schema:
      // undefined}` would break runtime fan-out at first delivery.
      if (entry?.schema === undefined || entry.schema === null) continue;
      built[name] = {
        schema: normalizeSchema(entry.schema),
        // Thread `source` through — a source-fed channel (ticker,
        // polling table) is wired to an agentCapabilities.tools entry
        // via source.tool; dropping it silently de-wires the channel.
        ...(entry.source ? { source: entry.source } : {}),
      };
    }
    if (Object.keys(built).length > 0) {
      contract.streamSpec = built as DataContract['streamSpec'];
    }
  }
  if (
    input.propsSpec?.properties &&
    Object.keys(input.propsSpec.properties).length > 0
  ) {
    const built: Record<
      string,
      { schema: unknown; required?: boolean }
    > = {};
    for (const [name, entry] of Object.entries(input.propsSpec.properties)) {
      if (entry?.schema === undefined || entry.schema === null) continue;
      built[name] = {
        schema: normalizeSchema(entry.schema),
        ...(entry.required === true ? { required: true } : {}),
      };
    }
    if (Object.keys(built).length > 0) {
      contract.propsSpec = {
        properties: built,
      } as DataContract['propsSpec'];
    }
  }
  // agentCapabilities.tools — catalog the LLM authored to back a
  // source-fed streamSpec channel (streamSpec[*].source.tool). The
  // catalog populates from the LLM tool input; the synthesizer does
  // not wire actions to tools (no nextStep on the cold path).
  if (
    input.agentCapabilities?.tools &&
    Object.keys(input.agentCapabilities.tools).length > 0
  ) {
    const built: Record<string, AgentToolEntry> = {};
    for (const [name, entry] of Object.entries(input.agentCapabilities.tools)) {
      if (!entry || typeof entry !== 'object') continue;
      // The LLM authors the ergonomic flat shape ({inputSchema?,
      // outputSchema?, usage?}); the wire shape nests the MCP descriptor
      // under `toolInfo` with a REQUIRED `inputSchema` (default the
      // void-object schema when the LLM omitted it). `usage` stays on the
      // ggui authoring layer alongside the descriptor.
      const inputSchema = (entry.inputSchema !== undefined
        ? normalizeSchema(entry.inputSchema)
        : { type: 'object' }) as JsonSchema;
      built[name] = {
        toolInfo: {
          inputSchema,
          ...(entry.outputSchema !== undefined
            ? { outputSchema: normalizeSchema(entry.outputSchema) as JsonSchema }
            : {}),
        },
        ...(typeof entry.usage === 'string' ? { usage: entry.usage } : {}),
      };
    }
    if (Object.keys(built).length > 0) {
      contract.agentCapabilities = { tools: built };
    }
  }
  // clientCapabilities.gadgets — browser-capability gadgets the
  // component imports. The wire map is PACKAGE-KEYED two-level
  // (`Record<packageName, Record<exportName, GadgetExportUse>>`). The
  // outer key is the npm package, the inner key is the export name
  // (its grammar discriminates kind — `use`-prefixed hook or
  // PascalCase component); the only wire-authored payload per export
  // is optional `description` / `usage` override prose.
  if (
    input.clientCapabilities?.gadgets &&
    Object.keys(input.clientCapabilities.gadgets).length > 0
  ) {
    const built: Record<
      string,
      Record<string, { description?: string; usage?: string }>
    > = {};
    for (const [pkgName, packageUse] of Object.entries(
      input.clientCapabilities.gadgets,
    )) {
      if (
        !packageUse ||
        typeof packageUse !== 'object' ||
        Array.isArray(packageUse)
      ) {
        continue;
      }
      const exportsBuilt: Record<
        string,
        { description?: string; usage?: string }
      > = {};
      for (const [exportName, use] of Object.entries(packageUse)) {
        if (!use || typeof use !== 'object' || Array.isArray(use)) continue;
        exportsBuilt[exportName] = {
          ...(typeof use.description === 'string'
            ? { description: use.description }
            : {}),
          ...(typeof use.usage === 'string' ? { usage: use.usage } : {}),
        };
      }
      if (Object.keys(exportsBuilt).length > 0) {
        built[pkgName] = exportsBuilt;
      }
    }
    if (Object.keys(built).length > 0) {
      contract.clientCapabilities = {
        gadgets: built,
      } as DataContract['clientCapabilities'];
    }
  }
  return contract;
}

/** Narrow check that the LLM-supplied schema is an object-shaped JSON
 *  Schema we can pass through. Garbage falls back to the payload-less
 *  default — defensive against LLMs that return strings or arrays
 *  under `schema`. */
function isObjectSchema(value: unknown): value is { type: 'object'; properties?: unknown } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const t = (value as { type?: unknown }).type;
  return t === 'object';
}

/** Per-export budget (chars) for the synth-prompt teaching section.
 *  Description always preserved; usage truncated last when over
 *  budget. Keeps prompt bloat bounded across large registries. */
const SYNTH_PER_LIBRARY_BUDGET = 300;
/** Total cap for the AVAILABLE GADGETS section. Excess entries
 *  silently truncated to keep the prompt tractable. */
const SYNTH_TOTAL_BUDGET = 3_000;

/**
 * Compose the "AVAILABLE GADGETS" section appended to synth's user
 * prompt. Flattens the package-keyed
 * {@link GadgetDescriptor} catalog into one line per export:
 *
 *     - hook `useGeolocation` (package `@ggui-ai/gadgets`) — <desc> (usage: <usage>)
 *     - component `Chart` (package `@acme/charts`) — <desc> (usage: <usage>)
 *
 * The leading `hook` / `component` tag teaches the LLM the two render
 * idioms (a hook is CALLED, a component is RENDERED as JSX); the
 * `(package …)` tag carries the npm package name the LLM needs to
 * author the package-keyed
 * `clientCapabilities.gadgets[<package>][<export>]` wire entry.
 *
 * Budget enforcement: per-export text capped at
 * {@link SYNTH_PER_LIBRARY_BUDGET}, total section capped at
 * {@link SYNTH_TOTAL_BUDGET}.
 *
 * Returns `undefined` when the catalog is empty / every export lacks
 * teaching text — the caller then omits the section entirely
 * (preserves the no-registry prompt verbatim for cache hit).
 *
 * Pure helper; exported for the prompt-builder unit test.
 */
export function composeAvailableGadgetsSection(
  gadgets: readonly GadgetDescriptor[] | undefined,
): string | undefined {
  if (!gadgets || gadgets.length === 0) return undefined;

  const lines: string[] = [];
  let total = 0;
  outer: for (const descriptor of gadgets) {
    for (const exp of descriptor.exports) {
      // Field-presence discrimination — `{hook}` vs `{component}`. The
      // export-name grammar is itself kind-disjoint, but the explicit
      // tag spares the LLM having to re-derive it.
      const kind = 'hook' in exp ? 'hook' : 'component';
      const name = gadgetExportName(exp);
      const desc = (exp.description ?? '').trim();
      const usage = (exp.usage ?? '').trim();
      if (desc.length === 0 && usage.length === 0) continue;

      let entry = `- ${kind} \`${name}\` (package \`${descriptor.package}\`) — ${desc || '(no description)'}`;
      if (usage.length > 0) {
        // Reserve budget for description first; truncate usage if needed.
        const remaining = SYNTH_PER_LIBRARY_BUDGET - entry.length;
        if (remaining > 16) {
          const tail =
            usage.length <= remaining - 9
              ? usage
              : `${usage.slice(0, remaining - 12)}…`;
          entry += ` (usage: ${tail})`;
        }
      }
      if (entry.length > SYNTH_PER_LIBRARY_BUDGET) {
        entry = `${entry.slice(0, SYNTH_PER_LIBRARY_BUDGET - 1)}…`;
      }
      if (total + entry.length + 1 > SYNTH_TOTAL_BUDGET) break outer;
      lines.push(entry);
      total += entry.length + 1;
    }
  }

  if (lines.length === 0) return undefined;
  // Surface the two render idioms so synth-emitted contracts match what
  // the code-gen boilerplate direct-imports from each gadget package.
  // Hooks implement `GadgetHook<TOutput, TOptions>` (lifecycle envelope
  // of `{ status, value, error, start, stop }`) and are CALLED;
  // components are RENDERED as JSX. Values reach the agent only via
  // `contextSpec` / `actionSpec` threading.
  const protocolHint =
    'Hooks (`use`-prefixed) are CALLED — `import { useGeolocation } from \'<package>\';` then `useGeolocation()`; each returns a `GadgetHook<TOutput, TOptions>` envelope `{ status, value, error, start, stop }`. Components (PascalCase) are RENDERED as JSX — `import { Chart } from \'<package>\';` then `<Chart … />`. UI code direct-imports each export from its gadget package; gadget values reach the agent only when threaded into a contextSpec slot or actionSpec payload.';
  return `AVAILABLE GADGETS (declare under clientCapabilities.gadgets[<package>][<export>] when the intent justifies):\n${lines.join('\n')}\n\n${protocolHint}`;
}
