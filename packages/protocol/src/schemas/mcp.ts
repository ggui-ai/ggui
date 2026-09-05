/**
 * MCP Tool Zod Schemas — Single Source of Truth
 *
 * These schemas define the validation rules for MCP tool inputs.
 * TypeScript types in types/mcp.ts are derived from these via z.infer.
 *
 * Two consumption patterns, both anchored here:
 *
 *   - **Wired raw shapes** (`*InputShape`): handlers in
 *     `@ggui-ai/mcp-server-handlers` (and the hosted pod's discover
 *     tool) import the SHAPE directly as their `inputSchema` and
 *     validate with `z.object(shape)` — unknown keys are STRIPPED.
 *     The shape is the one authored copy of the validation rules AND
 *     the agent-facing `.describe()` strings that ship via
 *     `tools/list`.
 *
 *   - **Lifecycle triad** (`ggui_handshake` / `ggui_update`): the
 *     handlers carry deliberate input divergences (handshake's
 *     blueprintDraft contract is loose ON PURPOSE so the negotiator can
 *     repair malformations; update's sessionId is optional for
 *     in-process dispatch), so they author their own raw shapes. The
 *     schemas here remain the canonical strict wire contract + the
 *     `z.infer` source for the published types. `ggui_render` is wired:
 *     its handler imports {@link renderInputShape}.
 */

import { z } from 'zod';
import {
  blueprintDraftSchema,
  handshakeSuggestionSchema,
} from './handshake-suggestion';
import { dataContractSchema, jsonObjectSchema, jsonValueSchema } from './data-contract';
import { blueprintVarianceSchema, blueprintSourceSchema } from './blueprint';
import {
  MCP_ENDPOINT_REFUSAL_CODES,
  REFUSAL_RETRIES,
  RENDER_GATE_REFUSAL_CODES,
} from '../types/refusal-codes';

import { RUNTIME_TELEMETRY_MAX_EVENTS } from './runtime-telemetry-limits';

// ── Wired Tool Input Shapes ──
//
// Raw zod shapes for the non-lifecycle tools. The SHAPE is the canonical
// authored artifact: the live handlers register it as their `inputSchema`
// (the transport layer projects it onto `tools/list`) and validate with
// `z.object(shape)` — unknown keys are stripped at the wire boundary.
// The derived `z.object(...)` schema next to each shape is the same
// contract as a composed validator and the `z.infer` source for the
// published input types in `types/mcp.ts`.

/**
 * `ggui_consume` input. The long-poll bound is SPEC §7.3: integer
 * seconds in `[0, 25]` — the cap dodges infrastructure kill windows
 * (API-gateway 30s HTTP limits, host MCP clients that abort long tool
 * calls). Longer waits are the agent's loop, not a server knob.
 */
export const consumeInputShape = {
  sessionId: z
    .string()
    .min(1)
    .describe(
      'Globally-unique sessionId to consume events from. Cross-tenant access surfaces uniformly as session_not_found.',
    ),
  timeout: z
    .number()
    .int()
    .min(0)
    .max(25)
    .optional()
    .describe(
      'Inline long-poll seconds, integer in [0, 25]. 0 = immediate. Values outside the bound reject INVALID_PARAMS. Returns on first event OR timeout; re-call on empty to keep waiting — longer waits are your loop, not a bigger timeout.',
    ),
} as const;

export const consumeInputSchema = z.object(consumeInputShape);

/**
 * `ggui_emit` input — emit a stamped delivery on a declared
 * `streamSpec[channel]`.
 */
export const emitInputShape = {
  sessionId: z.string().min(1),
  channel: z.string().min(1),
  payload: z.unknown(),
  complete: z.boolean().optional(),
} as const;

export const emitInputSchema = z.object(emitInputShape);

export const getSessionInputShape = {
  sessionId: z
    .string()
    .min(1)
    .describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
} as const;

export const getSessionInputSchema = z.object(getSessionInputShape);

/**
 * `ggui_get_render_source` input — read the generated source of the
 * calling app's own render. Same shape as {@link getSessionInputShape}
 * (both take only a sessionId); kept as its own named export rather
 * than reused directly so each tool's wire contract is independently
 * pinned, per this file's one-shape-per-tool convention.
 */
export const getRenderSourceInputShape = {
  sessionId: z
    .string()
    .min(1)
    .describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
} as const;

export const getRenderSourceInputSchema = z.object(getRenderSourceInputShape);

/**
 * `ggui_list_featured_blueprints` input — intentionally EMPTY. The
 * pre-launch No-Backcompat scrub deleted the level/category/tags/limit
 * filters (delete-until-wired); filters re-enter here when a real
 * consumer passes them.
 */
export const listFeaturedBlueprintsInputShape = {} as const;

export const listFeaturedBlueprintsInputSchema = z.object(
  listFeaturedBlueprintsInputShape,
);

export const searchBlueprintsInputShape = {
  query: z
    .string()
    .min(1)
    .describe("Natural-language description of the UI you're looking for"),
  limit: z.number().int().min(1).max(100).optional(),
  // Charset mirrors `MCP_TOOL_BINDING_NAME_RE` in
  // `@ggui-ai/artifact-manifest` (src/mcp-tool-bindings.ts). Inlined:
  // protocol cannot import artifact-manifest — the dependency points
  // the other way.
  tool: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,128}$/)
    .optional()
    .describe(
      "Filter registry-sourced candidates to artifacts declaring a binding for this exact MCP tool name (case-sensitive). Local results are unaffected.",
    ),
  server: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,128}$/)
    .optional()
    .describe(
      "Filter registry-sourced candidates to artifacts declaring a binding for this exact MCP server name (case-sensitive). Combine with `tool` to require the exact (server, tool) pair.",
    ),
} as const;

export const searchBlueprintsInputSchema = z.object(searchBlueprintsInputShape);

export const renderBlueprintInputShape = {
  blueprintId: z
    .string()
    .min(1)
    .describe(
      "The stable blueprint id declared via ggui.ui.json#id. Must match an entry in this server's UI registry.",
    ),
} as const;

export const renderBlueprintInputSchema = z.object(renderBlueprintInputShape);

export const discoverInputShape = {} as const;

export const discoverInputSchema = z.object(discoverInputShape);

// ── Post-Phase-B — canonical tool triad ──
//
// `ggui_handshake` → `ggui_render` → `ggui_update` / `ggui_consume`.
// The retired `ggui_new_session` step is gone — handshake mints the
// render server-side. Conversation grouping (sibling renders within one
// host chat) lives on the unchanged `_meta["ai.ggui/host-session"]`
// channel, captured ONCE at render creation, never threaded by the
// agent. The collapse of Session→GguiSession means `sessionId` is the single
// identity the wire references everywhere.
//

/**
 * `ggui_handshake` — three-step suggestion protocol.
 *
 * Step 1 (this input): the agent posts a draft — its idea: contract +
 * optional variance + optional generator hint.
 *
 * Step 2 (server-side, see `handshakeOutputSchema`): the server runs
 * `BlueprintSearch` and contract-validation in parallel and returns a
 * `HandshakeSuggestion` routed by `origin: cache | agent | synth`.
 *
 * Step 3 (paired `ggui_render`): the agent accepts (reuses the
 * provisional `blueprintId` minted in step-2) OR overrides (mints a
 * fresh `blueprintId` against a NEW draft).
 *
 * Locked decisions:
 *
 *   - `blueprintDraft` is the single-field input wrapping contract +
 *     variance + generator hint.
 *   - The agent is the contract authority; synth amends only when
 *     validation fails.
 *   - Post-Phase-B the handshake input carries NO `sessionId`. The
 *     server mints `sessionId` on the paired `ggui_render`; host
 *     conversation grouping flows via the host-supplied
 *     `_meta["ai.ggui/host-session"]` envelope captured at render
 *     creation (see {@link GguiSessionBase.hostSession}).
 */
export const handshakeInputSchema = z.object({
  /**
   * Concise semantic identity of the UI. Same intent across calls =
   * same component reused. Required — drives blueprint-search keying
   * (intent tokens contribute to the intent axis).
   * @example "Gmail inbox for email triage"
   * @example "Current weather conditions"
   */
  intent: z.string().min(1).describe('Concise purpose — same intent = same component reused. e.g. "Gmail inbox for email triage"'),
  /**
   * Agent's draft — contract (required) + variance + generator hint.
   * The contract drives the blueprint-search embed/structural axes
   * and the contract validators; variance feeds the variance axis
   * and rides through to the suggestion's `blueprintMeta`.
   */
  blueprintDraft: blueprintDraftSchema
    .describe(
      'Agent\'s draft — a JSON OBJECT, never a JSON-encoded string (pass {contract: {...}}, not "{\\"contract\\":...}"; a string fails input validation with -32602). Fields: contract (required) + optional variance + optional generator slug hint. The server combines this with cached blueprints + validator outcomes to produce a three-mode suggestion (cache / agent / synth).',
    ),
  /**
   * Skip blueprint-search on step-2 and route straight to validation
   * + (if validation passes) agent-mode suggestion against the draft.
   * Used after a prior handshake returned an unwanted cache suggestion
   * and the agent wants to force a fresh-gen path on the paired render.
   */
  forceCreate: z.boolean().optional(),
}).strict();

