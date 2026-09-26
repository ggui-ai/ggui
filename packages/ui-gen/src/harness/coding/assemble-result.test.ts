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
import { absorbTokens, createTelemetry } from "./generate-task-runner";
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

// #retail-L1 review — prompt-cache observability passthrough.
//
// The cache-token counters (provider-specific; only some providers report
// prompt-cache reads/writes) accumulate onto the telemetry during the
// coding loop. The assembler must carry them onto the GenerationResult so
// the downstream observability line that derives a cache-read ratio sees
// real numbers instead of a structural zero. Absent on the telemetry
// (providers that don't report them) → absent on the result, never
// defaulted to 0 at this boundary.
describe("assembleGenerationResult — cache-token passthrough", () => {
  it("carries cacheReadTokens/cacheCreationTokens through when telemetry reports them", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();

    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.totalIn = 1_000;
    telemetry.cacheReadTokens = 800;
    telemetry.cacheCreationTokens = 200;

    const result = await assembleGenerationResult({ session, telemetry, source: "" });

    expect(result.cacheReadTokens).toBe(800);
    expect(result.cacheCreationTokens).toBe(200);
  });

  // ggui#1186 — `tokens.total` is the FULL processed footprint (the adapters'
  // convention: non-cached input + cache creation + cache reads + output), so a
  // row's cached count is recoverable as `total − input − output` even when the
  // cache fields themselves are not published. Before this pin the harness path
  // published `input + output`, which priced the cached prefix but hid it.
  it("tokens.total is the full footprint: input + cacheCreation + cacheRead + output", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();
    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.totalIn = 122;
    telemetry.totalOut = 609;
    telemetry.cacheReadTokens = 36_501;
    telemetry.cacheCreationTokens = 200;
    const result = await assembleGenerationResult({ session, telemetry, source: "" });
    expect(result.tokens).toEqual({ input: 122, output: 609, total: 122 + 200 + 36_501 + 609 });
    expect(result.tokens.total - result.tokens.input - result.tokens.output).toBe(36_701);
  });

  // ggui#1281 — the eval round's cache reads/writes reach the same totals as the
  // coding turns': before the fix the eval path added input/output only, so a
  // generation's published total dropped every eval call's cached prefix.
  it("a coding turn plus an eval round: tokens.total is the full footprint of BOTH (ggui#1281)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();
    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    absorbTokens(telemetry, { input: 122, output: 609, cacheRead: 36_501, cacheCreation: 200 }); // coding turn
    absorbTokens(telemetry, { input: 21, output: 350, cacheRead: 84_000, cacheCreation: 2_800 }); // eval round
    const result = await assembleGenerationResult({ session, telemetry, source: "" });
    expect(result.tokens).toEqual({
      input: 122 + 21,
      output: 609 + 350,
      total: 122 + 21 + (200 + 2_800) + (36_501 + 84_000) + 609 + 350,
    });
    expect(result.cacheReadTokens).toBe(36_501 + 84_000);
    expect(result.cacheCreationTokens).toBe(200 + 2_800);
  });

  it("tokens.total is input + output when no cache counter was reported", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();
    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.totalIn = 1_000;
    telemetry.totalOut = 50;
    const result = await assembleGenerationResult({ session, telemetry, source: "" });
    expect(result.tokens).toEqual({ input: 1_000, output: 50, total: 1_050 });
  });

  it("forwards evalResult.criteriaCoverage to the assembled result untouched (bench reporter reads it per run)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();
    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.totalIn = 1_000;
    telemetry.evalResult = {
      issues: [],
      pass: ["functionality"],
      criteriaCoverage: [
        { criterion: "functionality", tier: 1, status: "ran" },
        { criterion: "crash", tier: 1, status: "skipped", reason: "no tool call returned" },
      ],
    };

    const result = await assembleGenerationResult({ session, telemetry, source: "" });

    expect(result.evalResult?.criteriaCoverage).toEqual(telemetry.evalResult.criteriaCoverage);
  });

  it("stamps the contract-feedback round's record on the result the generation ends with, beside that result's own (post-round) probe verdict (ggui#1261)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();
    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.evalResult = { issues: [], pass: [], runtimeProbe: { status: "ran", verdict: "pass" } };
    telemetry.contractFeedback = {
      firedOn: ["runtime:prop-sensitivity:currentUser"],
      sourceBefore: "export default function Chat() { return <p>You</p>; }",
    };

    const result = await assembleGenerationResult({ session, telemetry, source: "export default function Chat(props) { return <p>{props.currentUser}</p>; }" });

    expect(result.evalResult?.contractFeedback).toEqual(telemetry.contractFeedback);
    expect(result.evalResult?.runtimeProbe).toEqual({ status: "ran", verdict: "pass" });
    expect(result.evalResult?.issues).toEqual([]);
  });

  it("carries no contract-feedback key when no such round fired (truthful absence)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();
    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.evalResult = { issues: [], pass: [], runtimeProbe: { status: "ran", verdict: "pass" } };

    const result = await assembleGenerationResult({ session, telemetry, source: "" });

    expect(result.evalResult).toBeDefined();
    expect("contractFeedback" in result.evalResult!).toBe(false);
  });

  // ggui#404 — the same-exchange guard's record rides the result, present ONLY
  // when that guard ended the run.
  it("carries sameExchangeBreak when the guard ended the run, and no key otherwise", async () => {
    const session = fakeSession();
    const broke = createTelemetry();
    broke.codingStartedAtMs = session.startedAtMs + 50;
    broke.sameExchangeBreak = { tool: "cat", repeats: 3 };
    const r1 = await assembleGenerationResult({ session, telemetry: broke, source: "" });
    expect(r1.sameExchangeBreak).toEqual({ tool: "cat", repeats: 3 });

    const clean = createTelemetry();
    clean.codingStartedAtMs = session.startedAtMs + 50;
    const r2 = await assembleGenerationResult({ session, telemetry: clean, source: "" });
    expect("sameExchangeBreak" in r2).toBe(false);
  });

  it("leaves cache-token fields undefined when telemetry omits them (truthful absence)", async () => {
    const session = fakeSession();
    const telemetry = createTelemetry();

    telemetry.codingStartedAtMs = session.startedAtMs + 50;
    telemetry.codingMs = 1_000;
    telemetry.totalIn = 1_000;
    // No cacheReadTokens / cacheCreationTokens set — provider didn't report.

    const result = await assembleGenerationResult({ session, telemetry, source: "" });

    expect(result.cacheReadTokens).toBeUndefined();
    expect(result.cacheCreationTokens).toBeUndefined();
  });
});
