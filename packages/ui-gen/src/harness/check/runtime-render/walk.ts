/**
 * The action walk (ggui#1652): find a control that dispatches one action by
 * walking the card's screens, as a person would, in a mount of its own.
 *
 * A screen is the card's set of controls, told apart by each control's tag,
 * type, label (its aria-label, placeholder or text) and disabled state, never
 * by typed values, selection or generated names.
 * Picking an answer is the same screen unless it enables or disables a
 * control; a wizard's next step, or an Edit button that now reads Save, is a
 * new one. Each control is pressed once per screen. When every control on
 * the current screen has been pressed, the walk returns over controls it has
 * already pressed to the nearest screen that still has one to press. A press
 * that leads back to a screen already seen is not progress, so Back and Next
 * cannot loop, in any language. The walk stops at the first press that
 * dispatches the action, when every reachable control has been pressed, at
 * a cap on presses, or at its deadline. Neither the cap nor the deadline
 * stops it while it is on the first screen with a control there still
 * unpressed; once a press leaves the first screen both apply, and a
 * first-screen control left unpressed is pressed only if a known route
 * leads back to it (a one-way wizard has none).
 */
import type { MinimalElement } from "./host-boundary.js";

/** One control the walk can press, and how. */
export interface WalkControl {
  readonly element: MinimalElement;
  /** Whether the control names the action (its label, aria-label or `data-action`). */
  readonly namesAction: boolean;
}

/** A fresh copy of the card, and how to fill its screen's empty form controls. */
export interface WalkMount {
  readonly container: MinimalElement;
  /** Fill the current screen's empty form controls; filled ones are left as they are. */
  readonly prime: () => void;
}

export interface WalkInput<C extends WalkControl> {
  /** Mount a fresh copy of the card; undefined when it cannot be mounted. */
  readonly mount: () => Promise<WalkMount | undefined>;
  /** The screen's controls, in the order they are tried. */
  readonly controls: (container: MinimalElement) => readonly C[];
  /** Press one control; true when the press dispatched the action. */
  readonly press: (control: C) => Promise<boolean>;
  readonly describe: (el: MinimalElement) => string;
  /** Epoch ms after which no further press is made. */
  readonly stopAt: number;
  readonly maxPresses: number;
}

export type WalkStop = "dispatched" | "explored" | "press-cap" | "deadline" | "no-mount";

export interface WalkOutcome {
  readonly fired: boolean;
  /** The control whose press dispatched the action, and the mount it is in. */
  readonly element?: MinimalElement;
  readonly container?: MinimalElement;
  readonly presses: number;
  readonly screens: number;
  readonly stoppedBy: WalkStop;
  /** Whether any screen rendered a control that names the action. */
  readonly namedControlSeen: boolean;
  /** The last few controls pressed, oldest first. */
  readonly lastPressed: readonly string[];
  /** The text of every screen the walk reached, once each, in the order reached. */
  readonly screenTexts: readonly string[];
}

/** How many of the last presses an outcome keeps. */
const LAST_PRESSED_KEPT = 4;

function isDisabled(el: MinimalElement): boolean {
  return el.getAttribute("disabled") !== null || el.getAttribute("aria-disabled") === "true";
}

/**
 * A control's label for the fingerprint. Never its `name` or `id`: React
 * generates those (`useId`) afresh when a step re-mounts, so a screen keyed
 * on them would look new on every return and the walk would loop on it.
 */
