/**
 * `ggui_handshake` — the contract-negotiation step of the
 * handshake/render protocol.
 *
 * ## What this handler does
 *
 *   1. Validates the handshake input shape (`{ intent, blueprintDraft,
 *      forceCreate? }`). Post-Phase-B (flatten-render-identity) the
 *      input no longer carries `sessionId` — the paired `ggui_render`
 *      mints the render server-side. Host conversation grouping (sibling
 *      renders within one host chat) lives on the `_meta["ai.ggui/host-session"]`
 *      envelope, captured ONCE at render creation.
 *   2. Resolves the per-app gadget catalog.
 *   3. Delegates suggestion production to the bound
 *      {@link HandshakeNegotiator} — which produces a
 *      {@link HandshakeSuggestion} routed by `origin: cache | agent | synth`.
 *      FORGIVING posture: the input draft is NOT validated/thrown here.
 *      The negotiator owns validity — it cache-matches a registered
 *      blueprint (origin: cache) OR runs `ensureConformingContract` on
 *      the agent's draft (origin: agent when already clean, synth when
 *      the bounded repair loop had to fix it), and ALWAYS returns a
 *      contract that passes the deterministic `validateContract` gate.
 *      Absent negotiator → the seam stamps an `origin: 'agent'`
 *      suggestion using the agent's draft verbatim (no repair; the
 *      backstop below validates it and a malformed draft fails closed).
 *   4. Persists a {@link HandshakeRecord} under a TTL-bounded
 *      {@link KeyValueStore} key. Single-use: the paired `ggui_render`
 *      consumes it via `getAndDelete`.
 *   5. Returns a `GguiHandshakeOutput`-shaped result carrying the
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
import { isGeneratorRegistered } from './assert-generator.js';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  resolveAppGadgets,
  blueprintSourceToFlat,
  validateContract,
  lintContract,
  summarizeContract,
  dataContractSchema,
  handshakeSuggestionSchema,
  handshakeInputSchema,
  blueprintDraftObjectSchema,
  DATA_CONTRACT_SHAPE_RULE,
  DATA_CONTRACT_MINIMAL_EXAMPLE,
  buildEnforcedPropsSchema,
  canonicalPropsSchemaBytes,
  classifyPropsSchemaProfile,
  jsonSchemaSchema,
  type Blueprint,
  type BlueprintDraft,
  type BlueprintMeta,
  type BlueprintSourceKind,
  type BlueprintVariance,
  type GadgetDescriptor,
  type DataContract,
  type HandshakeSuggestion,
  type JsonSchema,
  type JsonValue,
  type PropsSchemaProfile,
  type ServerCapabilities,
  type SuggestionFinding,
} from '@ggui-ai/protocol';
import { computePropsSchemaHash } from '@ggui-ai/protocol/props-schema-hash';
import type {
  AppMetadataStore,
  KeyValueStore,
  TelemetrySink,
  VariantSelectionContext,
  VariantSelectionDecision,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { buildSalvagedOrDeclined } from './handshake-fallbacks.js';
import type { GguiLifecycleEmitter } from './lifecycle.js';

/**
 * Handshake-time input shape.
 *
 * `blueprintDraft` carries the agent's draft (contract + optional
 * variance + optional generator hint). `forceCreate` short-circuits
 * cache search so the paired render always cold-gens.
 */
/**
 * The agent's draft as it ENTERS the handshake. `contract` is `unknown`
 * because a FORGIVING handshake accepts a possibly-malformed proposal and
 * lets the negotiator validate / repair it — it is not yet a guaranteed
 * `DataContract`. (The protocol {@link BlueprintDraft} keeps
 * `contract: DataContract` for the STRICT `ggui_render` override path.)
 */
export interface DraftInput {
  readonly contract: unknown;
  readonly variance?: BlueprintDraft['variance'];
  readonly generator?: string;
}

export interface HandshakeStoredInput {
  /** Concise semantic identity of the UI — drives intent-axis search keying. */
  readonly intent: string;
  /** Agent's draft — contract (untrusted) + optional variance + generator. */
  readonly blueprintDraft: DraftInput;
  /**
   * Skip blueprint search and route straight to validation (and on
   * pass, agent-mode suggestion). Used after an earlier handshake
   * returned an unwanted cache suggestion.
   */
  readonly forceCreate?: boolean;
}

/**
 * Routing hint carried from handshake to the paired render.
 *
 * Post-Phase-B (flatten-render-identity): the prior `sessionId` +
 * `stackItemId` pair collapsed to a single optional `sessionId`. The
 * negotiator MAY suggest reusing an existing render (the cache /
 * update path); absent ⇒ the paired `ggui_render` mints a fresh
 * render.
 */
export interface HandshakeStoredTarget {
  readonly sessionId?: string;
}

/**
 * Persisted handshake record. The paired `ggui_render` reads:
 *
 *   - `suggestion.blueprintMeta` — the provisional blueprintId +
 *     contractHash + (when cache) codeHash + `source` (the matched
 *     row's stored provenance) for accept-path delivery.
 *   - `input.blueprintDraft.contract` — the agent's original draft
 *     (only used for telemetry; accept-path runs gen against the
 *     suggestion's stored contract).
 *   - `effectiveContract` — the contract gen runs against on the
 *     accept-path. Equals the agent's draft for `origin: agent`, the
 *     amended contract for `origin: synth`, the cached blueprint's
 *     contract for `origin: cache`.
 *   - `target` — optional sessionId routing hint (cache / update path).
 */
