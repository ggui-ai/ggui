// packages/gadgets/src/stdlib-parity.test.ts
//
// Cross-package contract test: `@ggui-ai/protocol`'s
// `STDLIB_GADGETS` descriptor list MUST stay in sync with
// the hooks this package actually exports.
//
// Why this lives here (and not in `@ggui-ai/protocol`):
//
//   - The descriptors live in protocol because the contract surface
//     (`DataContract.clientCapabilities.gadgets`) owns the
//     authoring shape. Descriptors are strings only — no runtime
//     deps, so the protocol package stays free of a
//     `@ggui-ai/gadgets` workspace dep that would create a
//     cycle (protocol → gadgets → protocol).
//
//   - Parity verification requires importing both the descriptor list
//     AND the actual hook implementations. That happens here, on the
//     runtime side: this package consumes protocol's descriptor list
//     and asserts the hook names match the hooks it exports.
//
//   - Drift fails the test on CI. The protocol package cannot ship a
//     stale descriptor list without the runtime side catching it; the
//     runtime side cannot add or remove a hook without updating the
//     protocol-side descriptors.

import { describe, expect, it } from 'vitest';
import {
  STDLIB_GADGETS,
  STDLIB_GADGETS_PACKAGE,
  STDLIB_GADGETS_VERSION,
  STDLIB_GADGET_HOOKS,
  gadgetExportName,
} from '@ggui-ai/protocol';
import type { GadgetExport, GadgetStatus } from '@ggui-ai/protocol';
import * as gadgets from './index.js';

/**
 * Runtime mirror of the `GadgetStatus` union. The `satisfies` clause
 * rejects values outside the union; the `_statusExhaustive` pin below
 * fails the build when a NEW union member is added without updating
 * this list — so the example-validation tests can never run against a
 * stale status vocabulary.
 */
const GADGET_STATUS_VALUES = [
  'idle',
  'prompting',
  'active',
  'completed',
  'denied',
  'error',
] as const satisfies readonly GadgetStatus[];
const _statusExhaustive: GadgetStatus extends (typeof GADGET_STATUS_VALUES)[number]
  ? true
  : never = true;
void _statusExhaustive;

/**
 * The only invokable members of a `GadgetHook` result
 * (`{value, status, error?, start, stop?}` — protocol
 * `types/gadget.ts`). Example `call` strings invoking anything else
 * (historic drift: `write.write(...)`, `notify.show(...)`) teach the
 * generation LLM an API that does not exist.
 */
const HOOK_RESULT_METHODS = new Set(['start', 'stop']);

/** Narrowed shape of every stdlib example block (typed `JsonValue`
 *  on the descriptor, so the structure must be asserted at runtime). */
interface StdlibExample {
  readonly call: string;
  readonly returns: { readonly status: string; readonly value?: unknown };
}

function asStdlibExample(hook: string, example: unknown): StdlibExample {
  expect(example, `${hook}: example must be a {call, returns} object`).toEqual(
    expect.objectContaining({
      call: expect.any(String),
      returns: expect.objectContaining({ status: expect.any(String) }),
    }),
  );
  return example as StdlibExample;
}

/**
 * Every export across every stdlib gadget package, flattened. A
 * `GadgetDescriptor` is now a PACKAGE with an `exports[]` array, so
 * parity assertions iterate exports — not top-level descriptors.
 */
function allStdlibExports(): readonly GadgetExport[] {
  return STDLIB_GADGETS.flatMap((pkg) => pkg.exports);
}

/** Hook-export names across every stdlib gadget package. */
function allStdlibHookNames(): readonly string[] {
  return allStdlibExports()
    .filter((exp) => 'hook' in exp)
    .map((exp) => exp.hook);
}

/**
 * Hook names this package actually exports. Filtered from the
 * package's `index.ts` re-exports to only camelCase identifiers
 * starting with `use` — keeps the parity check immune to incidental
 * helper exports (`type`-only exports, capability descriptor types,
 * `GadgetStatus`/`GadgetError`, etc.).
 */
function discoverExportedHooks(): readonly string[] {
  const names: string[] = [];
  for (const key of Object.keys(gadgets)) {
    if (/^use[A-Z]/.test(key) && typeof (gadgets as Record<string, unknown>)[key] === 'function') {
      names.push(key);
    }
  }
  return names.sort();
}

