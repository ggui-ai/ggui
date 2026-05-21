/**
 * `ggui_handshake` — the contract-negotiation step of the
 * handshake/push protocol.
 *
 * ## What this handler does
 *
 *   1. Validates the handshake input shape (`{ sessionId, intent,
 *      blueprintDraft, forceCreate? }`).
 *   2. Resolves session existence + tenancy.
 *   3. Resolves the per-app gadget catalog.
 *   4. Delegates suggestion production to the bound
 *      {@link HandshakeNegotiator} — which produces a
 *      {@link HandshakeSuggestion} routed by `origin: cache | agent | synth`.
 *      The negotiator implementation owns the search + validate
 *      orchestration (the reference LLM-backed negotiator runs
 *      `BlueprintSearch.search` and `validateContract` in parallel,
 *      falling through to a `synth.amend` seam when validation fails).
 *      Absent negotiator → the seam stamps an `origin: 'agent'`
 *      suggestion using the agent's draft verbatim (no enrichment).
 *   5. Persists a {@link HandshakeRecord} under a TTL-bounded
 *      {@link KeyValueStore} key. Single-use: the paired `ggui_push`
 *      consumes it via `getAndDelete`.
 *   6. Returns a `GguiHandshakeOutput`-shaped result carrying the
 *      handshakeId, the suggestion, optional alternatives, and the
 *      canonical hash of the agent's draft.
 *
 * ## Output shape
 *
 * The handler returns a single `suggestion` carrying `origin`
 * (cache | agent | synth) plus an ALWAYS-PRESENT `blueprintMeta`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertContractNoRetiredFields } from './assert-contract-no-retired-fields.js';
import { assertGeneratorRegistered } from './assert-generator.js';
import { clientObservationsSchema } from './client-observations.js';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  STDLIB_GADGETS,
  assertContractSchemasValid,
  assertCrossReferences,
  assertNameInvariants,
  assertSchemaCompat,
  dataContractSchema,
  handshakeSuggestionSchema,
  type Blueprint,
  type BlueprintDraft,
  type BlueprintMeta,
  type GadgetDescriptor,
  type DataContract,
  type HandshakeSuggestion,
  type JsonValue,
  type ServerCapabilities,
  type SuggestionFinding,
} from '@ggui-ai/protocol';
import type {
  AppMetadataStore,
  KeyValueStore,
  SessionStore,
  TelemetrySink,
  VariantSelectionContext,
  VariantSelectionDecision,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import type { CanvasLifecycleEmitter } from './canvas-lifecycle.js';
import { SessionNotFoundError, SessionRequiredError } from './errors.js';

/**
 * Handshake-time input shape.
 *
 * `blueprintDraft` carries the agent's draft (contract + optional
 * variance + optional generator hint). `forceCreate` short-circuits
 * cache search so the paired push always cold-gens.
 */
export interface HandshakeStoredInput {
  /** Concise semantic identity of the UI — drives intent-axis search keying. */
  readonly intent: string;
  /** Agent's draft — contract (required) + optional variance + generator. */
  readonly blueprintDraft: BlueprintDraft;
  /**
   * Skip blueprint search and route straight to validation (and on
   * pass, agent-mode suggestion). Used after an earlier handshake
   * returned an unwanted cache suggestion.
   */
  readonly forceCreate?: boolean;
}

/**
 * Routing hint carried from handshake to the paired push. Populated
 * by the suggestion's `target` field (passed through from the
 * negotiator) so the push reuses the session the handshake already
 * resolved against.
 */
export interface HandshakeStoredTarget {
  readonly sessionId?: string;
  readonly stackItemId?: string;
}

/**
 * Persisted handshake record. The paired `ggui_push` reads:
 *
 *   - `suggestion.blueprintMeta` — the provisional blueprintId +
 *     contractHash + (when cache) codeHash for accept-path delivery.
 *   - `suggestion.blueprintMeta.generator` — which generator slug to
 *     drive on gen.
 *   - `input.blueprintDraft.contract` — the agent's original draft
 *     (only used for telemetry; accept-path runs gen against the
 *     suggestion's stored contract).
 *   - `effectiveContract` — the contract gen runs against on the
 *     accept-path. Equals the agent's draft for `origin: agent`, the
 *     amended contract for `origin: synth`, the cached blueprint's
 *     contract for `origin: cache`.
 *   - `target` — session + optional stackItemId routing.
 */
export interface HandshakeRecord {
  readonly handshakeId: string;
  readonly action: 'create' | 'reuse' | 'update' | 'replace' | 'compose' | 'declined';
  readonly reason: string;
  /** Agent's original draft input — for telemetry + override-path validation. */
  readonly input: HandshakeStoredInput;
  /** Routing hint. */
  readonly target: HandshakeStoredTarget;
  /** Server's suggestion — always populated on a successful handshake. */
  readonly suggestion: HandshakeSuggestion;
  /**
   * Effective contract the accept-path gen / cache-delivery runs
   * against. Derived from `suggestion.blueprintMeta` + `input` per
   * the origin:
   *
   *   - `origin: 'cache'`  — the cached blueprint's contract.
   *   - `origin: 'agent'`  — `input.blueprintDraft.contract` verbatim.
   *   - `origin: 'synth'`  — synth's amended contract (the contract
   *                          whose canonical hash equals
   *                          `blueprintMeta.contractHash`).
   *
   * Materialized at handshake-time so the push doesn't re-derive.
   */
  readonly effectiveContract: DataContract;
  readonly appId: string;
  readonly createdAt: string;
}

