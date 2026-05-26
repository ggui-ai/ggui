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
  pushDecisionSchema,
} from './handshake-suggestion';

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
// args (`stackItemid`, `sesssionId`, etc.) surface immediately at the wire
// boundary instead of silently no-op-ing because the server stripped them.
export const popInputSchema = z.object({
  sessionId: z.string().describe('Session opaque id from ggui_new_session.'),
}).strict();

export const consumeInputSchema = z.object({
  stackItemId: z.string().describe('Stack item opaque id (UUID) — returned by ggui_push.'),
  timeout: z.number().min(0).max(25).optional()
    .describe('Long-poll timeout in seconds (default short; max 25).'),
}).strict();

/**
 * Input schema for `ggui_emit` — emit a stamped delivery on a declared
 * `streamSpec[channel]`.
 */
export const emitInputSchema = z.object({
  sessionId: z.string().describe('Session opaque id from ggui_new_session.'),
  channel: z.string()
    .describe('Channel name declared on the active stack item streamSpec.'),
  payload: z.unknown().describe('Payload — must match streamSpec[channel].schema.'),
  complete: z.boolean().optional()
    .describe('True marks the stream complete; subsequent emits on this channel reject.'),
  stackItemId: z.string().optional()
    .describe('Stack item to scope this emit to; defaults to session top.'),
}).strict();

export const getSessionInputSchema = z.object({
  sessionId: z.string().describe('Session opaque id from ggui_new_session.'),
}).strict();

export const getStackInputSchema = z.object({
  sessionId: z.string().describe('Session opaque id from ggui_new_session.'),
}).strict();

export const closeInputSchema = z.object({
  sessionId: z.string().describe('Session opaque id from ggui_new_session.'),
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
  sessionId: z.string().optional().describe('Existing session ID to push consent UI into'),
}).strict();

// ── Protocol v1.1 — canonical tool quartet ──
//
// `ggui_new_session` + `ggui_handshake` + `ggui_push` + `ggui_update`.
// The session lifecycle is decoupled from the push lifecycle: agents
// mint a sessionId via `ggui_new_session` ONCE per chat, then thread
// it across every subsequent `ggui_handshake`. `ggui_update` mutates
// stack-item props addressed by the globally-unique `stackItemId` — no
// sessionId required (server resolves via the SessionStore's stackItemId
// secondary index, with appId tenancy enforced from `ctx.appId`).
//

/**
 * `ggui_new_session` — mint or resolve a chat-scoped session handle.
 *
 * Server-mints, agent-threads. SEP-2567 aligned ("Sessionless MCP",
 * Final 2026-03-11): the MCP spec deliberately removes Mcp-Session-Id
 * because hosts can't agree on what a session means; the recommended
 * pattern is exactly this — server returns explicit handles, agent
 * threads them through subsequent calls.
 *
 * No inputs — every call mints a fresh random sessionId. (A prior
 * optional `seed` for deterministic derivation was retired because
 * LLMs were passing the same seed across user turns and getting back
 * the same sessionId, defeating the "new" in the tool name.)
 */
export const newSessionInputSchema = z.object({}).strict();

export const newSessionOutputSchema = z.object({
  sessionId: z.string()
    .describe('Thread this through every subsequent ggui_handshake / ggui_update call in this chat.'),
  appId: z.string(),
  createdAt: z.string()
    .describe('ISO 8601 — creation timestamp of the freshly-minted session.'),
  nextStep: z.object({
    tool: z.literal('ggui_handshake'),
    description: z.string(),
    example: z.string(),
  }).describe('Wire-shape recovery hint — a worked literal example of the next call.'),
});

//
// `ggui_handshake` + `ggui_push` + `ggui_update` follow.
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
 * Step 3 (paired `ggui_push`): the agent accepts (reuses the
 * provisional `blueprintId` minted in step-2) OR overrides (mints a
 * fresh `blueprintId` against a NEW draft).
 *
 * Locked decisions:
 *
 *   - `blueprintDraft` is the single-field input wrapping contract +
 *     variance + generator hint.
 *   - The agent is the contract authority; synth amends only when
 *     validation fails.
 */
