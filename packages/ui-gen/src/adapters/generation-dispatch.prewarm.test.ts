// @vitest-environment node
//
// ggui#1769: the dispatch pre-warms the runtime-render check's DOM and testing
// stack ONLY where the check will run in this process. In a plain Node process
// every check runs in an isolated worker, so a warm here loads ~1 s of modules
// onto this process's event loop on the first generation and helps nothing.
// The gate is the dispatcher's own predicate (`renderCheckRunsInProcess`), so
// the two cannot drift apart.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warm = vi.hoisted(() => ({ fn: vi.fn(() => Promise.resolve({ ms: 0, loaded: 4, missing: 0 })) }));

vi.mock("../harness/check/runtime-render/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../harness/check/runtime-render/index.js")>();
  return { ...actual, warmupRuntimeRenderProbe: warm.fn };
});

const { prewarmInProcessRenderCheck } = await import("./generation-dispatch.js");
const { renderCheckRunsInProcess } = await import("../harness/check/runtime-render/index.js");

/** Stand in for a DOM-owning environment (a vitest `happy-dom` file): the predicate reads only presence. */
function withDomGlobals(): void {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", {});
}

describe("dispatch pre-warm runs only where the check runs in-process (ggui#1769)", () => {
  beforeEach(() => warm.fn.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it("a plain Node process (checks run in a worker) starts no warm", () => {
    expect(renderCheckRunsInProcess()).toBe(false);
    expect(prewarmInProcessRenderCheck(undefined)).toBe(false);
    expect(prewarmInProcessRenderCheck(true)).toBe(false);
    expect(warm.fn).not.toHaveBeenCalled();
  });

  it("control: a DOM-owning process (checks run in-process) starts exactly one warm", () => {
    withDomGlobals();
    expect(renderCheckRunsInProcess()).toBe(true);
    expect(prewarmInProcessRenderCheck(undefined)).toBe(true);
    expect(warm.fn).toHaveBeenCalledTimes(1);
  });

  it("runtime render switched off starts no warm, DOM or not", () => {
    withDomGlobals();
    expect(prewarmInProcessRenderCheck(false)).toBe(false);
    expect(warm.fn).not.toHaveBeenCalled();
  });
});
