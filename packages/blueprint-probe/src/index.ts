/**
 * `@ggui-ai/blueprint-probe` — server-side runtime probe for blueprint
 * manifests.
 *
 * Implements {@link BlueprintProbeRunner} from `@ggui-ai/registry-core`.
 * The static gates in `checkConformance()` catch syntax errors, missing
 * exports, and obvious shape mismatches; this probe goes one step
 * further by actually CALLING the blueprint's default export through
 * React's server renderer to catch:
 *
 *   - destructuring of `undefined` (e.g. `const { foo } = props` where
 *     fixtureProps omits `foo`)
 *   - hook-call-order violations
 *   - thrown errors during the first render
 *   - missing prop coercions (e.g. calling `.toFixed()` on a string)
 *
 * Implementation: compile TSX → CJS via esbuild, run inside Node's
 * `vm` module with a `require` shim that resolves the always-allowed
 * blueprint imports (react, react/jsx-runtime) to the real impls and
 * stubs `@ggui-ai/gadgets` with a no-op Proxy. The default export is
 * then rendered via {@link renderToString} with the manifest's
 * `fixtureProps` (or `{}` if absent).
 *
 * Why not happy-dom: the probe doesn't need a window/document —
 * `renderToString` is server-side. Skipping happy-dom keeps the
 * dependency footprint smaller (~6 MB delta) and avoids the
 * "happy-dom diverges from real iframe env" risk class.
 *
 * Why CJS not ESM: Node's `vm.runInContext` runs synchronous code in
 * a context; ESM requires `vm.Module` which is unstable. CJS keeps
 * the surface small.
 *
 * SSR / CSR caveat — this is a best-effort smoke check.
 * `renderToString` is server-side: there is no `window`,
 * no `document`, and `useEffect` does NOT fire. Blueprints that
 * synchronously read `document.*` or `window.*` during render (or rely
 * on layout effects to bail out of a render path) will false-positive
 * here — the probe will report `probe_failed` even though the live
 * iframe runtime would render them fine. Inverse: a blueprint that
 * relies on `useEffect` to surface a runtime error will false-NEGATIVE
 * (probe says ok; iframe blows up). Consumers should treat probe
 * success as "no obvious render-time crash" — not "guaranteed to work
 * in the iframe runtime".
 *
 * Security caveat — `vm.runInContext` is NOT a security boundary.
 * A malicious blueprint that imports `react`
 * (always-allowed) can climb the prototype chain to the host's
 * `Function` constructor and read `process.env`. This probe is a
 * smoke check, not a sandbox; do not wire it into a path that handles
 * untrusted blueprints without first running it in a separate
 * isolation layer (separate Lambda with no secrets in env, or
 * `isolated-vm` for a real V8 isolate).
 */
import { createRequire } from 'node:module';
import * as vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as React from 'react';
import type {
  ArtifactManifest,
} from '@ggui-ai/artifact-manifest';
import type {
  BlueprintProbeRunner,
  ConformanceResponseBody,
} from '@ggui-ai/registry-core';

type BlueprintManifest = Extract<ArtifactManifest, { kind: 'blueprint' }>;

/**
 * Timeout bound for `vm.runInContext`. An unbounded probe can hang
 * the host on a `while(true){}` blueprint until the HTTP gateway's
 * 30s ceiling fires — denying publish throughput. The timeout is
 * comfortably above any legitimate blueprint render but far enough
 * below the transport ceiling that the probe failure is the one
 * observed.
 *
 * NOTE: `vm.runInContext` only times out synchronous CJS evaluation.
 * `renderToString` runs OUTSIDE the vm context and is also
 * synchronous + CPU-bound — a blueprint that puts a setState-in-
 * render loop into its component body can still hang React's
 * server renderer. There's no synchronous way to bound that without
 * a worker thread; the HTTP gateway's 30s transport ceiling is the
 * fallback bound for that case.
 */
const PROBE_VM_TIMEOUT_MS = 5000;

/**
 * Server-side blueprint runtime probe — a dev / CI tool. Wire it into
 * the publish flow as the opt-in `PublishArtifactDeps.blueprintProbe`
 * deps slot so the static gates always run while the runtime probe
 * stays opt-in (avoids forcing react-dom into every conformance HTTP
 * caller). It executes blueprint code via `vm`, so do not place it on
 * a production path handling untrusted blueprints without a separate
 * isolation layer — see the file-level security caveat.
 */
