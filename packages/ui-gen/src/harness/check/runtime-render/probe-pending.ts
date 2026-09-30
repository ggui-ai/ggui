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
 * the optional `isConnected` a live DOM node carries, and an input's live
 * `value` (an `<input type="submit">` shows its label through it).
 */
export interface LookableElement {
  readonly tagName?: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  readonly isConnected?: boolean;
  readonly value?: unknown;
}

export function lookOf(el: LookableElement): ControlLook {
  return {
    connected: el.isConnected !== false,
    // React renders `disabled={true}` as `disabled=""`, so presence is the test.
    disabled: el.getAttribute("disabled") !== null || el.getAttribute("aria-disabled") === "true",
    ariaBusy: el.getAttribute("aria-busy") === "true",
    text:
      el.tagName?.toLowerCase() === "input"
        ? String(typeof el.value === "string" ? el.value : (el.getAttribute("value") ?? ""))
        : (el.textContent ?? ""),
  };
}

/**
 * Whether `work` settles within `ms`. It never cancels `work`; it only stops
 * waiting for it, so a phase can give up on a card that stalls.
 */
export async function settlesWithin(ms: number, work: Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([work.then(() => true), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