export interface HandshakeRecord {
  readonly handshakeId: string;
  readonly action: 'create' | 'reuse' | 'update' | 'replace' | 'declined';
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
   * Materialized at handshake-time so the render doesn't re-derive.
   */
  readonly effectiveContract: DataContract;
  /**
   * Reference to the cached blueprint this handshake reused — present ONLY
   * when the decision was a cache reuse (`suggestion.origin === 'cache'`).
   * The paired `ggui_render` point-reads the stored blueprint via this ref
   * (design §6) instead of re-running the matcher. Absent on
   * create / synth / agent handshakes.
   */
  readonly matchedBlueprint?: {
    readonly id: string;
    readonly contractKey: string;
    readonly variantKey: string;
  };
  /**
   * The ENFORCED props schema, persisted at handshake time — the
   * `buildEnforcedPropsSchema` artifact over `effectiveContract.propsSpec`
   * (empty closed wrapper for a propsSpec-less contract). The paired
   * `ggui_render` validates against THIS persisted value (not a
   * recomputation), which is what makes the returned-schema AUTHORITY
   * obligation structural under rolling-deploy version skew
   * (docs/plans/2026-08-19-schema-precise-render.md, frozen shape).
   * Always persisted on non-declined records; wire emission is
   * conditional (see the handler body). Optional on the type only for
   * the TTL-bounded mixed-version window at a deploy boundary —
   * records written by the previous build lack it and fall back to
   * the propsSpec recomputation path.
   */
  readonly propsSchema?: JsonSchema;
  /** sha256 (lowercase hex) over the RFC 8785 canonical bytes of
   *  {@link propsSchema}. Persisted with it; stamped onto props
   *  contract-violation errors as the breach classifier. */
  readonly propsSchemaHash?: string;
  /** Grammar-safe-core classification of {@link propsSchema} —
   *  `classifyPropsSchemaProfile`'s verdict at handshake time. */
  readonly propsSchemaProfile?: PropsSchemaProfile;
  readonly appId: string;
  readonly createdAt: string;
}

/**
 * Negotiator binding. The negotiator's role is to PRODUCE the
 * {@link HandshakeSuggestion} — given the agent's draft and any
 * per-app context, the negotiator returns:
 *
 *   - `suggestion` — always present.
 *   - `action` — `'reuse'` for cache hits, `'create'` otherwise.
 *   - `reason` — human-readable explanation.
 *   - `target` — optional routing hint.
 *   - `alternatives` — optional top-N alternative blueprints.
 *   - `effectiveContract` — the contract gen runs against on
 *                           accept-path. The handshake handler
 *                           persists this so render doesn't re-derive.
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
    /** Agent's draft — untrusted contract (see {@link DraftInput}). */
    readonly blueprintDraft: DraftInput;
    /** Force-skip cache search; route to validation + agent/synth path. */
    readonly forceCreate?: boolean;
    /** Per-app gadget catalog — synth uses to populate gadgets. */
    readonly gadgets?: readonly GadgetDescriptor[];
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
    readonly ctx: HandlerContext;
  }): Promise<VariantSelectionDecision>;
}

/**
 * A handshake the server DECLINED (ggui#523 item 3): the draft could
 * not be repaired AND no entry of it survives the contract gate, so
 * there is no contract to propose. No handshake record is written and
 * no `nextStep` is offered — the agent reads `suggestion.validationFindings`
 * (every one names its path), fixes the draft, and re-handshakes.
 * This replaced the empty-contract fallback: a hollow `{}` "success"
 * was indistinguishable from a rejection, and the observed recovery was
 * a field-by-field bisect.
 */
export interface HandshakeNegotiatorDeclined {
  readonly action: 'declined';
  readonly reason: string;
  /** `origin: 'agent'` (the draft is the agent's, unchanged), findings loud, summary teaches. */
  readonly suggestion: HandshakeSuggestion;
  /** Nothing to render against — declined handshakes never reach `ggui_render`. */
  readonly effectiveContract: null;
}

/**
 * A handshake decision that carries a conforming contract to render
 * against — every action but `'declined'`.
 */
export interface HandshakeNegotiatorDecision {
  readonly action: 'create' | 'reuse' | 'update' | 'replace';
  readonly reason: string;
  readonly suggestion: HandshakeSuggestion;
  /**
   * Effective contract the accept-path gen / cache-delivery runs
   * against. See {@link HandshakeRecord.effectiveContract}. Never
   * empty on the server's initiative: a dirty draft is repaired,
   * salvaged to its conforming subset, or DECLINED (see
   * {@link HandshakeNegotiatorDeclined}) — `{}` is proposed only when
   * the agent itself drafted a clean `{}`.
   */
  readonly effectiveContract: DataContract;
  /** Routing hint. */
  readonly target?: HandshakeStoredTarget;
  /** Top-N alternative blueprints surfaced on the response. */
  readonly alternatives?: readonly Blueprint[];
  /**
   * Reference to the cached blueprint this decision reused — present ONLY
   * on `origin: 'cache'` reuse. Threaded onto the persisted
   * {@link HandshakeRecord} so the paired `ggui_render` can point-read the
   * stored blueprint (§6) instead of re-running the matcher. HANDLERS-side
   * only — deliberately kept out of `@ggui-ai/protocol` (P2-4): it is an
   * internal server-to-render routing detail, not an agent-facing wire
   * field. Absent on create / synth / agent decisions.
   */
  readonly matchedBlueprint?: {
    readonly id: string;
    readonly contractKey: string;
    readonly variantKey: string;
  };
}

/** What a negotiator answers: a decision to render against, or a decline. */
export type HandshakeNegotiatorResult = HandshakeNegotiatorDecision | HandshakeNegotiatorDeclined;

