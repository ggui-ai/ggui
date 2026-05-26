/**
 * `loadGadgetRegistry()` — composes the gadget-package registry the
 * iframe runtime exposes to generated component code (GG.8.2 —
 * per-package, not per-hook).
 *
 * The iframe-runtime's boot sequence calls this immediately before
 * `installGlobalRegistry()` to compose the value that lands at
 * `globalThis.__ggui__.gadgets`. The composition is:
 *
 *   - STDLIB seed: the whole `@ggui-ai/gadgets` module namespace
 *     (pre-loaded so the 7 first-party browser-capability hooks
 *     always work), stored under `registry['@ggui-ai/gadgets']`.
 *   - PLUS one namespace per operator-registered package from the
 *     bootstrap's `gadgets` field — dynamically imported here once per
 *     package (target = `bundleUrl` if present else `package`) and
 *     stored under the package-name key.
 *
 * Every export the package ships — hooks AND components — is reachable
 * because the whole namespace is stored; the per-package data-URL shim
 * the rewriter emits resolves `__ggui__.gadgets[package][export]`.
 *
 * When a registration carries `bundleSri` alongside `bundleUrl`, the
 * loader routes through a `<link rel="modulepreload" integrity>` gate
 * so the browser refuses execution on hash mismatch with the
 * registry-served bytes. The integrity-less dynamic `import()` path is
 * preserved for refs that don't publish bundles (in-tree packages,
 * hand-authored ggui.json).
 *
 * Failure handling: a package that fails to load (network error,
 * bad bundle, etc.) is logged and skipped — the rest of the registry
 * still installs. The per-package shim's lazy thunks throw a clear
 * "not loaded" error at call/render time instead of silently crashing
 * inside React.
 *
 * STDLIB always wins: an operator-registered package named
 * `@ggui-ai/gadgets` cannot shadow the STDLIB seed (defense-in-depth).
 */

import type { GadgetPackageRegistry, ModuleNamespace } from './globals.js';

/**
 * Minimal shape consumed by the loader — mirrors the protocol's
 * `McpAppAiGguiSessionMeta.gadgets[*]` entry but typed locally so the loader
 * is testable without dragging the protocol package into unit setups.
 */
export interface GadgetRegistration {
  /** Bare npm package name — the registry key the loaded module
   * namespace is stored under, and the bare-specifier load source when
   * `bundleUrl` is absent. */
  readonly package: string;
  /** ggui-hosted ESM bundle URL — preferred load source when present. */
  readonly bundleUrl?: string;
  /** `sha384-<base64>` subresource-integrity hash. When present
   * alongside `bundleUrl`, the loader injects a `<link
   * rel="modulepreload" integrity>` to enforce hash-match on the
   * registry-served bytes before the subsequent dynamic `import()`
   * resolves. Absent → fall back to integrity-less dynamic
   * `import()`. */
  readonly bundleSri?: string;
}

/**
 * Injectable dynamic-importer — production passes
 * `(target) => import(target)`; tests pass a fake that returns a
 * canned module from a Map. Keeping it injectable lets the unit
 * tests pin the merge / collision / failure semantics without
 * touching the network.
 */
export type DynamicImporter = (target: string) => Promise<ModuleNamespace>;

const defaultImporter: DynamicImporter = (target) =>
  import(/* @vite-ignore */ target);

/**
 * Injectable SRI-aware bundle loader. The production path
 * (`defaultIntegrityLoader`) emits a `<link rel="modulepreload"
 * integrity="<sri>" crossorigin="anonymous" href="<url>">` element,
 * waits for the preload to settle (or fail on hash mismatch), then
 * resolves the bundle via a normal dynamic `import(url)` — the
 * `import` call reuses the cached preload bytes, so the integrity
 * gate has already executed by the time the module instantiates.
 *
 * Why preload + import rather than `<script type="module" integrity>`:
 * a plain `<script type="module">` runs the bundle's top-level but
 * its exports are NOT exposed on `globalThis`. The bundle would have
 * to plant exports on a global by side effect — a contract we'd have
 * to invent and document. `link rel="modulepreload"` reuses the same
 * SRI primitive while keeping the import surface a standard module.
 *
 * Import-map integrity (Chrome 127+, draft) is the long-term answer
 * — when it lands universally, we can drop the preload step and
 * declare integrity on the import map. Until then, preload + import
 * is the cross-browser path.
 *
 * Tests inject a fake to assert the emitted element shape without a
 * real DOM round-trip.
 */
export type IntegrityLoader = (args: {
  readonly url: string;
  readonly integrity: string;
  /** Package name — used only in diagnostic messages. */
  readonly name: string;
}) => Promise<ModuleNamespace>;

