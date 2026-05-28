/**
 * Server-level instructions presets for the MCP `InitializeResult.
 * instructions` field.
 *
 * **What this string does**: per the MCP spec
 * (`@modelcontextprotocol/sdk/types.js`), `instructions` is "a hint to
 * the model" that hosts MAY add to the system prompt. Its job is to
 * help the LLM **understand the server's tools and protocol**. It is
 * NOT an enforcement mechanism — the LLM weighs it against the host's
 * own system prompt, the user's chat-level instructions, and built-in
 * tool-selection priors.
 *
 * **Difference from per-tool description**: per-tool descriptions
 * answer "what does THIS tool do?" Server instructions answer "what is
 * this server, and how do its tools fit together?" Both are spec-
 * defined hints, both compose into the same system prompt.
 *
 * **Why presets explain protocol, not behavior**: previous iterations
 * tried to nudge the LLM to "render every response" via imperative
 * language. In observed practice this is worth less than a single
 * line of user-side custom instruction, AND the spec doesn't promise
 * the field has that pull. Honest framing: the presets explain what
 * ggui is, how the three lifecycle tools relate, and how rendered UIs
 * route actions/streams back. The LLM picks tools when its judgment
 * matches; for stronger pull, ship a recommended user-instruction
 * snippet (see the console `/settings` onboarding card).
 *
 * **Preset depth**:
 *
 *   - `'default'`    — concise protocol explainer (server identity +
 *                      live-UI mechanism + lifecycle bullets).
 *   - `'aggressive'` — adds the action-routing detail.
 *   - `'always'`     — adds a worked invocation example.
 *   - `'minimal'`    — server identity only.
 *   - `'off'`        — omit the field entirely.
 *
 * Names are kept (vs renaming to `verbose` etc.) for compat with the
 * already-shipped `--mcp-instructions` CLI flag and operator configs.
 */

/**
 * Action-routing pattern detail (Pattern α / Pattern β). Layered atop
 * `default` by the `aggressive` and `always` presets — `default`
 * already covers the actionSpec wire shape via the MENTAL MODEL
 * block; this paragraph adds the host-side dispatch semantics that
 * matter when an operator wants the LLM to also reason about how the
 * underlying tools/call envelopes flow.
 */
const ACTION_ROUTING_PARAGRAPH =
  "Action routing: every actionSpec entry is a GESTURE — a discrete event the agent reacts to on its next turn. When the user interacts, the iframe relays the action through `ggui_runtime_submit_action` to the server, which appends the event onto a per-stack-item pipe. Your `ggui_consume` long-poll unblocks mid-turn with the event payload plus a uiContext snapshot of every declared contextSpec slot. There is no synchronous server-side tool-fire — `actions drive turns` is a structural invariant (docs/principles/actions-vs-context.md): an action always waits for the agent. Cross-MCP `nextStep` hints work the same way: the agent reads the event's `actionData.nextStep`, decides whether to honor it, and calls the named tool on the next turn (the tool MAY live on a different MCP server — declare it in `agentCapabilities.tools` so the cross-ref invariant passes).";

/**
 * Worked invocation example. Layered atop the `aggressive` content by
 * `always` only — shows the literal handshake → render pattern an
 * operator can copy.
 */
const WORKED_EXAMPLE_PARAGRAPH =
  "Example: ggui_handshake({ intent: 'a settings panel for notification preferences', blueprintDraft: { contract: {...}, variance: { persona: 'minimalist' } } }) returns { handshakeId: 'h_…', suggestion: { origin: 'cache' | 'agent' | 'synth', blueprintMeta: { blueprintId, contractHash, codeHash?, generator, variance }, amendments?, validationFindings? }, contractHash: '<hex>' }. ACCEPT PATH: ggui_render({ handshakeId: 'h_…', decision: { kind: 'accept' } }) — reuses the provisional blueprintId; response carries the minted renderId. OVERRIDE PATH: ggui_render({ handshakeId: 'h_…', decision: { kind: 'override', blueprintDraft: { contract: { ...refined } } } }) — mints a fresh blueprintId against your new draft.";

