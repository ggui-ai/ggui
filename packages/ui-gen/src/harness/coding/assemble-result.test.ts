// Regression test for the timing-breakdown fix (2026-04-14; see
// core/docs/ui-generation-experiments.md post-#39 telemetry fix).
//
// Prior behavior: `codingMs` in the log captured the ENTIRE inner loop
// (coding + eval + eval-fix), and `evalMs` was `Date.now() - codingStart -
// codingMs` ≈ 0, so `[simple] timing: coding=X eval=0ms total=X` was
// structurally wrong.
//
// Fixed behavior: `codingMs` is coding-only (inner-loop minus eval wall);
// `evalMs` is the accumulated runEvalRound wall-time; `setupMs` is the
// session init/cleanup overhead. Invariant: codingMs + evalMs + setupMs
// ≈ totalMs (within measurement slop).
//
// This test asserts the arithmetic at the assembleGenerationResult layer
// by inspecting the shipped `breakdown` fields.

import { describe, expect, it } from "vitest";
import { assembleGenerationResult } from "./assemble-result";
import { createTelemetry } from "./generate-task-runner";
import type { CodingSession } from "./init-session";

function fakeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  const session = {
    startedAtMs: Date.now() - 10_000,
    harness: { process: { mode: "single_pass" } },
    qualityMode: "fast" as const,
    codingAgent: { cleanup: async () => {} },
    tiersMod: null,
    ...overrides,
  } as unknown as CodingSession;
  return session;
}

describe("assembleGenerationResult — timing breakdown", () => {
  it("reports accurate coding/eval/setup split (not the pre-fix evalMs=0 bug)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();

    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 8_000; // inner loop duration
    telemetry.cumulativeEvalWallMs = 3_000; // 3s of eval
    telemetry.cumulativeLlmMs = 4_500;
    telemetry.cumulativeEvalLlmMs = 2_500;
    telemetry.cumulativeToolMs = 100;
    telemetry.evalRoundsUsed = 2;

    const result = await assembleGenerationResult({
      session,
      telemetry,
      source: "export default function C(){return null}",
    });

    // codingMs in the breakdown is coding-only (total inner loop - eval wall)
    expect(result.breakdown?.codingMs).toBe(5_000);
    // evalMs is the real accumulated eval wall (was 0 before the fix)
    expect(result.breakdown?.evalMs).toBe(3_000);
    // evalLlmMs is the new counter for eval-round LLM+visual parallel wall
    expect(result.breakdown?.evalLlmMs).toBe(2_500);
    // llmMs retains the coding-turn-only semantics for back-compat
    expect(result.breakdown?.llmMs).toBe(4_500);

    // Invariant: the three components of totalMs add up.
    const { codingMs, evalMs, setupMs } = result.breakdown!;
    const accounted = (codingMs ?? 0) + evalMs + (setupMs ?? 0);
    // totalMs is `Date.now() - session.startedAtMs`; it drifts by a few ms
    // between tick-start of this test and when assemble calculates it. Allow
    // 50ms slop to avoid flakes on slow runners.
    expect(Math.abs(accounted - result.generationTimeMs)).toBeLessThan(50);
  });

  it("handles zero eval rounds (coding=full inner loop, eval=0)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();

    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 6_000;
    telemetry.cumulativeEvalWallMs = 0;
    telemetry.cumulativeEvalLlmMs = 0;
    telemetry.evalRoundsUsed = 0;

    const result = await assembleGenerationResult({ session, telemetry, source: "" });

    expect(result.breakdown?.codingMs).toBe(6_000);
    expect(result.breakdown?.evalMs).toBe(0);
    expect(result.breakdown?.evalLlmMs).toBe(0);
  });

  it("clamps to zero when accumulated eval exceeds codingMs (defensive)", async () => {
    // If a future refactor makes eval wall leak outside codingMs, the
    // subtraction could go negative. Math.max guards it.
    const session = fakeSession();
    const telemetry = createTelemetry();

    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 2_000;
    telemetry.cumulativeEvalWallMs = 5_000; // leaked over the loop boundary
    telemetry.evalRoundsUsed = 1;

    const result = await assembleGenerationResult({ session, telemetry, source: "" });

    expect(result.breakdown?.codingMs).toBe(0); // clamped, not -3000
    expect(result.breakdown?.evalMs).toBe(5_000);
  });
});
