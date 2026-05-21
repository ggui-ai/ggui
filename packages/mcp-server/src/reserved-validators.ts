/**
 * Reserved-channel payload validator composition for `@ggui-ai/mcp-server`.
 *
 * `@ggui-ai/protocol` ships zero knowledge of A2UI (see Protocol #6,
 * vendor-neutral separation). The preview channel's payload shape is
 * authored in `@ggui-ai/preview-a2ui`; this module adapts that package's
 * `parseServerMessage` into the
 * {@link ReservedChannelValidator} shape `validateStreamData` expects
 * via its `extraReservedValidators` injection point.
 *
 * Composition surface:
 *
 *   - {@link composePreviewReservedValidator} — returns a single-entry
 *     map binding `_ggui:preview` to the A2UI adapter. Call at server
 *     construction and feed into `extraReservedValidators` on
 *     `SessionChannelOptions` / `CreateGguiServerOptions`.
 *   - {@link mergeReservedValidators} — combine multiple validator maps
 *     when a caller provides their own extras AND the server wants to
 *     layer A2UI on top. Caller-provided entries win on key conflict.
 *
 * Design note: kept deliberately narrow. No server-opinionated default
 * catalog filtering, no surface-id checking — those live in the A2UI
 * runtime consumer. The adapter enforces only what `parseServerMessage`
 * enforces: message-shape conformance to the V1 write-path union.
 */
import {
  parseServerMessage,
  type ServerMessageParseResult,
} from '@ggui-ai/preview-a2ui';
import {
  PREVIEW_CHANNEL,
  type ContractViolation,
  type ReservedChannelValidator,
  type ValidationResult,
} from '@ggui-ai/protocol';

/**
 * Adapter mapping `parseServerMessage` output to the
 * `ValidationResult` shape `validateStreamData` returns. Accepts any
 * `_ggui:preview` payload and surfaces the A2UI parse issues under the
 * `payload` field path when rejection fires.
 *
 * Channel-close sentinel: `null` / `undefined` payloads on
 * `_ggui:preview` are the live-channel terminal envelope emitted by the
 * preview runner's `finalizePreviewChannel` (alongside
 * `complete: true`). This is a transport-level teardown marker, NOT an
 * A2UI message, so the A2UI adapter accepts it verbatim. Any
 * non-null, non-undefined payload runs through the full A2UI validator.
 */
function a2uiPreviewValidator(payload: unknown): ValidationResult {
  // Live-channel teardown sentinel — see JSDoc above.
  if (payload === null || payload === undefined) {
    return { valid: true, violations: [] };
  }
  const parsed: ServerMessageParseResult = parseServerMessage(payload);
  if (parsed.ok) return { valid: true, violations: [] };
  const violations: ContractViolation[] = parsed.issues.map((issue) => ({
    field: issue.path.length === 0 ? 'payload' : `payload.${issue.path.join('.')}`,
    message: issue.message,
    expected: 'A2UI ServerMessage (v0.9 write-path union)',
    received: 'malformed',
  }));
  // If Zod produced no issues (defensive — safe-parse always surfaces
  // at least one on failure), synthesize a single catch-all violation
  // so callers still see a rejection reason.
  if (violations.length === 0) {
    violations.push({
      field: 'payload',
      message: 'A2UI preview payload did not match the V1 write-path union',
      expected: 'A2UI ServerMessage (v0.9)',
      received: 'malformed',
    });
  }
  return { valid: false, violations };
}

/**
 * Returns a reserved-validator map binding `_ggui:preview` to the A2UI
 * adapter. Single-entry by design — each reserved channel gets its own
 * validator; consumers that want to compose more should call
 * {@link mergeReservedValidators}.
 *
 * No parameters today. When the A2UI V1 subset widens (e.g.
 * `updateDataModel`), the adapter follows `parseServerMessage` without
 * touching this export.
 */
export function composePreviewReservedValidator(): ReadonlyMap<
  string,
  ReservedChannelValidator
> {
  return new Map([[PREVIEW_CHANNEL, a2uiPreviewValidator as ReservedChannelValidator]]);
}

/**
 * Merge two reserved-validator maps into one. Keys present in
 * `override` WIN on conflict — the pattern is "server supplies
 * defaults (A2UI), caller may replace by key".
 *
 * Returns a `ReadonlyMap` so the composed result has the same
 * immutability guarantee as the individual inputs.
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