/**
 * Three-step handshake output. Single `suggestion` carries
 * `origin: cache | agent | synth`, `blueprintMeta` (always present),
 * and optional `amendments` (synth-only) / `validationFindings`
 * (soft on cache).
 *
 * The agent reads `suggestion.origin` to branch the paired render call:
 *
 *   - `cache`  → render `{handshakeId, props}` (omit `override`) for cache delivery.
 *   - `agent`  → render `{handshakeId, props}` (omit `override`) to gen against the draft.
 *   - `synth`  → render `{handshakeId, props}` (omit `override`) to gen against the amended contract.
 *
 * Any origin → render `{handshakeId, props, override: {contract?, variance?}}`
 * to re-aim the suggestion — `override.contract` gens against a fresh
 * contract; `override.variance` re-aims the variant axis.
 *
 * Wire-output is intentionally lean. The handler carries `target`,
 * `alternatives`, `contractHash`, `serverCapabilities` on its internal
 * `HandshakeOutput` TS shape for telemetry / post-classify tracing —
 * zod strips them before structuredContent serialization. `reason` IS
 * a wire field (optional, ≤280 chars — see below).
 *
 * `serverCapabilities` reaches the iframe via the `ai.ggui/render`
 * slice meta (see `slice-meta-derivation.ts`), not via this response.
 *
 * Post-Phase-B the `'compose'` action enum value is gone — there is no
 * stack of N renders to compose against. Three create/update branches +
 * `'declined'` cover every legal outcome.
 */
export const handshakeOutputSchema = z.object({
  handshakeId: z.string().describe('Stable id — pass to ggui_render / ggui_update'),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'declined']),
  /**
   * The handshake suggestion — see `handshakeSuggestionSchema`. The
   * routing discriminator is `suggestion.origin`; `blueprintMeta` is
   * ALWAYS present; `amendments` / `validationFindings` are
   * conditional on the routing outcome.
   */
  suggestion: handshakeSuggestionSchema
    .describe('Server\'s suggestion — origin-routed (cache | agent | synth). Always carries a provisional `blueprintMeta` the agent reuses by rendering WITHOUT `override` (accept the proposal as-is).'),
  /**
   * Truncated human-readable rationale for the `action` value. Helps
   * the agent and the operator narrate why the server chose to reuse a cached
   * blueprint vs synth a fresh one vs decline. Internal-only
   * `target`, `alternatives`, `contractHash`, `serverCapabilities`
   * stay off the wire — they're telemetry, not agent-actionable.
   */
  reason: z
    .string()
    .max(280)
    .optional()
    .describe(
      'Short rationale (≤280 chars) for the `action` value. Surfaced for agent + operator visibility; truncated to keep the structuredContent payload predictable.',
    ),
  nextStep: z.object({
    tool: z.literal('ggui_render'),
    description: z.string(),
    example: z.string(),
  }).optional().describe(
    'Wire-shape recovery hint. A worked literal example of the next ggui_render call the agent should emit — the example string can be copied verbatim and tweaked (e.g. fill in `props` placeholders). Top-level field so a skimming agent finds it immediately.',
  ),
});

/**
 * `ggui_render` — materialises a UI emission. Step 3 of the three-step
 * handshake protocol.
 *
 * The agent commits relative to the prior handshake's suggestion by
 * PRESENCE of `override` (no discriminated union): omit `override` to
 * ACCEPT the proposal as-is, or provide `override: {contract?, variance?}`
 * to re-aim the contract and/or the variant axis (PATCH semantics).
 *
 * Locked decisions:
 *
 *   - ACCEPT (omit `override`) reuses the agreed contract + the proposed
 *     variance, resolving the proposed `(contractKey, variantKey)`.
 *   - `override.contract` re-drafts the contract (STRICT — must already
 *     conform; the server does not repair it) and cold-gens against it.
 *   - `override.variance` re-aims the variant axis while keeping the
 *     agreed contract, re-resolving the effective
 *     `(contractKey, variantKey(newVariance))`.
 *   - `props` is REQUIRED (pass `{}` when the effective contract declares
 *     no propsSpec).
 *
 * There is no separate `ggui_commit` — render absorbs that responsibility.
 *
 * Post-Phase-B rename from `ggui_push` — the tool materialises a single
 * render (no stack of N to push onto); the new name reflects what the
 * tool does at the protocol surface.
 *
 * WIRED shape — `@ggui-ai/mcp-server-handlers`'s `ggui_render` registers
 * {@link renderInputShape} as its `inputSchema` and validates with
 * `z.object(shape)` (unknown top-level keys strip; `infra` / `override`
 * sub-objects stay `.strict()` so typos inside them surface as clear zod
 * paths).
 */
export const renderInputShape = {
  handshakeId: z
    .string({
      message:
        'ggui_render: handshakeId is REQUIRED. Call ggui_handshake({intent, blueprintDraft}) first to negotiate — handshake returns a handshakeId + suggestion. Then render with {handshakeId, props} (accept the suggestion as-is) or {handshakeId, props, override: {contract?, variance?}} (re-aim the contract and/or variance). Direct-render without a handshakeId is not supported.',
    })
    .min(1, 'ggui_render: handshakeId must be a non-empty string from a prior ggui_handshake call.'),
  /**
   * Runtime prop values for THIS render. Validated against the
   * effective contract's `propsSpec` — required-field checks + type
   * checks per spec entry. Validation failures fail the render with a
   * recoverable `ContractViolationError`.
   *
   * REQUIRED — pass `{}` when the effective contract declares no
   * propsSpec (the field is required, the value may be empty).
   */
  props: z.record(z.string(), z.unknown()),
  /**
   * Per-render theme override. When set, lands on the committed
   * render and takes priority over `App.defaultThemeId` at
   * bootstrap-projection time. Use sparingly — most renders should
   * inherit the app default.
   */
  themeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Per-render theme override. Wins over App.defaultThemeId for THIS render. Omit to inherit the app theme.',
    ),
  /**
   * Typed `infra` envelope. Today carries one field (`model`); future
   * expansion (temperature, max_tokens, provider hints) lands here
   * additively. `model` MUST parse as a model route in either wire form —
   * canonical `provider:model` or LiteLLM `provider/model` (aliases resolve
   * in both). The mechanism is `renderInputEnvelopeSchema`
   * (`schemas/render-input-envelope.ts`), which the render handler parses
   * BEFORE its pre-generation gate; this registered shape stays
   * parser-free by design so a browser bundle never carries the route
   * tables (ggui#818). A bound generator may also accept generator-specific
   * prefixes for alternate transports.
   *
   * Strict — extra keys at `infra.*` are not silently dropped, so a
   * typo (`infra.modelId`) surfaces as a clear zod path instead of a
   * silent default-model fallback.
   */
  infra: z
    .object({
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Model route in either wire form — canonical `anthropic:claude-haiku-4-5-20251001` or LiteLLM `anthropic/claude-haiku-4-5` (aliases resolve in both); generator-specific prefixes (e.g. `bedrock/...`) route to that transport. A value that parses in neither form fails the handler input parse at `infra.model`, before any pre-generation gate; `model_not_in_tier` is only ever a well-formed route with no rate row on the effective tier.',
        ),
    })
    .strict()
    .optional(),
  /**
   * Re-aim the handshake proposal (PATCH semantics). Omit to ACCEPT the
   * proposal as-is; provide to re-draft the contract and/or re-aim the
   * variant axis. At least one of `contract` / `variance` MUST be set —
   * an empty `override: {}` is rejected.
   *
   *   - `contract` — STRICT full re-draft of the contract. The server
   *     does NOT repair it; it must already conform.
   *   - `variance` — re-aim the variant axis (persona / aesthetic /
   *     context / seedPrompt) while keeping the agreed contract. A
   *     different variance resolves a distinct cached component.
   */
  override: z
    .object({
      contract: dataContractSchema
        .optional()
        .describe(
          'STRICT full re-draft of the contract — must already conform; the server will not repair it.',
        ),
      variance: blueprintVarianceSchema
        .optional()
        .describe(
          'Re-aim the variant (persona/aesthetic/context/seedPrompt); keeps the agreed contract.',
        ),
    })
    .strict()
    .refine((o) => o.contract !== undefined || o.variance !== undefined, {
      message:
        'override must set contract and/or variance — omit override entirely to ACCEPT the handshake proposal as-is.',
    })
    .optional()
    .describe(
      'Omit to ACCEPT the proposal as-is. Provide to re-aim contract and/or variance (PATCH semantics).',
    ),
} as const;

export const renderInputSchema = z.object(renderInputShape);

/**
 * Reuse outcome for a single `ggui_render` — surfaced on the wire so an
 * agent or operator can tell whether a stored component was served or a
 * new one was generated. Counts generation calls only; it carries no
 * cost or tier semantics.
 */
