/**
 * Throw-on-violation wrapper around `validateStreamData`. Mirrors the
 * inline pattern that ggui_emit's hosted handler used to hand-roll.
 *
 * Signature matches the {@link StreamEnvelope} wire shape — channel
 * name + payload are the explicit envelope fields the sender provides.
 *
 * Contract:
 *   - Reserved-channel (`_ggui:*`) payloads ALWAYS validate — regardless
 *     of whether a user streamSpec is declared. The reserved-channel
 *     payload check runs through `validateStreamData`'s two-tier
 *     lookup (extras + builtins per Item 4 injection pattern), so a
 *     render without any user streamSpec still rejects malformed
 *     `_ggui:contract-error` / `_ggui:preview` emissions.
 *   - User channels: `spec === undefined` → no-op (missing streamSpec
 *     is permissive; nothing to enforce at this boundary). Otherwise
 *     validate channel is declared + payload conforms; on failure
 *     throw `ContractViolationError` with tool=`'ggui_emit'`.
 *
 * Used on the hosted fan-out path (`handle-data.ts`), the OSS `/ws`
 * fan-out (`sendToRender`), and the `ggui_emit` tool handler.
 * Channel semantics (mode / replay / complete) are NOT validated here
 * — see `resolveStreamChannel` for semantics lookup.
 */
import {
  ContractViolationError,
  isKnownReservedChannel,
  validateStreamData,
  type ReservedChannelValidator,
  type StreamSpec,
} from '@ggui-ai/protocol';

export function assertStreamContract(
  spec: StreamSpec | undefined,
  channelName: string,
  payload: unknown,
  extraReservedValidators?: ReadonlyMap<string, ReservedChannelValidator>,
): void {
  // Reserved channels validate even without a user streamSpec — the
  // payload shape is server-owned (or injected), so missing user
  // contract is not a reason to skip. An empty StreamSpec `{}` gives
  // `validateStreamData` a defined (empty) spec to consult; the
  // reserved-channel branch inside the validator takes precedence and
  // runs the two-tier lookup before the declared-channel check fires.
  if (isKnownReservedChannel(channelName)) {
    const result = validateStreamData(channelName, payload, spec ?? {}, extraReservedValidators);
    if (!result.valid) {
      throw new ContractViolationError({
        tool: 'ggui_emit',
        violations: result.violations,
      });
    }
    return;
  }
  if (!spec) return;
  const result = validateStreamData(channelName, payload, spec, extraReservedValidators);
  if (!result.valid) {
    throw new ContractViolationError({
      tool: 'ggui_emit',
      violations: result.violations,
    });
  }
}
