/**
 * Pure render-mutation flow: compute the new props map (full replace
 * OR RFC 7396 merge), assert the props contract against the FINAL
 * state, return the updated render. Mirrors the semantics the OSS +
 * cloud `ggui_update` handlers route through.
 *
 * Post-Phase-B (flatten-render-identity): the prior
 * `applyStackItemPatch({stack, stackItemId, …})` worked over a vessel
 * holding an array of entries. Every "stack" was length-one
 * post-Phase-A, and Phase-B deletes the vessel — there is no array
 * here, only a single render. The find-by-id step is gone; the caller
 * has already resolved the target render via `renderStore.get()`.
 *
 * Pure + seam-free:
 *   - input is a single typed render snapshot
 *   - output is the updated render snapshot
 *   - no GguiSessionStore, no DDB, no WebSocket delivery — the caller
 *     (hosted pod / OSS handler) owns the read-modify-write
 *     persistence and any live-delivery side-effects
 *
 * Throws:
 *   - `ContractViolationError` (tool='ggui_update') when the existing
 *     render carries a propsSpec and the FINAL props (post-merge for
 *     `merge`) fail validation
 *
 * The caller is expected to have already narrowed its raw DB row into
 * a `GguiSessionTarget` — DB-shape sanity checks stay hosted-specific.
 */
import type { JsonObject, JsonValue, PropsSpec } from '@ggui-ai/protocol';
import { assertPropsContract } from './assert-props-contract.js';

/**
 * Minimum shape the helper needs to validate + patch a render. Both
 * `@ggui-ai/protocol`'s `ComponentGguiSession` and the hosted pod's raw DDB
 * projection satisfy this shape, so the helper works for both without
 * either caller needing a cast. The generic `T` carries through so the
 * returned render preserves the caller's concrete type. `props` is
 * included so the merge path can read the existing state before
 * computing the next.
 */
export interface GguiSessionTarget {
  readonly id: string;
  readonly propsSpec?: PropsSpec;
  readonly props?: JsonObject;
}

export type ApplyGguiSessionPatchInput<T extends GguiSessionTarget> =
  | {
      readonly render: T;
      readonly mode: 'replace';
      readonly props: JsonObject;
    }
  | {
      readonly render: T;
      readonly mode: 'merge';
      readonly patch: JsonObject;
    };

export interface ApplyGguiSessionPatchResult<T extends GguiSessionTarget> {
  /** The updated render (post-patch). Safe to persist. */
  readonly updatedSession: T;
  /** The final props map applied (post-merge for `mode:'merge'`). */
  readonly finalProps: JsonObject;
}

/**
 * Apply an RFC 7396 (JSON Merge Patch) `patch` to `target` and return
 * the merged result without mutating either input. Pure, recursive.
 *
 * Rules:
 *   - For each key in `patch`:
 *     - If `patch[key] === null`: delete that key from the result.
 *     - Else if both `target[key]` and `patch[key]` are non-array
 *       objects: recursively merge.
 *     - Else: `patch[key]` replaces `target[key]` outright (arrays
 *       fully replace per RFC 7396 — element-wise merge is out of
 *       spec).
 *
 * Keys present in `target` but absent from `patch` carry through
 * unchanged.
 *
 * @public — exported for handler tests + cross-impl conformance.
 */
export function applyMergePatch(
  target: JsonObject,
  patch: JsonObject,
): JsonObject {
  const result: JsonObject = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    const existing = result[key];
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      result[key] = applyMergePatch(
        existing as JsonObject,
        value as JsonObject,
      );
    } else {
      result[key] = value as JsonValue;
    }
  }
  return result;
}

export function applyGguiSessionPatch<T extends GguiSessionTarget>(
  input: ApplyGguiSessionPatchInput<T>,
): ApplyGguiSessionPatchResult<T> {
  const existing = input.render;

  // Compute the FINAL props map. For `replace` it's just the new map;
  // for `merge` we apply RFC 7396 against the current state.
  const finalProps: JsonObject =
    input.mode === 'replace'
      ? input.props
      : applyMergePatch(existing.props ?? {}, input.patch);

  // Validate the FINAL state — required fields, type-correctness,
  // unknown-key strictness. For merge mode, this catches the case
  // where the patch's null-delete would orphan a required field, or
  // a recursive merge would introduce an undeclared key.
  assertPropsContract(existing.propsSpec, finalProps);

  // Spread preserves T's other fields; the `props` override lands on
  // top. The spread infers `T & { props: JsonObject }`, which is
  // assignable to `T` — no cast needed.
  const updatedSession: T = { ...existing, props: finalProps };

  return {
    updatedSession,
    finalProps,
  };
}