/**
 * Negotiator binding. The negotiator's role is to PRODUCE the
 * {@link HandshakeSuggestion} — given the agent's draft, the resolved
 * session, and any per-app context, the negotiator returns:
 *
 *   - `suggestion` — always present (Option B from the plan).
 *   - `action` — `'reuse'` for cache hits, `'create'` otherwise.
 *   - `reason` — human-readable explanation.
 *   - `target` — optional routing hint.
 *   - `alternatives` — optional top-N alternative blueprints.
 *   - `effectiveContract` — the contract gen runs against on
 *                           accept-path. The handshake handler
 *                           persists this so push doesn't re-derive.
 *
 * Negotiator implementations may:
 *
 *   - Run `BlueprintSearch` + parallel validation for the full
 *     three-mode routing (cache / agent / synth) — see
 *     `@ggui-ai/negotiator` for the canonical impl.
 *   - Stub `origin: 'agent'` against the agent's draft (the OSS
 *     default when no negotiator is bound).
 */
export interface HandshakeNegotiator {
  decide(input: {
    /** Agent-authored intent — drives search intent-axis keying. */
    readonly intent: string;
    /** Agent's draft — see {@link BlueprintDraft}. */
    readonly blueprintDraft: BlueprintDraft;
    /** Force-skip cache search; route to validation + agent/synth path. */
    readonly forceCreate?: boolean;
    /** Per-app gadget catalog — synth uses to populate gadgets. */
    readonly gadgets?: readonly GadgetDescriptor[];
    /** Resolved sessionId — validated by the handler before invoking. */
    readonly sessionId: string;
    readonly ctx: HandlerContext;
  }): Promise<HandshakeNegotiatorResult> | HandshakeNegotiatorResult;

  /**
   * Optional LLM-driven variant selection. When a negotiator
   * exposes this method, the variant-selector orchestration
   * ({@link selectVariantWithLlm}) can dispatch the per-call LLM
   * pick into the same negotiator that owns the rest of the
   * handshake decision pipeline. Implementations:
   *
   *   - Read each candidate's `variance` (persona / aesthetic /
   *     context / seedPrompt) + `validatorScore` +
   *     `isOperatorDefault` and compare to the context's `intent`
   *     + `variance` signals.
   *   - Return a {@link VariantSelectionDecision} carrying the
   *     chosen `blueprintId`, a `[0, 1]` calibrated confidence, and
   *     a human-readable reason.
   *
   * Calibration is load-bearing: the orchestration thresholds on
   * `confidence` to decide LLM-pick vs deterministic-ladder
   * fallback. An impl that always returns `1.0` defeats the
   * fallback; an impl that always returns `0.0` defeats the LLM
   * layer. The default threshold is `0.6`
   * ({@link DEFAULT_VARIANT_SELECTION_CONFIDENCE_THRESHOLD}).
   *
   * Absent → the orchestration falls straight through to the
   * deterministic ladder. This is the default posture when no LLM
   * is bound.
   */
  selectVariant?(input: {
    /** Pre-filtered candidate shortlist (≤ shortlistSize per the orchestration). */
    readonly candidates: readonly Blueprint[];
    /** Per-call inputs — see {@link VariantSelectionContext}. */
    readonly context: VariantSelectionContext;
    /** Resolved sessionId — same trust root as `decide()`. */
    readonly sessionId: string;
    readonly ctx: HandlerContext;
  }): Promise<VariantSelectionDecision>;
}

export interface HandshakeNegotiatorResult {
  readonly action: 'create' | 'reuse' | 'update' | 'replace' | 'compose' | 'declined';
  readonly reason: string;
  readonly suggestion: HandshakeSuggestion;
  /**
   * Effective contract the accept-path gen / cache-delivery runs
   * against. See {@link HandshakeRecord.effectiveContract}.
   */
  readonly effectiveContract: DataContract;
  /** Routing hint. */
  readonly target?: HandshakeStoredTarget;
  /** Top-N alternative blueprints surfaced on the response. */
  readonly alternatives?: readonly Blueprint[];
}

