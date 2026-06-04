import type { PropsSpec, StreamSpec, ActionSpec, ContextSpec, JsonSchema, JsonObject, DataContract } from '../types/data-contract';
import { deriveContextDefault } from '../types/data-contract';
import type { ActionEnvelope } from '../types/events';
import type { CompiledContractValidators } from '../integrations/mcp-apps';
import {
  compileForValidation,
  compileValidatorModule,
  mapAjvErrorsToViolations,
  prefixViolations,
} from './ajv-runtime';
import type { ValidateFunction } from './ajv-runtime';

// Re-export so consumers (the renderer iframe) can type precompiled
// validator modules without a direct `ajv` dependency.
export type { ValidateFunction } from './ajv-runtime';
import { checkCrossReferences } from './cross-references';
import { checkNameInvariants } from './name-invariants';
import { checkSchemaCompat } from './schema-compat-invariants';
import {
  BUILTIN_RESERVED_VALIDATORS,
  RESERVED_CHANNEL_PREFIX,
  isKnownReservedChannel,
  isReservedChannelName,
  type ReservedChannelValidator,
} from './reserved-channels';

export interface ContractViolation extends JsonObject {
  field: string;
  message: string;
  expected?: string;
  received?: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: ContractViolation[];
}

/**
 * Synthesize a {@link PropsSpec} into the single object-node JSON
 * Schema the runtime validates `props` against — `{type:'object',
 * properties:{…entry.schema…}, required:[…entry.required…]}`.
 * Closed-shape (`additionalProperties:false` at every depth) is NOT
 * injected here — the Ajv compile step ({@link compileForValidation} /
 * {@link compileValidatorModule}) does that, so this returns the raw
 * pre-injection wrapper.
 *
 * Shared by {@link validatePropsData} (server-side runtime check) and
 * {@link compileContractValidators} (render-time standalone emission) so
 * the precompiled in-iframe validator enforces byte-identical
 * semantics to the runtime validator — one synthesis, no drift.
 */
export function buildPropsWrapperSchema(spec: PropsSpec): JsonSchema {
  // `properties` is required by the `PropsSpec` type, but a degenerate
  // contract can carry `props: {}` on the wire — tolerate that as an
  // empty wrapper rather than throwing on `Object.entries(undefined)`.
  const properties = spec.properties ?? {};
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, entry]) => [name, entry.schema]),
    ),
    required: Object.entries(properties)
      .filter(([, entry]) => entry.required === true)
      .map(([name]) => name),
  };
}

/**
 * Validate runtime props data against a PropsSpec contract.
 *
 * Synthesizes the propsSpec into a single JSON Schema object node
 * — `{type:'object', properties: {…spec.properties[name].schema…},
 * required: [...names where entry.required], additionalProperties:
 * false}` — and validates `props` against it via the shared Ajv
 * runtime. The closed-shape injector recurses into every nested
 * object so the bidirectional contract (every declared key
 * validated, every data key declared) holds at any depth.
 *
 * Load-bearing for `ggui_update kind:'merge'` (RFC 7396): a patch
 * adding a key absent from `propsSpec.properties` would silently
 * land on the render without this gate. Same rule applies to
 * the `done`-vs-declared-`completed` class of bug inside array
 * items — Ajv rejects with the exact path (`todos[0].done`).
 */
export function validatePropsData(
  props: Record<string, unknown>,
  spec: PropsSpec,
  precompiled?: ValidateFunction,
): ValidationResult {
  // `precompiled` — a server-emitted, eval-free validator — lets a
  // CSP-sandboxed caller (the renderer iframe) skip the `ajv.compile()`
  // codegen its CSP forbids. Same Ajv engine, compiled once server-side.
  const validate = precompiled ?? compileForValidation(buildPropsWrapperSchema(spec));
  const ok = validate(props);
  if (ok) return { valid: true, violations: [] };
  return {
    valid: false,
    violations: mapAjvErrorsToViolations(validate.errors, props),
  };
}

