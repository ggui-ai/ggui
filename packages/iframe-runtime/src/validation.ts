/**
 * Renderer-local contract-validation seam.
 *
 * Every wire-traffic check in the iframe-runtime routes through this
 * module. Its two jobs:
 *
 *   1. **Precompiled-validator substitution (A4 / CSP fix).** The
 *      renderer iframe runs under a strict CSP with no `'unsafe-eval'`,
 *      so it cannot call `ajv.compile()` (codegen via `new Function`).
 *      The server precompiles each contract sub-schema into an
 *      eval-free ESM validator module and ships them on the bootstrap;
 *      {@link loadCompiledValidators} loads them into a
 *      {@link CompiledValidatorSet} which {@link setActiveValidatorSet}
 *      installs here. Each validator below passes the matching
 *      precompiled `ValidateFunction` into the protocol validator,
 *      which uses it INSTEAD of compiling the schema in-iframe.
 *      A defensive try/catch degrades to permissive if the protocol
 *      validator still throws (precompiled validator absent + CSP
 *      blocks the `ajv.compile()` fallback) — a dispatched action
 *      beats a silently-dropped one.
 *
 *   2. **Reserved-channel validator composition** — A2UI default for
 *      `_ggui:preview` composed with any bootstrap-supplied overrides.
 *
 * The renderer owns reserved-channel validation. The `<McpAppIframe>`
 * host wrapper explicitly does NOT run this path — its only contract is
 * the postMessage bridge to the renderer iframe.
 */
import type {
  ActionSpec,
  ActionEnvelope,
  ContextSpec,
  JsonObject,
  PropsSpec,
  ReservedChannelValidator,
  StreamSpec,
  ValidationResult,
} from '@ggui-ai/protocol';
import {
  isKnownReservedChannel,
  validateActionEnvelope,
  validateContextData,
  validatePropsData,
  validateStreamData,
} from '@ggui-ai/protocol';
import type { CompiledValidatorSet } from './compiled-validators.js';

// =============================================================================
// Active precompiled-validator set
// =============================================================================

/**
 * Boot-installed precompiled validators for the active render's
 * contract. `undefined` until {@link setActiveValidatorSet} runs (and
 * in unit tests, which exercise the in-iframe compilation fallback).
 */
let activeValidatorSet: CompiledValidatorSet | undefined;

/**
 * Install the precompiled validators loaded from the bootstrap. Called
 * once per boot (by `bootSequence`), after the bootstrap is parsed. A
 * single set per iframe document — one render, one active contract.
 */
export function setActiveValidatorSet(
  set: CompiledValidatorSet | undefined,
): void {
  activeValidatorSet = set;
}

const VALID: ValidationResult = { valid: true, violations: [] };

/**
 * Run a protocol validator, degrading to permissive if it throws. The
 * only throw path is the CSP `EvalError` from an `ajv.compile()`
 * fallback when no precompiled validator covered the surface — better a
 * dispatched action than a crash that silently drops it.
 */
function guarded(label: string, run: () => ValidationResult): ValidationResult {
  try {
    return run();
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn(
        `[ggui:validation] ${label}: validator unavailable (no precompiled validator + CSP blocks in-iframe compile) — allowing through`,
        err,
      );
    }
    return VALID;
  }
}

// =============================================================================
// Reserved validator map composition
// =============================================================================

/**
 * Merge two reserved-validator maps. Override keys WIN on conflict.
 * The renderer ships an A2UI default for `_ggui:preview`; the
 * bootstrap MAY replace it by key (not yet wired on the producer
 * side — reserved as an extensibility slot).
 */
export function mergeReservedValidators(
  base: ReadonlyMap<string, ReservedChannelValidator> | undefined,
  override: ReadonlyMap<string, ReservedChannelValidator> | undefined,
): ReadonlyMap<string, ReservedChannelValidator> | undefined {
  if (!base && !override) return undefined;
  if (!base) return override;
  if (!override) return base;
  const merged = new Map<string, ReservedChannelValidator>(base);
  for (const [key, validator] of override) {
    merged.set(key, validator);
  }
  return merged;
}

// =============================================================================
// Outbound / inbound validation entry points
// =============================================================================

export interface RendererValidatorContext {
  /**
   * Composed reserved-channel validators resolved once at boot.
   * Passed through to `validateStreamData`'s `extraReservedValidators`
   * param. `undefined` is honest-permissive (matches the pre-Item-4
   * behavior; useful for test harnesses).
   */
  readonly reservedValidators: ReadonlyMap<string, ReservedChannelValidator> | undefined;
}

/**
 * Validate an outbound {@link ActionEnvelope} before emitting over the
 * live channel. Symmetric with the server's inbound enforcement.
 *
 * `actionSpec === undefined` = permissive (the server's "no contract to
 * enforce" posture). Uses the precompiled action validators when
 * present so the dispatch never trips the iframe's no-`unsafe-eval` CSP.
 */
export function validateOutboundActionEnvelope(
  actionSpec: ActionSpec | undefined,
  envelope: ActionEnvelope,
): ValidationResult {
  return guarded('outbound-action', () =>
    validateActionEnvelope(envelope, actionSpec, activeValidatorSet?.actions),
  );
}

/**
 * Validate an inbound stream-channel delivery before applying it to
 * render state. Known reserved channels (`_ggui:*`) validate even
 * when the target render has no declared `streamSpec` — the
 * payload shape is server-owned; user channels stay permissive without
 * a contract.
 */
export function validateInboundStreamPayload(
  streamSpec: StreamSpec | undefined,
  channelName: string,
  payload: unknown,
  ctx: RendererValidatorContext,
): ValidationResult {
  return guarded('inbound-stream', () => {
    if (isKnownReservedChannel(channelName)) {
      return validateStreamData(
        channelName,
        payload,
        streamSpec ?? {},
        ctx.reservedValidators,
        activeValidatorSet?.streams,
      );
    }
    if (!streamSpec) return VALID;
    return validateStreamData(
      channelName,
      payload,
      streamSpec,
      ctx.reservedValidators,
      activeValidatorSet?.streams,
    );
  });
}

/**
 * Validate an inbound `props_update` payload before patching a
 * render's props. Server already runs `assertPropsContract` on the emit
 * path; this client-side revalidation is defense-in-depth for
 * spec-versioning drift (server snapshot ≠ client cached spec).
 */
export function validateInboundPropsPayload(
  propsSpec: PropsSpec | undefined,
  props: JsonObject,
): ValidationResult {
  if (!propsSpec) return VALID;
  return guarded('inbound-props', () =>
    validatePropsData(props, propsSpec, activeValidatorSet?.props),
  );
}

/**
 * Validate a contextSpec slot value before the observer posts a
 * `ui/update-model-context` envelope. Uses the precompiled context
 * validators when present so the gate never trips the CSP.
 */
export function validateContextValue(
  spec: ContextSpec,
  slotName: string,
  value: unknown,
): ValidationResult {
  return guarded('context-slot', () =>
    validateContextData(slotName, value, spec, activeValidatorSet?.context),
  );
}