export interface GguiHandshakeHandlerDeps {
  /**
   * Persistence plane for handshake records. The OSS default wires
   * `InMemoryKeyValueStore`; hosted wraps DDB / ElastiCache. The
   * `getAndDelete` contract on the seam guarantees single-use
   * consumption of each `handshakeId`.
   */
  readonly kvStore: KeyValueStore;
  /**
   * Optional per-app metadata resolver. When bound, the handler reads
   * `app.gadgets` for the resolved `ctx.appId`, resolves the effective
   * catalog via `resolveAppGadgets` (stdlib floor + declared overlay —
   * the same resolution the render gate and `ggui_list_gadgets` apply),
   * and threads it to the negotiator so synth can teach the LLM which
   * gadget bindings the produced UI may use.
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
   * Generation-progress lifecycle emitter. When wired, the handler
   * fires `handshake_started` at entry and `handshake_completed` just
   * before return on the `_ggui:lifecycle` channel. Fire-and-forget
   * — emit errors are absorbed by the impl.
   *
   * Post-Phase-B (flatten-render-identity): the emitter is keyed by
   * `handshakeId` instead of `sessionId` — handshakes happen BEFORE
   * a render exists; consumers that want to bracket the gap bind
   * their subscription on the sessionId returned by the paired
   * `ggui_render`. Absent ⇒ no emissions.
   */
  readonly lifecycleEmitter?: GguiLifecycleEmitter;
  /**
   * Optional operational-signal sink. When bound, the handler emits
   * a `handshake.decided` event on every successful handshake
   * carrying:
   *
   *   - `appId`, `handshakeId`
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
   */
  readonly telemetrySink?: TelemetrySink;
}

/** Default TTL (seconds). 10 minutes — same as the KV-store docstring. */
export const HANDSHAKE_RECORD_TTL_SEC = 600;

/** Default generator slug — matches the `GeneratorRegistry` default. */
export const DEFAULT_GENERATOR_SLUG = 'ui-gen-default-haiku-4-5';

/**
 * Compose the KV key for a given (appId, handshakeId) pair. Exported
 * so the paired render handler reads the same shape — single source
 * of truth for the key format.
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

/**
 * Input schema — DERIVED from the protocol's `handshakeInputSchema`
 * (ggui#523 item 1), with ONE deliberate divergence: `contract` is a
 * loose record here. Rationale, unchanged since the forgiving handshake
 * landed: the MCP SDK validates tool args against THIS schema before the
 * handler runs, so a strict `dataContractSchema` would hard-fail the two
 * most common malformations (wrapper-nesting, type-spelling) at the
 * schema layer and revive the handshake-retry loop; the negotiator's
 * repair path (`ensureConformingContract`) is where the draft is judged.
 * What is NOT loose is the teaching: the loose record carries the
 * protocol's shape rule + a minimal valid example as JSON-Schema
 * metadata, so `tools/list` teaches the contract shape at the one tool
 * an agent must call first. Everything else — `intent`, `forceCreate`,
 * the draft's `variance` (with its legal-set rejection message) — IS
 * the protocol schema; the handler adds only its stricter `generator`
 * grammar.
 */
const looseContractSchema = z
  .record(z.string(), z.unknown())
  .describe(
    `Your PROPOSED DataContract. Accepted as any JSON object here — the negotiator validates and repairs it (a malformed draft is a trigger into repair, never a schema-layer failure); what it could not keep is reported in suggestion.validationFindings. ${DATA_CONTRACT_SHAPE_RULE}`,
  )
  .meta({ examples: [DATA_CONTRACT_MINIMAL_EXAMPLE] });

const generatorSchema = z
  .string()
  .max(120)
  .regex(/^[a-z0-9_:.-]+$/i, {
    message:
      "generator must be a registered generator identifier (e.g. 'anthropic-claude-haiku-4-5'), not source code or free-form text",
  })
  .optional()
  .describe('Optional generator slug hint (a registered generator identifier). Unregistered slugs are dropped with a finding, never fatal.');

const inputSchema = {
  intent: handshakeInputSchema.shape.intent,
  blueprintDraft: blueprintDraftObjectSchema
    .extend({
      contract: looseContractSchema,
      generator: generatorSchema,
    })
    .describe(handshakeInputSchema.shape.blueprintDraft.description ?? ''),
  forceCreate: handshakeInputSchema.shape.forceCreate,
} as const;

/** Output zod-shape mirror. Same shape as `handshakeOutputSchema`.
 *
 * The three `propsSchema*` fields are the schema-precise render wire
 * surface (frozen 2026-08-19; docs/plans/2026-08-19-schema-precise-render.md
 * §2). P3 pin 1: they are declared HERE, on the zod output schema, and
 * ride the RESULT BODY (`structuredContent`) — never `_meta` — so the
 * vocabulary stays in the model's context and transcript-reading
 * runtimes can consume it. This zod schema is an active strip gate;
 * an emitted-but-undeclared field silently disappears from the wire.
 */
const outputSchema = {
  handshakeId: z.string(),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'declined']),
  suggestion: handshakeSuggestionSchema,
  propsSchema: jsonSchemaSchema
    .optional()
    .describe(
      'The exact JSON Schema the paired ggui_render enforces for this handshakeId — generate props that satisfy it (enum fields list their full legal vocabulary). Present when the agreed contract differs from your draft; when absent, your draft propsSpec is agreed verbatim. Advisory: no agent obligation attaches to reading it; runtimes MAY compile it for constrained argument generation.',
    ),
  propsSchemaHash: z
    .string()
    .optional()
    .describe(
      'sha256 (lowercase hex) over the RFC 8785 canonical form of the enforced props schema. Present on every non-declined handshake. A later contract_violation carries the hash of the schema it enforced — equal hashes mean the props were at fault.',
    ),
  propsSchemaProfile: z
    .string()
    .optional()
    .describe(
      "Grammar profile of the enforced props schema: 'grammar-safe' (every keyword is in the enumerated core — a runtime can compile the schema into a decoding grammar) or 'full' (read the schema as context instead). Treat unrecognized values as 'full'; the set may grow in minor versions.",
    ),
  nextStep: z
    .object({
      tool: z.literal('ggui_render'),
      example: z.string(),
    })
    .optional(),
} as const;

