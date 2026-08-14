// packages/ui-gen/src/harness/check/runtime-render/production-act-shim.ts
//
// Minimal adaptation to two upstream constraints, neither of which
// this package controls:
//
//   1. React intentionally strips `act` from its PRODUCTION build.
//      `react/cjs/react.production.js` does not export it — only the
//      development build does (`typeof require('react').act` is
//      `'function'` under a dev build, `undefined` under production).
//   2. `@testing-library/react`'s `act-compat` module hard-requires
//      `act` at MODULE SCOPE: it snapshots
//      `typeof React.act === 'function' ? React.act : DeprecatedReactTestUtils.act`
//      into a `const` the first time it is imported in the process.
//      Under a production build, that snapshot resolves to React
//      DOM's `react-dom/test-utils` production `act` stub, which
//      THROWS `React.act is not a function` the moment it is called.
//
// Hosts that run this probe inside a production Node process
// (server-side blueprint validation) hit this: every render throws
// through RTL's `act` wrapper before the probe ever sees the
// component. Hosts that run it under a development/test build (every
// CI/vitest run in this repo — `NODE_ENV=test` resolves the dev
// build) never see it; `act` is real there and this shim is a no-op.
//
// **Load-order constraint**: this MUST run before the FIRST import of
// `@testing-library/react` anywhere in the process — act-compat binds
// its `act` reference into a module-scope `const` at import time, so
// patching `react-dom/test-utils` AFTER that import has already
// happened does nothing (the snapshot already captured the broken
// stub). Patch `react-dom/test-utils`, never `react` itself — that
// entry point is deprecated and test-only, so this patch cannot
// perturb any production rendering path; nothing else in a server
// process legitimately imports it.
//
// `createRequire` (not `import`) reaches these modules deliberately:
// ESM namespace objects are frozen, so a normal `import` gives no way
// to mutate `act` on it. The CJS `module.exports` objects `require`
// resolves are mutable, and RTL's act-compat interop-copies THAT
// object's properties at its own load time — so mutating it here,
// before RTL loads, is what makes the patch visible to RTL at all.

import { createRequire } from "node:module";

let installed = false;

/**
 * The one property this module reads/mutates on `react` and
 * `react-dom/test-utils`'s CJS exports. A minimal local shape rather
 * than the real (deprecated, possibly absent) type declarations for
 * `react-dom/test-utils` — narrow enough to type-check the mutation
 * without `as any` / `Record<string, unknown>`.
 */
interface MutableActCarrier {
  act?: unknown;
}

/** The one React DOM export this module needs — typed narrowly for the same reason. */
interface FlushSyncCarrier {
  flushSync: (fn: () => void) => void;
}

/**
 * Patch `react-dom/test-utils`'s `act` with a `flushSync`-backed
 * replacement, but ONLY when the current process is running React's
 * production build (no real `act` exported). Idempotent — safe to
 * call more than once or from more than one call site; the actual
 * patch only ever applies once per process.
 *
 * No-op (by design, not by accident) whenever `react`'s own `act`
 * export is a real function — every dev/test build, including every
 * vitest run in this repo. This shim changes zero behavior in CI.
 */
export function installProductionActShim(): void {
  if (installed) return;
  installed = true;

  const require_ = createRequire(import.meta.url);

  let reactCjs: MutableActCarrier;
  try {
    reactCjs = require_("react");
  } catch {
    // React itself isn't resolvable in this process — the probe
    // surfaces its own load error; nothing for this shim to patch.
    return;
  }

  if (typeof reactCjs.act === "function") {
    // Dev/test builds export a real `act` — strict no-op.
    return;
  }

  try {
    const testUtils: MutableActCarrier = require_("react-dom/test-utils");
    const reactDom: FlushSyncCarrier = require_("react-dom");
    testUtils.act = createFlushSyncAct(reactDom.flushSync);
  } catch {
    // Frozen/locked exports (or a react-dom build without flushSync)
    // — leave it. The probe then surfaces the raw upstream error,
    // which is the pre-fix behavior: an honest failure, not a
    // silently-broken patch.
  }
}

/**
 * Build an `act`-compatible replacement backed by `flushSync`, which
 * — unlike `act` — DOES exist in React's production build.
 *
 * `flushSync` is the single property this shim relies on from dev
 * `act`: it forces the scheduled render to commit SYNCHRONOUSLY
 * before returning, so a render throw propagates synchronously to the
 * caller and the DOM is fully committed by the time this resolves.
 *
 * Returned function is act-style: if the callback itself returned a
 * thenable (RTL's async act-wrapped interactions), the result
 * resolves once that thenable settles (rejecting on its rejection);
 * otherwise it resolves after one microtask, mirroring `act`'s own
 * "flush the microtask queue" contract for the synchronous case.
 *
 * **Known, documented delta vs. a real dev `act`**: passive effects
 * (`useEffect`) flush on a LATER task under `flushSync`, not
 * synchronously at act-exit — `flushSync` only guarantees the
 * synchronous commit, not effect flushing. The probe's uncaught-error
 * handlers plus its 100ms teardown grace window (`render-check.ts`'s
 * `cleanupAsyncInfra`) already cover a late effect throwing after this
 * resolves, so this delta does not reopen the crash class the probe
 * exists to catch.
 *
 * Exported separately so the flushSync/thenable semantics are unit
 * testable without a real React runtime.
 */
export function createFlushSyncAct(
  flushSync: (fn: () => void) => void,
): (callback: () => unknown) => Promise<void> {
  return (callback: () => unknown): Promise<void> => {
    let callbackResult: unknown;
    flushSync(() => {
      callbackResult = callback();
    });
    if (isThenable(callbackResult)) {
      const pending = callbackResult;
      return new Promise<void>((resolve, reject) => {
        pending.then(() => resolve(), reject);
      });
    }
    return new Promise<void>((resolve) => {
      queueMicrotask(resolve);
    });
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