/**
 * The default-preset body, captured as a const so `aggressive` and
 * `always` can layer additional paragraphs on top without diverging
 * from the protocol-primer baseline.
 */
const DEFAULT_PRESET_BODY = [
    'GGUI PROTOCOL — open standard for agents to deliver real interactive UIs to end-users (https://github.com/ggui-ai/ggui). You are the agent; the user is on the other side of a rendered UI, NOT a text terminal. Every user message — whether an obvious UI request (a card, a form, a list, a chart, a settings panel) OR conversational chat (a greeting, a question, a follow-up, even "hey") — must be rendered via the ggui_* tools rather than replied to in plain text. There is no plain-text reply path. For greetings, render a greeting/chat UI. For questions, render an answer card. For "hey", render a hello-bubble or a quick-reply chooser. The renderer can paint any HTML/CSS/JS your contract describes — including simple text bubbles — so "should I use ggui?" reduces to "always".',
    '',
    '═══ MENTAL MODEL ═══',
    '',
    'Every UI you render is described by a DataContract — a typed declaration of four data surfaces. You author the contract at handshake time; the contract is what the renderer compiles + the agent later interacts with. Four specs, each with one job:',
    '',
    '  • propsSpec    — agent → client (one-shot data). The initial values the rendered UI displays. Push sends these as `props`; ggui_update mutates them after delivery. e.g. a weather card has {temperature, condition, city} on propsSpec.',
    '',
    '  • actionSpec   — client → agent (discrete events). User gestures (clicks, submits) that drive the agent\'s NEXT TURN. Each entry has a `label`, optional `schema` for the payload, and optional `nextStep: "<toolName>"`. When `nextStep` is present, it names the tool the agent SHOULD call next AND the same name MUST also appear in `agentCapabilities.tools` (cross-ref invariant; rejection code `cross_reference_unresolved`). Omit `nextStep` entirely when the agent should decide freely from broader context (open-ended form submits). e.g. a feedback form has `submit` on actionSpec with `nextStep:"record_feedback"` (and `record_feedback` listed under `agentCapabilities.tools`).',
    '',
    '  • contextSpec  — client → agent (observed state, not events). Continuous client state the agent observes — slider position, draft text, current selection. Use contextSpec when you need to KNOW the state but don\'t need to ACT on every change. On MCP Apps hosts the runtime auto-mirrors the snapshot into the host\'s widget-context surface (the agent sees it on the next turn without polling). On raw MCP clients there is no auto-mirror — call ggui_get_render to read `contextSnapshot` when you need the latest values. e.g. a calendar has `selectedDate` on contextSpec.',
    '',
    '  • streamSpec   — agent → client (live updates). Live outbound channels for streaming data to the UI mid-render — chat tokens, progress events, log lines, time-series data. Each entry has a `schema` for the frame shape; you push frames via ggui_emit. e.g. a chat surface has `assistantMessage` on streamSpec for token-by-token output.',
    '',
    'PLACEMENT RULE for actionSpec vs contextSpec: "does this thing need the agent\'s next-turn reasoning?" Yes → actionSpec. No → contextSpec. There is no third category (full rule: docs/principles/actions-vs-context.md).',
    '',
    '═══ LIFECYCLE ═══',
    '',
    'Every chat that touches ggui follows this loop:',
    '',
    'TOOL PREREQUISITES (read once, internalize):',
    '  • `ggui_handshake` is a prerequisite for `ggui_render` ONLY. It returns the contract+code negotiation state (`handshakeId`) that `ggui_render` consumes. Call it BEFORE rendering a NEW UI.',
    '  • `ggui_consume` and `ggui_update` operate on EXISTING renders identified by `renderId` and require NO handshake. The `renderId` was minted by an earlier `ggui_render` call; it identifies the live iframe the user is interacting with. Calling `ggui_handshake` before `ggui_consume`/`ggui_update` is a category error — it would mint a SEPARATE new render that the user can\'t see, orphaning whichever live iframe the gesture targeted.',
    '  • Each `renderId` is the agent\'s persistent handle to one specific live iframe. Reuse it across consume/update for as long as the user is interacting with that UI; only call `ggui_handshake` again when you need to spawn a genuinely new UI surface.',
    '',
    '  1. ggui_handshake — FIRST CALL for any UI. Negotiate a contract for the next render. Post {intent, blueprintDraft: {contract, variance?, generator?}}. `variance` is optional and lets you steer cache lookup + gen by axis: `persona` ("minimalist", "playful"), `aesthetic` ("dense", "spacious"), `intentContext` (free-form usage notes), `seedPrompt` (deterministic seed). Server runs BlueprintSearch + contract-validation in parallel and returns a handshakeId + suggestion (origin: cache | agent | synth). cache → blueprint already exists, render delivers it instantly. agent → novel-but-clean draft, gen runs on render. synth → your draft failed validation, server amended it; diff is on suggestion.amendments.',
    '',
    '  2. ggui_render — deliver the UI. handshakeId is REQUIRED (from step 1); calling render without it fails with `handshake_not_found`. Send {handshakeId, decision: {kind:"accept"}} to use the suggestion verbatim, OR {handshakeId, decision: {kind:"override", blueprintDraft:{...}}} to mint fresh against a new draft. If the contract declares propsSpec, props is REQUIRED. Response includes the minted `renderId` — your handle for every follow-up call. Handshake records are SINGLE-USE and expire after 10 minutes. On error: `handshake_not_found` → call ggui_handshake again. `contract_violation` (props don\'t match propsSpec) / `contract_schema_invalid` (an inner JSON Schema is malformed) / `cross_reference_unresolved` (`actionSpec[*].nextStep` or `streamSpec[*].source.tool` names a tool not in `agentCapabilities.tools`) / `schema_mismatch_error` (action schema not a subset of the named tool\'s inputSchema) / `missing_props` → fix the input and retry with the SAME handshakeId (still valid until consumed).',
    '',
    '  3. NEXT STEP — read the render response. If it carries a `nextStep` field, call that tool with the given args. Render only emits `nextStep` when the contract declared a non-empty actionSpec (i.e., the UI has interactive buttons/forms); in that case nextStep names ggui_consume and your job is to long-poll for the user\'s gesture. If the render response has NO nextStep, the UI is pure-display (props only, no actionSpec) — you can end your turn; the user reads the UI and types their next prompt when they\'re ready.',
    '',
    '  4. ggui_consume (when render said to) — long-poll for user interaction. Keyed by renderId. Blocks up to ~15 min (deployment-configurable); returns when an actionSpec event arrives or the render closes. Each return carries `{events, status}`: `events[]` is the discrete action(s) the user just took. Each event is an envelope `{intent, actionData, uiContext, actionId, firedAt}` — `actionData` is WHAT the user did (action name + validated payload, plus `nextStep` hint if the author declared one); `uiContext` is the iframe-local snapshot of every declared contextSpec slot AT THE MOMENT the action fired (form fields, selected tab, slider value, scroll position — whatever the contract declared). Both inform your reaction without a second round trip. Honor each event\'s `actionData.nextStep` hint if the tool is available, then loop back to step 1 to render the response. Continue until consume returns status:"completed" or no further follow-up is needed.',
    '',
    '  5. ggui_update — reflect the new state in the UI. After ANY domain-tool call whose result changed data the rendered UI displays (e.g. `todo_toggle` flips a todo\'s `done`, `cart_add_item` extends a cart, `note_save` persists text), you MUST immediately call `ggui_update` with the refreshed props so the user sees what just happened. The rendered UI does NOT auto-refresh — it only shows the props it was last given. Skipping `ggui_update` after a state-mutating tool call leaves the user staring at stale state and is the #1 wire bug. Pattern: `consume → domain-tool → ggui_update → loop to consume`. Two modes: `{renderId, kind:"replace", props}` sends the FULL new props map (use when most fields changed or you want deterministic restoration); `{renderId, kind:"merge", patch}` sends ONLY the delta as RFC 7396 JSON Merge Patch (shallow merge, recurse on nested objects, `null` deletes a key, arrays fully replace — use when most props stay the same and only one or two fields changed). Prefer `merge` after a single domain-tool mutation; prefer `replace` when restoring state or when most fields changed. The only times you skip `ggui_update` are: (a) the domain tool was pure-read (todo_list, search, etc.) AND its result wasn\'t for the UI, or (b) the contract has no propsSpec (pure-display with no mutable state).',
    '',
    'In short: let the protocol\'s `nextStep` fields drive routing. Every ggui_* tool whose response logically chains forwards (handshake → render → consume) emits a nextStep when there IS a next step; the absence of nextStep means "you\'re done with this thread for now."',
    '',
    '═══ COMPLEMENTARY TOOLS ═══',
    '',
    '  • ggui_update    — refresh a delivered UI with new props WITHOUT destroying it. Two modes: `kind:"replace"` (full props) or `kind:"merge"` (RFC 7396 delta — see step 5). ALWAYS call this after any state-mutating tool call; re-rendering would lose scroll position, focus, and uncommitted input. Forgetting `ggui_update` after a mutation is the most common protocol bug.',
    '',
    '  • ggui_emit    — push frames to a streamSpec channel on a delivered UI. Use when the contract declared streamSpec (chat tokens, progress bars, live data). Frames must match the channel\'s declared `schema`. The live channel of the wire carries these.',
    '',
    '  • ggui_get_render / ggui_list_renders — inspect current render state if you\'ve lost track of what\'s on screen. ggui_get_render returns the render including its `contextSnapshot` — the canonical way to read contextSpec values from a raw MCP client. ggui_list_renders enumerates every render in the current host conversation (paired by `_meta["ai.ggui/host-session"]` on the inbound call).',
    '',
    '═══ HOST RENDERING ═══',
    '',
    'Two host shapes consume render output identically — your job is the same:',
    '',
    '  • MCP Apps hosts (claude.ai, MCP-Apps-aware desktop clients) — render responses carry the rendered UI inline via `_meta["ai.ggui/render"]`; the host displays it automatically. The user interacts with the UI directly, and contextSpec snapshots flow back into your widget-context surface without any agent action.',
    '',
    '  • Plain MCP clients (Claude Agent SDK without MCP Apps host adapter, raw CLI clients) — render responses carry a renderer URL in the structured content; the host either embeds it as an iframe or displays it as a link. Wire flow is identical (handshake → render → consume); only the rendering surface differs.',
    '',
    'Rendered UIs are LIVE — actionSpec entries route back to you as events you receive via consume (each gesture\'s payload validated against the entry\'s declared schema). You don\'t write glue code for any of this; declaring the spec at handshake time is enough.',
    '',
    '═══ TOOL DISCOVERY (lazy-loading hosts) ═══',
    '',
    'Some MCP hosts (notably claude.ai\'s connector model) use PROGRESSIVE tool discovery — only a small priority subset of tools is warmed at conversation start; the rest must be explicitly discovered via `tool_search` before they\'re callable. The ggui_* loop crosses this boundary on every render: handshake/render warm easily because you call them early, but `ggui_consume` and `ggui_update` are needed AFTER render and the host may not have loaded them yet.',
    '',
    'SYMPTOM: a tool call fails with a message like "tool has not been loaded yet — call tool_search first" or "you do not have the correct parameter names." RECOVERY: call `tool_search` with the tool name as a query (e.g. `tool_search({ query: "ggui_consume" })`), wait for the load to complete, then retry the original call with the same args. Same pattern for `ggui_update`. After one successful `tool_search` per tool per conversation, subsequent calls work directly.',
    '',
    'WHEN IN DOUBT: if the render response carries `nextStep`, the host has effectively asked you to call that tool. Don\'t skip ggui_consume because the host whined about it being unloaded — `tool_search` first, then call. Skipping it leaves the user staring at a UI whose actions silently never reach the agent — the worst protocol failure mode.',
  ];