interface HandshakeOutput {
  handshakeId: string;
  action: 'create' | 'reuse' | 'update' | 'replace' | 'declined';
  /**
   * Negotiator reason — internal-only after the 2026-05-13 output trim.
   * Persisted on the HandshakeRecord for telemetry / cache-trace; zod
   * strips it before structuredContent serialization.
   */
  reason: string;
  /** Routing hint — internal-only. Same pattern as `reason`. */
  target: HandshakeStoredTarget;
  suggestion: HandshakeSuggestion;
  /** Top-N alternatives — internal-only. */
  alternatives?: readonly Blueprint[];
  /** Canonical hash — internal-only telemetry. */
  contractHash: string;
  /** Enforced props schema — wire-emitted when the effective contract
   *  differs from the agent's parsed draft (and under the byte
   *  ceiling); always persisted on the record. */
  propsSchema?: JsonSchema;
  /** Present on every non-declined handshake (P3 pin 2). */
  propsSchemaHash?: string;
  /** Present whenever {@link propsSchemaHash} is. */
  propsSchemaProfile?: PropsSchemaProfile;
  nextStep?: {
    readonly tool: 'ggui_render';
    readonly example: string;
  };
  /** Server capabilities — internal-only; bootstrap-meta projects this. */
  serverCapabilities?: ServerCapabilities;
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
  const nowIso = deps.now ?? (() => new Date().toISOString());
  const defaultGenerator = deps.defaultGenerator ?? DEFAULT_GENERATOR_SLUG;

