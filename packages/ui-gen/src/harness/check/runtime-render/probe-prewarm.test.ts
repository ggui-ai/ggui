// @vitest-environment node
// packages/ui-gen/src/harness/check/runtime-render/probe-prewarm.test.ts
//
// Regression pin for ggui#403 defect 1: the probe must survive its own
// pre-warm. `warmupRuntimeRenderProbe()` imports the probe's runtime
// deps at dispatch entry — BEFORE any DOM exists. user-event v14
// captures `globalThis.document` into its module-scope setup defaults
// at MODULE LOAD, so a bare `userEvent.setup()` after a DOM-less
// pre-warm received `document: undefined` and crashed every probe with
//   Cannot read properties of undefined
//     (reading 'Symbol(Node prepared with document state workarounds)')
// The fix passes the live document explicitly (`setup({ document })`),
// making the probe immune to import order.
//
// This file MUST run in the node environment (no ambient DOM) and MUST
// be its own file: the poisoning is a module-load-order property, and
// vitest's per-file isolation is what makes the order deterministic.

//
// ggui#1380 C2 adds the WORKER warm: `warmupRuntimeRenderWorker()` spawns one
// real check worker on a trivial component, so the process that will run
// every probe has run one — the node binary, the page cache and esbuild's
// service are warm, and the result says whether that process can run at
// all. `runSandboxed` is wrapped by a pass-through spy so the spawn is
// observable and can be made to reject; the existing probe pin below still
// spawns for real through the same wrapper.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataContract } from "@ggui-ai/protocol";
import type { SandboxOptions, SandboxResult } from "@ggui-ai/sandbox";

const sandbox = vi.hoisted(() => ({
  runSandboxed: vi.fn<(opts: SandboxOptions) => Promise<SandboxResult>>(),
}));

vi.mock("@ggui-ai/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ggui-ai/sandbox")>();
  sandbox.runSandboxed.mockImplementation((opts) => actual.runSandboxed(opts));
  return { ...actual, runSandboxed: sandbox.runSandboxed };
});

const { warmupRuntimeRenderProbe, warmupRuntimeRenderWorker } = await import("./index.js");
const { DEFAULT_RUNTIME_RENDER_CHECK } = await import("./adapter.js");

const CONTRACT: DataContract = {
  actionSpec: {
    save: { label: "Save" },
  },
};

const SOURCE = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';
export default function Card(props: { title: string }) {
  const save = useAction('save');
  return (
    <div>
      <h1>{props.title}</h1>
      <button onClick={() => save({})}>Save</button>
    </div>
  );
}
`;

describe("runtime-render probe after DOM-less pre-warm (ggui#403)", () => {
  it("probe still RUNS when user-event was imported before any DOM existed", async () => {
    // Mimic generation-dispatch: warm the deps with no DOM up.
    expect(globalThis.document).toBeUndefined();
    const warm = await warmupRuntimeRenderProbe();
    expect(warm.missing).toBe(0);

    const outcome = await DEFAULT_RUNTIME_RENDER_CHECK.run({
      sourceCode: SOURCE,
      compiledCode: "compiled-by-probe",
      contract: CONTRACT,
    });

    // Pre-fix this was `infra-skipped` (user-event's frozen
    // `document: undefined` default) on every single invocation.
    expect(outcome.status).toBe("ran");
    // The action IS wired natively — the probe's click simulation must
    // have actually executed, not been skipped: a verified wiring
    // produces no issue for `save`.
    const saveIssues = outcome.issues.filter((i) => i.subcategory?.includes("save"));
    expect(saveIssues).toEqual([]);
  });
});

describe("warmupRuntimeRenderWorker — one real worker run at boot (ggui#1380 C2)", () => {
  beforeEach(() => {
    sandbox.runSandboxed.mockClear();
  });

  it("spawns exactly one check worker (node + the worker entry) and reports ok with its wall-clock", async () => {
    const warm = await warmupRuntimeRenderWorker();
    expect(sandbox.runSandboxed).toHaveBeenCalledTimes(1);
    const opts = sandbox.runSandboxed.mock.calls[0]?.[0];
    expect(opts?.command).toBe(process.execPath);
    // Under vitest the host resolves the worker from `src/` (tsx); built,
    // it is `dist/harness/check/runtime-render/render-check-worker.js` —
    // the kill-path pin covers the dist entry.
    expect(opts?.args.at(-1)).toMatch(
      /harness\/check\/runtime-render\/render-check-worker\.(?:ts|js)$/
    );
    expect(warm.ok).toBe(true);
    expect(warm.ms).toBeGreaterThan(0);
  });

  it("threads the caller's bounds to the one run", async () => {
    await warmupRuntimeRenderWorker({ timeoutMs: 20_000, heapMb: 384 });
    const opts = sandbox.runSandboxed.mock.calls[0]?.[0];
    expect(opts?.timeoutMs).toBe(20_000);
    expect(opts?.nodeHeapMb).toBe(384);
  });

  it("reports { ok: false, reason } when the worker cannot run — and never throws", async () => {
    sandbox.runSandboxed.mockImplementationOnce(() => Promise.reject(new Error("spawn ENOENT")));
    const warm = await warmupRuntimeRenderWorker();
    expect(warm.ok).toBe(false);
    expect(warm.ms).toBeGreaterThanOrEqual(0);
    if (warm.ok === false) expect(warm.reason).toContain("spawn ENOENT");
  });
});