export const renderCacheMarkerSchema = z.object({
  hit: z
    .boolean()
    .describe('True when a stored component was served without generating new code.'),
  similarity: z
    .number()
    .optional()
    .describe('Cosine similarity of the matched component to the request (semantic match only).'),
  cachedBlueprintId: z
    .string()
    .optional()
    .describe('The stored component id that was matched. Equals top-level blueprintId on a hit.'),
  llmCallsAvoided: z
    .number()
    .describe('Generation calls skipped by serving the stored component (0 on a fresh generation).'),
  kind: z
    .enum(['full-template', 'cold'])
    .optional()
    .describe('full-template = a whole stored component was served; cold = freshly generated.'),
  reason: z
    .string()
    .optional()
    .describe(
      'Compact human-readable explanation of the cache outcome — why this render reused a stored component or generated cold. Diagnostic; default-available without the verbose env-gated trace.',
    ),
});

/**
 * Canonical failure codes for the in-result `ggui_render` failure
 * envelope (SPEC §7.9 Plane 3). Closed enum — a failed render's
 * `error.code` is always one of these five; finer-grained diagnostics
 * ride on `error.message`.
 *
 *   - `PRODUCTION_FAILED` — generation ran but did not produce a
 *     component (LLM/compile/commit failure).
 *   - `VALIDATION_ERROR` — a server-side precondition rejected the
 *     render before generation could run (misconfigured generation
 *     route, unusable stored config).
 *   - `NO_PLATFORM_KEY` — the server's managed provider-key
 *     configuration has no key for the resolved route.
 *   - `NO_CREDENTIALS` — no generation credentials are configured on
 *     the server at all.
 *   - `GENERATION_QUEUE_OVERLOADED` — the deployment's generation
 *     admission gate rejected this request before any generation
 *     attempt started (concurrent-request queue full, or wait for a
 *     free slot exceeded the configured timeout). Distinct from
 *     `PRODUCTION_FAILED` by design: generation never ran, so callers
 *     MUST NOT bill or count it as a failed attempt. See
 *     {@link GenerationError} in `types/ui-generator.ts` for the full
 *     contract.
 */
export const renderErrorCodeSchema = z.enum([
  'PRODUCTION_FAILED',
  'VALIDATION_ERROR',
  'NO_PLATFORM_KEY',
  'NO_CREDENTIALS',
  'GENERATION_QUEUE_OVERLOADED',
]);

/**
 * Canonical inferred type for {@link renderErrorCodeSchema}. Lives
 * beside the schema (rather than in `types/mcp.ts`, which re-exports
 * it) so `types/render.ts` can reference it without a type-only
 * import cycle through `types/mcp.ts`.
 */
export type RenderErrorCode = z.infer<typeof renderErrorCodeSchema>;

/**
 * In-result failure marker for `ggui_render`. Present on the wire
 * output iff the tool result is `isError: true` — the structuredContent
 * stays schema-conformant on failures, and this field carries the
 * canonical failure classification.
 */
export const renderErrorSchema = z.object({
  code: renderErrorCodeSchema.describe(
    'Canonical failure class. PRODUCTION_FAILED: generation did not produce a component. VALIDATION_ERROR: a server-side precondition rejected the render before generation. NO_PLATFORM_KEY: the server\'s managed provider-key configuration has no key for the resolved route. NO_CREDENTIALS: no generation credentials are configured on the server. GENERATION_QUEUE_OVERLOADED: the deployment\'s admission gate rejected the request before generation started (queue full or wait timed out) — not a failed attempt; safe to retry immediately.',
  ),
  message: z
    .string()
    .describe(
      'Human-readable failure detail — fold into the next attempt or surface to the operator.',
    ),
});

/**
 * The three outcomes a `ggui_render` result can report (SPEC §7.1,
 * ggui#786). A reader branches on this rather than guessing from which
 * fields happen to be present:
 *
 *   - `rendered` — the render ran and produced an interface. The
 *     identity fields (`sessionId`, `action`, `contractHash`,
 *     `blueprintId`, `variantKey`, `cache`) are all present.
 *   - `failed` — generation RAN and did not produce a component. The
 *     error session IS committed, so the identity fields are present
 *     and `error` carries the classification. The handshake is
 *     consumed.
 *   - `refused` — the deployment declined the call BEFORE it did any
 *     work: no state read, nothing committed, no spend. (The SDK has
 *     already checked the call against the declared `inputSchema` —
 *     the claim is nothing READ, not nothing validated.) The identity
 *     fields are structurally ABSENT and `refusal` carries the whole
 *     story; the handshake is INTACT, so the same id is valid on a
 *     retry.
 *
 * Declared HERE rather than in `types/mcp.ts` (which re-exports the
 * inferred type) so `types/render.ts` can reference it without a
 * type-only import cycle through `types/mcp.ts` — same convention as
 * {@link renderErrorCodeSchema}.
 */
export const renderOutcomeSchema = z.enum(['rendered', 'failed', 'refused']);

/** Canonical inferred type for {@link renderOutcomeSchema}. */
export type RenderOutcome = z.infer<typeof renderOutcomeSchema>;

/**
 * In-result PRE-GENERATION REFUSAL marker (SPEC §7.1's refused arm,
 * ggui#786). Present iff `outcome: 'refused'`.
 *
 * `code` draws from the closed render-gate subset of
 * `PRE_GENERATION_REFUSAL_CODES` — a code that is not registered fails
 * this enum at the transport, loudly. It is a bug, never a wire state.
 *
 * An agent MUST NOT auto-retry an `after-fix` refusal whose registry
 * row names a `fixBy` other than `caller`: the fix belongs to the app's
 * owner, the tenant, or the operator, and retrying does not perform it.
 */
/**
 * The refusal projection every surface shares — what a client acts on:
 * the diagnostic, the one recovery step, and how the call becomes
 * possible again. Defined ONCE and spread into each surface's envelope
 * (the render gate's {@link renderRefusalSchema}, the per-app endpoint's
 * {@link transportRefusalSchema}); the `code` enum is per surface,
 * derived from the registry. `fixBy` never travels — it is a registry
 * attribute a client reads by `code`.
 */
const refusalProjectionFields = {
  message: z
    .string()
    .describe(
      'Precise diagnostic — what was checked, and against what. Surface it to the operator; do not parse it.',
    ),
  fix: z
    .string()
    .describe(
      'The one recovery step, addressed to the party that can take it. Retry the same call only when that party is the caller.',
    ),
  retry: z
    .enum(REFUSAL_RETRIES)
    .describe(
      "How the call becomes possible again. 'after-fix': a named party acts and the same call then succeeds. 'next-period': time restores it at the next period boundary. 'later': transient — retry after a short delay. 'never': no caller action restores it under this identity.",
    ),
} as const;

export const renderRefusalSchema = z.object({
  code: z
    .enum(RENDER_GATE_REFUSAL_CODES)
    .describe(
      "Registered refusal state. Look the code up in the protocol's refusal registry for its retry class and which party can act; the accompanying `fix` names the one recovery step.",
    ),
  ...refusalProjectionFields,
  handshake: z
    .literal('intact')
    .describe(
      'The handshake was NOT consumed — nothing was read. The same handshakeId is valid on a retry.',
    ),
  balanceCentsAtCheck: z
    .number()
    .int()
    .optional()
    .describe(
      'Present only when the refusing check read a balance: its value at the moment of the check.',
    ),
});

/** The refusal marker, derived from {@link renderRefusalSchema}. */
export type PreGenerationRefusal = z.infer<typeof renderRefusalSchema>;

/**
 * A refusal typed on the per-app MCP endpoint's authorization
 * (ggui#825) — the registry projection WITHOUT the render-only fields:
 * no `handshake` (nothing was handed), no `balanceCentsAtCheck`. Strict:
 * a render-only field here is a bug, never a wire state. `code` draws
 * from {@link MCP_ENDPOINT_REFUSAL_CODES} — today exactly
 * `app_deprovisioned`, the one refusal with a tenant-side fix and
 * therefore the one that MUST be legible where a deleted app and a bad
 * credential would otherwise look alike.
 */
export const transportRefusalSchema = z.strictObject({
  code: z
    .enum(MCP_ENDPOINT_REFUSAL_CODES)
    .describe(
      "Registered refusal state on the per-app endpoint. Look the code up in the protocol's refusal registry for its retry class and which party can act.",
    ),
  ...refusalProjectionFields,
});

/** A refusal on the per-app MCP endpoint, derived from {@link transportRefusalSchema}. */
export type TransportRefusal = z.infer<typeof transportRefusalSchema>;