/**
 * Validate a stream delivery's payload against the channel's declared
 * schema on a {@link StreamSpec}.
 *
 * Signature takes the channel name + payload explicitly — matching
 * the {@link StreamEnvelope} wire shape (where channel is a first-
 * class envelope field, not a field nested inside the payload).
 *
 * Checks:
 *  - `channelName` is declared in `spec` (a flat `Record<channelName,
 *    StreamChannelEntry>` post-2026-04-22 flatten) — undeclared
 *    channels reject with `'Unknown stream channel'` in the
 *    violation message.
 *  - `payload` conforms to `spec[channelName].schema` when
 *    that schema declares a `type`.
 *
 * Reserved-channel handling (injection pattern):
 *
 *   Known reserved channels (see {@link isKnownReservedChannel}) are
 *   server-owned and bypass the streamSpec path entirely — agents
 *   never declare them. Their payloads are validated through the
 *   TWO-TIER validator lookup:
 *
 *     1. `extraReservedValidators` — optional, caller-provided. Primary
 *        consumer: a hosting implementation composing the A2UI
 *        validator for `_ggui:preview`. Consulted FIRST so callers can
 *        override or extend built-ins.
 *     2. `BUILTIN_RESERVED_VALIDATORS` — protocol-owned, always active.
 *        Ships the {@link validateContractErrorPayload} for
 *        `_ggui:contract-error`.
 *     3. Fall-through: if no validator is registered for the known
 *        reserved channel, return `{valid: true}`. Preserves backward
 *        compatibility for any future reserved channel the runtime
 *        adds before its validator is authored.
 *
 *   Without this structure, a `_ggui:preview` emission into a render
 *   whose active render carries ANY user streamSpec would
 *   synthesize a false "Unknown channel" violation, blocking the
 *   provisional preview runtime. Symmetric with the client-side
 *   handling in `GguiRender`.
 *
 * Crucially narrow by design — the known-reserved path is a CLOSED
 * SET, not a prefix check. A typo inside the reserved namespace
 * (e.g. `_ggui:preveiw`) is NOT recognized, falls through to the
 * normal unknown-channel rejection, and surfaces the bug at its
 * emission site instead of turning into a silent no-op delivery.
 *
 * Does NOT validate channel semantics (mode / replay / complete) —
 * those are declarations, not shape constraints. See
 * `resolveStreamChannel` for semantics lookup.
 */
