/**
 * Render / props-mutation telemetry — the measurement leg (P2) of the
 * schema-precise render plan
 * (docs/plans/2026-08-19-schema-precise-render.md).
 *
 * Three events, one seam. All emissions ride the deps-injected
 * {@link TelemetrySink} (the `handshake.decided` precedent —
 * lossy, synchronous, MUST-NOT-throw; absent sink = noop):
 *
 *   - `render.attempted` — ggui_render entry, immediately after the
 *     handshake record resolves. The denominator for first-call
 *     violation rates: recoverable violations peek-don't-consume the
 *     handshake, so retries share a handshakeId and first-vs-retry is
 *     derivable from event order alone.
 *   - `render.contract_violation` — every contract-grounded rejection
 *     across ggui_render AND the props-mutation family (ggui_update /
 *     ggui_amend), discriminated by `site` (where in the flow) +
 *     `class` (which failure family), with `violationKeywords`
 *     segmentation (which JSON Schema keywords fired — the signal
 *     that separates vocabulary failures like `enum` from structural
 *     ones like `required`/`additionalProperties`).
 *   - `render.committed` — the success terminal for a render.
 *
 * Attribute values are flat primitives per the sink contract;
 * violation keywords are therefore joined into one bounded,
 * comma-separated string.
 */
import type { ContractViolation } from '@ggui-ai/protocol';
import type { TelemetrySink } from '@ggui-ai/mcp-server-core';

export const RENDER_ATTEMPTED_EVENT = 'render.attempted';
export const RENDER_CONTRACT_VIOLATION_EVENT = 'render.contract_violation';
export const RENDER_COMMITTED_EVENT = 'render.committed';

/** Where in the flow the rejection fired. */
export type RenderViolationSite =
  | 'props_validation'
  | 'override_no_propsspec'
  | 'contract_gate'
  | 'schema_compat'
  | 'mutation_props';

/** Which failure family the rejection belongs to. */
export type RenderViolationClass =
  | 'props'
  | 'override_contract_invalid'
  | 'contract_schema_invalid'
  | 'schema_mismatch';

/** Attribute-value length bound — keywords are a segmentation signal,
 *  not a payload; one pathological schema must not bloat the event. */
const MAX_KEYWORDS_LENGTH = 256;

/**
 * Collapse a violation list to its unique producing keywords, sorted
 * for deterministic attribute values, joined with `,`. Synthetic
 * violations without a keyword contribute nothing; an all-synthetic
 * list yields `undefined` (attribute omitted).
 */
export function joinViolationKeywords(
  violations: readonly ContractViolation[] | undefined,
): string | undefined {
  if (!violations || violations.length === 0) return undefined;
  const keywords = [
    ...new Set(
      violations
        .map((v) => v.keyword)
        .filter((k): k is string => typeof k === 'string' && k.length > 0),
    ),
  ].sort();
  if (keywords.length === 0) return undefined;
  return keywords.join(',').slice(0, MAX_KEYWORDS_LENGTH);
}

export function emitRenderAttempted(
  sink: TelemetrySink | undefined,
  args: {
    readonly appId: string;
    readonly handshakeId: string;
    readonly origin: string;
    readonly overridePresent: boolean;
  },
): void {
  if (!sink) return;
  sink.emit({
    name: RENDER_ATTEMPTED_EVENT,
    at: Date.now(),
    attributes: {
      appId: args.appId,
      handshakeId: args.handshakeId,
      origin: args.origin,
      overridePresent: args.overridePresent,
    },
  });
}

export function emitRenderContractViolation(
  sink: TelemetrySink | undefined,
  args: {
    readonly appId: string;
    readonly tool: 'ggui_render' | 'ggui_update' | 'ggui_amend';
    readonly site: RenderViolationSite;
    readonly violationClass: RenderViolationClass;
    readonly handshakeId?: string;
    readonly sessionId?: string;
    readonly origin?: string;
    readonly overridePresent?: boolean;
    /** Mutation mode — the props-mutation family only. */
    readonly kind?: 'replace' | 'merge';
    /** sha256 of the ENFORCED schema's RFC 8785 canonical bytes —
     *  the breach-classifier join key (matches the hash on the
     *  handshake output and on `ContractViolationError.toErrorData`). */
    readonly propsSchemaHash?: string;
    readonly violations?: readonly ContractViolation[];
  },
): void {
  if (!sink) return;
  const violationKeywords = joinViolationKeywords(args.violations);
  sink.emit({
    name: RENDER_CONTRACT_VIOLATION_EVENT,
    at: Date.now(),
    attributes: {
      appId: args.appId,
      tool: args.tool,
      site: args.site,
      class: args.violationClass,
      ...(args.handshakeId !== undefined
        ? { handshakeId: args.handshakeId }
        : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(args.origin !== undefined ? { origin: args.origin } : {}),
      ...(args.overridePresent !== undefined
        ? { overridePresent: args.overridePresent }
        : {}),
      ...(args.kind !== undefined ? { kind: args.kind } : {}),
      ...(args.propsSchemaHash !== undefined
        ? { propsSchemaHash: args.propsSchemaHash }
        : {}),
      ...(violationKeywords !== undefined ? { violationKeywords } : {}),
    },
  });
}

export function emitRenderCommitted(
  sink: TelemetrySink | undefined,
  args: {
    readonly appId: string;
    readonly handshakeId: string;
    readonly codeReady: boolean;
    readonly cacheHit: boolean;
  },
): void {
  if (!sink) return;
  sink.emit({
    name: RENDER_COMMITTED_EVENT,
    at: Date.now(),
    attributes: {
      appId: args.appId,
      handshakeId: args.handshakeId,
      codeReady: args.codeReady,
      cacheHit: args.cacheHit,
    },
  });
}