/**
 * The JSON-RPC error object a per-app MCP endpoint answers with when it
 * refuses a request for a typed reason (ggui#825, codes ruled in
 * ggui#836): HTTP 403, `code` `-32003` (`APP_NOT_FOUND` — the endpoint
 * no longer serves this app, the same reading ggui's embed host gives a
 * proxy 403) and `message` `App not found`, plus `data.refusal`, which
 * makes it legible. `data` is strict: it carries the refusal and nothing
 * else. An authorization failure that is not a registry state answers
 * HTTP 403 with `-32007` (`UNAUTHORIZED`) and NO `data` — the three
 * untyped arms stay indistinguishable among themselves by contract:
 * naming any of them would say which is true. A first-party server
 * never chooses `-32000`: it is the SDK client's `ConnectionClosed`, so
 * a bare 403 and a dropped socket would share a number.
 */
export const transportRefusalErrorSchema = z.strictObject({
  code: z.literal(-32003),
  message: z.literal('App not found'),
  data: z.strictObject({ refusal: transportRefusalSchema }),
});

/** The typed-refusal JSON-RPC error object, derived from {@link transportRefusalErrorSchema}. */
export type TransportRefusalError = z.infer<typeof transportRefusalErrorSchema>;

/**
 * The COMPLETE structuredContent of a refused tool result — the whole
 * payload, not a slice of it. Strict on purpose: a refusal commits
 * nothing, so ANY other key (a `sessionId`, a `resourceUri`, an
 * `error`) means the projection leaked state that does not exist.
 *
 * Today `ggui_render` is the only tool that carries a refusing gate;
 * {@link renderOutputSchema} delegates its refused arm here rather than
 * restating the rules, so there is exactly ONE declaration of them.
 *
 * NOT reusable verbatim by a second refusing tool, despite the strict
 * shape reading as generic: {@link renderRefusalSchema} REQUIRES
 * `handshake: 'intact'`, and that field is render-only by
 * construction — a mutation consumes no handshake, so it has nothing
 * to report intact. A mutation arm therefore lands WITH its first
 * emitter, sharing the facts this envelope carries (`code`, `message`,
 * `fix`, `retry`, one closed registry) and carrying no `handshake`
 * field at all (ggui#798).
 */
export const refusedOutputSchema = z.strictObject({
  outcome: z.literal('refused'),
  refusal: renderRefusalSchema,
});

/**
 * The refused arm's presence rule: the WHOLE payload must be
 * {@link refusedOutputSchema}. Delegating here rather than restating
 * the rule inline keeps one declaration of the RENDER refused
 * envelope. A mutation arm cannot delegate to it — that schema
 * REQUIRES `handshake: 'intact'` — so it mints its own with its first
 * emitter, sharing the facts and carrying no `handshake` (ggui#798).
 */
function refineRefusedArm(value: unknown, ctx: z.RefinementCtx): void {
  if (refusedOutputSchema.safeParse(value).success) return;
  ctx.addIssue({
    code: 'custom',
    message:
      "outcome 'refused' MUST carry a registered `refusal` and nothing else — a refusal commits nothing, so no identity field and no `error` may appear beside it.",
  });
}

/**
 * Report a field the committed arms (`rendered` / `failed`) require but
 * the payload omits. The fields are optional at the schema level only
 * to make room for the refused arm; demoting them must not weaken the
 * committed arms, which is what this restores.
 */
function requireOnCommittedArm(
  present: boolean,
  field: string,
  outcome: string,
  ctx: z.RefinementCtx,
): void {
  if (present) return;
  ctx.addIssue({
    code: 'custom',
    path: [field],
    message: `outcome '${outcome}' MUST carry \`${field}\` — a committed render reports its full identity.`,
  });
}

/** `refusal` rides the refused arm only. */
function rejectRefusalOnCommittedArm(
  refusal: unknown,
  outcome: string,
  ctx: z.RefinementCtx,
): void {
  if (refusal === undefined) return;
  ctx.addIssue({
    code: 'custom',
    path: ['refusal'],
    message: `\`refusal\` is present only on outcome 'refused', not '${outcome}'.`,
  });
}

/**
 * Canonical failure codes for a `resources/read` on a render locator
 * (`ui://ggui/render/{sessionId}/{blueprintKey}`). Closed enum.
 *
 * This is a DIFFERENT surface from {@link renderErrorCodeSchema}: that
 * one classifies a `ggui_render` tool call that ran and failed, and
 * rides in the tool result. This one classifies a resource read that
 * cannot return a mount, and rides on a JSON-RPC error — a read either
 * yields a live mount or fails, never a successful result wrapping a
 * dead shell. That is what makes the contract host-checkable.
 *
 *   - `NOT_FOUND` — no live render and no restorable record. The
 *     locator never existed, aged out, was erased, or the caller may
 *     not read it. Denial is deliberately reported as absence: a
 *     distinguishable "denied" would turn the read into an oracle for
 *     the existence of other callers' renders.
 *   - `BLUEPRINT_UNRESOLVABLE` — a record exists, but the component
 *     behind it cannot be resolved: removed, taken down, or the record
 *     carries no component reference at all.
 *   - `NOT_SUPPORTED` — this deployment keeps no durable record, so an
 *     evicted locator can never be restored. A property of the server,
 *     identical for every caller and every locator.
 *   - `NOT_MOUNTABLE` — the render resolved, but no delivery channel is
 *     available to mount it.
 */
export const resourceReadErrorCodeSchema = z.enum([
  'NOT_FOUND',
  'BLUEPRINT_UNRESOLVABLE',
  'NOT_SUPPORTED',
  'NOT_MOUNTABLE',
]);

/**
 * Failure shape for a `resources/read` that cannot return a mount.
 * Projected onto a JSON-RPC error by `resourceReadErrorToJsonRpc` —
 * `code` lands on `error.data.code`, so hosts can branch on the
 * classification without parsing prose.
 *
 * `message` is caller-facing and `detail` is operator-facing. NEITHER
 * is preserved on `NOT_FOUND`: the mapper substitutes a constant there
 * so a denied read and a genuine miss are byte-identical on the wire.
 * Put diagnostics for that case in the server's own logs.
 */
export const resourceReadErrorSchema = z.object({
  code: resourceReadErrorCodeSchema.describe(
    'Canonical failure class. NOT_FOUND: no live render and no restorable record (also the response when the caller may not read this locator). BLUEPRINT_UNRESOLVABLE: a record exists but the component behind it is gone. NOT_SUPPORTED: this server keeps no durable record, so an evicted locator can never be restored. NOT_MOUNTABLE: the render resolved but no delivery channel is available.',
  ),
  message: z
    .string()
    .describe('Human-readable failure detail. Replaced by a constant on NOT_FOUND.'),
  detail: z
    .string()
    .optional()
    .describe(
      'Extra diagnostic context for operators. Dropped on NOT_FOUND so a denied read cannot be told apart from a miss.',
    ),
});

/**
 * Wire-output shape. `outcome` is the discriminant and the only
 * unconditionally required field; which of the others exist follows
 * from it, per the THREE OUTCOMES section below — that section is the
 * single summary of this shape, so do not restate it here.
 * The handler carries `shortCode`, `codeReady`, `handshakeId`,
 * `decision`, `contract`, `codeUrl`, `codeHash`
 * on its internal `RenderOutput` TS shape for telemetry / post-classify
 * tracing — zod strips them before structuredContent serialization.
 *
 * The iframe receives bootstrap credentials (`wsUrl`, `wsToken`,
 * `expiresAt`) via the single `ai.ggui/render` slice meta, not via this
 * response. There is no clickable `url` field — post-R5 the `/r/`
 * shortCode route was deleted (every host either resolves the
 * `_meta.ui.resourceUri` iframe or reads `{sessionId}` via
 * `render-resource/...`). Leaving a dead URL on the wire had the model
 * hallucinating links that resolve nowhere.
 *
 * THREE OUTCOMES (SPEC §7.1, ggui#786). Every result carries
 * {@link renderOutcomeSchema} on `outcome`, and the identity fields are
 * present IFF something was committed — which is why they are optional
 * at the schema level and pinned by the presence refinement below:
 *
 *   - `rendered` — identity fields present; `resourceUri` present iff
 *     mountable; no `error`, no `refusal`.
 *   - `failed` — generation ran and produced nothing. Identity fields
 *     present (the error GguiSession IS committed, so `sessionId`
 *     remains a live handle into the session channel), `error`
 *     present, `resourceUri` absent, no `_meta` on the result. The
 *     handshake is consumed.
 *   - `refused` — the deployment declined before doing any work.
 *     Identity fields ABSENT, `refusal` present, no `error`, no
 *     `nextStep`, no `_meta`. Nothing was committed and the handshake
 *     is intact. The refused arm's whole envelope is
 *     {@link refusedOutputSchema}.
 *
 * The root stays ONE object with a discriminant field rather than a
 * discriminated union: the MCP spec's `Tool.outputSchema` root MUST be
 * a JSON Schema of type `object`, and the SDK registers zod raw shapes.
 * TypeScript narrowing is via the guards at the bottom of this file
 * ({@link isRenderedOutput} / {@link isFailedRenderOutput} /
 * {@link isRefusedRenderOutput}), never a parallel union type.
 *
 * Post-Phase-B the `'compose'` action enum value is gone — there is no
 * stack of N renders to compose against.
 */
