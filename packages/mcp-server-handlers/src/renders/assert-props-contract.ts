/**
 * Throw-on-violation wrapper around `validatePropsData`. Mirrors the
 * inline pattern that ggui_update's hosted handler used to hand-roll.
 *
 * Contract:
 *   - `spec === undefined` → no-op (matches legacy ggui_update: missing
 *     propsSpec is permissive, no validation runs).
 *   - Otherwise validate; on failure throw `ContractViolationError`
 *     attributed to the calling tool (`ggui_update` by default —
 *     `ggui_amend` threads its own name, #483) so the error envelope
 *     names the tool the agent actually called.
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
  tool: 'ggui_update' | 'ggui_amend' = 'ggui_update',
): void {
  if (!spec) return;
  const result = validatePropsData(patch, spec);
  if (!result.valid) {
    throw new ContractViolationError({
      tool,
      violations: result.violations,
    });
  }
}
