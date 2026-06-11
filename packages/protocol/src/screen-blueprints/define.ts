/**
 * `defineScreenBlueprint()` — authoring helper.
 *
 * Pass-through identity function. Exists purely to give IDE autocomplete
 * and type-checking on a deployment's blueprint manifest files (the
 * hand-authored screen-blueprint catalog).
 *
 * The helper is narrow by design — it preserves the literal type of the
 * blueprint so consumers can do precise inference (e.g. a future typed
 * seeder that knows which prop names exist in which blueprint).
 *
 * @example
 * ```ts
 * export default defineScreenBlueprint({
 *   id: "plan-my-week",
 *   ...
 * });
 * ```
 */
import type { ScreenBlueprint } from "./types.js";

export function defineScreenBlueprint<const T extends ScreenBlueprint>(blueprint: T): T {
  return blueprint;
}
