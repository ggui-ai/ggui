/**
 * Throw-on-violation wrapper around `validatePropsData`. Mirrors the
 * inline pattern that ggui_update's hosted handler used to hand-roll.
 *
 * Contract:
 *   - `spec === undefined` → no-op (matches legacy ggui_update: missing
 *     propsSpec is permissive, no validation runs).
 *   - Otherwise validate; on failure throw `ContractViolationError` with
 *     tool=`'ggui_update'` so error shape matches the existing protocol
 *     response envelope.
 *
 * This helper is the centralized enforcement point for props contracts —
 * every mutation path that applies new props to a render SHOULD go
 * through it, so an added call site doesn't drift on error shape or
 * bypass validation entirely.
 */
import {
  ContractViolationError,
  validatePropsData,
  type PropsSpec,
} from '@ggui-ai/protocol';

export function assertPropsContract(
  spec: PropsSpec | undefined,
  patch: Record<string, unknown>,
): void {
  if (!spec) return;
  const result = validatePropsData(patch, spec);
  if (!result.valid) {
    throw new ContractViolationError({
      tool: 'ggui_update',
      violations: result.violations,
    });
  }
}
