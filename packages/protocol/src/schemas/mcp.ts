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
import { dataContractSchema } from './data-contract';
import { blueprintVarianceSchema } from './blueprint';

// ── Shared Sub-Schemas ──

export const viewportSchema = z.object({
  width: z.number(),
  height: z.number(),
});

export const interfaceContextSchema = z.object({
  viewport: viewportSchema,
  platform: z.enum(['web', 'mobile', 'desktop']),
  deviceType: z.enum(['phone', 'tablet', 'desktop']),
  orientation: z.enum(['portrait', 'landscape']),
  devicePixelRatio: z.number().optional(),
  touchPrimary: z.boolean().optional(),
  shellType: z.enum(['chat', 'fullscreen', 'spatial']).optional(),
  colorScheme: z.enum(['light', 'dark']).optional(),
  reducedMotion: z.boolean().optional(),
}).passthrough();

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
      'Agent\'s draft: contract (required) + optional variance + optional generator slug hint. The server combines this with cached blueprints + validator outcomes to produce a three-mode suggestion (cache / agent / synth).',
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
   * additively. `model` MUST be a provider-prefixed id
   * (`provider/model-name`); a bound generator may also accept
   * generator-specific prefixes for alternate transports.
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
          'Provider-prefixed model id (e.g., `anthropic/claude-haiku-4-5`, `openai/gpt-5`). Generator-specific prefixes (e.g., `bedrock/...` for AWS Bedrock routing) supported when the bound generator handles them.',
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
 * Wire-output shape — `{sessionId, resourceUri?, action, contractHash,
 * cache, error?, nextStep?}`. `contractHash` (data-contract identity)
 * and `cache` (reuse outcome) are required wire fields on this schema.
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
 * Failure envelope (SPEC §7.1): a failed/rejected generation returns
 * this same schema-conformant shape on an `isError: true` tool result —
 * `error` present, `resourceUri` absent (nothing mountable), no
 * `_meta` on the result. The error GguiSession is still committed, so
 * `sessionId` remains a live handle into the session channel.
 *
 * Post-Phase-B the `'compose'` action enum value is gone — there is no
 * stack of N renders to compose against.
 */
export const renderOutputSchema = z.object({
  sessionId: z.string(),
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
  action: z.enum(['create', 'reuse', 'update', 'replace', 'declined']),
  contractHash: z
    .string()
    .describe(
      'Canonical hash of the rendered data contract (shape only — fields, types, specs). Same hash ⟺ same data flow.',
    ),
  blueprintId: z
    .string()
    .describe(
      'Opaque id of the materialised component for this render. On the handshake-decided reuse paths (accept a cache-origin proposal, or a variance re-aim that resolves to an existing variant) it is the stored id — equal ids across renders mean the same stored component. override.contract always generates cold and mints a fresh id, even for an identical contract.',
    ),
  variantKey: z
    .string()
    .describe(
      'Canonical hash of the design-time variance (persona, aesthetic, seed prompt, context). With contractHash it forms the reuse key: the same pair reuses one component; a different variant of the same contract gets its own.',
    ),
  cache: renderCacheMarkerSchema.describe(
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
 * Wire-output shape — minimal acknowledgement. The handler carries
 * `decision`, `contract`, `contractHash` on its internal `UpdateOutput`
 * TS shape — zod strips them before structuredContent serialization.
 *
 * Every REAL update (`updated: true`) mints a new history record and
 * its result carries the `ai.ggui/render` slice as a FULL bootable
 * mount package (#483 — hosts mint a per-result view for the new
 * card); a no-op (`updated: false`) carries NO result `_meta`.
 * Already-mounted frames are not repainted by update — they freeze as
 * history when its higher-epoch `props_update` frame lands; the
 * in-place repaint over the live-channel ladder (WS / SSE / polling /
 * bridge-pull) is `ggui_amend`'s job.
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
   * mount URI. Kept in sync with the update handler's wire shape —
   * this export and the handler's inline schema must not drift.
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
});

/**
 * `ggui_amend` wire output (#483) — acknowledgement only. `resourceUri`
 * is the BARE live-head URI (amend targets the mounted card; it never
 * mints a record, so there is no pinned URI to return and no epoch
 * field — the history number is untouched by construction). The
 * mounted card receives the new props over the live channels.
 */
export const amendOutputSchema = z.object({
  sessionId: z.string(),
  updated: z.boolean(),
  resourceUri: z.string(),
  /** Same no-op feedback channel as ggui_update's `warning`. */
  warning: z.string().optional(),
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
 * Per-batch event cap on `ggui_runtime_telemetry` — a bounded
 * fire-and-forget diagnostic channel, never a data plane.
 */
export const RUNTIME_TELEMETRY_MAX_EVENTS = 40;

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
