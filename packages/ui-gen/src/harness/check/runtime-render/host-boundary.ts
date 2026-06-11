// packages/ui-gen/src/harness/check/runtime-render/host-boundary.ts
//
// The ONE narrowing seam between the render-check pipeline and its
// host runtime: happy-dom elements, @testing-library/react containers,
// and the @testing-library/user-event module. Each export is either a
// runtime-validated guard (throws a descriptive error on violation) or
// a single documented structural view (all-optional facet of the same
// live object), so the check pipeline's call sites stay cast-free.
//
// Deliberately DOM-lib-free: some downstream tsconfigs (e.g.
// cloud/amplify) exclude the DOM lib, so this module declares the
// minimal structural surfaces it needs instead of importing
// `HTMLElement` / `Element` types.

import { openRecord } from "../../../internal/open-record.js";

/**
 * Minimal structural view of a rendered DOM element — the only element
 * surface the checks read.
 */
export interface MinimalElement {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll<T extends MinimalElement = MinimalElement>(selector: string): Iterable<T>;
}

/** The one user-gesture surface the checks drive. */
export interface ClickUser {
  readonly click: (el: MinimalElement) => Promise<void>;
}

/**
 * All-optional form-control facet of an element. Used by the synthetic
 * change-value writer; absent properties are tolerated by all readers
 * and writers.
 */
export interface EditableSurface {
  value?: string;
  checked?: boolean;
  type?: string;
  options?: ArrayLike<{ value: string }>;
}

/** All-optional tree-climbing facet (closest-form lookup). */
export interface ParentLink {
  readonly tagName?: string;
  readonly parentNode?: unknown;
}

/** Look up a method on an arbitrary host object, bound to it. */
function getMethod(
  o: unknown,
  name: string,
): ((...args: unknown[]) => unknown) | undefined {
  if (typeof o !== "object" && typeof o !== "function") return undefined;
  if (o === null) return undefined;
  const v = openRecord(o)[name];
  if (typeof v !== "function") return undefined;
  return (v as (...args: unknown[]) => unknown).bind(o);
}

/**
 * Validating narrower: host element (RTL container, climbed parent
 * node) → {@link MinimalElement}. Throws when the value lacks the
 * element surface — a violation of the happy-dom/RTL boundary
 * contract, not a check failure.
 */
export function toMinimalElement(v: unknown): MinimalElement {
  if (
    typeof v === "object" &&
    v !== null &&
    typeof openRecord(v).tagName === "string" &&
    typeof openRecord(v).getAttribute === "function" &&
    typeof openRecord(v).querySelectorAll === "function"
  ) {
    // Runtime-checked above; the remaining gap (exact method
    // signatures) is the structural boundary this module owns.
    return v as MinimalElement;
  }
  throw new Error(
    "[runtime-render] host value lacks the element surface (tagName/getAttribute/querySelectorAll)",
  );
}

/**
 * Validating narrower over the `@testing-library/user-event` module:
 * prefers the v14 `setup()` instance, falls back to the module-level
 * `click` (pre-v14 shape). Throws when neither surface exists.
 */
export function buildClickUser(userEventModule: unknown): ClickUser {
  const setup = getMethod(userEventModule, "setup");
  const instance: unknown = setup ? setup() : userEventModule;
  const click = getMethod(instance, "click");
  if (!click) {
    throw new Error(
      "[runtime-render] user-event module exposes neither setup().click nor click()",
    );
  }
  return {
    click: async (el: MinimalElement): Promise<void> => {
      await click(el);
    },
  };
}

/**
 * Validating narrower: element → its `dispatchEvent` surface. Returns
 * the live method (bound), so dispatch hits the real element.
 */
export function toEventDispatcher(el: MinimalElement): {
  dispatchEvent: (ev: Event) => void;
} {
  const dispatch = getMethod(el, "dispatchEvent");
  if (!dispatch) {
    throw new Error(
      `[runtime-render] element <${el.tagName.toLowerCase()}> has no dispatchEvent`,
    );
  }
  return {
    dispatchEvent: (ev: Event): void => {
      dispatch(ev);
    },
  };
}

/**
 * View an element as its all-optional form-control facet. Returns the
 * SAME reference (writes must land on the live element); the facet is
 * all-optional, so every reader/writer already tolerates absence —
 * there is nothing to validate at runtime.
 */
export function editableSurface(el: object): EditableSurface {
  return el as EditableSurface;
}

/** View a host node as its all-optional tree-climbing facet. */
export function parentLink(node: object): ParentLink {
  return node as ParentLink;
}
