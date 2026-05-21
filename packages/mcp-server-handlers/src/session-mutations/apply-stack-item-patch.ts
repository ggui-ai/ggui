/**
 * Pure stack-mutation flow: find the target stack item, compute the
 * new props map (full replace OR RFC 7396 merge), assert the props
 * contract against the FINAL state, return the new stack. Mirrors
 * the semantics the OSS + cloud `ggui_update` handlers route through.
 *
 * Pure + seam-free:
 *   - input is a typed `StackItem[]` snapshot
 *   - output is a typed `StackItem[]` snapshot
 *   - no SessionStore, no DDB, no WebSocket delivery — the caller
 *     (hosted pod / OSS handler) owns the read-modify-write
 *     persistence and any live-delivery side-effects
 *
 * Throws:
 *   - `StackItemNotFoundError` when no stack item has `id === stackItemId`
 *   - `ContractViolationError` (tool='ggui_update') when the existing
 *     stack item carries a propsSpec and the FINAL props (post-merge
 *     for `merge`) fail validation
 *
 * The caller is expected to have already narrowed its raw DB rows
 * into `StackItem[]` — DB-shape sanity checks stay hosted-specific.
 */
import type { JsonObject, JsonValue, PropsSpec } from '@ggui-ai/protocol';
import { StackItemNotFoundError } from './errors.js';
import { assertPropsContract } from './assert-props-contract.js';

/**
 * Minimum shape the helper needs to find + validate + patch a stack
 * item. Both `@ggui-ai/protocol`'s `StackItem` and the hosted pod's
 * raw DDB row projection satisfy this shape, so the helper works for
 * both without either caller needing a cast. The generic `T` carries
 * through so the returned stack preserves the caller's concrete item
 * type. `props` is included so the merge path can read the existing
 * state before computing the next.
 */
export interface StackItemTarget {
  readonly id: string;
  readonly propsSpec?: PropsSpec;
  readonly props?: JsonObject;
}

export type ApplyStackItemPatchInput<T extends StackItemTarget> =
  | {
      readonly stack: ReadonlyArray<T>;
      readonly stackItemId: string;
      readonly mode: 'replace';
      readonly props: JsonObject;
    }
  | {
      readonly stack: ReadonlyArray<T>;
      readonly stackItemId: string;
      readonly mode: 'merge';
      readonly patch: JsonObject;
    };

export interface ApplyStackItemPatchResult<T extends StackItemTarget> {
  /** New stack with the targeted item replaced. Safe to persist. */
  readonly stack: T[];
  /** The updated item (post-patch) for callers that need it directly. */
  readonly updatedItem: T;
  /** Index of the updated item within the returned stack. */
  readonly updatedIndex: number;
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

export function applyStackItemPatch<T extends StackItemTarget>(
  input: ApplyStackItemPatchInput<T>,
): ApplyStackItemPatchResult<T> {
  const { stack, stackItemId } = input;
  const index = stack.findIndex((item) => item.id === stackItemId);
  if (index === -1) {
    throw new StackItemNotFoundError(
      `Page not found: ${stackItemId}. Declared page ids: [${stack
        .map((item) => item.id)
        .join(', ')}]`,
    );
  }

  const existing = stack[index];
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
  // top. Cast is required because TS can't prove {...T, props:
  // JsonObject} is T (T's own props type isn't constrained here),
  // but structurally it is.
  const updatedItem = { ...existing, props: finalProps } as unknown as T;
  const nextStack = [...stack];
  nextStack[index] = updatedItem;

  return {
    stack: nextStack,
    updatedItem,
    updatedIndex: index,
    finalProps,
  };
}