  return {
    name: 'ggui_handshake',
    title: 'Handshake',
    audience: ['agent'],
    // The CONTRACT SHAPE block below is the protocol's
    // DATA_CONTRACT_SHAPE_RULE, inlined as a literal because the MCP
    // reference generator reads descriptions statically — a pin in
    // handshake.test.ts holds it byte-equal to the constant.
    description:
      deps.description ??
      "Negotiate a contract for a UI you want to deliver. Call BEFORE ggui_render. Input: {intent, blueprintDraft: {contract, variance?, generator?}}. CONTRACT SHAPE — DataContract = up to six top-level specs: propsSpec (initial render data), actionSpec (user gestures that drive the agent's next turn), contextSpec (observable client state), streamSpec (live update channels), agentCapabilities (MCP tools the AGENT may call — the catalog actionSpec[*].nextStep and streamSpec[*].source.tool must resolve into), clientCapabilities (browser gadget hooks the COMPONENT imports). EVERY entry under propsSpec.properties / actionSpec / streamSpec / contextSpec is a WRAPPER object whose JSON Schema sits in its `schema:` field — never a flat JSON Schema at the entry level. Wrappers reject unrecognized keys. Placement test: needs next-turn reasoning ⇒ actionSpec; observed state only ⇒ contextSpec. ActionEntry uses OPTIONAL `nextStep: '<toolName>'` to hint the agent's intended next tool call — when present, the tool MUST also be declared in `agentCapabilities.tools`; OMIT it entirely when the agent should decide freely. AGENT TOOLS: key `agentCapabilities.tools` by the BARE MCP tool name (the part after any `mcp__<server>__` prefix a host adds), NOT the host's connection label; each entry is `{toolInfo: {inputSchema, …}, serverInfo?, usage?, example?}` — `toolInfo` with its `inputSchema` is REQUIRED (copy the tool's declared JSON Schema); set the tool's `serverInfo.name` to the server handle from that SAME prefix (e.g. `mcp__todo__todo_add` → `serverInfo.name: 'todo'`) — it lets the server reuse a UI built against the same (server, tool) for a later turn or a different agent. If a tool has NO `mcp__<server>__` prefix, OMIT `serverInfo` — never invent a name. `version` is optional metadata (include it only if your host surfaces it from `initialize`); a version difference alone never blocks reuse. NEGOTIATION: the server PRIORITIZES reusing a similar contract it already built for an earlier UI — so it returns a PROPOSED contract rather than echoing your draft back. The `suggestion` carries that proposed contract plus a short `proposedContractSummary` and origin = cache (the server proposes a similar contract it built before) | agent (your draft was already clean and is proposed as-is) | synth (the server repaired your draft into the proposal; what changed is listed in suggestion.validationFindings). SCHEMA ON THE WIRE: the response also carries `propsSchema` — the EXACT JSON Schema the paired ggui_render will enforce (enum fields list their full legal vocabulary; present whenever the proposal's props shape differs from your draft) — plus `propsSchemaHash` and `propsSchemaProfile`; when `propsSchema` is present, generate `props` that satisfy it instead of guessing values from your draft. FORGIVING: the proposal is ALWAYS protocol-conforming — accept it; do NOT re-call ggui_handshake in a loop hoping for a different origin. Two honest exceptions: (a) `action: 'declined'` — nothing in your draft passed the contract gate, so there is NO proposal and NO ggui_render for that handshakeId; read suggestion.validationFindings (each names its path and what the protocol wants there), fix the draft, and call ggui_handshake once more; (b) a `proposedContractSummary` starting with `PARTIAL` — the proposal is your draft MINUS the entries the protocol refused (each listed in validationFindings): render it to get the rest working, and re-declare the dropped entries via `override: {contract}` on the render or a corrected re-handshake. The server never substitutes an empty contract for yours. When origin = cache the proposal may not cover every field of your draft; suggestion.validationFindings flags any COVERAGE_GAP, one per uncovered surface. DEFAULT TO ACCEPT (reuse-and-refine is the priority) — override only if the user must directly see or act on a flagged surface, since the cached UI cannot show it; a COVERAGE_GAP on a prop notes whether that prop was required or optional in your draft to inform that call. Also when origin = cache the proposed UI may have been built for a DIFFERENT variance than you requested; suggestion.validationFindings flags a VARIANCE_GAP (built for X, you asked Y). DEFAULT TO ACCEPT here too (reuse-and-refine) — re-aim the variance only if the persona/aesthetic difference is user-observable and matters for this interaction. Then you act on the paired ggui_render (where `props` is REQUIRED): OMIT `override` to ACCEPT the proposed contract (the normal path), OR set `override: {variance}` to re-aim the variant — keeps the agreed contract; a different variance resolves a distinct cached component, OR set `override: {contract}` to commit a NEW contract of your own (STRICT — it must already conform, the server will not repair an override, and render fails if it does not). VARIANCE is design-shaping signals only, and a STRICT four-key object: persona / aesthetic / context / seedPrompt — no other keys exist (`mood` is not one; put tonal intent in `aesthetic`); per-user runtime data belongs in `props` / contextSpec, NOT in variance. STRICTNESS: variance, blueprintDraft, and every wrapper entry (propsSpec.properties / actionSpec / streamSpec / contextSpec / agentCapabilities.tools) reject unrecognized keys — misplaced fields fail the call or surface as validationFindings rather than being ignored. Then ggui_consume → react → repeat. PLACEMENT RULE: actionSpec = events that drive the agent's next turn; contextSpec = observable state. Test: needs next-turn reasoning? actionSpec. No? contextSpec.",
    inputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<HandshakeOutput> {
      const parsed = z.object(inputSchema).parse(input);
      let normalizedInput = normalizeInput(parsed);

      // Forgiving generator: an UNKNOWN generator slug is DROPPED (the
      // server default is used) + surfaced as a finding, rather than
      // thrown. Handshake never hard-fails on a fixable detail. This
      // finding is the only generator-validation surface — render's
      // strict override path carries no generator field.
      const generatorFindings: SuggestionFinding[] = [];
      if (
        !isGeneratorRegistered(
          normalizedInput.blueprintDraft.generator,
          defaultGenerator,
        )
      ) {
        generatorFindings.push({
          code: 'GENERATOR_UNKNOWN',
          severity: 'warn',
          path: 'blueprintDraft.generator',
          message: `generator '${normalizedInput.blueprintDraft.generator}' is not registered on this server; using the default '${defaultGenerator}'. Omit blueprintDraft.generator to silence.`,
        });
        const { generator: _droppedGenerator, ...draftWithoutGenerator } =
          normalizedInput.blueprintDraft;
        normalizedInput = {
          ...normalizedInput,
          blueprintDraft: draftWithoutGenerator,
        };
      }

      // The agent's draft is NOT validated/thrown here. The negotiator
      // owns validity — it cache-matches OR repairs the draft
      // (ensureConformingContract) and returns a contract that passes the
      // deterministic gate. This is the forgiving-handshake posture: a
      // malformed draft is a TRIGGER into repair, not a thrown error.

      // Per-app gadget catalog — resolved via `resolveAppGadgets`
      // (stdlib floor + declared overlay, declared wins per-package),
      // the SAME resolution the render gate (render.ts) and
      // `ggui_list_gadgets` apply. The negotiator MUST see the catalog
      // the render gate will accept; a store that returns raw declared
      // rows must not drop the floor here. Idempotent over stores that
      // pre-floor on read (e.g. the cloud DDB adapter).
      const gadgets: readonly GadgetDescriptor[] | undefined =
        deps.appMetadataStore
          ? resolveAppGadgets(
              (await deps.appMetadataStore.get(ctx.appId))?.gadgets,
            )
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
            ctx,
          })
        : buildDefaultAgentSuggestion(normalizedInput.blueprintDraft);

      // DECLINED (ggui#523 item 3): the draft could not be repaired and
      // nothing in it conforms. No record (nothing to render against),
      // no `nextStep`; the findings say what to fix. The lifecycle sees
      // a completed handshake with outcome 'declined'.
      if (negotiated.action === 'declined') {
        const handshakeId = mintHandshakeId();
        deps.lifecycleEmitter?.emit(handshakeId, {
          kind: 'handshake_started',
          handshakeId,
          intent: normalizedInput.intent,
        });
        deps.lifecycleEmitter?.emit(handshakeId, {
          kind: 'handshake_completed',
          handshakeId,
          outcome: 'declined',
          genExpected: false,
        });
        const declinedSuggestion: HandshakeSuggestion =
          generatorFindings.length > 0
            ? {
                ...negotiated.suggestion,
                validationFindings: [
                  ...(negotiated.suggestion.validationFindings ?? []),
                  ...generatorFindings,
                ],
              }
            : negotiated.suggestion;
        const truncatedDeclineReason =
          negotiated.reason.length > 280
            ? `${negotiated.reason.slice(0, 277)}...`
            : negotiated.reason;
        return {
          handshakeId,
          action: 'declined',
          reason: truncatedDeclineReason,
          target: {},
          suggestion: declinedSuggestion,
          contractHash: blueprintKey(
            dataContractSchema.safeParse(normalizedInput.blueprintDraft.contract).data,
          ),
        };
      }