export const handshakeInputSchema = z.object({
  /**
   * Required. Mint via `ggui_new_session` once per chat, then thread
   * through every subsequent handshake. Server validates existence +
   * tenant ownership; unknown / cross-tenant ids surface as
   * session_not_found.
   */
  sessionId: z.string()
    .min(1)
    .describe('Session handle minted by ggui_new_session. Required — call ggui_new_session({seed?}) first to obtain one. Reuse the same sessionId across multiple handshake/push pairs in the same chat to grow the session stack.'),
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
   * and the agent wants to force a fresh-gen path on the paired push.
   */
  forceCreate: z.boolean().optional(),
}).strict();

/**
 * Three-step handshake output. Single `suggestion` carries
 * `origin: cache | agent | synth`, `blueprintMeta` (always present),
 * and optional `amendments` (synth-only) / `validationFindings`
 * (soft on cache).
 *
 * The agent reads `suggestion.origin` to branch the paired push:
 *
 *   - `cache`  → push `{decision: {kind: 'accept'}}` for cache delivery.
 *   - `agent`  → push `{decision: {kind: 'accept'}}` to gen against the draft.
 *   - `synth`  → push `{decision: {kind: 'accept'}}` to gen against the amended contract.
 *
 * Any origin → push `{decision: {kind: 'override', blueprintDraft: {...}}}` to
 * discard the suggestion and gen against a fresh draft (mints a new
 * `blueprintId` server-side).
 *
 * Wire-output is intentionally lean. The handler carries `reason`,
 * `target`, `alternatives`, `contractHash`, `serverCapabilities` on
 * its internal `HandshakeOutput` TS shape for telemetry / post-classify
 * tracing — zod strips them before structuredContent serialization.
 *
 * `serverCapabilities` reaches the iframe via the `ai.ggui/session` +
 * `ai.ggui/stack-item` slice meta pair (see `slice-meta-derivation.ts`),
 * not via this response.
 */
export const handshakeOutputSchema = z.object({
  handshakeId: z.string().describe('Stable id — pass to ggui_push / ggui_update'),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'compose', 'declined']),
  /**
   * The handshake suggestion — see `handshakeSuggestionSchema`. The
   * routing discriminator is `suggestion.origin`; `blueprintMeta` is
   * ALWAYS present; `amendments` / `validationFindings` are
   * conditional on the routing outcome.
   */
  suggestion: handshakeSuggestionSchema
    .describe('Server\'s suggestion — origin-routed (cache | agent | synth). Always carries a provisional `blueprintMeta` the agent reuses by sending `decision: \'accept\'` on push.'),
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
    tool: z.literal('ggui_push'),
    description: z.string(),
    example: z.string(),
  }).optional().describe(
    'Wire-shape recovery hint. A worked literal example of the next ggui_push call the agent should emit — the example string can be copied verbatim and tweaked (e.g. fill in `props` placeholders). Top-level field so a skimming agent finds it immediately.',
  ),
});

/**
 * `ggui_push` — materialises a UI emission. Step 3 of the three-step
 * handshake protocol.
 *
 * The agent commits its decision relative to the prior handshake's
 * suggestion: ACCEPT (use the provisional `blueprintMeta` from
 * step-2 verbatim) or OVERRIDE (mint a fresh blueprintId with a NEW
 * `blueprintDraft`).
 *
 * Locked decisions:
 *
 *   - `decision` discriminator: `{kind: 'accept'} |
 *     {kind: 'override', blueprintDraft: {...}}`.
 *   - `accept` reuses `handshake.suggestion.blueprintMeta.blueprintId`
 *     exactly; `override` discards the provisional id and mints fresh.
 *
 * There is no separate `ggui_commit` — push absorbs that responsibility.
 */
export const pushInputSchema = z.object({
  handshakeId: z
    .string({
      message:
        'ggui_push: handshakeId is REQUIRED. Call ggui_handshake({sessionId, intent, blueprintDraft}) first to negotiate — handshake returns a handshakeId + suggestion. Then push with {handshakeId, decision: {kind: \'accept\'}} (accept the suggestion) or {handshakeId, decision: {kind: \'override\', blueprintDraft: {...}}} (override with a fresh draft). Direct-push without a handshakeId is not supported.',
    })
    .min(1, 'ggui_push: handshakeId must be a non-empty string from a prior ggui_handshake call.'),
  /**
   * Runtime prop values for THIS render. Validated against the
   * effective contract's `propsSpec` — required-field checks + type
   * checks per spec entry. Validation failures fail the push with a
   * recoverable `ContractViolationError`.
   */
  props: z.record(z.string(), z.unknown()).optional(),
  /**
   * Decision discriminator (REQUIRED).
   *
   *   - `{kind: 'accept'}` — use the handshake's
   *     `suggestion.blueprintMeta` verbatim. Cache delivery (origin
   *     === 'cache') or gen-against-suggestion (origin === 'agent' /
   *     'synth'). Reuses the provisional `blueprintId`.
   *   - `{kind: 'override', blueprintDraft: {...}}` — mint a fresh
   *     `blueprintId` and gen against the agent's NEW draft. The
   *     provisional id from the handshake is discarded. Telemetry
   *     threads via `handshakeId`.
   */
  decision: pushDecisionSchema
    .describe('Accept the handshake suggestion (use provisional blueprintId verbatim) or override with a fresh draft (mint new blueprintId).'),
}).strict();