export const renderOutputSchema = z.object({
  outcome: renderOutcomeSchema.describe(
    "Which of the three outcomes this result reports. 'rendered': an interface was produced. 'failed': generation ran and produced none — the session is committed and `error` classifies it. 'refused': the deployment declined before doing any work — `refusal` carries the state, nothing was committed, and the handshake is still valid.",
  ),
  /** Present iff something was committed — absent on a refusal. */
  sessionId: z.string().optional(),
  /**
   * Spec-canonical MCP-Apps entry-point — same `ui://ggui/render/{id}`
   * URI surfaced on `_meta.ui.resourceUri`. Surfacing it on the LLM-
   * visible structuredContent too lets SDKs that strip `_meta` from
   * tool_results (OpenAI Agents SDK, Google ADK) reach the mount URI;
   * SDKs that preserve `_meta` see the same value on both fields.
   * Mirrors the `resourceUri` field on `ggui_update`'s output.
   *
   * OPTIONAL — present iff the render is mountable. Absent on the
   * failure envelope (`error` present): a failed render commits an
   * error GguiSession but exposes no mount affordance.
   */
  resourceUri: z
    .string()
    .optional()
    .describe(
      'MCP-Apps mount URI (ui://ggui/render/{id}). Present iff the render is mountable; absent on a failed render.',
    ),
  action: z
    .enum(['create', 'reuse', 'update', 'replace', 'declined'])
    .optional(),
  contractHash: z
    .string()
    .optional()
    .describe(
      'Canonical hash of the rendered data contract (shape only — fields, types, specs). Same hash ⟺ same data flow.',
    ),
  blueprintId: z
    .string()
    .optional()
    .describe(
      'Opaque id of the materialised component for this render. On the handshake-decided reuse paths (accept a cache-origin proposal, or a variance re-aim that resolves to an existing variant) it is the stored id — equal ids across renders mean the same stored component. override.contract always generates cold and mints a fresh id, even for an identical contract.',
    ),
  variantKey: z
    .string()
    .optional()
    .describe(
      'Canonical hash of the design-time variance (persona, aesthetic, seed prompt, context). With contractHash it forms the reuse key: the same pair reuses one component; a different variant of the same contract gets its own.',
    ),
  cache: renderCacheMarkerSchema
    .optional()
    .describe(
      'Reuse outcome for this render: whether a stored component was served, its similarity, the matched component id, and how many generation calls that avoided.',
    ),
  /**
   * In-result failure marker — present iff the tool result is
   * `isError: true`. The structuredContent stays schema-conformant on
   * failures; this field carries the canonical `{code, message}`
   * classification. Absent on every successful render.
   */
  error: renderErrorSchema
    .optional()
    .describe(
      'Present iff the tool result is isError — canonical {code, message} for a failed/rejected generation. Absent on success.',
    ),
  /**
   * In-result PRE-GENERATION REFUSAL marker — present iff
   * `outcome: 'refused'`, and then it is the ONLY field besides
   * `outcome` (see {@link refusedOutputSchema}).
   */
  refusal: renderRefusalSchema
    .optional()
    .describe(
      'Present iff outcome is refused — the registered state the deployment declined on, plus the one recovery step. Nothing was committed and the handshake is still valid.',
    ),
  /**
   * Wire-shape recovery hint for the next call. Emitted ONLY when the
   * rendered contract has a non-empty `actionSpec` — i.e. the agent will
   * receive user-action events on this render. Pure-display renders
   * (props only) get no `nextStep` because there is nothing to consume.
   *
   * Mirrors the chain at `handshake.nextStep` (→ render). Closes the loop
   * with consume.
   *
   * `args.sessionId` is the literal value the agent passes to
   * `ggui_consume` — copy-paste shape.
   */
  nextStep: z.object({
    tool: z.literal('ggui_consume'),
    description: z.string(),
    example: z.string(),
    args: z.object({
      sessionId: z.string(),
      // The per-call long-poll window in seconds. Carried on the hint
      // because consume's own default is 0 (single non-blocking
      // drain): an agent copying a timeout-less hint gets an instant
      // empty result and stops looping.
      timeout: z.number(),
    }),
  }).optional().describe(
    'Required-next-call hint — when the rendered contract has actions, points the agent at ggui_consume({sessionId, timeout}) for the inbound action loop. Absent for pure-display renders.',
  ),
}).superRefine((value, ctx) => {
  // Present-iff-committed. NOTE for implementors: this refinement is
  // attached to the COMPOSED schema. A consumer that decomposes the
  // schema to its raw shape and rebuilds it (`z.object(schema.shape)`,
  // which is how the MCP SDK registers a tool's outputSchema) loses
  // these rules — which is why the transport validates a refused
  // payload against `refusedOutputSchema` directly. See SPEC §7.1.
  if (value.outcome === 'refused') {
    refineRefusedArm(value, ctx);
    return;
  }
  requireOnCommittedArm(value.sessionId !== undefined, 'sessionId', value.outcome, ctx);
  requireOnCommittedArm(value.action !== undefined, 'action', value.outcome, ctx);
  requireOnCommittedArm(
    value.contractHash !== undefined,
    'contractHash',
    value.outcome,
    ctx,
  );
  requireOnCommittedArm(
    value.blueprintId !== undefined,
    'blueprintId',
    value.outcome,
    ctx,
  );
  requireOnCommittedArm(value.variantKey !== undefined, 'variantKey', value.outcome, ctx);
  requireOnCommittedArm(value.cache !== undefined, 'cache', value.outcome, ctx);
  rejectRefusalOnCommittedArm(value.refusal, value.outcome, ctx);
  // `resourceUri` present IFF `rendered` — the mountability rule, the
  // one presence rule the six identity fields do not cover. A `failed`
  // render commits an error GguiSession but exposes no mount, so a URI
  // beside it points a host at a render that does not exist.
  if (value.outcome === 'rendered' && value.resourceUri === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['resourceUri'],
      message:
        "outcome 'rendered' MUST carry `resourceUri` — a rendered result is mountable, and the URI is how a host mounts it.",
    });
  }
  if (value.outcome === 'failed' && value.resourceUri !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['resourceUri'],
      message:
        "`resourceUri` is present only on outcome 'rendered' — a failed render exposes no mount affordance.",
    });
  }
  if (value.outcome === 'failed' && value.error === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['error'],
      message:
        "outcome 'failed' MUST carry `error` — the classification is what distinguishes it from a render that succeeded.",
    });
  }
  if (value.outcome === 'rendered' && value.error !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['error'],
      message: "`error` is present only on outcome 'failed', not 'rendered'.",
    });
  }
});

/**
 * `ggui_update` — refresh the rendered UI with new state.
 *
 * Discriminated on `kind`:
 *
 *   - `kind: 'replace'` + `props` — full props replacement. The new
 *     map IS the new state. Use when most props change OR when you
 *     want deterministic state restoration (no merge ambiguity).
 *
 *   - `kind: 'merge'` + `patch` — RFC 7396 JSON Merge Patch semantics.
 *     Top-level keys merge shallow; nested objects merge recursively;
 *     a `null` value DELETES the key; arrays fully replace (NOT element-
 *     wise). Use when most props stay the same and the agent only
 *     needs to send a small delta — common after a single domain-tool
 *     mutation. RFC 7396 chosen because it has a published spec and
 *     wide library support (GitHub API, Kubernetes strategic-merge).
 *
 * Anti-patterns (the discriminated union rejects these structurally,
 * but they're a common author mistake when copy-pasting):
 *
 *   - Do NOT send `props` on `kind: 'merge'` — use `patch`.
 *   - Do NOT send `patch` on `kind: 'replace'` — use `props`.
 *
 * Both modes validate the FINAL props state (post-merge for `merge`)
 * against the render's `propsSpec` and reject on violation —
 * partial patches that would break required fields, type-mismatch
 * values, etc. all reject pre-persist.
 *
 * `sessionId` is globally unique; the server tenancy-checks via
 * `ctx.appId`.
 */
export const updateInputSchema = z.discriminatedUnion('kind', [
  z.object({
    sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
    kind: z.literal('replace'),
    props: z.record(z.string(), z.unknown())
      .describe('Full replacement props map. New map IS the new state, rendered as a NEW card (a new history entry). For an in-place repaint of the mounted card use ggui_amend.'),
  }).strict(),
  z.object({
    sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
    kind: z.literal('merge'),
    patch: z.record(z.string(), z.unknown())
      .describe('RFC 7396 JSON Merge Patch — null deletes a key; arrays fully replace. The merged state renders as a NEW card (a new history entry). For an in-place repaint of the mounted card use ggui_amend.'),
  }).strict(),
]);

/**
 * `ggui_amend` wire input (#483) — same replace/merge mutation
 * grammar as `ggui_update`, different mount identity: amend targets
 * the ALREADY-MOUNTED card. No new card, no history entry, the
 * history number does not advance. Git reading: `ggui_update` =
 * commit; `ggui_amend` = commit --amend.
 */