      // Backstop: the negotiator's effectiveContract MUST pass the
      // single deterministic gate. For a bound negotiator this is
      // GUARANTEED (ensureConformingContract loops until validateContract
      // is green), so a throw here means the negotiator returned a
      // non-conforming contract — a negotiator bug surfaced loudly rather
      // than shipped downstream. The no-negotiator default path also
      // lands here: an invalid draft with nothing bound to repair it
      // fails closed with the deterministic findings (bind a negotiator
      // to get the forgiving repair path).
      validateContract(negotiated.effectiveContract);

      // Merge handshake-level findings (e.g. a dropped generator) into
      // the negotiator's suggestion so the agent sees every adjustment.
      const finalSuggestion: HandshakeSuggestion =
        generatorFindings.length > 0
          ? {
              ...negotiated.suggestion,
              validationFindings: [
                ...(negotiated.suggestion.validationFindings ?? []),
                ...generatorFindings,
              ],
            }
          : negotiated.suggestion;

      const handshakeId = mintHandshakeId();
      // Emit handshake_started so progress UIs can show a
      // `negotiating` state. Fire-and-forget; absent emitter is a
      // no-op. Keyed by handshakeId — no render exists yet.
      deps.lifecycleEmitter?.emit(handshakeId, {
        kind: 'handshake_started',
        handshakeId,
        intent: normalizedInput.intent,
      });
      const target: HandshakeStoredTarget = negotiated.target ?? {};

      // Canonical hash of the AGENT'S DRAFT contract (pre-amendment).
      // Draft is untrusted (may be malformed) — hash only when it parses;
      // blueprintKey tolerates `undefined`. Telemetry-only.
      const draftHash = blueprintKey(
        dataContractSchema.safeParse(normalizedInput.blueprintDraft.contract)
          .data,
      );

      // Thread the matched-blueprint ref onto the record ONLY on a cache
      // reuse — the paired ggui_render point-reads the stored blueprint via
      // it (design §6). Create / synth / agent decisions omit it.
      const matchedBlueprint =
        negotiated.suggestion.origin === 'cache'
          ? negotiated.matchedBlueprint
          : undefined;

      // Schema-precise render (frozen shape, guuey#271): materialize
      // the ENFORCED props schema once, at handshake time. The record
      // persists it (the paired ggui_render validates against the
      // PERSISTED value — the AUTHORITY obligation is structural, not
      // a recompute-and-hope); the wire carries hash + profile on
      // every non-declined handshake (pin 2), and the schema VALUE
      // whenever the effective contract's props shape differs from
      // the agent's parsed draft — the exact asymmetry this surface
      // closes (cache/synth/salvaged paths; a verbatim-accepted draft
      // already sits in the agent's context, and a compiling runtime
      // derives the identical artifact locally via the OSS builder,
      // verifying against the hash).
      const enforcedPropsSchema = buildEnforcedPropsSchema(
        negotiated.effectiveContract.propsSpec ?? { properties: {} },
      );
      const propsSchemaHash = computePropsSchemaHash(enforcedPropsSchema);
      const propsSchemaProfile =
        classifyPropsSchemaProfile(enforcedPropsSchema);
      const parsedDraft = dataContractSchema.safeParse(
        normalizedInput.blueprintDraft.contract,
      );
      const draftMatchesEffective =
        parsedDraft.success &&
        computePropsSchemaHash(
          buildEnforcedPropsSchema(
            parsedDraft.data.propsSpec ?? { properties: {} },
          ),
        ) === propsSchemaHash;
      // Pathological-size escape hatch (frozen behavior): past the
      // provisional ceiling the schema VALUE is omitted — hash +
      // profile still ride; a named retrieval affordance is
      // deliberately deferred (no field name without its mechanism).
      const PROPS_SCHEMA_BYTE_CEILING = 256 * 1024;
      const underCeiling =
        Buffer.byteLength(
          canonicalPropsSchemaBytes(enforcedPropsSchema),
          'utf8',
        ) <= PROPS_SCHEMA_BYTE_CEILING;
      const emitPropsSchema = !draftMatchesEffective && underCeiling;

      const record: HandshakeRecord = {
        handshakeId,
        action: negotiated.action,
        reason: negotiated.reason,
        input: normalizedInput,
        target,
        suggestion: finalSuggestion,
        effectiveContract: negotiated.effectiveContract,
        ...(matchedBlueprint !== undefined ? { matchedBlueprint } : {}),
        propsSchema: enforcedPropsSchema,
        propsSchemaHash,
        propsSchemaProfile,
        appId: ctx.appId,
        createdAt: nowIso(),
      };

      await deps.kvStore.set(
        handshakeRecordKey(ctx.appId, handshakeId),
        JSON.stringify(record),
        { ttlSec },
      );

      // Emit `handshake.decided` with selection signals.
      emitHandshakeDecided(deps.telemetrySink, {
        appId: ctx.appId,
        handshakeId,
        record,
      });

      // Emit handshake_completed.
      const lifecycleOutcome: 'accepted' | 'amended' | 'cached' =
        negotiated.suggestion.origin === 'cache'
          ? 'cached'
          : negotiated.suggestion.origin === 'synth'
            ? 'amended'
            : 'accepted';
      deps.lifecycleEmitter?.emit(handshakeId, {
        kind: 'handshake_completed',
        handshakeId,
        outcome: lifecycleOutcome,
        genExpected: negotiated.action === 'create',
      });

      const nextStep = buildNextStepHint({
        handshakeId,
        contract: negotiated.effectiveContract,
      });

      const serverCapabilities = deps.serverCapabilities?.();
      // Truncate `reason` to the wire-output cap (280 chars).
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
        ...(emitPropsSchema ? { propsSchema: enforcedPropsSchema } : {}),
        propsSchemaHash,
        propsSchemaProfile,
        ...(nextStep ? { nextStep } : {}),
        ...(serverCapabilities ? { serverCapabilities } : {}),
      };
    },
  };
}

