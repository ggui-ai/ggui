// Smoke test for the closure-based generate task runner. Verifies the
// closure produces a TaskRunner shape and that telemetry initializes
// cleanly. Full end-to-end tests live alongside dispatchGeneration once
// step 4 wires the runner in.

import { describe, expect, it } from "vitest";
import { createTelemetry } from "./generate-task-runner";

describe("createTelemetry", () => {
  it("produces a zeroed counters/totals record", () => {
    const t = createTelemetry();
    expect(t.turnsUsed).toBe(0);
    expect(t.evalRoundsUsed).toBe(0);
    expect(t.totalIn).toBe(0);
    expect(t.totalOut).toBe(0);
    expect(t.cumulativeLlmMs).toBe(0);
    expect(t.cumulativeToolMs).toBe(0);
    expect(t.cumulativeEvalWallMs).toBe(0);
    expect(t.cumulativeEvalLlmMs).toBe(0);
    expect(t.compiledCode).toBe("");
    expect(t.pairedSource).toBe("");
    expect(t.selfCheckPassed).toBe(false);
    expect(t.initialResultDelivered).toBe(false);
    expect(t.evalResult).toBeUndefined();
    expect(t.codingStartedAtMs).toBe(0);
    expect(t.codingMs).toBe(0);
  });

  it("seeds breakdown counter buckets to zero", () => {
    const t = createTelemetry();
    expect(t.counters.phases).toEqual({
      impl: 0,
      patch: 0,
      evalFix: 0,
      scaffold: 0,
      fill: 0,
    });
    expect(t.counters.outcomes).toEqual({
      pass: 0,
      patchInvalid: 0,
      selfCheckFail: 0,
      diffFail: 0,
    });
  });

  it("returns an independent record each call (no shared mutation)", () => {
    const a = createTelemetry();
    const b = createTelemetry();
    a.totalIn = 100;
    a.counters.phases.impl = 5;
    expect(b.totalIn).toBe(0);
    expect(b.counters.phases.impl).toBe(0);
  });
});
