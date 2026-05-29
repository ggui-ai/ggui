/**
 * Pure line-pricing + modifier validation, shared by `seed.ts` and
 * `service.ts` so a line's total can never drift between the two.
 *
 * Validates that every selected modifier references a real group/option
 * and that single-select groups aren't chosen more than once, then
 * returns the line total in integer cents: (base + Σ option deltas) × qty.
 */
import type { ModifierGroup, SelectedOption } from './types.js';
import { ValidationError } from './types.js';

export interface Priceable {
  readonly priceCents: number;
  readonly options: readonly ModifierGroup[];
}

export function priceLine(
  item: Priceable,
  selectedOptions: readonly SelectedOption[],
  qty: number,
): number {
  if (!Number.isInteger(qty) || qty < 1) {
    throw new ValidationError('qty must be a positive integer');
  }
  const perGroupCount = new Map<string, number>();
  let unitCents = item.priceCents;
  for (const sel of selectedOptions) {
    const group = item.options.find((g) => g.id === sel.groupId);
    if (!group) throw new ValidationError(`unknown modifier group "${sel.groupId}"`);
    const opt = group.options.find((o) => o.id === sel.optionId);
    if (!opt) {
      throw new ValidationError(`unknown option "${sel.optionId}" in group "${sel.groupId}"`);
    }
    const count = (perGroupCount.get(group.id) ?? 0) + 1;
    perGroupCount.set(group.id, count);
    if (!group.multi && count > 1) {
      throw new ValidationError(`modifier group "${group.id}" allows only one choice`);
    }
    unitCents += opt.priceDeltaCents;
  }
  return unitCents * qty;
}