describe('@ggui-ai/gadgets ↔ STDLIB_GADGETS parity', () => {
  it('every hook export in STDLIB_GADGETS resolves to an exported hook', () => {
    const exported = new Set(discoverExportedHooks());
    const missing = allStdlibHookNames().filter(
      (hook) => !exported.has(hook),
    );

    expect(missing).toEqual([]);
  });

  it('every exported hook has a matching STDLIB_GADGETS export', () => {
    const exported = discoverExportedHooks();
    const declaredHooks = new Set(allStdlibHookNames());
    const undeclared = exported.filter((hook) => !declaredHooks.has(hook));

    expect(undeclared).toEqual([]);
  });

  it('STDLIB_GADGET_HOOKS matches the hook-export list', () => {
    const fromExports = new Set(allStdlibHookNames());
    expect(STDLIB_GADGET_HOOKS).toEqual(fromExports);
  });

  it('every descriptor declares the stdlib package as its default', () => {
    const wrongPackage = STDLIB_GADGETS.filter(
      (entry) => entry.package !== STDLIB_GADGETS_PACKAGE,
    );
    expect(wrongPackage).toEqual([]);
  });

  it('STDLIB_GADGETS_PACKAGE matches this package\'s name', async () => {
    // The package.json lives one directory up from the test file —
    // resolved via dynamic import so the assertion stays runtime-only
    // (no top-level filesystem reads at module load).
    const pkg = (await import('../package.json', { with: { type: 'json' } })) as {
      default: { name: string };
    };
    expect(STDLIB_GADGETS_PACKAGE).toBe(pkg.default.name);
  });

  it('STDLIB_GADGETS_VERSION matches this package\'s version', async () => {
    // A stdlib gadget's identity is `(hook, package, version)`. Every
    // wire ref + descriptor for a stdlib gadget carries
    // `STDLIB_GADGETS_VERSION`; this test pins it against
    // `packages/gadgets/package.json#version` so a runtime-package
    // bump without updating the constant fails CI instead of silently
    // breaking every wire ref's identity tuple.
    const pkg = (await import('../package.json', { with: { type: 'json' } })) as {
      default: { version: string };
    };
    expect(STDLIB_GADGETS_VERSION).toBe(pkg.default.version);
  });

  it('every STDLIB_GADGETS entry carries the constant version', () => {
    const wrongVersion = STDLIB_GADGETS.filter(
      (entry) => entry.version !== STDLIB_GADGETS_VERSION,
    );
    expect(wrongVersion).toEqual([]);
  });

  it('export names are unique across the stdlib catalog', () => {
    const names = allStdlibExports().map((exp) => gadgetExportName(exp));
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  // ── Example-block fidelity ────────────────────────────────────────
  //
  // The `example` blocks ship verbatim to agents via
  // `ggui_list_gadgets`, and ui-gen's system prompt exempts stdlib
  // gadgets from the `.d.ts` Type: line BECAUSE "they already carry an
  // `example`" — so for stdlib hooks the example is the ONLY API
  // signal the generation LLM gets. These tests pin every example to
  // the real `GadgetHook` contract.

  it("every example's returns.status is a GadgetStatus member", () => {
    const statuses = new Set<string>(GADGET_STATUS_VALUES);
    for (const exp of allStdlibExports()) {
      const name = gadgetExportName(exp);
      const example = asStdlibExample(name, exp.example);
      expect(
        statuses.has(example.returns.status),
        `${name}: returns.status '${example.returns.status}' is not in the GadgetStatus union`,
      ).toBe(true);
    }
  });

  it("every example's call string invokes the declared hook and only start()/stop() on its result", () => {
    for (const exp of allStdlibExports()) {
      const name = gadgetExportName(exp);
      const example = asStdlibExample(name, exp.example);

      // The call string must actually invoke the hook it documents.
      expect(
        example.call.includes(`${name}(`),
        `${name}: example call string never invokes the hook`,
      ).toBe(true);

      // Every `<ident>.<method>(` in the call string must be a real
      // GadgetHook result member — start or stop. Catches drift like
      // `write.write('hello')` / `notify.show({...})`.
      const methodCalls = [...example.call.matchAll(/\.(\w+)\(/g)].map(
        (m) => m[1],
      );
      const phantom = methodCalls.filter(
        (method) => method !== undefined && !HOOK_RESULT_METHODS.has(method),
      );
      expect(
        phantom,
        `${name}: example call invokes method(s) [${phantom.join(', ')}] that do not exist on a GadgetHook result (only start/stop do)`,
      ).toEqual([]);
    }
  });
});
