/**
 * Throw-on-violation wrapper around `validateActionData`. Mirrors the
 * inline pattern the hosted websocket ingress (`handle-event.ts`) used to
 * hand-roll for live-channel inbound action validation.
 *
 * Contract:
 *   - `spec === undefined` → no-op (no actionSpec declared on the stack
 *     item = no contract to enforce; legacy pushes without actionSpec
 *     keep flowing).
 *   - Otherwise validate the full ActionEventValue shape
 *     (`{ action, data?, tool? }`); on failure throw
 *     `ContractViolationError` with tool=`'ggui_event'` so the hosted
 *     ingress can surface `toErrorData()` to the offending client.
 *
 * Centralizing here means OSS's future live-channel endpoint can reuse the
 * exact same enforcement primitive with zero code duplication.
 */
import {
  ContractViolationError,
  validateActionData,
  type ActionSpec,
} from '@ggui-ai/protocol';

export function assertActionContract(
  spec: ActionSpec | undefined,
  value: unknown,
): void {
  if (!spec) return;
  const result = validateActionData(value, spec);
  if (!result.valid) {
    throw new ContractViolationError({
      tool: 'ggui_event',
      violations: result.violations,
    });
  }
}
