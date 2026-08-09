import type { GadgetDescriptor } from '../types/data-contract';
import { STDLIB_GADGETS } from './stdlib-gadgets';
function dedupeByPackage(list: readonly GadgetDescriptor[]): readonly GadgetDescriptor[] {
  const m = new Map<string, GadgetDescriptor>();
  for (const g of list) m.set(g.package, g);
  return [...m.values()];
}
/**
 * Resolve an app's effective gadget set from its three sources, in
 * ascending precedence: the first-party stdlib package is the
 * structural FLOOR, `installed` (rows added through the host's install
 * surface) layers on top of it, and `declared` (app-declared extensions
 * from the app's own config) wins over both. Later wins on a `package`
 * collision — declared beats installed beats floor, because the app's
 * own config is the operator's explicit source of truth and must not be
 * silently shadowed by an install performed elsewhere.
 *
 * Absent/empty sources ⇒ exactly the stdlib set; idempotent over
 * already-resolved input.
 */
export function resolveAppGadgets(
  declared?: readonly GadgetDescriptor[] | null,
  installed?: readonly GadgetDescriptor[] | null,
): readonly GadgetDescriptor[] {
  if ((!declared || declared.length === 0) && (!installed || installed.length === 0)) {
    return STDLIB_GADGETS;
  }
  return dedupeByPackage([
    ...STDLIB_GADGETS,
    ...(installed ?? []),
    ...(declared ?? []),
  ]);
}
