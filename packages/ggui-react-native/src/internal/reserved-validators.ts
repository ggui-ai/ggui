/**
 * Client-side reserved-channel payload validator composition
 * (mirror of `@ggui-ai/react::internal/reserved-validators.ts` + the
 * server-side composer in `@ggui-ai/mcp-server::reserved-validators.ts`).
 *
 * `GguiSession` composes this and threads it through
 * `validateInboundStreamPayload`'s `extraReservedValidators`
 * parameter — so malformed `_ggui:preview` frames that sneak past the
 * server's outbound fan-out (or arrive from a third-party ggui
 * implementation without server-side validation) still reject at the
 * native-client receipt boundary instead of landing in
 * `ProvisionalRenderer`.
 *
 * `@ggui-ai/protocol` stays vendor-neutral per Protocol #6 — this
 * composer lives here because that's where the A2UI dep graph is
 * allowed (react-native ships preview-a2ui as a prod dep).
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
 * Adapt `parseServerMessage` into the `ReservedChannelValidator` shape.
 * Accepts `null` / `undefined` payloads as live-channel teardown
 * sentinels (the preview runner emits `{payload: null, complete: true}`
 * on every exit path); non-sentinel payloads run the A2UI validator.
 */
function a2uiPreviewValidator(payload: unknown): ValidationResult {
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
 * adapter. Single-entry by design.
 */
export function composePreviewReservedValidator(): ReadonlyMap<
  string,
  ReservedChannelValidator
> {
  return new Map([[PREVIEW_CHANNEL, a2uiPreviewValidator as ReservedChannelValidator]]);
}

/**
 * Merge two reserved-validator maps. `override` keys WIN on conflict.
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