export interface GguiHandshakeHandlerDeps {
  /**
   * Persistence plane for handshake records. The OSS default wires
   * `InMemoryKeyValueStore`; hosted wraps DDB / ElastiCache. The
   * `getAndDelete` contract on the seam guarantees single-use
   * consumption of each `handshakeId`.
   */
  readonly kvStore: KeyValueStore;
  /**
   * Session store. When bound, the handshake handler validates the
   * `sessionId` field on the wire input — must exist AND belong to
   * `ctx.appId`. Unknown / cross-tenant ids surface as
   * `SessionNotFoundError`.
   */
  readonly sessionStore?: SessionStore;
  /**
   * Optional per-app metadata resolver. When bound, the handler reads
   * `app.gadgets` for the resolved `ctx.appId` and threads it
   * to the negotiator so synth can teach the LLM which gadget
   * bindings the produced UI may use.
   */
  readonly appMetadataStore?: AppMetadataStore;
  /**
   * Optional negotiator binding. See {@link HandshakeNegotiator}.
   * Absent → the handler stamps an `origin: 'agent'` suggestion using
   * the agent's draft verbatim (no enrichment / no search).
   */
  readonly negotiator?: HandshakeNegotiator;
  /**
   * Optional description override. Hosted deployments may want
   * different prose than OSS.
   */
  readonly description?: string;
  /**
   * UUID minter override — tests pass a deterministic mint. Defaults
   * to `randomUUID` from `node:crypto`.
   */
  readonly generateHandshakeId?: () => string;
  /**
   * Provisional blueprint-id minter override. Same posture as
   * {@link generateHandshakeId} — tests freeze for deterministic
   * assertions. Defaults to `randomUUID` prefixed with `bp_`.
   */
  readonly mintBlueprintId?: () => string;
  /**
   * Clock override — tests freeze time for deterministic
   * `createdAt`. Defaults to `() => new Date().toISOString()`.
   */
  readonly now?: () => string;
  /**
   * Record TTL in seconds. Defaults to 600 (10 min) — matches the
   * `KeyValueStore` docstring.
   */
  readonly ttlSec?: number;
  /**
   * Optional resolver invoked at handshake time to populate the
   * {@link ServerCapabilities} field on the response — lets the
   * client learn which stream transports the server supports.
   */
  readonly serverCapabilities?: () => ServerCapabilities | undefined;
  /**
   * Default generator slug used when the negotiator doesn't bind one
   * (the `origin: 'agent'` fallback path). Defaults to
   * `'ui-gen-default-haiku-4-5'`.
   */
  readonly defaultGenerator?: string;
  /**
   * Canvas-mode lifecycle emitter. When
   * wired, the handler fires `handshake_started` at entry and
   * `handshake_completed` just before return on the `_ggui:lifecycle`
   * channel. Fire-and-forget — emit errors are absorbed by the impl.
   *
   * Absent ⇒ no emissions. Sessions without canvas mode wired (the
   * vast majority today) pay zero cost.
   */
  readonly canvasLifecycle?: CanvasLifecycleEmitter;
  /**
   * Optional operational-signal sink. When bound, the handler emits
   * a `handshake.decided` event on every successful handshake
   * carrying:
   *
   *   - `appId`, `handshakeId`, `sessionId`
   *   - `origin` — `cache | agent | synth` from the suggestion
   *   - `action` — `'create' | 'reuse' | …` from the negotiator
   *   - `selectedBlueprintId` — the provisional id on the suggestion
   *   - `selectionReason` — `suggestion.rationale` /
   *                          `blueprintMeta.selectedReason`
   *   - `selectionConfidence` — surfaced when the negotiator's
   *                              `selectVariant` ran AND the
   *                              orchestration carried confidence
   *                              into `blueprintMeta.selectedReason`;
   *                              absent on negotiators that don't
   *                              implement the optional `selectVariant`
   *                              seam (the deterministic ladder
   *                              doesn't carry a confidence axis).
   *
   * Lossy + non-throwing per the {@link TelemetrySink} contract;
   * absent dep is a NoopTelemetrySink semantic equivalent.
   *
   * These fields ride through every handshake decision so operators
   * can plot LLM-pick vs ladder-fallback frequency from one stream.
   */
  readonly telemetrySink?: TelemetrySink;
}

/** Default TTL (seconds). 10 minutes — same as the KV-store docstring. */
export const HANDSHAKE_RECORD_TTL_SEC = 600;

/** Default generator slug — matches the `GeneratorRegistry` default. */
export const DEFAULT_GENERATOR_SLUG = 'ui-gen-default-haiku-4-5';

/**
 * Compose the KV key for a given (appId, handshakeId) pair. Exported
 * so the paired push handler reads the same shape — single source of
 * truth for the key format.
 */
export function handshakeRecordKey(
  appId: string,
  handshakeId: string,
): string {
  return `ggui-handshake:${appId}:${handshakeId}`;
}

/** Trust-internal parse + shape guard shared by peek + consume. */
function parseHandshakeRaw(
  raw: string | null,
  appId: string,
): HandshakeRecord | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as HandshakeRecord;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.handshakeId !== 'string') return null;
    if (typeof parsed.appId !== 'string' || parsed.appId !== appId) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read a handshake record WITHOUT consuming it. Returns `null` when
 * the id is unknown or expired.
 */
export async function peekHandshakeRecord(
  kvStore: KeyValueStore,
  appId: string,
  handshakeId: string,
): Promise<HandshakeRecord | null> {
  const raw = await kvStore.get(handshakeRecordKey(appId, handshakeId));
  return parseHandshakeRaw(raw, appId);
}

/**
 * Read + atomically consume a handshake record. Returns `null` when
 * the id is unknown or expired.
 */
export async function consumeHandshakeRecord(
  kvStore: KeyValueStore,
  appId: string,
  handshakeId: string,
): Promise<HandshakeRecord | null> {
  const raw = await kvStore.getAndDelete(handshakeRecordKey(appId, handshakeId));
  return parseHandshakeRaw(raw, appId);
}