export const blueprintProbeRunner: BlueprintProbeRunner = {
  async probe(manifest: BlueprintManifest): Promise<ConformanceResponseBody> {
    try {
      const compiled = compileToCjs(manifest.source);
      const moduleDefault = evaluateModule(compiled);
      if (typeof moduleDefault !== 'function') {
        return probeFailed(
          `blueprint default export is not a function/component (got ${describeType(moduleDefault)})`,
        );
      }
      const Component = moduleDefault as React.FunctionComponent<
        Record<string, unknown>
      >;
      const props =
        manifest.fixtureProps !== undefined &&
        manifest.fixtureProps !== null &&
        typeof manifest.fixtureProps === 'object' &&
        !Array.isArray(manifest.fixtureProps)
          ? (manifest.fixtureProps as Record<string, unknown>)
          : {};
      // `react-dom/server` is loaded via dynamic import so the module
      // graph here doesn't drag the server-side renderer into every
      // consumer that just imports `BlueprintProbeRunner` for the
      // type. The import is awaited once per probe.
      const { renderToString } = await import('react-dom/server');
      renderToString(React.createElement(Component, props));
      return { ok: true, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Server-side absolute paths in error text would leak deployment
      // topology to anyone publishing a broken blueprint. Scrub paths
      // and drop the stack entirely — the publisher can't act on a
      // stack from the probe's vm context.
      const scrubbedMessage = scrubServerPaths(message);
      return probeFailed(`runtime probe threw: ${scrubbedMessage}`, {
        message: scrubbedMessage,
      });
    }
  },
};

function compileToCjs(source: string): string {
  // `jsx: 'automatic'` emits `require('react/jsx-runtime')` calls so
  // the probe doesn't need a `React` global in scope. `format: 'cjs'`
  // keeps the eval-via-vm surface small.
  const { code } = transformSync(source, {
    loader: 'tsx',
    format: 'cjs',
    target: 'es2020',
    jsx: 'automatic',
    sourcemap: false,
  });
  return code;
}

function evaluateModule(code: string): unknown {
  const moduleObj = { exports: {} as Record<string, unknown> };
  // `createRequire` against this file resolves react / react-dom /
  // react/jsx-runtime through the package's own node_modules graph —
  // the same React instance the probe later calls `renderToString`
  // on. Without a shared instance, hooks throw the "more than one
  // copy of React" runtime check.
  const realRequire = createRequire(import.meta.url);

  const requireShim = (specifier: string): unknown => {
    if (specifier === '@ggui-ai/gadgets') {
      return gadgetsStub;
    }
    // Only react surfaces are routed through — anything else got
    // through the gate-7 import allow-list already, so we don't
    // expect other specifiers here. Surface as a probe failure so
    // misconfigured blueprints fail loud.
    if (
      specifier === 'react' ||
      specifier === 'react-dom' ||
      specifier === 'react/jsx-runtime' ||
      specifier === 'react-dom/server'
    ) {
      return realRequire(specifier);
    }
    throw new Error(
      `probe require-shim does not resolve \`${specifier}\` — only the always-allowed blueprint imports are routed through.`,
    );
  };

  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    // `console` lets blueprints log without crashing the probe.
    console,
  });
  // Bound synchronous evaluation. Without `timeout`, a
  // `while(true){}` blueprint hangs the host. Node surfaces the
  // bound as a thrown Error; the outer catch maps it to
  // `blueprint_runtime_probe_failed` with a clear message.
  vm.runInContext(code, context, {
    filename: 'blueprint.cjs.js',
    timeout: PROBE_VM_TIMEOUT_MS,
  });
  return moduleObj.exports.default;
}

/**
 * Stub for `@ggui-ai/gadgets`. Every hook returns `undefined` (or
 * `[undefined, () => undefined]` for setState-shaped tuples). The
 * Proxy responds to any property access with a no-op function so
 * blueprints that call hooks the probe doesn't pre-stub still get a
 * survivable answer.
 */
const noopHook = (): unknown => undefined;
// The stub mimics what `require('@ggui-ai/gadgets')` would return —
// a CJS module namespace whose shape is unknown by design (the probe
// doesn't ship a gadget registry). `Record<string, unknown>` is the
// honest type; the `as Record<string, unknown>` on the Proxy target
// is the lone shape-unknown cast in this file (the stub is the
// shape-unknown construct, not data with a known type).
const gadgetsStub: Record<string, unknown> = new Proxy(
  {} as Record<string, unknown>,
  {
    get(_, prop) {
      if (prop === '__esModule') return true;
      if (typeof prop === 'symbol') return undefined;
      return noopHook;
    },
  },
);

function probeFailed(
  message: string,
  detail?: Record<string, unknown>,
): ConformanceResponseBody {
  return {
    ok: false,
    errors: [
      {
        code: 'blueprint_runtime_probe_failed',
        message,
        ...(detail !== undefined ? { detail } : {}),
      },
    ],
  };
}

function describeType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Strip absolute filesystem paths from probe error messages.
 * Lambda's `/var/task/...` and the dev host's `/home/node/...`
 * paths leak through esbuild diagnostics + thrown Error messages;
 * the publisher can't act on them and they reveal deployment
 * topology.
 *
 * The regex matches any `/`-prefixed run up to a `packages/`, `cloud/`,
 * or `node_modules/` segment and keeps the tail from that segment on —
 * so `/var/task/node_modules/react/index.js` becomes
 * `node_modules/react/index.js`. Anything that doesn't match a
 * recognised segment is left as-is; we'd rather over-keep than
 * accidentally strip a user-meaningful identifier.
 */
function scrubServerPaths(input: string): string {
  return input.replace(
    /\/[^\s)]+\/(packages|cloud|node_modules)\b/g,
    '$1',
  );
}
