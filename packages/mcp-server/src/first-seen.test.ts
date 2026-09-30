import { describe, expect, it } from "vitest";
import { createFirstSeen } from "./first-seen.js";

describe("createFirstSeen", () => {
  it("says first once per key", () => {
    const seen = createFirstSeen(4);
    expect([seen.first("a"), seen.first("a"), seen.first("b"), seen.first("a")]).toEqual([true, false, true, false]);
  });

  it("holds at most `capacity` keys, forgetting the oldest", () => {
    const seen = createFirstSeen(2);
    expect(seen.first("a")).toBe(true);
    expect(seen.first("b")).toBe(true);
    expect(seen.first("c")).toBe(true); // forgets "a"
    expect(seen.first("b")).toBe(false);
    expect(seen.first("a")).toBe(true); // forgotten, so new again; forgets "b"
    expect(seen.first("c")).toBe(false);
  });

  it("refuses a capacity that is not a positive integer", () => {
    expect(() => createFirstSeen(0)).toThrow(RangeError);
    expect(() => createFirstSeen(1.5)).toThrow(RangeError);
  });
});