export const amendInputSchema = z.discriminatedUnion('kind', [
  z.object({
    sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
    kind: z.literal('replace'),
    props: z.record(z.string(), z.unknown())
      .describe('Full replacement props map, applied to the currently mounted card in place.'),
  }).strict(),
  z.object({
    sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
    kind: z.literal('merge'),
    patch: z.record(z.string(), z.unknown())
      .describe('RFC 7396 JSON Merge Patch — null deletes a key; arrays fully replace. Applied to the currently mounted card in place.'),
  }).strict(),
]);

/**
 * Agent-facing description of the schema-attestation hash, shared by
 * both mutation tools (ggui#560). It is not a comment: `.describe()`
 * ships as JSON-Schema `description` in the tool declaration, so this
 * string is what an agent reads out of `tools/list` when it has to
 * decide whether a hash mismatch means the contract moved under it.
 * Declared once so the two tools cannot say different things about the
 * same field.
 */
const PROPS_SCHEMA_HASH_DESCRIPTION =
  'sha256 (lowercase hex) over the RFC 8785 canonical form of the enforced props schema this mutation was validated against — the same schema the paired handshake disclosed. Present when the session declares a propsSpec. Equal to the handshake propsSchemaHash by the session-continuity guarantee; a mismatch means the contract changed under you.';

/** Agent-facing description of the grammar-profile classifier. Same rationale as {@link PROPS_SCHEMA_HASH_DESCRIPTION}. */
const PROPS_SCHEMA_PROFILE_DESCRIPTION =
  "Grammar profile of the enforced props schema: 'grammar-safe' or 'full'. Present with propsSchemaHash; treat unrecognized values as 'full'.";

/**
 * Wire-output shape — minimal acknowledgement. This schema IS the
 * handler's declared output: `ggui_update` registers `.shape` and its
 * return type is `GguiUpdateOutput` (`z.infer` of this schema), so
 * there is no second declaration to keep in step (ggui#798).
 *
 * Every REAL update (`updated: true`) mints a new history record and
 * its result carries the `ai.ggui/render` slice as a FULL bootable
 * mount package (#483 — hosts mint a per-result view for the new
 * card); a no-op (`updated: false`) carries NO result `_meta`.
 * Already-mounted frames are not repainted by update — they freeze as
 * history when its higher-epoch `props_update` frame lands; the
 * in-place repaint over the live-channel ladder (WS / SSE / polling /
 * bridge-pull) is `ggui_amend`'s job.
 *
 * NO refusal arm (ggui#786): the pre-generation refusal envelope rides
 * `ggui_render` only. There is no pre-state POLICY gate on the
 * mutation tools today — nothing on this path can decline a call for
 * deployment-policy reasons (a contract error still rejects a
 * malformed mutation before any store read; that is a parse result,
 * not a refusal) — and `handshake: 'intact'` would assert something
 * meaningless on a tool that consumes no handshake. The arm lands with its first
 * emitter (ggui#798), not as a mechanical port of the render one.
 */
export const updateOutputSchema = z.object({
  sessionId: z.string(),
  updated: z.boolean(),
  /**
   * The epoch-pinned URI of the NEW history record this update minted
   * (`ui://ggui/render/{id}[/{key}]#{epoch}` — see epoch-uri.ts). On a
   * no-op (`updated: false`) no record is minted and this is the bare
   * live-head URI. Mirrored on the LLM-visible structuredContent so
   * SDKs that strip `_meta` from tool_results can still reach the
   * mount URI.
   */
  resourceUri: z.string(),
  /**
   * The session's head epoch after this call: advanced by one on a
   * real update (`updated: true`), unchanged on a no-op. `ggui_render`
   * mints epoch 0. The session ROW is the authority
   * (`GguiSessionBase.epoch`, absent ⇒ 0); the ledger's `ui.reminted`
   * events are the wire signal only — the ledger is horizon-bounded
   * and must never be counted as the source of truth.
   */
  epoch: z.number().int().min(0),
  /**
   * Present ONLY on a no-op (`updated: false`): the patch conformed to
   * the contract but left the final props semantically identical to
   * the current state, so nothing was written, nothing changes on
   * screen, and NO new history record was minted. Model-visible by
   * design — the common producer of a no-op is an agent echoing
   * existing props back believing it changed the UI, and this field is
   * its feedback channel.
   */
  warning: z.string().optional(),
  /**
   * Schema attestation (ggui#560): identity hash of the enforced props
   * schema this mutation was validated against — the same schema the
   * paired handshake disclosed. Present when the session declares a
   * `propsSpec`; equal to the handshake's `propsSchemaHash` under the
   * session-continuity guarantee, so a mismatch is the observable form
   * of a contract changing mid-session.
   */
  propsSchemaHash: z
    .string()
    .optional()
    .describe(PROPS_SCHEMA_HASH_DESCRIPTION),
  /** Present with `propsSchemaHash`; same profile classifier as the handshake's. */
  propsSchemaProfile: z
    .string()
    .optional()
    .describe(PROPS_SCHEMA_PROFILE_DESCRIPTION),
});

/**
 * `ggui_amend` wire output (#483) — acknowledgement only. `resourceUri`
 * is the BARE live-head URI (amend targets the mounted card; it never
 * mints a record, so there is no pinned URI to return and no epoch
 * field — the history number is untouched by construction). The
 * mounted card receives the new props over the live channels.
 *
 * As with {@link updateOutputSchema}, this schema IS the handler's
 * declared output — `ggui_amend` registers `.shape` and returns
 * `GguiAmendOutput` (ggui#798).
 */
export const amendOutputSchema = z.object({
  sessionId: z.string(),
  updated: z.boolean(),
  /**
   * The BARE live-head URI — amend targets the mounted card and never
   * mints a record, so there is no pinned URI to return and no epoch
   * field (the history number is untouched by construction).
   *
   * NORMATIVE re-anchor reference (SPEC §7.1.2.1, ggui#652 /
   * guuey#535): together with `sessionId` this is the durable record
   * that an in-place repaint touched this session at this turn. A
   * host's persistence layer MAY consume it as a locator-only
   * re-anchor — `resources/read`-resolvable, stable for the session's
   * lifetime — so a restored transcript re-positions the card at its
   * latest referencing turn and rehydrates CURRENT state instead of a
   * stale earlier snapshot. It rides `structuredContent` (LLM-visible,
   * same rationale as ggui_update's resourceUri: consumers that strip
   * `_meta` still reach it) and MUST NOT move to a result `_meta`
   * slice — any result `_meta` on this tool makes view-minting hosts
   * break the in-place semantics.
   *
   * Both this field and `sessionId` are REQUIRED, which is what makes
   * SPEC §7.1.2.1's "structurally guaranteed" true rather than a
   * convention.
   */
  resourceUri: z.string(),
  /** Same no-op feedback channel as ggui_update's `warning`. */
  warning: z.string().optional(),
  /** Schema attestation (ggui#560) — same semantics as ggui_update's. */
  propsSchemaHash: z
    .string()
    .optional()
    .describe(PROPS_SCHEMA_HASH_DESCRIPTION),
  /** Present with `propsSchemaHash`. */
  propsSchemaProfile: z
    .string()
    .optional()
    .describe(PROPS_SCHEMA_PROFILE_DESCRIPTION),
});

/**
 * `ggui_runtime_declare_tool_catalog` — the host runtime declares its
 * per-app canonical tool-identity catalog (one row per app).
 *
 * The map is `bare tool name → the canonical serverInfo` that the tool's
 * MCP server announced in its `initialize` reply. ggui folds this into
 * the handshake step (`canonicalizeToolIdentity`) so a reused blueprint's
 * `agentCapabilities.tools[*].serverInfo` is rewritten to the canonical
 * value regardless of whether the inbound contract authored a config-key
 * name, fabricated one, or omitted it. That makes blueprint reuse
 * identity-stable across runtimes.
 *
 * Keyed by the BARE tool name — the same key the canonicalization step
 * matches on. `version` is OPTIONAL: it rides along as metadata; tool
 * identity is `(name)` matched by bare name, never `(name, version)`.
 *
 * `appId` is NOT on the input — the handler reads it off `ctx.appId`
 * resolved by the upstream auth adapter, so a declaration can only ever
 * write its own app's row. The output echoes the resolved `appId` so the
 * caller can confirm which app row it wrote.
 *
 * REPLACE semantics: each declaration overwrites the app's prior catalog
 * wholesale (the host re-declares its full current toolset on connect).
 */
export const declareToolCatalogInputSchema = z
  .object({
    toolCatalog: z
      .record(
        z.string(),
        z.object({ name: z.string(), version: z.string().optional() }).strict(),
      )
      .describe(
        "Per-app canonical tool identities: bare tool name -> its server's initialize-declared serverInfo. Host/library-supplied; not an agent action.",
      ),
  })
  .strict();

export const declareToolCatalogOutputSchema = z
  .object({
    saved: z.boolean(),
    appId: z.string(),
  })
  .strict();

// ── `ggui_runtime_pull` — bridge-pull rung of the live-channel ladder ──

