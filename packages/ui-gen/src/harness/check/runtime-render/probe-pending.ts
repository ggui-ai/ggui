/**
 * ggui#1398 leg 3 — the render check's stand-in for the runtime's pending
 * state, and the rule for "the control visibly changed".
 *
 * In a served card, the runtime marks an action pending when the card's
 * dispatch of it commits, and clears it when the session's next frame lands;
 * `useActionPending` reads that state through wire's `ActionPendingContext`.
 * The probe has no transport and no next frame, so it marks an action pending
 * right after its own synthetic click really fired the action, looks at the
 * clicked control, then clears it: one dispatch, one answer.
 */
import type { ActionPendingSource } from "@ggui-ai/wire";

/** An {@link ActionPendingSource} the probe drives by hand. */
export interface ProbePendingSource extends ActionPendingSource {
  /** Mark `actionName` pending and notify subscribers. */
  mark(actionName: string): void;
  /** Clear every pending action (the "answer landed"), notifying only if something was pending. */
  clear(): void;
}

export function createProbePendingSource(): ProbePendingSource {
  const pending = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    isPending: (actionName) => pending.has(actionName),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mark: (actionName) => {
      pending.add(actionName);
      notify();
    },
    clear: () => {
      if (pending.size === 0) return;
      pending.clear();
      notify();
    },
  };
}

/** What a control shows, for a before/after comparison around a dispatch. */
export interface ControlLook {
  /** Still in the document; `false` when the card replaced the control. */
  readonly connected: boolean;
  /** `disabled`, or `aria-disabled="true"`. */
  readonly disabled: boolean;
  /** `aria-busy="true"`. */
  readonly ariaBusy: boolean;
  /** The control's text. */
  readonly text: string;
}

/**
 * The DOM surface {@link lookOf} reads: the probe's `MinimalElement` plus
 * the optional `isConnected` a live DOM node carries.
 */
export interface LookableElement {
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  readonly isConnected?: boolean;
}

export function lookOf(el: LookableElement): ControlLook {
  return {
    connected: el.isConnected !== false,
    // React renders `disabled={true}` as `disabled=""`, so presence is the test.
    disabled: el.getAttribute("disabled") !== null || el.getAttribute("aria-disabled") === "true",
    ariaBusy: el.getAttribute("aria-busy") === "true",
    text: el.textContent ?? "",
  };
}

/**
 * Whether the control visibly changed between two looks: it became disabled
 * or busy, its text changed (whitespace aside), or the card replaced it.
 */
export function lookChanged(before: ControlLook, after: ControlLook): boolean {
  if (before.connected && !after.connected) return true;
  if (!before.disabled && after.disabled) return true;
  if (!before.ariaBusy && after.ariaBusy) return true;
  return before.text.trim() !== after.text.trim();
}