/**
 * Default `origin: 'agent'` suggestion when no negotiator is bound (OSS
 * zero-config). No negotiator ⇒ no LLM ⇒ nothing can REPAIR a malformed
 * draft. The handshake backstop (validateContract) would throw on one,
 * so this still honors "handshake never hard-fails": a clean draft is
 * used verbatim; a malformed draft is deterministically reduced to its
 * conforming subset (one finding per dropped entry) or DECLINED when
 * nothing survives — never the empty contract (ggui#523 item 3); bind a
 * HandshakeNegotiator to get the forgiving repair path instead.
 */
function buildDefaultAgentSuggestion(
  blueprintDraft: DraftInput,
): HandshakeNegotiatorResult {
  const variance: BlueprintVariance = {
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
  };
  const lint = lintContract(blueprintDraft.contract);
  if (lint.errors.length > 0) {
    // Dirty draft and nothing bound to repair it: keep the conforming
    // subset, or decline. Never the empty contract (ggui#523 item 3).
    return buildSalvagedOrDeclined({
      draftContract: blueprintDraft.contract,
      reason:
        'no-negotiator-bound: draft failed validation and no negotiator (LLM) is bound to repair it. Bind a HandshakeNegotiator to enable repair.',
      variance,
    });
  }
  // `clean` ⇒ shape phase passed ⇒ strict parse cannot throw.
  const contract: DataContract = dataContractSchema.parse(blueprintDraft.contract);
  // No blueprintId, no source — origin:'agent' (D4): the durable UUID
  // and the real provenance are both minted at render-time
  // registration, never at handshake.
  const blueprintMeta: BlueprintMeta = {
    contractHash: blueprintKey(contract),
    variance,
  };
  const suggestion: HandshakeSuggestion = {
    origin: 'agent',
    rationale:
      'no-negotiator-bound: OSS default routes the draft as origin=agent (no search, no repair). Bind a HandshakeNegotiator to enable cache/synth routing.',
    blueprintMeta,
    proposedContractSummary: summarizeContract(contract),
  };
  return {
    action: 'create',
    reason: suggestion.rationale,
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
    readonly contract: unknown;
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
  readonly contract: unknown;
  readonly variance?: {
    readonly persona?: string;
    readonly aesthetic?: string;
    readonly context?: Record<string, unknown>;
    readonly seedPrompt?: string;
  };
  readonly generator?: string;
}): DraftInput {
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
 * `nextStep.example` verbatim into its next `ggui_render` call.
 */
function buildNextStepHint(input: {
  handshakeId: string;
  contract: DataContract;
}): HandshakeOutput['nextStep'] | undefined {
  const { handshakeId, contract } = input;
  // `props` is REQUIRED on the renderInputSchema, and the proposed
  // contract's REQUIRED prop entries must appear in it — a bare `{}`
  // example against such a contract fails validation when followed
  // verbatim (a live agent flagged exactly that, 2026-08-12). Derive
  // the example from the effective contract: required entries keyed
  // with their declared `example`/`default` when present, else a
  // type-shaped placeholder. No required props → `{}` stays honest.
  const propsExample = buildPropsExample(contract) ?? '{}';
  // ACCEPT shape: omit `override` entirely — the agent reuses the
  // proposed contract. (Re-aim via `override:{variance}` / `override:
  // {contract}` is taught in the description, not the default hint.)
  const example = `ggui_render({"handshakeId":"${handshakeId}","props":${propsExample}})`;
  return {
    tool: 'ggui_render',
    example,
  };
}

/**
 * JSON example for the contract's propsSpec — EVERY declared prop,
 * required ones first, each with its declared `example`, then
 * `default`, then a type-shaped placeholder from its JSON Schema
 * (first enum member, else '' / 0 / false, arrays with one item in the
 * item's shape, objects with every declared key). Returns undefined
 * when the contract declares no props — the caller's `{}` fallback is
 * then valid verbatim.
 *
 * Why every prop and not only the required ones (ggui#523, live bench
 * 2026-08-16): the render gate validates props against a CLOSED key
 * set at every level, and an agent that cannot see the whole set
 * invents keys (`members[0].id`) and blank enum values (`status: ""`
 * where the contract says idle|success). The example IS the closed
 * set, values included — the agent copies the shape and replaces the
 * values.
 */
function buildPropsExample(contract: DataContract): string | undefined {
  const properties = contract.propsSpec?.properties;
  if (properties === undefined) return undefined;
  const out: Record<string, JsonValue> = {};
  const entries = Object.entries(properties);
  const ordered = [
    ...entries.filter(([, entry]) => entry.required === true),
    ...entries.filter(([, entry]) => entry.required !== true),
  ];
  for (const [name, entry] of ordered) {
    out[name] =
      entry.example ?? entry.default ?? placeholderForSchema(entry.schema);
  }
  if (Object.keys(out).length === 0) return undefined;
  try {
    return JSON.stringify(out);
  } catch {
    return undefined;
  }
}

/**
 * Type-shaped placeholder for a JSON Schema — the props example the
 * agent copies from `nextStep.example`, so it must show the SHAPE the
 * render gate will hold the agent to, all the way down (ggui#523).
 *
 * The first landing bench (8 guest turns on dev, 2026-08-16) failed
 * 5/8 renders on the first attempt with "Undeclared field 'name' …
 * Declared keys: [id, title, cards]" / "Required field 'title'
 * missing" — every one a nested ARRAY ITEM shape the agent guessed,
 * because this used to answer `[]` for any array and `{}` for any
 * object. Now: an array shows one item in the item's shape; an object
 * shows every declared key (the gate rejects undeclared ones, so the
 * closed set IS the teaching); an enum shows its first value; a
 * declared `example`/`default` on a nested schema wins. Bounded depth.
 */
function placeholderForSchema(
  schema: JsonValue | Record<string, unknown>,
  depth = 0,
): JsonValue {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return '';
  }
  const s = schema as {
    type?: unknown;
    enum?: unknown;
    example?: unknown;
    default?: unknown;
    items?: unknown;
    properties?: unknown;
    const?: unknown;
  };
  if (s.const !== undefined) return s.const as JsonValue;
  if (s.example !== undefined) return s.example as JsonValue;
  if (s.default !== undefined) return s.default as JsonValue;
  if (Array.isArray(s.enum) && s.enum.length > 0) {
    return s.enum[0] as JsonValue;
  }
  const type = Array.isArray(s.type) ? s.type[0] : s.type;
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'array': {
      // One item in the item's shape — `[]` teaches nothing about what
      // goes inside, and "inside" is where the first-attempt failures were.
      if (depth >= 4 || s.items === undefined || typeof s.items !== 'object' || Array.isArray(s.items)) {
        return [];
      }
      return [placeholderForSchema(s.items as Record<string, unknown>, depth + 1)];
    }
    case 'object': {
      if (depth >= 4 || s.properties === null || typeof s.properties !== 'object' || Array.isArray(s.properties)) {
        return {};
      }
      const out: Record<string, JsonValue> = {};
      for (const [key, sub] of Object.entries(s.properties as Record<string, unknown>)) {
        out[key] = placeholderForSchema(sub as Record<string, unknown>, depth + 1);
      }
      return out;
    }
    default:
      return '';
  }
}

