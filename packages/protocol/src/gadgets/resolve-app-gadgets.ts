import type { GadgetDescriptor } from '../types/data-contract';
import { STDLIB_GADGETS } from './stdlib-gadgets';
function dedupeByPackage(list: readonly GadgetDescriptor[]): readonly GadgetDescriptor[] {
  const m = new Map<string, GadgetDescriptor>();
  for (const g of list) m.set(g.package, g);
  return [...m.values()];
}
/**
 * Resolve an app's effective gadget set: the first-party stdlib package is the
 * structural FLOOR, and `declared` (app-declared extensions) layers on top.
 * Replaces the legacy fallback-when-absent resolution that dropped the stdlib
 * package the moment an app declared any extension. `declared` wins on a
 * `package` collision; absent/empty ⇒ exactly the stdlib set; idempotent.
 */
export function resolveAppGadgets(
  declared?: readonly GadgetDescriptor[] | null,
): readonly GadgetDescriptor[] {
  if (!declared || declared.length === 0) return STDLIB_GADGETS;
  return dedupeByPackage([...STDLIB_GADGETS, ...declared]);
}