/** Input zod-shape mirror — same shape as `handshakeInputSchema`. */
const inputSchema = {
  sessionId: z.string().min(1, 'sessionId is required — call ggui_new_session first'),
  intent: z.string().min(1, 'intent is required'),
  /**
   * Agent's draft — contract (required) + variance + generator hint.
   * Validated structurally; the negotiator branch makes the value
   * judgement (contract validates? cache hits? synth amends?).
   */
  blueprintDraft: z
    .object({
      // `dataContractSchema` enforces the strict per-entry wrappers
      // — PropEntry / ActionEntry / StreamChannelEntry / ContextEntry
      // wrappers reject extras. The most common author confusion this
      // catches: putting a JSON Schema flat at the entry level
      // (`propsSpec.properties.todos = {type: 'array', ...}`)
      // instead of wrapping it (`propsSpec.properties.todos =
      // {schema: {type: 'array', ...}, required: true}`). Pre-tighten,
      // the loose `z.object({}).passthrough()` here let the bad shape
      // through and the failure surfaced as an opaque
      // ContractSchemaMetaError at layer-B meta-validation. Now zod
      // rejects with a precise `propsSpec.properties.todos.schema:
      // Required` path before layer-B runs.
      contract: dataContractSchema,
      variance: z
        .object({
          persona: z.string().optional(),
          aesthetic: z.string().optional(),
          context: z.record(z.string(), z.unknown()).optional(),
          seedPrompt: z.string().optional(),
        })
        .strict()
        .optional(),
      // Identifier string naming a server-registered generator
      // (e.g. "anthropic-claude-haiku-4-5"). NOT a place for
      // component source code — the LLM has been observed stuffing
      // a full function body in here when the override-path
      // mental model is unclear. Cap length + restrict charset
      // so any non-identifier value fails at the wire boundary
      // instead of silently falling back to default deeper in
      // synth dispatch.
      generator: z
        .string()
        .max(120)
        .regex(/^[a-z0-9_:.-]+$/i, {
          message:
            "generator must be a registered generator identifier (e.g. 'anthropic-claude-haiku-4-5'), not source code or free-form text",
        })
        .optional(),
    })
    .strict(),
  forceCreate: z.boolean().optional(),
} as const;

/** Output zod-shape mirror. Same shape as `handshakeOutputSchema`. */
const outputSchema = {
  handshakeId: z.string(),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'compose', 'declined']),
  // Server controls this shape end-to-end — `handshakeSuggestionSchema`
  // is `.strict()` on every nested layer (blueprintMeta, amendments,
  // validationFindings). Tightening from `z.object({}).passthrough()`
  // makes drift between the protocol type and the handler's emitted
  // shape a typecheck/runtime failure instead of a silent passthrough.
  suggestion: handshakeSuggestionSchema,
  nextStep: z
    .object({
      tool: z.literal('ggui_push'),
      example: z.string(),
    })
    .optional(),
  // surface the iframe-captured HostContext
  // projection to the agent so it can reason about device class,
  // available display modes, and container dimensions on the next push.
  // Absent ⇒ iframe hasn't echoed yet (first handshake before iframe
  // mount, or non-spec-compliant host); agent falls back to ggui's
  // own InterfaceContext.
  client: clientObservationsSchema,
} as const;

interface HandshakeOutput {
  handshakeId: string;
  action: 'create' | 'reuse' | 'update' | 'replace' | 'compose' | 'declined';
  /**
   * Negotiator reason — internal-only after the 2026-05-13 output trim.
   * Persisted on the HandshakeRecord for telemetry / cache-trace; zod
   * strips it before structuredContent serialization. Kept on the TS
   * shape so internal seams (push handler post-classify trace) still
   * read it from the consumed record without re-derivation.
   */
  reason: string;
  /** Routing hint — internal-only. Same pattern as `reason`. */
  target: HandshakeStoredTarget;
  suggestion: HandshakeSuggestion;
  /** Top-N alternatives — internal-only. Same pattern. */
  alternatives?: readonly Blueprint[];
  /** Canonical hash — internal-only telemetry. */
  contractHash: string;
  nextStep?: {
    readonly tool: 'ggui_push';
    readonly example: string;
  };
  /** Server capabilities — internal-only; bootstrap-meta projects this. */
  serverCapabilities?: ServerCapabilities;
  /**
   * Client-side observed state echoed back to the agent. Today carries
   * only the iframe-captured `HostContextProjection`. Future
   * additions may layer further client signals (e.g. an echoed
   * `InterfaceContext`, last-known navigation state) onto this same
   * envelope.
   *
   * Absent ⇒ no client observations available for this session yet —
   * usually means the iframe hasn't completed `ui/initialize`. Agent
   * falls back to ggui's own `InterfaceContext` pipeline in that case.
   */
  client?: {
    readonly hostContext?: import('@ggui-ai/protocol').HostContextProjection;
  };
}

/**
 * Build the OSS `ggui_handshake` handler. See file-level docstring for
 * the full algorithm.
 */