export function validateStreamData(
  channelName: string,
  payload: unknown,
  spec: StreamSpec,
  extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>,
  precompiledChannels?: ReadonlyMap<string, ValidateFunction>,
): ValidationResult {
  if (isKnownReservedChannel(channelName)) {
    // Lookup order: extras first (so hosting implementations can
    // override built-ins if they ever need to), then built-ins, then
    // fall through to valid (unrecognized-but-known reserved channel
    // without a registered validator).
    const override = extraReservedValidators?.get(channelName);
    if (override) return override(payload);
    const builtin = BUILTIN_RESERVED_VALIDATORS.get(channelName);
    if (builtin) return builtin(payload);
    return { valid: true, violations: [] };
  }
  const violations: ContractViolation[] = [];

  const channelEntry = spec[channelName];
  if (!channelEntry) {
    violations.push({
      field: 'channel',
      message: `Unknown stream channel '${channelName}'. Declared channels: ${Object.keys(spec).join(', ')}`,
      expected: Object.keys(spec).join(' | '),
      received: channelName,
    });
    return { valid: false, violations };
  }

  if (channelEntry.schema && payload !== undefined) {
    const validate =
      precompiledChannels?.get(channelName) ??
      compileForValidation(channelEntry.schema);
    const ok = validate(payload);
    if (!ok) {
      for (const v of prefixViolations(
        mapAjvErrorsToViolations(validate.errors, payload),
        `${channelName}.payload`,
      )) {
        violations.push(v);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Validate a contextSpec slot value against the spec's declared
 * schema. Symmetric with {@link validateStreamData} /
 * {@link validateActionData}: the iframe-runtime observer uses this
 * to gate Provider values BEFORE posting `ui/update-model-context`
 * envelopes (per the contextSpec design-lock — Q4 schema check).
 *
 * Checks:
 *   - `slotName` is declared in `spec` — undeclared slots reject with
 *     `'Unknown context slot'`.
 *   - `value` conforms to `spec[slotName].schema` when that schema
 *     declares a `type`.
 *
 * Mirrors `validateActionData`'s posture: the runtime that calls this
 * decides whether to surface the failure (dev-only `console.warn`,
 * drop silently in production) — the validator is a pure shape gate.
 */
export function validateContextData(
  slotName: string,
  value: unknown,
  spec: ContextSpec,
  precompiledSlots?: ReadonlyMap<string, ValidateFunction>,
): ValidationResult {
  const violations: ContractViolation[] = [];

  const entry = spec[slotName];
  if (!entry) {
    violations.push({
      field: 'contextSpec',
      message: `Unknown context slot '${slotName}'. Declared slots: ${
        Object.keys(spec).join(', ') || '(none)'
      }`,
      expected: Object.keys(spec).join(' | ') || '(none)',
      received: slotName,
    });
    return { valid: false, violations };
  }

  if (entry.schema && value !== undefined) {
    const validate =
      precompiledSlots?.get(slotName) ?? compileForValidation(entry.schema);
    const ok = validate(value);
    if (!ok) {
      for (const v of prefixViolations(
        mapAjvErrorsToViolations(validate.errors, value),
        `${slotName}.value`,
      )) {
        violations.push(v);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Validate an inbound user-action payload against the render's ActionSpec.
 *
 * Symmetric with {@link validatePropsData} / {@link validateStreamData}, but for
 * live-channel INBOUND user → core traffic. Enforces the action contract at the
 * wire boundary BEFORE the event is buffered or forwarded to an agent.
 *
 * Input shape mirrors `ActionEventValue` from `events.ts`:
 *   `{ action: string, data?: JsonValue, tool?: string }`
 *
 * Checks:
 * - `action` is a non-empty string
 * - `action` is declared in `spec` (a flat `Record<actionName,
 *   ActionEntry>` post-2026-04-22 flatten)
 * - If the declared action has a `schema`, `data` matches it
 *
 * Actions without a declared schema are void-payload (fire-and-forget) — a
 * present-but-unexpected `data` is tolerated to stay forward-compatible with
 * clients that attach UI metadata the contract doesn't model. Contracts that
 * want strict emptiness should declare `schema: { type: 'null' }`.
 */
export function validateActionData(
  value: unknown,
  spec: ActionSpec,
  precompiledActions?: ReadonlyMap<string, ValidateFunction>,
): ValidationResult {
  const violations: ContractViolation[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    violations.push({
      field: 'value',
      message: 'Action payload must be an object with an `action` field',
      expected: 'object',
      received: getJsonType(value),
    });
    return { valid: false, violations };
  }

  const record = value as Record<string, unknown>;
  const actionId = record.action;

  if (typeof actionId !== 'string' || actionId.length === 0) {
    violations.push({
      field: 'action',
      message: 'Missing or empty `action` identifier',
      expected: 'string',
      received: getJsonType(actionId),
    });
    return { valid: false, violations };
  }

  const entry = spec[actionId];
  if (!entry) {
    violations.push({
      field: 'action',
      message: `Unknown action '${actionId}'. Declared actions: ${Object.keys(spec).join(', ') || '(none)'}`,
      expected: Object.keys(spec).join(' | ') || '(none)',
      received: actionId,
    });
    return { valid: false, violations };
  }

  if (entry.schema) {
    const validate =
      precompiledActions?.get(actionId) ?? compileForValidation(entry.schema);
    const ok = validate(record.data);
    if (!ok) {
      for (const v of prefixViolations(
        mapAjvErrorsToViolations(validate.errors, record.data),
        `${actionId}.data`,
      )) {
        violations.push(v);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

function getJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Validate an inbound {@link ActionEnvelope} against the target
 * render's {@link ActionSpec}. Payload-contract layer of live-channel
 * inbound enforcement — the allowlist gate (`assertEventAllowed` in
 * `@ggui-ai/mcp-server-handlers`) is a separate concern that runs
 * first.
 *
 * Semantics:
 *   - `envelope.type !== 'data:submit'` → `{valid: true, violations: []}`.
 *     Only action submissions carry payload contract today; other
 *     event types (lifecycle, interaction, error) have no schema
 *     enforcement on this layer.
 *   - `spec === undefined` → `{valid: true, violations: []}`. Renders
 *     without an actionSpec have no contract; legacy renders keep
 *     flowing.
 *   - Otherwise `envelope.payload` is validated against `spec` via
 *     {@link validateActionData}. Same rules, same output shape.
 *
 * This helper does NOT enforce allowlist, render binding, or render
 * routing — those are ingress-plumbing concerns. Pure payload-shape
 * check; returns `ValidationResult` rather than throwing so callers
 * can decide whether to surface as a wire error, log, etc.
 */
export function validateActionEnvelope(
  envelope: ActionEnvelope,
  spec: ActionSpec | undefined,
  precompiledActions?: ReadonlyMap<string, ValidateFunction>,
): ValidationResult {
  if (envelope.type !== 'data:submit') return { valid: true, violations: [] };
  if (!spec) return { valid: true, violations: [] };
  return validateActionData(envelope.payload, spec, precompiledActions);
}

/**
 * Compile a contract's runtime-validated sub-schemas into standalone,
 * eval-free ESM validator modules — the producer half of the
 * precompiled-validator channel
 * ({@link CompiledContractValidators} on `McpAppAiGguiMeta`).
 *
 * The renderer iframe runs under a strict CSP with no `'unsafe-eval'`,
 * so it cannot call `ajv.compile()` (which builds validators via
 * `new Function`). Compilation therefore happens server-side at render
 * time — where the contract schema is fixed and codegen is legal — and
 * the iframe loads each emitted module via a `blob:` dynamic import.
 *
 * One module per runtime-validated surface, matching the four runtime
 * validators in this file exactly (no second contract model):
 *
 *   - `props`   — the synthesized object wrapper from
 *     {@link buildPropsWrapperSchema}, as {@link validatePropsData}
 *     validates `props`.
 *   - `actions` — per-action `entry.schema`, as {@link validateActionData}
 *     validates `data`. Void actions (no `schema`) contribute no entry.
 *   - `streams` — per-channel `entry.schema`, as {@link validateStreamData}
 *     validates `payload`.
 *   - `context` — per-slot `entry.schema`, as {@link validateContextData}
 *     validates `value`.
 *
 * Returns `undefined` when the contract declares no runtime-validated
 * schema at all — the slice-meta projection then omits the field.
 */
export function compileContractValidators(specs: {
  readonly propsSpec?: PropsSpec;
  readonly actionSpec?: ActionSpec;
  readonly streamSpec?: StreamSpec;
  readonly contextSpec?: ContextSpec;
}): CompiledContractValidators | undefined {
  const compilePerEntry = (
    spec: Record<string, { schema?: JsonSchema }> | undefined,
  ): Record<string, string> | undefined => {
    if (!spec) return undefined;
    const collected: Record<string, string> = {};
    for (const [name, entry] of Object.entries(spec)) {
      if (entry && entry.schema) {
        collected[name] = compileValidatorModule(entry.schema);
      }
    }
    return Object.keys(collected).length > 0 ? collected : undefined;
  };

  const out: {
    props?: string;
    actions?: Record<string, string>;
    streams?: Record<string, string>;
    context?: Record<string, string>;
  } = {};

  // A degenerate contract may carry `props: {}` (a propsSpec with no
  // `properties`) — guard before `Object.keys` so the projection never
  // throws on it; an empty propsSpec simply contributes no validator.
  if (
    specs.propsSpec &&
    specs.propsSpec.properties &&
    Object.keys(specs.propsSpec.properties).length > 0
  ) {
    out.props = compileValidatorModule(buildPropsWrapperSchema(specs.propsSpec));
  }
  const actions = compilePerEntry(specs.actionSpec);
  if (actions) out.actions = actions;
  const streams = compilePerEntry(specs.streamSpec);
  if (streams) out.streams = streams;
  const context = compilePerEntry(specs.contextSpec);
  if (context) out.context = context;

  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Wrap a {@link CompiledContractValidators} object as the source text of
 * an ES module whose `default` export is the same object. This is the
 * wire format served from the content-addressable contract route
 * (`GET /contract/<hash>.js`) in #109's decomposition slice — one URL,
 * one fetch, one dynamic-import per unique contract.
 *
 * Why a wrapping module rather than emitting the validator-modules
 * raw: each inner validator-module is independently `export default ...`,
 * so they can't share a single file without name collisions. The
 * iframe-runtime's existing `loadCompiledValidators` already knows how
 * to take a `CompiledContractValidators` and load each inner module via
 * `blob:` import; this wrapper just hands it the same shape it expects,
 * sourced from one HTTP round-trip instead of inline.
 *
 * `JSON.stringify` is deterministic on objects with string keys in V8
 * + Node — the producer's iteration order is preserved, so a given
 * contract always serializes to identical bytes. {@link computeContractBundle}
 * leans on that determinism so the resulting hash is stable across
 * renders of the same contract.
 *
 * @public
 */
export function bundleCompiledValidatorsAsModule(
  compiled: CompiledContractValidators,
): string {
  return `export default ${JSON.stringify(compiled)};\n`;
}

/**
 * Recursive canonical-JSON serializer with object keys sorted
 * lexicographically at every depth. Output is byte-stable across any
 * two callers building the same logical contract via different key
 * orders (e.g. `{a:1, b:2}` vs `{b:2, a:1}`) — so {@link computeContractBundle}'s
 * hash is robust to spec-author hand-ordering.
 *
 * Arrays preserve element order (semantically meaningful in JSON
 * Schema, e.g. `required: [a, b]` differs from `[b, a]` for some
 * validators / error message ordering). Functions are not part of
 * `DataContract` specs, so the type-`function` branch is unreachable
 * in normal use and excluded.
 */
function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJsonStringify((value as Record<string, unknown>)[k])}`,
    );
    return `{${parts.join(',')}}`;
  }
  // undefined / function — not valid inside DataContract specs.
  return 'null';
}

/**
 * Convenience over {@link compileContractValidators} +
 * {@link bundleCompiledValidatorsAsModule} + sha256 — produces the
 * `{contractHash, bundleSource, validators}` triple the emitter (render.ts
 * / update.ts in #109 C4) writes to the content-addressable store and
 * emits as `_meta["ai.ggui/contract"] = {contractHash, validatorsUrl}`.
 *
 * `contractHash` is `sha256(canonicalJsonStringify(specs))` (hex). Hashing
 * the INPUT specs — not the compiled output — guarantees a stable hash
 * across server processes and Ajv version bumps: the same contract
 * definition always lands at the same URL. Compiled output bytes may
 * differ across calls (Ajv's standalone emitter uses incrementing
 * counter names like `validate10`/`validate11`), but the CodeStore is
 * idempotent (first write wins) and the URL response carries
 * `Cache-Control: immutable`, so browsers + CDNs lock in the
 * first-served bytes and never observe a counter-name reshuffle.
 *
 * Returns `undefined` when the contract declares no runtime-validated
 * schema at all (matches {@link compileContractValidators}'s posture).
 *
 * @public
 */
export async function computeContractBundle(specs: {
  readonly propsSpec?: PropsSpec;
  readonly actionSpec?: ActionSpec;
  readonly streamSpec?: StreamSpec;
  readonly contextSpec?: ContextSpec;
}): Promise<
  | {
      readonly contractHash: string;
      readonly bundleSource: string;
      readonly validators: CompiledContractValidators;
    }
  | undefined
> {
  const validators = compileContractValidators(specs);
  if (validators === undefined) return undefined;
  const bundleSource = bundleCompiledValidatorsAsModule(validators);
  // Web Crypto's subtle.digest is universal (Node 19+, all modern
  // browsers, Workers). The protocol package ships into iframe-runtime
  // bundles too — `node:crypto` would force esbuild to mark a Node
  // builtin unresolved at browser bundle time even though this
  // function is server-only at call time.
  const bytes = new TextEncoder().encode(canonicalJsonStringify(specs));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const contractHash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { contractHash, bundleSource, validators };
}

/**
 * Format violations into a human-readable error message for the target agent.
 */
export function formatViolations(violations: ContractViolation[]): string {
  return violations
    .map(v => `- ${v.field}: ${v.message}${v.expected ? ` (expected: ${v.expected}, got: ${v.received})` : ''}`)
    .join('\n');
}

// =============================================================================
// Contract Structure Validation (Scenario 1: Bad Contract)
// =============================================================================

/**
 * Validate the contract structure itself — catches malformed contract
 * before they're persisted and used to validate runtime data.
 *
 * Checks:
 * - PropsSpec properties have valid schemas (type or oneOf/anyOf defined)
 * - Array schemas have items defined (otherwise element validation is impossible)
 * - Object schemas with required fields reference existing properties
 * - StreamSpec channels have schemas defined (reserved-prefix names rejected)
 * - ActionSpec actions have schemas defined
 * - ContextSpec slots: identifier-shape keys, no reserved keys
 *   (`__proto__`/`constructor`/`prototype`), schema present, default
 *   satisfies schema, debounceMs is a non-negative integer, no key
 *   collision with propsSpec, and `deriveContextDefault` yields a
 *   non-undefined initial value (see `validateContextStructure`).
 * - Cross-reference invariants (`actionSpec.nextStep`,
 *   `streamSpec.source.tool` resolve to `agentCapabilities.tools[*]`).
 * - Name invariants (no collision across actionSpec / streamSpec /
 *   contextSpec; no `_ggui:` reserved-prefix keys).
 * - Schema-compat invariants (`actionSpec[*].schema` ⊆
 *   `tool.inputSchema`; `streamSpec[*].schema` ⊇ `tool.outputSchema`).
 */
export function validateContractStructure(contract: DataContract): ValidationResult {
  const violations: ContractViolation[] = [];

  if (contract.propsSpec) {
    const entries = Object.entries(contract.propsSpec.properties);
    if (entries.length === 0) {
      violations.push({
        field: 'propsSpec',
        message: 'PropsSpec has no properties — contract must define at least one prop',
        expected: 'non-empty properties map',
        received: 'empty',
      });
    }

    for (const [name, entry] of entries) {
      if (!entry.schema) {
        violations.push({
          field: `propsSpec.${name}`,
          message: `Prop '${name}' has no schema — cannot validate data without a type definition`,
          expected: 'schema with type',
          received: 'undefined',
        });
        continue;
      }
      validateSchemaStructure(entry.schema, `propsSpec.${name}`, violations);
    }
  }

  if (contract.streamSpec) {
    for (const [channelName, entry] of Object.entries(contract.streamSpec)) {
      if (isReservedChannelName(channelName)) {
        // Server-owned namespace (see `./reserved-channels`). Agents
        // can't declare here — these channels are emitted by the
        // runtime, not the agent's contract. Skip further structural
        // checks on this entry; the rejection is the authoritative
        // violation.
        violations.push({
          field: `streamSpec.${channelName}`,
          message: `Stream channel '${channelName}' is in the reserved '${RESERVED_CHANNEL_PREFIX}' namespace — server-owned channels cannot be declared in agent streamSpec`,
          expected: `name not starting with '${RESERVED_CHANNEL_PREFIX}'`,
          received: channelName,
        });
        continue;
      }
      if (!entry.schema) {
        violations.push({
          field: `streamSpec.${channelName}`,
          message: `Stream channel '${channelName}' has no schema — cannot validate payloads`,
          expected: 'schema with type',
          received: 'undefined',
        });
      } else {
        validateSchemaStructure(entry.schema, `streamSpec.${channelName}`, violations);
      }
    }
  }

  if (contract.actionSpec) {
    for (const [actionId, entry] of Object.entries(contract.actionSpec)) {
      if (entry.schema) {
        validateSchemaStructure(entry.schema, `actionSpec.${actionId}`, violations);
      }
      // ActionSpec schema is optional — actions can be void (e.g., button click with no payload)
    }
  }

  if (contract.contextSpec) {
    validateContextStructure(contract.contextSpec, violations, contract.propsSpec);
  }

  // Cross-reference invariants: actionSpec[*].nextStep and
  // streamSpec[*].source.tool both resolve to agentCapabilities.tools[*]
  // keys on the same contract. Folded into the same violations list so a
  // single call surfaces both structural AND reference bugs.
  for (const violation of checkCrossReferences(contract)) {
    violations.push(violation);
  }

  // Name-invariant rules: no collisions across actionSpec / streamSpec
  // / contextSpec keys; no `_ggui:` reserved-prefix keys on actionSpec
  // or contextSpec (streamSpec reserved-prefix rejection is the
  // dedicated `streamSpec.*` clause above). Same fold-into-violations
  // posture as cross-references.
  for (const violation of checkNameInvariants(contract)) {
    violations.push(violation);
  }

  // Schema-compat invariants: action.schema ⊆ tool.inputSchema and
  // channel.schema ⊇ tool.outputSchema, validated against the
  // contract's OWN agentTools catalog. Distinct scope from the
  // server-level F4 check (which compares against the live tool
  // registry's zod schemas).
  for (const violation of checkSchemaCompat(contract)) {
    violations.push(violation);
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Slot-key identifier check for contextSpec. Slot keys are surfaced
 * as React Context names by the boilerplate generator (`currentStep`
 * → `CurrentStepContext`); a non-identifier here would break the
 * generation step at runtime, so we reject at render-time instead.
 */
const CONTEXT_SLOT_KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Reserved slot keys for contextSpec. Forbidden because they would
 * shadow Object prototype slots when the runtime materializes the
 * context map (e.g., `obj['__proto__'] = …` in pre-frozen
 * environments would mutate the prototype chain rather than set a
 * slot). Defensive — the runtime uses a frozen spec lookup, but the
 * render-time gate keeps the invariant load-bearing for any future
 * implementation that materializes the spec into a plain object.
 */
const CONTEXT_RESERVED_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Per-slot structural validation for {@link ContextSpec}.
 * Surfaces every violation alongside the surrounding actionSpec /
 * streamSpec / props checks so authors see the full contract status
 * in one pass instead of fix-and-retry per-field.
 *
 * Rules enforced:
 *   1. Slot keys MUST match {@link CONTEXT_SLOT_KEY_PATTERN} (camelCase
 *      JS identifier) — boilerplate generates a React Context name
 *      from the key.
 *   2. Slot keys MUST NOT be in {@link CONTEXT_RESERVED_KEYS}
 *      (`__proto__` / `constructor` / `prototype`).
 *   3. `entry.schema` MUST be present and structurally valid (same
 *      structural check as actionSpec / streamSpec schemas).
 *   4. If `entry.default` is present, it MUST satisfy `entry.schema`
 *      (same posture as `validatePropsData` for `default`).
 *   5. If `entry.debounceMs` is present, it MUST be a non-negative
 *      integer (`0` allowed = immediate).
 *   6. Slot keys MUST NOT collide with any key in
 *      {@link PropsSpec.properties} — the boilerplate generator emits
 *      `const [<slotKey>, set<PascalSlotKey>] = useState(...)` inside
 *      the same function scope as the destructured `props.<key>`, so a
 *      collision would shadow the prop binding.
 *   7. {@link deriveContextDefault} MUST yield a non-undefined value
 *      for every slot — otherwise the boilerplate's
 *      `useState(<defaultExpr>)` call would emit `useState(undefined)`,
 *      defeating the typed initial-value contract. Schemas without a
 *      derivable primitive type (e.g., bare `oneOf`/`anyOf`) MUST set
 *      `entry.default` explicitly.
 */
function validateContextStructure(
  spec: ContextSpec,
  violations: ContractViolation[],
  props?: PropsSpec,
): void {
  const propKeys: ReadonlySet<string> = props
    ? new Set(Object.keys(props.properties))
    : new Set<string>();

  for (const [slotKey, entry] of Object.entries(spec)) {
    const path = `contextSpec.${slotKey}`;

    if (CONTEXT_RESERVED_KEYS.has(slotKey)) {
      violations.push({
        field: path,
        message: `context slot key '${slotKey}' is reserved (forbidden: ${[
          ...CONTEXT_RESERVED_KEYS,
        ]
          .map(k => `'${k}'`)
          .join(', ')})`,
        expected: 'non-reserved identifier',
        received: slotKey,
      });
      continue;
    }

    if (!CONTEXT_SLOT_KEY_PATTERN.test(slotKey)) {
      violations.push({
        field: path,
        message: `context slot key '${slotKey}' is not a valid JS identifier (must match ${CONTEXT_SLOT_KEY_PATTERN})`,
        expected: 'camelCase JS identifier',
        received: slotKey,
      });
      continue;
    }

    if (propKeys.has(slotKey)) {
      violations.push({
        field: path,
        message: `context slot key '${slotKey}' collides with propsSpec.properties.${slotKey} (would shadow the prop binding in generated boilerplate)`,
        expected: 'slot key not present in propsSpec.properties',
        received: slotKey,
      });
      continue;
    }

    if (!entry.schema) {
      violations.push({
        field: path,
        message: `context slot '${slotKey}' has no schema — cannot validate slot values`,
        expected: 'schema with type',
        received: 'undefined',
      });
      continue;
    }

    validateSchemaStructure(entry.schema, path, violations);

    if (entry.default !== undefined) {
      try {
        const validate = compileForValidation(entry.schema);
        const ok = validate(entry.default);
        if (!ok) {
          for (const v of prefixViolations(
            mapAjvErrorsToViolations(validate.errors, entry.default),
            `${path}.default`,
          )) {
            violations.push(v);
          }
        }
      } catch {
        // Schema malformed under Ajv strict mode. The dedicated
        // `validateSchemaStructure` call earlier in this loop has
        // already pushed a violation describing the schema problem;
        // skipping the default check here avoids a noisy duplicate.
      }
    }

    // Default-derivability — boilerplate emits `useState(<defaultExpr>)`,
    // and `defaultExpr` must NOT be `undefined`. Resolves via
    // `deriveContextDefault`: explicit `entry.default` first, then the
    // schema-typed fallback. Schemas with no resolvable primitive type
    // (e.g., bare `oneOf`/`anyOf`) require the author to set `default`
    // explicitly.
    if (deriveContextDefault(entry) === undefined) {
      const t = entry.schema?.type;
      violations.push({
        field: path,
        message: `context slot '${slotKey}' has no derivable default${
          t ? ` (schema type ${t})` : ''
        }; explicitly set entry.default`,
        expected: 'derivable default via deriveContextDefault',
        received: 'undefined',
      });
    }

    if (entry.debounceMs !== undefined) {
      if (
        typeof entry.debounceMs !== 'number' ||
        !Number.isInteger(entry.debounceMs) ||
        entry.debounceMs < 0
      ) {
        violations.push({
          field: `${path}.debounceMs`,
          message: `contextSpec[${slotKey}].debounceMs must be a non-negative integer (got ${String(
            entry.debounceMs,
          )})`,
          expected: 'non-negative integer',
          received: getJsonType(entry.debounceMs),
        });
      }
    }
  }
}

/**
 * Recursively validate a JSON Schema node for structural completeness.
 */
function validateSchemaStructure(
  schema: JsonSchema,
  path: string,
  violations: ContractViolation[],
): void {
  // Must have type, oneOf, or anyOf
  if (!schema.type && !schema.oneOf && !schema.anyOf) {
    violations.push({
      field: path,
      message: `Schema at '${path}' has no type, oneOf, or anyOf — cannot determine data shape`,
      expected: 'type | oneOf | anyOf',
      received: 'none',
    });
    return;
  }

  if (schema.type === 'array' && !schema.items) {
    violations.push({
      field: path,
      message: `Array schema at '${path}' has no items — cannot validate array elements`,
      expected: 'items schema',
      received: 'undefined',
    });
  }

  if (schema.type === 'object' && schema.required?.length) {
    const definedProps = Object.keys(schema.properties ?? {});
    for (const req of schema.required) {
      if (!definedProps.includes(req)) {
        violations.push({
          field: `${path}.${req}`,
          message: `Required field '${req}' is not defined in properties at '${path}'`,
          expected: `'${req}' in properties`,
          received: `properties: [${definedProps.join(', ')}]`,
        });
      }
    }
  }

  // Recurse into nested schemas
  if (schema.items) {
    validateSchemaStructure(schema.items, `${path}.items`, violations);
  }
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      validateSchemaStructure(propSchema, `${path}.${key}`, violations);
    }
  }
  // Recurse into union branches
  if (schema.oneOf) {
    for (let i = 0; i < schema.oneOf.length; i++) {
      validateSchemaStructure(schema.oneOf[i], `${path}.oneOf[${i}]`, violations);
    }
  }
  if (schema.anyOf) {
    for (let i = 0; i < schema.anyOf.length; i++) {
      validateSchemaStructure(schema.anyOf[i], `${path}.anyOf[${i}]`, violations);
    }
  }
}

/**
 * Typed error for contract violations.
 *
 * Thrown by commit/update/stream handlers when agent data doesn't match
 * the negotiated contract. The MCP handler catches this and returns a
 * structured error response with violations + hint so the agent can
 * self-correct (fix data or propose a new contract via ggui_render).
 */
function defaultHintFor(tool: 'ggui_render' | 'ggui_update' | 'ggui_emit' | 'ggui_event'): string {
  if (tool === 'ggui_event') {
    return 'The user-action payload did not match the render\'s actionSpec. Re-check the client-side action wiring, or have the agent render a new UI whose actionSpec covers this payload shape.';
  }
  return 'Fix your data to match the contract, or call ggui_render to create a new UI for this data shape.';
}

export class ContractViolationError extends Error {
  readonly violations: ContractViolation[];
  readonly tool: 'ggui_render' | 'ggui_update' | 'ggui_emit' | 'ggui_event';
  readonly hint: string;

  constructor(opts: {
    tool: 'ggui_render' | 'ggui_update' | 'ggui_emit' | 'ggui_event';
    violations: ContractViolation[];
    hint?: string;
  }) {
    const formattedViolations = formatViolations(opts.violations);
    super(`Contract violation in ${opts.tool}:\n${formattedViolations}`);
    this.name = 'ContractViolationError';
    this.violations = opts.violations;
    this.tool = opts.tool;
    this.hint = opts.hint ?? defaultHintFor(opts.tool);
  }

  /** Structured payload for MCP error response `data` field. */
  toErrorData(): {
    error: 'contract_violation';
    tool: string;
    violations: ContractViolation[];
    hint: string;
  } {
    return {
      error: 'contract_violation',
      tool: this.tool,
      violations: this.violations,
      hint: this.hint,
    };
  }
}