/**
 * Wire-output shape — intentionally lean: `{stackItemId, nextStep?,
 * action}`. The handler carries `sessionId`, `shortCode`, `codeReady`,
 * `handshakeId`, `decision`, `contract`, `contractHash`, `cache`,
 * `codeUrl`, `codeHash` on its internal `PushOutput` TS shape for
 * telemetry / post-classify tracing — zod strips them before
 * structuredContent serialization.
 *
 * The iframe receives bootstrap credentials (`wsUrl`, `token`,
 * `expiresAt`) via the `ai.ggui/session` slice meta, not via this
 * response. There is no clickable `url` field — post-R5 the `/r/`
 * shortCode route was deleted (every host either resolves the
 * `_meta.ui.resourceUri` iframe or reads `{sessionId, stackItemId}`
 * via `session-resource/item/...`). Leaving a dead URL on the wire
 * had the model hallucinating links that resolve nowhere.
 */
export const pushOutputSchema = z.object({
  stackItemId: z.string(),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'compose', 'declined']),
  /**
   * Wire-shape recovery hint for the next call. Emitted ONLY when the
   * pushed contract has a non-empty `actionSpec` — i.e. the agent will
   * receive user-action events on this stack item. Pure-display pushes
   * (props only) get no `nextStep` because there is nothing to consume.
   *
   * Mirrors the chain at `new_session.nextStep` (→ handshake) and
   * `handshake.nextStep` (→ push). Closes the loop with consume.
   *
   * `args.stackItemId` is the literal value the agent passes to
   * `ggui_consume` — copy-paste shape.
   */
  nextStep: z.object({
    tool: z.literal('ggui_consume'),
    description: z.string(),
    example: z.string(),
    args: z.object({
      stackItemId: z.string(),
    }),
  }).optional().describe(
    'Recovery hint — when the pushed contract has actions, points the agent at ggui_consume({stackItemId}) for the inbound action loop. Absent for pure-display pushes.',
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
 * against the stack item's `propsSpec` and reject on violation —
 * partial patches that would break required fields, type-mismatch
 * values, etc. all reject pre-persist.
 *
 * `stackItemId` is globally unique; the server resolves the owning
 * session via its secondary index and tenancy-checks via `ctx.appId`.
 * NO `sessionId` on the wire.
 */
export const updateInputSchema = z.discriminatedUnion('kind', [
  z.object({
    stackItemId: z.string().describe('Stack item opaque id (UUID) — returned by ggui_push.'),
    kind: z.literal('replace'),
    props: z.record(z.string(), z.unknown())
      .describe('Full replacement props map. New map IS the new state.'),
  }).strict(),
  z.object({
    stackItemId: z.string().describe('Stack item opaque id (UUID) — returned by ggui_push.'),
    kind: z.literal('merge'),
    patch: z.record(z.string(), z.unknown())
      .describe('RFC 7396 JSON Merge Patch — null deletes a key; arrays fully replace.'),
  }).strict(),
]);

/**
 * Wire-output shape — minimal acknowledgement. The handler carries
 * `sessionId`, `decision`, `contract`, `contractHash` on its internal
 * `UpdateOutput` TS shape — zod strips them before structuredContent
 * serialization.
 *
 * Post-update the iframe receives the new props via the live-channel
 * `props_update` WS frame; the cross-host fallback path receives them
 * via the `ai.ggui/stack-item.propsJson` slice field (see
 * `update.resultMeta`). The wire response itself is just
 * acknowledgement.
 */
export const updateOutputSchema = z.object({
  stackItemId: z.string(),
  updated: z.boolean(),
});