export function createGguiHandshakeHandler(
  deps: GguiHandshakeHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, HandshakeOutput> {
  const ttlSec = deps.ttlSec ?? HANDSHAKE_RECORD_TTL_SEC;
  const mintHandshakeId = deps.generateHandshakeId ?? (() => randomUUID());
  const mintBlueprintId = deps.mintBlueprintId ?? (() => `bp_${randomUUID()}`);
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const defaultGenerator = deps.defaultGenerator ?? DEFAULT_GENERATOR_SLUG;

  return {
    name: 'ggui_handshake',
    title: 'Handshake',
    audience: ['agent'],
    description:
      deps.description ??
      "Negotiate a contract for a UI you want to deliver. Call AFTER ggui_new_session (once per chat) and BEFORE ggui_push. Input: {sessionId, intent, blueprintDraft: {contract, variance?, generator?}}. CONTRACT SHAPE (DataContract) — every entry under propsSpec.properties / actionSpec / streamSpec / contextSpec is a WRAPPER that contains a JSON Schema in its `schema:` field; the JSON Schema does NOT sit flat at the entry level. ActionEntry uses OPTIONAL `nextStep: '<toolName>'` to hint the agent's intended next tool call — when present, the tool MUST also be declared in `agentCapabilities.tools`; OMIT it entirely when the agent should decide freely (open-ended form submits, the agent composes the next call from broader context). WORKED EXAMPLE: {propsSpec: {properties: {todos: {schema: {type: 'array', items: {type: 'object', properties: {id: {type: 'string'}, text: {type: 'string'}, completed: {type: 'boolean'}}, required: ['id', 'text', 'completed']}}, required: true}}}, actionSpec: {toggleTodo: {label: 'Toggle todo', schema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}, nextStep: 'todo_toggle'}}, agentCapabilities: {tools: {todo_toggle: {description: 'Flip a todo done/undone', inputSchema: {type: 'object', properties: {id: {type: 'string'}}, required: ['id']}}}}}. COMMON MISTAKES — (1) putting JSON Schema flat: `{propsSpec: {properties: {todos: {type: 'array', items: ...}}}}` REJECTS with `Missing 'schema' field`. (2) using `dispatch: {kind: ...}` on an actionSpec entry — that vocabulary is RETIRED; use flat optional `nextStep: '<toolName>'` instead, or omit. (3) referencing a tool from `actionSpec[*].nextStep` without declaring it in `agentCapabilities.tools` — handshake AND push validation both reject with `cross_reference_unresolved` listing the dangling reference. Returns a `suggestion` with origin = cache | agent | synth — server matched an existing blueprint (cache), accepted your draft as-is (agent), or amended it (synth; diff in suggestion.amendments). On the paired ggui_push you send `decision: {kind: 'accept'}` (use the suggestion verbatim) or `decision: {kind: 'override', blueprintDraft}` (mint fresh against a NEW draft). Then ggui_consume → react → repeat. PLACEMENT RULE: actionSpec = events that drive the agent's next turn; contextSpec = observable state. Test: needs next-turn reasoning? actionSpec. No? contextSpec.",
    inputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<HandshakeOutput> {
      // Pre-zod sessionId guard. Surfaces a typed SessionRequiredError
      // (with recovery prose) when the agent omits sessionId entirely.
      if (
        input === null ||
        typeof input !== 'object' ||
        typeof (input as { sessionId?: unknown }).sessionId !== 'string' ||
        (input as { sessionId: string }).sessionId.length === 0
      ) {
        throw new SessionRequiredError();
      }
      const parsed = z.object(inputSchema).parse(input);
      const normalizedInput = normalizeInput(parsed);
      const sessionId = parsed.sessionId;

      // Session existence + tenancy check. Also captures hostContext
      // for surfacing to the agent in the return value.
      let sessionHostContext: import('@ggui-ai/protocol').HostContextProjection | undefined;
      if (deps.sessionStore) {
        const session = await deps.sessionStore.get(sessionId);
        if (!session || session.appId !== ctx.appId) {
          throw new SessionNotFoundError(sessionId);
        }
        sessionHostContext = session.hostContext;
      }

      // Contract validation chain — symmetric with `ggui_push` against
      // `effectiveContract`. Running these at handshake too means agents
      // get author-recoverable feedback BEFORE the negotiator runs and
      // BEFORE any blueprint is cached, saving a round-trip on contracts
      // that have structural mistakes the agent could fix immediately.
      //
      //   1. Layer-B meta-validation: every inner JSON Schema is
      //      well-formed under Ajv strict mode.
      //   2. Cross-reference invariants: every `actionSpec[*].nextStep`
      //      and `streamSpec[*].source.tool` resolves in the contract's
      //      own `agentCapabilities.tools` catalog.
      //   3. Name invariants: no collisions across actionSpec /
      //      streamSpec / contextSpec keys; no `_ggui:` reserved-prefix
      //      keys on actionSpec / contextSpec.
      //   4. Schema-compat invariants: action.schema ⊆
      //      agentCapabilities.tools[nextStep].inputSchema and
      //      channel.schema ⊇ agentCapabilities.tools[source.tool]
      //      .outputSchema against the contract's OWN catalog.
      //
      // The server-registry schema-compat check (knownActionTools)
      // stays in push — server-side schema-compat is a per-deployment
      // concern; the handshake doesn't know which server will
      // ultimately commit.
      // Semantic check on generator name — shared with push.ts's
      // override path so the two seams cannot drift.
      assertGeneratorRegistered(
        normalizedInput.blueprintDraft.generator,
        defaultGenerator,
      );

      const draftContract = normalizedInput.blueprintDraft.contract;
      assertContractNoRetiredFields(draftContract);
      assertContractSchemasValid(draftContract);
      assertCrossReferences(draftContract);
      assertNameInvariants(draftContract);
      assertSchemaCompat(draftContract);

      // Per-app gadget catalog.
      const gadgets: readonly GadgetDescriptor[] | undefined =
        deps.appMetadataStore
          ? ((await deps.appMetadataStore.get(ctx.appId))?.gadgets ??
            STDLIB_GADGETS)
          : undefined;

      // Delegate suggestion production to the negotiator. Absent
      // negotiator → default `origin: 'agent'` suggestion using the
      // agent's draft verbatim.
      const negotiated: HandshakeNegotiatorResult = deps.negotiator
        ? await deps.negotiator.decide({
            intent: normalizedInput.intent,
            blueprintDraft: normalizedInput.blueprintDraft,
            ...(normalizedInput.forceCreate === true
              ? { forceCreate: true as const }
              : {}),
            ...(gadgets !== undefined ? { gadgets } : {}),
            sessionId,
            ctx,
          })
        : buildDefaultAgentSuggestion(
            normalizedInput.blueprintDraft,
            mintBlueprintId,
            defaultGenerator,
          );

      // Re-run the same four contract invariants on the post-negotiation
      // `effectiveContract`. The agent-draft path above already passed
      // these on the input contract, but the negotiator may have
      // returned an amended contract (`suggestion.origin === 'synth'`)
      // OR a cached contract — both bypass the input gate. Without
      // this, a malformed synth output reaches the agent as a
      // valid-looking suggestion and push rejects on accept-path,
      // leaving the agent with a dead handshakeId. Validating here
      // makes the failure observable at the same surface that produced
      // it — agent retries the handshake with a different intent, no
      // wasted push call.
      //
      // Pure-functional check; redundant on agent-draft path (same
      // contract validated above) but cheap, and the redundancy
      // protects against future negotiator changes that might
      // accidentally bypass.
      assertContractNoRetiredFields(negotiated.effectiveContract);
      assertContractSchemasValid(negotiated.effectiveContract);
      assertCrossReferences(negotiated.effectiveContract);
      assertNameInvariants(negotiated.effectiveContract);
      assertSchemaCompat(negotiated.effectiveContract);

      const handshakeId = mintHandshakeId();
      // emit handshake_started so the canvas
      // animator transitions to its `handshake` state. Fire-and-
      // forget; absent emitter is a no-op.
      deps.canvasLifecycle?.emit(sessionId, {
        kind: 'handshake_started',
        handshakeId,
        intent: normalizedInput.intent,
      });
      const target: HandshakeStoredTarget = {
        ...(negotiated.target ?? {}),
        sessionId,
      };

      // Canonical hash of the AGENT'S DRAFT contract (pre-amendment).
      // Telemetry threads through this; the suggestion's
      // blueprintMeta.contractHash may differ on `origin: 'synth'`.
      const draftHash = blueprintKey(normalizedInput.blueprintDraft.contract);

      const record: HandshakeRecord = {
        handshakeId,
        action: negotiated.action,
        reason: negotiated.reason,
        input: normalizedInput,
        target,
        suggestion: negotiated.suggestion,
        effectiveContract: negotiated.effectiveContract,
        appId: ctx.appId,
        createdAt: nowIso(),
      };

      await deps.kvStore.set(
        handshakeRecordKey(ctx.appId, handshakeId),
        JSON.stringify(record),
        { ttlSec },
      );

      // Emit `handshake.decided` with selection signals.
      // Lossy + non-throwing per the TelemetrySink contract; absent
      // sink is a noop. The `selectionConfidence` axis surfaces only
      // when the negotiator's selectVariant ran AND threaded
      // confidence into blueprintMeta.selectedReason (encoded as
      // `conf=<n>` suffix per the convention). Operators tune
      // LLM-pick frequency from `origin` + `selectionConfidence` on
      // this stream.
      emitHandshakeDecided(deps.telemetrySink, {
        appId: ctx.appId,
        sessionId,
        handshakeId,
        record,
      });

      // emit handshake_completed. Outcome derived
      // from suggestion.origin; genExpected when the negotiator's
      // action is `create` (cold gen will follow). The animator
      // pre-warms its `constructing` state on `genExpected: true`
      // so the handshake→constructing transition doesn't flicker.
      const lifecycleOutcome: 'accepted' | 'amended' | 'cached' =
        negotiated.suggestion.origin === 'cache'
          ? 'cached'
          : negotiated.suggestion.origin === 'synth'
            ? 'amended'
            : 'accepted';
      deps.canvasLifecycle?.emit(sessionId, {
        kind: 'handshake_completed',
        handshakeId,
        outcome: lifecycleOutcome,
        genExpected: negotiated.action === 'create',
      });

      const nextStep = buildNextStepHint({
        handshakeId,
        suggestion: negotiated.suggestion,
      });

      const serverCapabilities = deps.serverCapabilities?.();
      // Truncate `reason` to the wire-output cap (280 chars) so the
      // structuredContent payload stays predictable. The full
      // untruncated value remains in the session-store record for
      // telemetry.
      const truncatedReason =
        record.reason.length > 280
          ? `${record.reason.slice(0, 277)}...`
          : record.reason;
      return {
        handshakeId,
        action: record.action,
        reason: truncatedReason,
        target,
        suggestion: record.suggestion,
        ...(negotiated.alternatives && negotiated.alternatives.length > 0
          ? { alternatives: negotiated.alternatives }
          : {}),
        contractHash: draftHash,
        ...(nextStep ? { nextStep } : {}),
        ...(serverCapabilities ? { serverCapabilities } : {}),
        // surface iframe-captured HostContext to the agent.
        // Only include the wrapper when there's something to report.
        ...(sessionHostContext !== undefined
          ? { client: { hostContext: sessionHostContext } }
          : {}),
      };
    },
  };
}

/**
 * Default `origin: 'agent'` suggestion when no negotiator is bound.
 * The agent's draft is taken at face value; no cache search, no
 * validation, no amendments. Useful for the OSS zero-config path
 * (deps without an LLM caller / vector store).
 */
function buildDefaultAgentSuggestion(
  blueprintDraft: BlueprintDraft,
  mintBlueprintId: () => string,
  defaultGenerator: string,
): HandshakeNegotiatorResult {
  const contract = blueprintDraft.contract;
  const generator = blueprintDraft.generator ?? defaultGenerator;
  const blueprintMeta: BlueprintMeta = {
    blueprintId: mintBlueprintId(),
    contractHash: blueprintKey(contract),
    generator,
    variance: {
      ...(blueprintDraft.variance?.persona !== undefined
        ? { persona: blueprintDraft.variance.persona }
        : {}),
      ...(blueprintDraft.variance?.aesthetic !== undefined
        ? { aesthetic: blueprintDraft.variance.aesthetic }
        : {}),
      ...(blueprintDraft.variance?.context !== undefined
        ? { context: blueprintDraft.variance.context }
        : {}),
      ...(blueprintDraft.variance?.seedPrompt !== undefined
        ? { seedPrompt: blueprintDraft.variance.seedPrompt }
        : {}),
    },
  };
  const suggestion: HandshakeSuggestion = {
    origin: 'agent',
    rationale:
      'no-negotiator-bound: OSS default routes the draft as origin=agent (no search, no validation, no amendments). Bind a HandshakeNegotiator to enable cache/synth routing.',
    blueprintMeta,
  };
  return {
    action: 'create',
    reason: 'no-negotiator-bound: agent draft accepted verbatim',
    suggestion,
    effectiveContract: contract,
  };
}

/**
 * Project the parsed input into the persisted {@link HandshakeStoredInput}
 * shape. Strips passthrough cruft.
 */
function normalizeInput(parsed: {
  readonly intent: string;
  readonly blueprintDraft: {
    readonly contract: DataContract;
    readonly variance?: {
      readonly persona?: string;
      readonly aesthetic?: string;
      readonly context?: Record<string, unknown>;
      readonly seedPrompt?: string;
    };
    readonly generator?: string;
  };
  readonly forceCreate?: boolean;
}): HandshakeStoredInput {
  return {
    intent: parsed.intent,
    blueprintDraft: normalizeBlueprintDraft(parsed.blueprintDraft),
    ...(parsed.forceCreate === true ? { forceCreate: true } : {}),
  };
}

function normalizeBlueprintDraft(draft: {
  readonly contract: DataContract;
  readonly variance?: {
    readonly persona?: string;
    readonly aesthetic?: string;
    readonly context?: Record<string, unknown>;
    readonly seedPrompt?: string;
  };
  readonly generator?: string;
}): BlueprintDraft {
  return {
    contract: draft.contract,
    ...(draft.variance !== undefined
      ? {
          variance: {
            ...(typeof draft.variance.persona === 'string'
              ? { persona: draft.variance.persona }
              : {}),
            ...(typeof draft.variance.aesthetic === 'string'
              ? { aesthetic: draft.variance.aesthetic }
              : {}),
            ...(isJsonObject(draft.variance.context)
              ? { context: draft.variance.context as { [k: string]: JsonValue | undefined } }
              : {}),
            ...(typeof draft.variance.seedPrompt === 'string'
              ? { seedPrompt: draft.variance.seedPrompt }
              : {}),
          },
        }
      : {}),
    ...(typeof draft.generator === 'string' && draft.generator.length > 0
      ? { generator: draft.generator }
      : {}),
  };
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Build the wire-shape recovery hint surfaced on the handshake
 * response as `nextStep`. The agent should be able to copy
 * `nextStep.example` verbatim into its next `ggui_push` call.
 *
 * Branches on `suggestion.origin`:
 *
 *   - `cache`  → accept-path example (cached delivery).
 *   - `agent` / `synth` → accept-path example (gen pending).
 *
 * Override examples are NOT emitted by default — the agent reads the
 * `suggestion` and decides whether to override. The doc string on
 * ggui_push covers the override shape.
 */
function buildNextStepHint(input: {
  handshakeId: string;
  suggestion: HandshakeSuggestion;
}): HandshakeOutput['nextStep'] | undefined {
  const { handshakeId, suggestion } = input;
  const propsExample = buildPropsExample(suggestion.blueprintMeta.contractHash);
  const propsSegment = propsExample !== undefined ? `,"props":${propsExample}` : '';
  const example = `ggui_push({"handshakeId":"${handshakeId}","decision":{"kind":"accept"}${propsSegment}})`;
  return {
    tool: 'ggui_push',
    example,
  };
}

/**
 * Build a placeholder JSON example for `props` when the suggestion
 * carries a non-empty propsSpec. Without access to the full contract
 * here, we just leave `props` absent; the propsSpec hint surface is
 * delegated to the push.ts handler's recovery error messages.
 */
function buildPropsExample(_contractHash: string): string | undefined {
  return undefined;
}

/**
 * Typed error thrown by `ggui_push` when the supplied handshakeId
 * doesn't resolve (unknown, already-consumed, or TTL-expired).
 */
export class HandshakeNotFoundError extends Error {
  readonly code = 'handshake_not_found' as const;
  constructor(public readonly handshakeId: string) {
    super(
      `ggui_push: handshakeId "${handshakeId}" not found. Handshake records are SINGLE-USE (consumed on push) and expire after ${HANDSHAKE_RECORD_TTL_SEC / 60} minutes. To recover: call ggui_handshake({sessionId, intent, blueprintDraft}) again to mint a fresh handshakeId, then push with the new pair. Each render-emission requires its own handshake; do not cache handshakeIds across calls.`,
    );
    this.name = 'HandshakeNotFoundError';
  }
}

// Re-export some types for backwards-import-paths (consumers that
// imported these from `handshake.ts` before).
export type { SuggestionFinding };

/**
 * Telemetry event name emitted by the handshake handler on every
 * successful negotiation. Exposed so consumers can pattern-match
 * against a stable reference instead of string-sniffing.
 */
export const HANDSHAKE_DECIDED_EVENT = 'handshake.decided';

/**
 * Telemetry attributes shape on `handshake.decided`. The fields ride
 * through every handshake decision so operators plot:
 *
 *   - LLM-pick vs deterministic-ladder frequency
 *     (`selectionConfidence` presence + magnitude)
 *   - cache-hit vs novel-vs-amended routing (`origin`)
 *   - per-app, per-session selection patterns (`appId`, `sessionId`)
 */
export interface HandshakeDecidedAttributes {
  readonly appId: string;
  readonly sessionId: string;
  readonly handshakeId: string;
  readonly action: 'create' | 'reuse' | 'update' | 'replace' | 'compose' | 'declined';
  readonly origin: 'cache' | 'agent' | 'synth';
  readonly selectedBlueprintId: string;
  readonly selectionReason: string;
  /**
   * Surfaced only when the negotiator's `selectVariant` seam
   * ran AND threaded calibrated confidence onto the blueprintMeta's
   * `selectedReason` field (encoded as a `conf=<n>` suffix on the
   * reason string). Absent on negotiators that don't implement the
   * optional `selectVariant` seam — the deterministic ladder
   * doesn't expose a confidence axis.
   */
  readonly selectionConfidence?: number;
  /**
   * Generator slug the suggestion's blueprintMeta carries. Operators
   * plot generator-mix on this axis (default vs advanced vs future
   * cohorts).
   */
  readonly generator: string;
}

/**
 * Extract a `conf=<n>` confidence suffix from the
 * `blueprintMeta.selectedReason` string when present. The
 * variant-selector orchestration encodes confidence onto the
 * reason field so it round-trips through every storage layer
 * without widening the protocol shape (the BlueprintMeta type
 * doesn't carry `confidence` as a first-class field).
 *
 * Returns `undefined` when no `conf=<n>` suffix matches — the
 * telemetry payload simply omits the axis.
 *
 * Pure / deterministic; exposed for testing.
 */
export function extractSelectionConfidence(
  reason: string | undefined,
): number | undefined {
  if (!reason) return undefined;
  const match = reason.match(/\bconf=([01](?:\.\d+)?|0?\.\d+)\b/);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[1]!);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

function emitHandshakeDecided(
  sink: TelemetrySink | undefined,
  args: {
    readonly appId: string;
    readonly sessionId: string;
    readonly handshakeId: string;
    readonly record: HandshakeRecord;
  },
): void {
  if (!sink) return;
  const { record } = args;
  const meta = record.suggestion.blueprintMeta;
  const reason = meta.selectedReason ?? record.suggestion.rationale;
  const confidence = extractSelectionConfidence(meta.selectedReason);
  // Build a flat string|number|boolean attribute map — the
  // TelemetrySink contract restricts to primitives.
  const attributes: Record<string, string | number | boolean> = {
    appId: args.appId,
    sessionId: args.sessionId,
    handshakeId: args.handshakeId,
    action: record.action,
    origin: record.suggestion.origin,
    selectedBlueprintId: meta.blueprintId,
    selectionReason: reason,
    generator: meta.generator,
  };
  if (confidence !== undefined) {
    attributes['selectionConfidence'] = confidence;
  }
  sink.emit({
    name: HANDSHAKE_DECIDED_EVENT,
    at: Date.now(),
    attributes,
  });
}