const defaultIntegrityLoader: IntegrityLoader = ({
  url,
  integrity,
  name,
}) => {
  return new Promise<ModuleNamespace>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(
        new Error(
          `[gadgets] SRI loader requires a document; cannot load '${name}' from '${url}' in this runtime.`,
        ),
      );
      return;
    }
    const link = document.createElement('link');
    link.rel = 'modulepreload';
    link.href = url;
    link.integrity = integrity;
    // crossorigin is REQUIRED for SRI on cross-origin resources (the
    // browser otherwise can't read the response body to hash it).
    // Same-origin requests ignore the attribute, so setting it
    // unconditionally is safe.
    link.crossOrigin = 'anonymous';
    link.addEventListener(
      'load',
      () => {
        // Preload succeeded (network + integrity both passed). Now
        // import the module by URL — the browser dedups to the
        // already-verified bytes. Any subsequent dynamic-import for
        // the same URL also hits the cache.
        import(/* @vite-ignore */ url).then(
          (mod) => resolve(mod as ModuleNamespace),
          (err: unknown) =>
            reject(
              err instanceof Error
                ? err
                : new Error(
                    `[gadgets] post-preload import failed for '${name}' from '${url}'`,
                  ),
            ),
        );
      },
      { once: true },
    );
    link.addEventListener(
      'error',
      () => {
        reject(
          new Error(
            `[gadgets] integrity-load failed for '${name}' from '${url}' (likely SRI mismatch or network failure)`,
          ),
        );
      },
      { once: true },
    );
    document.head.appendChild(link);
  });
};

interface LoaderLogger {
  warn(...args: unknown[]): void;
}

/**
 * Compose the runtime `gadgets` registry — package name → that
 * package's loaded module namespace (GG.8.2).
 *
 * @param stdlibModule   Pre-imported `@ggui-ai/gadgets` module
 *                       namespace. Lands at
 *                       `registry['@ggui-ai/gadgets']` unconditionally.
 * @param registrations  Bootstrap's resolved package catalog (one
 *                       entry per operator-registered 3rd-party
 *                       package).
 * @param opts.importer  Override dynamic-import for tests.
 * @param opts.logger    Override logger sink for tests.
 */
export async function loadGadgetRegistry(
  stdlibModule: ModuleNamespace,
  registrations: readonly GadgetRegistration[],
  opts: {
    readonly importer?: DynamicImporter;
    readonly integrityLoader?: IntegrityLoader;
    readonly logger?: LoaderLogger;
  } = {},
): Promise<GadgetPackageRegistry> {
  const importer = opts.importer ?? defaultImporter;
  const integrityLoader = opts.integrityLoader ?? defaultIntegrityLoader;
  const logger = opts.logger ?? console;

  // Seed with the STDLIB package namespace under its package key. A
  // plain mutable record we populate; the return narrows back to the
  // readonly `GadgetPackageRegistry` shape.
  const registry: Record<string, ModuleNamespace> = {
    '@ggui-ai/gadgets': stdlibModule,
  };

  for (const entry of registrations) {
    if (entry.package in registry) {
      // STDLIB wins; a later duplicate registration for an
      // already-loaded package is also skipped (first wins).
      continue;
    }
    const target = entry.bundleUrl ?? entry.package;
    if (target.length === 0) {
      logger.warn(
        `[gadgets] package '${entry.package}' has an empty load target — skipping.`,
      );
      continue;
    }
    // Registry-published bundles carry an SRI hash. Route through the
    // `<link rel="modulepreload" integrity>` gate so the browser
    // refuses execution on hash mismatch. Falls back to dynamic
    // `import()` when SRI is absent (in-tree packages, hand-authored
    // ggui.json refs).
    //
    // Local hoist to thread the narrowed `bundleUrl` + `bundleSri`
    // through the loader call without re-narrowing inside the ternary
    // (the loader signature wants concrete strings, not unions).
    const sriUrl =
      entry.bundleUrl !== undefined &&
      typeof entry.bundleSri === 'string' &&
      entry.bundleSri.length > 0
        ? { url: entry.bundleUrl, integrity: entry.bundleSri }
        : undefined;
    try {
      const mod =
        sriUrl !== undefined
          ? await integrityLoader({
              url: sriUrl.url,
              integrity: sriUrl.integrity,
              name: entry.package,
            })
          : await importer(target);
      // Store the whole module namespace under the package key — both
      // hook and component exports become reachable through it.
      registry[entry.package] = mod;
    } catch (err) {
      logger.warn(
        `[gadgets] Failed to load package '${entry.package}' from '${target}':`,
        err,
      );
      // Continue with other registrations — one broken package must
      // not block the whole iframe from booting.
    }
  }

  return registry;
}