/**
 * Preset name → instruction-string map. Operators select a preset by
 * passing `mcpInstructions: 'default'` (etc.) to `createGguiServer`.
 * Pass an arbitrary string to substitute custom copy. Pass `'off'` or
 * the empty string to omit the field entirely.
 *
 * @public
 */
export const MCP_INSTRUCTIONS_PRESETS = {
  /**
   * Concise protocol explainer — what ggui is, four-spec mental
   * model, lifecycle with nextStep-driven routing, complementary
   * tools. No-preset default.
   */
  default: DEFAULT_PRESET_BODY.join('\n'),

  /**
   * Default protocol primer + the host-side action-routing detail
   * (Pattern α direct dispatch vs Pattern β cross-server consent
   * bridge). Pick when the operator wants the LLM to also reason
   * about how the underlying tools/call envelopes flow.
   */
  aggressive: [...DEFAULT_PRESET_BODY, '', ACTION_ROUTING_PARAGRAPH].join('\n'),

  /**
   * `aggressive` + a worked invocation example. Useful when the
   * operator wants the LLM to see a complete handshake → render
   * pattern at boot.
   */
  always: [
    ...DEFAULT_PRESET_BODY,
    '',
    ACTION_ROUTING_PARAGRAPH,
    '',
    WORKED_EXAMPLE_PARAGRAPH,
  ].join('\n'),

  /**
   * Server identity only — no protocol detail. Pick when the
   * operator wants per-tool descriptions to be the sole signal.
   */
  minimal:
    'This server speaks the ggui protocol — an open standard for delivering interactive UIs to end-users (https://github.com/ggui-ai/ggui).',

  /**
   * Sentinel value. The wiring layer sees `'off'` and passes
   * `instructions: undefined` to the McpServer constructor — the
   * server omits the field on InitializeResult entirely.
   */
  off: '',
} as const;

