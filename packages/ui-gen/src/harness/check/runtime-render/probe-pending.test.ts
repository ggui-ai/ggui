/**
 * ggui#1398 leg 3 — the probe's pending source and the "did the control
 * visibly change" rule, as pure pieces.
 */
import { describe, expect, it } from "vitest";
import { createProbePendingSource, lookChanged, lookOf, type ControlLook } from "./probe-pending";

describe("createProbePendingSource (ggui#1398)", () => {
  it("an action is pending once marked, until cleared, and nothing else is", () => {
    const source = createProbePendingSource();
    expect(source.isPending("send")).toBe(false);
    source.mark("send");
    expect(source.isPending("send")).toBe(true);
    expect(source.isPending("cancel")).toBe(false);
    source.clear();
    expect(source.isPending("send")).toBe(false);
  });

  it("notifies subscribers on mark and on clear, and stops after unsubscribe", () => {
    const source = createProbePendingSource();
    let calls = 0;
    const off = source.subscribe(() => {
      calls += 1;
    });
    source.mark("send");
    source.clear();
    expect(calls).toBe(2);
    off();
    source.mark("send");
    expect(calls).toBe(2);
  });

  it("clearing with nothing pending notifies no one", () => {
    const source = createProbePendingSource();
    let calls = 0;
    source.subscribe(() => {
      calls += 1;
    });
    source.clear();
    expect(calls).toBe(0);
  });
});

describe("lookChanged (ggui#1398)", () => {
  const idle: ControlLook = { connected: true, disabled: false, ariaBusy: false, text: "Send" };

  it("an unchanged control did not visibly change", () => {
    expect(lookChanged(idle, { ...idle })).toBe(false);
  });

  it.each<[string, Partial<ControlLook>]>([
    ["became disabled", { disabled: true }],
    ["became aria-busy", { ariaBusy: true }],
    ["changed its text", { text: "Sending…" }],
    ["was replaced (detached)", { connected: false }],
  ])("a control that %s visibly changed", (_label, after) => {
    expect(lookChanged(idle, { ...idle, ...after })).toBe(true);
  });

  it("text compares trimmed, so whitespace alone is not a change", () => {
    expect(lookChanged(idle, { ...idle, text: "  Send\n" })).toBe(false);
  });

  it("a control that was already disabled and stays disabled did not change", () => {
    const busy: ControlLook = { ...idle, disabled: true };
    expect(lookChanged(busy, { ...busy })).toBe(false);
  });
});

describe("lookOf (ggui#1398)", () => {
  const el = (attrs: Record<string, string>, text: string, isConnected?: boolean) => ({
    textContent: text,
    getAttribute: (name: string) => (name in attrs ? attrs[name]! : null),
    ...(isConnected !== undefined ? { isConnected } : {}),
  });

  it("reads disabled from the attribute's presence (React renders it empty), busy and text", () => {
    expect(lookOf(el({ disabled: "", "aria-busy": "true" }, "Sending…"))).toEqual({
      connected: true,
      disabled: true,
      ariaBusy: true,
      text: "Sending…",
    });
  });

  it("aria-disabled=true reads as disabled; an element without isConnected reads as connected", () => {
    expect(lookOf(el({ "aria-disabled": "true" }, "Send")).disabled).toBe(true);
    expect(lookOf(el({}, "Send")).connected).toBe(true);
    expect(lookOf(el({}, "Send", false)).connected).toBe(false);
  });
});