function labelOf(el: MinimalElement): string {
  const named = el.getAttribute("aria-label") ?? el.getAttribute("placeholder");
  return (named ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** The screen's identity: its controls' structure and disabled state, in document order. */
export function screenFingerprint(container: MinimalElement): string {
  const parts: string[] = [];
  for (const el of container.querySelectorAll(
    'button, [role="button"], a[href], input, select, textarea, form'
  )) {
    parts.push(
      [el.tagName.toLowerCase(), el.getAttribute("type") ?? "", labelOf(el), isDisabled(el) ? "disabled" : ""].join("|")
    );
  }
  return parts.join("\n");
}

interface Screen {
  /** Each control's key, in try order. */
  readonly order: readonly string[];
  /** A pressed control's key → the screen its press led to. */
  readonly led: Map<string, string>;
}

/** Each control's key on a screen: its description, numbered among controls described alike. */
function keyed<C extends WalkControl>(controls: readonly C[], describe: (el: MinimalElement) => string): Map<string, C> {
  const seen = new Map<string, number>();
  const out = new Map<string, C>();
  for (const c of controls) {
    const d = describe(c.element);
    const n = seen.get(d) ?? 0;
    seen.set(d, n + 1);
    out.set(`${d}#${n}`, c);
  }
  return out;
}

/** The first press of the shortest known route to a screen with a control not yet pressed. */
function firstStepToUnpressed(screens: ReadonlyMap<string, Screen>, from: string): string | undefined {
  const firstStep = new Map<string, string | undefined>([[from, undefined]]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const screen = screens.get(at);
    if (screen === undefined) continue;
    if (at !== from && screen.order.some((k) => !screen.led.has(k))) return firstStep.get(at);
    for (const [key, to] of screen.led) {
      if (to === at || firstStep.has(to)) continue;
      firstStep.set(to, firstStep.get(at) ?? key);
      queue.push(to);
    }
  }
  return undefined;
}

export async function walkToAction<C extends WalkControl>(input: WalkInput<C>): Promise<WalkOutcome> {
  const lastPressed: string[] = [];
  const screenTexts: string[] = [];
  const screens = new Map<string, Screen>();
  let presses = 0;
  let namedControlSeen = false;
  const outcome = (stoppedBy: WalkStop, extra: Partial<WalkOutcome> = {}): WalkOutcome => ({
    fired: false,
    presses,
    screens: screens.size,
    stoppedBy,
    namedControlSeen,
    lastPressed: [...lastPressed],
    screenTexts: [...screenTexts],
    ...extra,
  });

  const mounted = await input.mount();
  if (mounted === undefined) return outcome("no-mount");
  const { container } = mounted;

  const arrive = (): { id: string; controls: Map<string, C> } => {
    mounted.prime();
    const controls = keyed(input.controls(container), input.describe);
    if ([...controls.values()].some((c) => c.namesAction)) namedControlSeen = true;
    const id = screenFingerprint(container);
    if (!screens.has(id)) {
      screens.set(id, { order: [...controls.keys()], led: new Map() });
      screenTexts.push(container.textContent ?? "");
    }
    return { id, controls };
  };

  let here = arrive();
  const first = here.id;
  for (;;) {
    const screen = screens.get(here.id)!;
    const onOpenFirstScreen = here.id === first && screen.order.some((k) => !screen.led.has(k));
    if (!onOpenFirstScreen) {
      if (presses >= input.maxPresses) return outcome("press-cap");
      if (Date.now() >= input.stopAt) return outcome("deadline");
    }
    const key = screen.order.find((k) => !screen.led.has(k)) ?? firstStepToUnpressed(screens, here.id);
    if (key === undefined) return outcome("explored");
    const control = here.controls.get(key);
    if (control === undefined) {
      // Listed when the screen was first seen, gone now: nothing to press.
      // It now leads nowhere, which a route never takes, so this cannot
      // pick the same control again.
      screen.led.set(key, here.id);
      continue;
    }
    presses += 1;
    lastPressed.push(input.describe(control.element));
    if (lastPressed.length > LAST_PRESSED_KEPT) lastPressed.shift();
    if (await input.press(control)) {
      return outcome("dispatched", { fired: true, element: control.element, container });
    }
    here = arrive();
    // The first press records where a control leads; a route that later
    // leads elsewhere is simply followed on from where it led.
    if (!screen.led.has(key)) screen.led.set(key, here.id);
  }
}