/**
 * The preset enum's string keys, exported as a type for caller
 * autocomplete.
 *
 * @public
 */
export type McpInstructionsPreset = keyof typeof MCP_INSTRUCTIONS_PRESETS;

/**
 * The values `createGguiServer.mcpInstructions` accepts:
 *
 *   - One of the preset names: `'default' | 'aggressive' | 'always' | 'minimal' | 'off'`.
 *   - An arbitrary string — used verbatim as the `instructions` field.
 *   - `undefined` — falls through to the no-preset default (`'default'`).
 *
 * @public
 */
export type McpInstructionsValue = McpInstructionsPreset | string;

/**
 * Resolve the operator-provided value into the actual string the MCP
 * server should send. Returns `undefined` when the result is empty
 * (the constructor should omit the field).
 *
 * **No-preset default = `'default'`.** All behavior-text presets
 * explain the protocol now (vs nudging tool-use), so the previous
 * "aggressive as no-preset default" rationale no longer applies —
 * `'default'` is the appropriate baseline. Operators who want fuller
 * protocol detail opt into `'aggressive'` or `'always'`. To turn
 * instructions off entirely, pass `'off'`.
 *
 * @public
 */
export function resolveMcpInstructions(
  value: McpInstructionsValue | undefined,
): string | undefined {
  if (value === undefined) {
    return MCP_INSTRUCTIONS_PRESETS.default;
  }
  if (value in MCP_INSTRUCTIONS_PRESETS) {
    const resolved =
      MCP_INSTRUCTIONS_PRESETS[value as McpInstructionsPreset];
    return resolved.length > 0 ? resolved : undefined;
  }
  // Caller passed a custom string. Empty string → omit.
  return value.length > 0 ? value : undefined;
}