/**
 * Typed error thrown by `ggui_render` when the supplied handshakeId
 * doesn't resolve (unknown, already-consumed, or TTL-expired).
 */
export class HandshakeNotFoundError extends Error {
  readonly code = 'handshake_not_found' as const;
  constructor(public readonly handshakeId: string) {
    super(
      `ggui_render: handshakeId "${handshakeId}" not found. Handshake records are SINGLE-USE (consumed on render) and expire after ${HANDSHAKE_RECORD_TTL_SEC / 60} minutes. To recover: call ggui_handshake({intent, blueprintDraft}) again to mint a fresh handshakeId, then render with the new pair. Each render-emission requires its own handshake; do not cache handshakeIds across calls.`,
    );
    this.name = 'HandshakeNotFoundError';
  }
}

/**
 * Telemetry event name emitted by the handshake handler on every
 * successful negotiation.
 */
export const HANDSHAKE_DECIDED_EVENT = 'handshake.decided';

/**
 * Telemetry attributes shape on `handshake.decided`.
 *
 * Provenance rides on the flat-codec keys (`sourceKind` /
 * `sourceGenerator` / `sourceModel` — see `FLAT_BLUEPRINT_SOURCE_KEYS`
 * in `@ggui-ai/protocol`), present iff the suggestion carries a
 * cache-backed `blueprintMeta.source` (`origin === 'cache'`).
 */
export interface HandshakeDecidedAttributes {
  readonly appId: string;
  readonly handshakeId: string;
  readonly action: 'create' | 'reuse' | 'update' | 'replace' | 'declined';
  readonly origin: 'cache' | 'agent' | 'synth';
  readonly selectedBlueprintId: string;
  readonly selectionReason: string;
  readonly selectionConfidence?: number;
  /**
   * The armed props-schema hash the record persists — same attribute
   * name as `render.contract_violation` rows stamp, so a telemetry
   * consumer can join violation hashes against the arm without any
   * out-of-band reference (telemetry-attribute only; the wire already
   * carries the hash on the handshake output). Present whenever the
   * record carries one.
   */
  readonly propsSchemaHash?: string;
  readonly sourceKind?: BlueprintSourceKind;
  readonly sourceGenerator?: string;
  readonly sourceModel?: string;
}

/**
 * Extract a `conf=<n>` confidence suffix from the
 * `blueprintMeta.selectedReason` string when present.
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
    readonly handshakeId: string;
    readonly record: HandshakeRecord;
  },
): void {
  if (!sink) return;
  const { record } = args;
  const meta = record.suggestion.blueprintMeta;
  const reason = meta.selectedReason ?? record.suggestion.rationale;
  const confidence = extractSelectionConfidence(meta.selectedReason);
  const attributes: Record<string, string | number | boolean> = {
    appId: args.appId,
    handshakeId: args.handshakeId,
    action: record.action,
    origin: record.suggestion.origin,
    selectionReason: reason,
    // Provenance (cache origin only) — flattened through the shared
    // codec so telemetry rows use the same key vocabulary as stores.
    ...(meta.source ? blueprintSourceToFlat(meta.source) : {}),
  };
  // blueprintId is absent on agent/synth origins (D4) — the UUID is
  // minted at render-time registration, not at handshake. Only emit the
  // attribute when a stored cache UUID backs the suggestion.
  if (meta.blueprintId !== undefined) {
    attributes['selectedBlueprintId'] = meta.blueprintId;
  }
  if (confidence !== undefined) {
    attributes['selectionConfidence'] = confidence;
  }
  // Arm hash for the self-contained breach join (violation rows stamp
  // the enforced hash under the same key) — conditional like
  // blueprintId: records predating the propsSchema persistence carry
  // none.
  if (record.propsSchemaHash !== undefined) {
    attributes['propsSchemaHash'] = record.propsSchemaHash;
  }
  sink.emit({
    name: HANDSHAKE_DECIDED_EVENT,
    at: Date.now(),
    attributes,
  });
}