/**
 * Server-side page cap for `ggui_runtime_pull`. A `limit` above this is
 * CLAMPED (not rejected) — the tool mirrors the cursor-walk posture of
 * the `/events` HTTP route, where a too-eager page size is a tuning
 * knob, not a caller bug. Shared so the pulling client and the serving
 * handler agree on the effective page ceiling from one constant.
 */
export const RUNTIME_PULL_MAX_LIMIT = 100;

/**
 * Server-side ceiling on `ggui_runtime_pull`'s `wait` hold, in seconds.
 * Chosen under `ggui_consume`'s proven 25-second host tolerance for
 * held tool calls — the hold must resolve before any host-side
 * `tools/call` timeout fires, or the transport counts a failure the
 * server intended as a quiet success.
 */
export const RUNTIME_PULL_MAX_WAIT_SECONDS = 20;

/**
 * One `GguiSessionEvent` ledger row on the `ggui_runtime_pull` wire —
 * the zod mirror of the canonical `GguiSessionEvent` interface in
 * `types/ggui-session-event.ts` (which stays the type-level source of
 * truth; `mcp.test.ts` pins the two together in both directions).
 */
export const gguiSessionEventSchema = z.object({
  seq: z
    .number()
    .int()
    .min(1)
    .describe(
      'Monotonic, gap-free per render; starts at 1 (0 is the "no events yet" cursor sentinel, never an event).',
    ),
  type: z
    .string()
    .min(1)
    .describe(
      'Wire-frame type — see the canonical GguiSessionEventType taxonomy; plain string so servers can mint new types without a protocol bump.',
    ),
  timestamp: z
    .string()
    .describe('ISO 8601 UTC timestamp the server stamped on emission.'),
  data: z
    .unknown()
    .describe(
      'Type-specific payload — structurally identical to the matching live-channel frame payload.',
    ),
});

/**
 * `ggui_runtime_pull` input — the terminal bridge-pull rung of the
 * live-channel failover ladder (WS → SSE → HTTP polling → bridge-pull).
 *
 * Two named parties:
 *
 *   - **Puller** — the `@ggui-ai/iframe-runtime` bridge rung. In a
 *     CSP-jailed MCP Apps host the iframe can reach no network origin
 *     at all, so it pulls the event ledger by issuing `tools/call`
 *     postMessages that the host's MCP client relays (the tool
 *     registers `_meta.ui.visibility: ['app']` per MCP Apps spec §401
 *     — hosts MUST route view-issued calls to it and MUST reject
 *     view-issued calls to tools without it).
 *   - **Server** — the MCP server hosting the render. It serves the
 *     SAME `GguiSessionEvent` ledger `GET
 *     /api/sessions/:sessionId/events` serves, through the same
 *     `listEventsSince` read, and MUST answer with the same shapes
 *     (see {@link runtimePullOutputSchema}) so one client parse core
 *     handles both carriers.
 *
 * Divergences from the HTTP route, both deliberate: `sinceSequence` is
 * OPTIONAL here (the bridge rung owns its cursor and seeds from 0; the
 * route requires it because a bare browser GET has no cursor owner),
 * and `limit` is clamped to {@link RUNTIME_PULL_MAX_LIMIT} instead of
 * rejecting above it. Tenancy violations and unknown sessionIds
 * surface uniformly as the `session_not_found` error — existence of
 * other tenants' renders is never leaked.
 */
export const runtimePullInputShape = {
  sessionId: z
    .string()
    .min(1)
    .describe(
      'Active render id — sourced from `_meta["ai.ggui/render"].sessionId` on the iframe boot envelope. Unknown and cross-tenant ids surface uniformly as session_not_found.',
    ),
  sinceSequence: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Replay cursor — only events with seq > sinceSequence return. Omit (= 0) on first pull; advance to the last event\'s seq (or lastSequence on an empty page) on every subsequent pull.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Max events per page. Values above ${RUNTIME_PULL_MAX_LIMIT} are clamped to ${RUNTIME_PULL_MAX_LIMIT}; omit for the default ${RUNTIME_PULL_MAX_LIMIT}. When hasMore is true, immediately re-pull with the advanced cursor.`,
    ),
  wait: z
    .number()
    .min(0)
    .optional()
    .describe(
      `Subscription-mode hold, in seconds. When set and the cursor page is empty, the server holds this call until an event lands or the hold elapses (values above ${RUNTIME_PULL_MAX_WAIT_SECONDS} are clamped to ${RUNTIME_PULL_MAX_WAIT_SECONDS}). An empty page after a full hold is a NORMAL result — immediately re-pull to stay subscribed, or back off to sparse un-held pulls after a few consecutive empties. Omit (= 0) for an immediate return.`,
    ),
} as const;

export const runtimePullInputSchema = z.object(runtimePullInputShape);

/**
 * Normal-page arm — EXACT `EventsResponse` parity with
 * `GET /api/sessions/:sessionId/events` (same keys, same semantics):
 * `events` strictly ascending by seq, `lastSequence` = the render's
 * current high-water mark (NOT the page's last seq — advances the
 * cursor on empty pages), `hasMore` = the page was truncated by
 * `limit`.
 */
export const runtimePullEventsPageSchema = z.object({
  events: z.array(gguiSessionEventSchema),
  lastSequence: z.number().int().min(0),
  hasMore: z.boolean(),
});

/**
 * Replay-horizon arm — parity with the route's 410 body, but on this
 * carrier it is a NORMAL result arm, not an error: the bridge rung is
 * terminal and treats it as a re-sync instruction. Returned when the
 * cursor fell out of the replayable window on EITHER side
 * (`sinceSequence` above the server's `lastSequence` — a cursor from a
 * different deployment/reset render — or below the retention horizon).
 * Client recovery: re-mount state from a fresh snapshot and reset the
 * cursor to `currentSequence`.
 */
export const runtimePullHorizonSchema = z.object({
  reason: z.literal('REPLAY_HORIZON_PASSED'),
  currentSequence: z.number().int().min(0),
});

/**
 * `ggui_runtime_pull` output — the canonical strict wire contract, a
 * two-arm union: {@link runtimePullEventsPageSchema} (normal page) |
 * {@link runtimePullHorizonSchema} (cursor out of window). The handler
 * registers a flat raw shape (MCP tool registration takes a
 * `ZodRawShape`, which cannot express a top-level union) and its
 * alignment test pins that shape to this union — same posture as
 * `updateInputSchema`.
 */
export const runtimePullOutputSchema = z.union([
  runtimePullEventsPageSchema,
  runtimePullHorizonSchema,
]);


/**
 * `ggui_runtime_telemetry` input — the iframe runtime's transport
 * self-report (`_meta.ui.visibility: ['app']`, view-callable only).
 *
 * Contract (both parties named): the IFRAME RUNTIME batches short
 * `{at, kind, detail?}` events describing its delivery-ladder journey
 * (boot-path decision, per-rung status transitions and failures —
 * `channel_failover_swap`, `channel_polling_budget_exhausted`, … —
 * and outbound doorbell rings) and flushes them over the host's
 * `tools/call` postMessage bridge; the SERVER logs one structured
 * line per batch for operator forensics and stores NOTHING. Sandboxed
 * hosts (claude.ai's `claudemcpcontent.com` frames) expose no
 * readable console and no network — this tool is the ONLY way the
 * ladder's behavior on such hosts reaches an operator. `sessionId` is
 * client-claimed (log-tagged, never trusted for reads); events are
 * bounded (≤ {@link RUNTIME_TELEMETRY_MAX_EVENTS} per batch, `kind` ≤
 * 64 chars, `detail` ≤ 512) so a hostile view cannot use the channel
 * for bulk exfiltration or log flooding.
 */
export const runtimeTelemetryInputShape = {
  sessionId: z
    .string()
    .min(1)
    .describe(
      'Render id the report concerns — sourced from the boot envelope. Client-claimed: used as a log tag only.',
    ),
  events: z
    .array(
      z.object({
        at: z
          .number()
          .min(0)
          .describe('Milliseconds since iframe boot (monotonic, client clock).'),
        kind: z
          .string()
          .min(1)
          .max(64)
          .describe(
            "Event name — e.g. 'boot.path', 'status.connected', 'channel_failover_swap', 'doorbell.ring'.",
          ),
        detail: z
          .string()
          .max(512)
          .optional()
          .describe('Optional compact context (JSON fragment or message).'),
      }),
    )
    .min(1)
    .max(RUNTIME_TELEMETRY_MAX_EVENTS)
    .describe('Batched ladder/doorbell events, oldest first.'),
} as const;

export const runtimeTelemetryInputSchema = z.object(runtimeTelemetryInputShape);

/** `ggui_runtime_telemetry` output — bare acknowledgement. */
export const runtimeTelemetryOutputSchema = z.object({ ok: z.literal(true) });

