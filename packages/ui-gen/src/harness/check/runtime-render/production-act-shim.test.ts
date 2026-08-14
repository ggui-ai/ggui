import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createFlushSyncAct, installProductionActShim } from "./production-act-shim.js";

describe("createFlushSyncAct", () => {
  it("runs the callback INSIDE the injected flushSync (order-assert via call log)", async () => {
    const calls: string[] = [];
    const fakeFlushSync = (fn: () => void): void => {
      calls.push("flushSync:before");
      fn();
      calls.push("flushSync:after");
    };
    const act = createFlushSyncAct(fakeFlushSync);

    await act(() => {
      calls.push("callback");
    });

    expect(calls).toEqual(["flushSync:before", "callback", "flushSync:after"]);
  });

  it("resolves after a microtask when the callback returns synchronously (non-thenable)", async () => {
    const fakeFlushSync = (fn: () => void): void => fn();
    const act = createFlushSyncAct(fakeFlushSync);

    await expect(act(() => "sync-result")).resolves.toBeUndefined();
  });

  it("resolves after the callback's returned thenable settles", async () => {
    const fakeFlushSync = (fn: () => void): void => fn();
    const act = createFlushSyncAct(fakeFlushSync);
    const resolutionOrder: string[] = [];

    const inner = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolutionOrder.push("inner-resolved");
        resolve();
      }, 0);
    });

    await act(() => inner);
    resolutionOrder.push("act-resolved");

    expect(resolutionOrder).toEqual(["inner-resolved", "act-resolved"]);
  });

  it("rejects when the callback's returned thenable rejects", async () => {
    const fakeFlushSync = (fn: () => void): void => fn();
    const act = createFlushSyncAct(fakeFlushSync);
    const boom = new Error("inner rejection");

    await expect(act(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});

describe("installProductionActShim", () => {
  it("calling it twice is safe (idempotent)", () => {
    expect(() => {
      installProductionActShim();
      installProductionActShim();
    }).not.toThrow();
  });

  it("is a strict no-op under dev React (real `act` present) — react-dom/test-utils's act is NOT replaced", () => {
    // Under vitest, NODE_ENV=test resolves React's development build,
    // which DOES export a real `act` — the shim must never touch
    // react-dom/test-utils in that case (zero CI behavior change).
    const require_ = createRequire(import.meta.url);
    const react = require_("react") as { act?: unknown };
    expect(typeof react.act).toBe("function");

    const testUtils = require_("react-dom/test-utils") as { act?: unknown };
    const before = testUtils.act;

    installProductionActShim();

    const after = testUtils.act;
    expect(after).toBe(before);
  });
});

// Deliberately NOT attempting to simulate a production React build
// here — that would require poisoning the module cache with a
// production react/react-dom, which leaks across this whole vitest
// suite (module cache is process-wide). The factory-level
// createFlushSyncAct tests above plus the no-op test are the right
// unit coverage for this file; the production path itself is
// verified on the host that actually runs a production Node build.
