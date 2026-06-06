/**
 * MCP Tool Zod Schemas — Single Source of Truth
 *
 * These schemas define the validation rules for MCP tool inputs.
 * TypeScript types in types/mcp.ts are derived from these via z.infer.
 * The server handler imports these for runtime validation.
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

// ── Other Tool Schemas ──

// Input schemas: pre-launch posture is `.strict()` — unknown keys reject.
// Pre-fix all of these had `.passthrough()` as forward-compat shims. Pre-
// launch No Backward Compatibility (CLAUDE.md) supersedes — typos in agent
// args (`renderid`, `redner_id`, etc.) surface immediately at the wire
// boundary instead of silently no-op-ing because the server stripped them.

export const consumeInputSchema = z.object({
  sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
  timeout: z.number().min(0).max(25).optional()
    .describe('Long-poll timeout in seconds (default short; max 25).'),
}).strict();

/**
 * Input schema for `ggui_emit` — emit a stamped delivery on a declared
 * `streamSpec[channel]`.
 */
export const emitInputSchema = z.object({
  sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
  channel: z.string()
    .describe('Channel name declared on the active GguiSession streamSpec.'),
  payload: z.unknown().describe('Payload — must match streamSpec[channel].schema.'),
  complete: z.boolean().optional()
    .describe('True marks the stream complete; subsequent emits on this channel reject.'),
}).strict();

export const getRenderInputSchema = z.object({
  sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
}).strict();

export const listFeaturedBlueprintsInputSchema = z.object({
  level: z.enum(['primitive', 'component', 'composite', 'template']).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
  limit: z.number().optional(),
}).strict();

export const searchBlueprintsInputSchema = z.object({
  query: z.string(),
  limit: z.number().optional(),
}).strict();

export const renderBlueprintInputSchema = z.object({
  blueprintId: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const discoverInputSchema = z.object({}).strict();

export const requestCredentialInputSchema = z.object({
  serviceId: z.string().describe('OAuth service ID (e.g., "bashdoor", "ubot")'),
  reason: z.string().optional().describe('Why the agent needs this credential (shown to user)'),
  sessionId: z.string().optional().describe('Existing GguiSession id to render consent UI into.'),
}).strict();

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
 * Wire-output is intentionally lean. The handler carries `reason`,
 * `target`, `alternatives`, `contractHash`, `serverCapabilities` on
 * its internal `HandshakeOutput` TS shape for telemetry / post-classify
 * tracing — zod strips them before structuredContent serialization.
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
 */
export const renderInputSchema = z.object({
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
}).strict();

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
 * Wire-output shape — `{sessionId, resourceUri, action, contractHash,
 * cache, nextStep?}`. `contractHash` (data-contract identity) and `cache`
 * (reuse outcome) are required wire fields on this schema.
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
   */
  resourceUri: z.string(),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'declined']),
  contractHash: z
    .string()
    .describe(
      'Canonical hash of the rendered data contract (shape only — fields, types, specs). Same hash ⟺ same data flow.',
    ),
  blueprintId: z
    .string()
    .describe(
      'Opaque id of the materialised component for this render. Equal across two renders means the same cached component was served (a fresh generation mints a new id; a reuse returns the stored one).',
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
    }),
  }).optional().describe(
    'Recovery hint — when the rendered contract has actions, points the agent at ggui_consume({sessionId}) for the inbound action loop. Absent for pure-display renders.',
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
      .describe('Full replacement props map. New map IS the new state.'),
  }).strict(),
  z.object({
    sessionId: z.string().describe('GguiSession opaque id (UUID) — returned by ggui_render.'),
    kind: z.literal('merge'),
    patch: z.record(z.string(), z.unknown())
      .describe('RFC 7396 JSON Merge Patch — null deletes a key; arrays fully replace.'),
  }).strict(),
]);

/**
 * Wire-output shape — minimal acknowledgement. The handler carries
 * `decision`, `contract`, `contractHash` on its internal `UpdateOutput`
 * TS shape — zod strips them before structuredContent serialization.
 *
 * Post-update the iframe receives the new props via the live-channel
 * `props_update` WS frame; the cross-host fallback path receives them
 * via the `ai.ggui/render.propsJson` slice field (see
 * `update.resultMeta`). The wire response itself is just
 * acknowledgement.
 */
export const updateOutputSchema = z.object({
  sessionId: z.string(),
  updated: z.boolean(),
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