// ── Outcome narrowing (ggui#786) ──
//
// The wire root must stay ONE object with a discriminant field (the MCP
// spec's `Tool.outputSchema` root MUST be type `object`, and the SDK
// registers raw shapes), so the identity fields are optional at the
// schema level and the presence rules ride the refinements above.
// Readers narrow with these guards — there is no parallel discriminated
// union type to keep in step with the schema.

type RenderOutputValue = z.infer<typeof renderOutputSchema>;

/** Identity fields a committed render reports. */
type CommittedRenderIdentity = Required<
  Pick<
    RenderOutputValue,
    'sessionId' | 'action' | 'contractHash' | 'blueprintId' | 'variantKey' | 'cache'
  >
>;

/** A render that produced an interface — identity fields present. */
export function isRenderedOutput(
  output: RenderOutputValue,
): output is RenderOutputValue & { outcome: 'rendered' } & CommittedRenderIdentity {
  return output.outcome === 'rendered';
}

/**
 * A generation that RAN and produced nothing. The error session is
 * committed, so `sessionId` is a live handle and `error` classifies it.
 */
export function isFailedRenderOutput(
  output: RenderOutputValue,
): output is RenderOutputValue & {
  outcome: 'failed';
  error: z.infer<typeof renderErrorSchema>;
} & CommittedRenderIdentity {
  return output.outcome === 'failed';
}

/**
 * A PRE-GENERATION refusal — nothing read and nothing committed, so
 * every identity field is absent and `refusal` carries the state. (Not
 * "nothing parsed": the SDK has already checked the call against the
 * tool's declared `inputSchema` by the time a gate can refuse it.)
 */
export function isRefusedRenderOutput(
  output: RenderOutputValue,
): output is { outcome: 'refused'; refusal: PreGenerationRefusal } {
  return output.outcome === 'refused';
}

// ============================================================================
// Tool output schemas the protocol owns (#817 part C). A handler registers
// `<schema>.shape` as its MCP `outputSchema` and derives its output type from
// the schema — never a parallel interface. No `.readonly()` here: zod 4
// projects it as `readOnly` into the advertised JSON Schema, and the wire is
// mutable JSON; readonly is applied at the seam (`DeepReadonly` on the
// derived types). Every shape is closed: the transport strip-parses against
// `.shape`, so the shape IS the wire.
// ============================================================================

/** Display modes an MCP Apps host can render a view in (ext-apps vocabulary). */
export const mcpUiDisplayModeSchema = z.enum(['inline', 'fullscreen', 'pip']);

/**
 * The host-context projection the iframe-runtime observes and `ggui_consume`
 * echoes (`client.hostContext`). Every field optional: a host that never
 * reports one leaves it absent — absent ⇒ the documented default.
 */
export const hostContextProjectionSchema = z.object({
  availableDisplayModes: z.array(mcpUiDisplayModeSchema).optional(),
  currentDisplayMode: mcpUiDisplayModeSchema.optional(),
  containerDimensions: z
    .object({
      width: z.number().optional(),
      maxWidth: z.number().optional(),
      height: z.number().optional(),
      maxHeight: z.number().optional(),
    })
    .optional(),
  platform: z.enum(['web', 'desktop', 'mobile']).optional(),
  deviceCapabilities: z
    .object({ touch: z.boolean().optional(), hover: z.boolean().optional() })
    .optional(),
  locale: z.string().optional(),
  timeZone: z.string().optional(),
});

/** `ggui_consume`'s `client` slice — what the runtime observed about its host. */
export const clientObservationsSchema = z.object({
  hostContext: hostContextProjectionSchema.optional(),
});

/** One row of `ggui_list_sessions` — eight closed keys; nothing passes through. */
export const gguiSessionSummaryWireSchema = z.object({
  sessionId: z.string(),
  hostName: z.string().optional(),
  hostSessionId: z.string().optional(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  status: z.string(),
  wsToken: z.string().optional(),
  wsTokenExpiresAt: z.string().optional(),
});

/**
 * The two states a GguiSession is in on the wire — the pair the consume
 * loop exits on (`expired`). Owned here (ggui#817 part C2); the type is
 * derived, never a second list.
 */
export const gguiSessionStatusSchema = z.enum(['active', 'expired']);

/**
 * One drained row of `ggui_consume` — a user action that reached the
 * pipe (ggui#817 part C2). Closed on the wire: an unknown key is
 * stripped at the transport, a missing key refuses the row at the seam
 * (`parsePendingEnvelope`), so a malformed pipe entry never ships to an
 * agent typed as a good one.
 */
export const consumeEventEntrySchema = z.object({
  type: z.literal('action'),
  sessionId: z.string().min(1),
  intent: z.string(),
  actionData: jsonValueSchema.nullable(),
  uiContext: jsonObjectSchema,
  actionId: z.string(),
  firedAt: z.string(),
});

/**
 * `ggui_consume`'s output — the drained rows, the session's state, and the
 * client's observations when the host sent any (ggui#817 part C2). The
 * handler registers `.shape`; `tools/list` therefore advertises the entry
 * vocabulary and the status enum instead of a free-form record and a free
 * string.
 */
export const gguiConsumeOutputSchema = z.object({
  events: z.array(consumeEventEntrySchema),
  status: gguiSessionStatusSchema,
  client: clientObservationsSchema.optional(),
});

/** `ggui_list_sessions`' output — the closed summary rows (ggui#817 part C2). */
export const gguiListSessionsOutputSchema = z.object({
  sessions: z.array(gguiSessionSummaryWireSchema),
});

/**
 * `ggui_emit`'s output (ggui#817 part C2): `accepted` at the boundary, and
 * `seq` when the server keeps a stream buffer — seq-aware implementations
 * stamp and return it so replay cursors can be built from the ack.
 */
export const gguiEmitOutputSchema = z.object({
  accepted: z.boolean(),
  seq: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Session-scoped monotonic outbound sequence assigned to this delivery. Present when the server keeps a stream buffer.',
    ),
});

/**
 * `ggui_get_session`'s wire: the store row's six base fields plus the mount
 * variant — for EVERY session. An MCP-Apps mount is locator-only on the
 * render object, but its store row carries the base fields, so the
 * projection reads them from the row and the wire never fails on that
 * variant. The locator itself is not on this wire (MCP-Apps resources have
 * their own paths).
 * `contextSnapshot` rides when a component (`render`) mount's row has one —
 * never on an mcpApps mount.
 */
export const gguiGetSessionOutputSchema = z.object({
  variant: z.enum(['render', 'mcpApps']),
  id: z.string(),
  appId: z.string(),
  eventSequence: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  lastActivityAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  /**
   * The last-known value of every declared contextSpec slot, as
   * `ggui_runtime_sync_context` wrote it onto the row — the read path a
   * raw MCP client (no widget-context mirror) has for contextSpec values.
   * Present iff the row carries one — component (`render`) mounts only; an
   * mcpApps mount never carries one; never an empty placeholder.
   */
  contextSnapshot: jsonObjectSchema.optional(),
});

/** The three sequential gates of `ggui_protocol_validate_blueprint`. */
export const blueprintValidationTierSchema = z.enum(['compile', 'selfCheck', 'runtime']);

export const blueprintValidationIssueSchema = z.object({
  tier: blueprintValidationTierSchema,
  code: z.string(),
  message: z.string(),
  fix: z.string().optional(),
});

/** `ggui_protocol_validate_blueprint`'s result envelope: `failedAt` names the tier that stopped, or null. */
export const blueprintValidationResultSchema = z.object({
  valid: z.boolean(),
  failedAt: blueprintValidationTierSchema.nullable(),
  errors: z.array(blueprintValidationIssueSchema),
  warnings: z.array(blueprintValidationIssueSchema),
});

/** A provider row — what `ggui_list_featured_blueprints` returns per blueprint. */
export const blueprintEntryWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: blueprintSourceSchema,
  updatedAt: z.string(),
  tags: z.array(z.string()).optional(),
});

export const gguiListFeaturedBlueprintsOutputSchema = z.object({
  blueprints: z.array(blueprintEntryWireSchema),
  total: z.number().int().nonnegative(),
});

/** One `ggui_search_blueprints` hit — a scored row plus the registry-only keys. */
export const gguiSearchBlueprintsResultSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  props: z.array(
    z.object({ name: z.string(), type: z.string(), required: z.boolean(), description: z.string() }),
  ),
  callbacks: z.array(z.string()),
  featured: z.boolean(),
  relevance: z.literal('match'),
  score: z.number(),
  origin: z.literal('registry').optional(),
  artifactId: z.string().optional(),
  version: z.string().optional(),
  mcpTools: z.array(z.object({ server: z.string().optional(), tool: z.string() })).optional(),
  scopeVerification: z.enum(['verified', 'unverified']).optional(),
});

export const gguiSearchBlueprintsOutputSchema = z.object({
  results: z.array(gguiSearchBlueprintsResultSchema),
  total: z.number(),
  query: z.string(),
  degradedSources: z
    .array(
      z.object({
        source: z.literal('registry'),
        reason: z.enum(['unreachable', 'timeout', 'invalid_response']),
      }),
    )
    .optional(),
});
