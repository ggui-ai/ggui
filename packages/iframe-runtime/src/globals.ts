/**
 * `globalThis.__ggui__` registry setup — the one seam generated
 * component code reads from.
 *
 * The renderer bundles React + ReactDOM + `@ggui-ai/wire` +
 * `@ggui-ai/design` INSIDE itself, then exposes those runtime
 * values on a single
 * `globalThis.__ggui__` object so generated ESM modules can
 * destructure them via the data-URL shim rewrite (see
 * `@ggui-ai/design/rendering/rewrite-imports.ts`).
 *
 * Shape
 * -----
 *
 * ```ts
 * globalThis.__ggui__ = {
 *   react, reactDom,
 *   primitives, components, compositions, interact,
 *   wire,
 * };
 * ```
 *
 * Keys match the `gguiKey` vocabulary the design package's
 * `rewriteImports()` resolves against (`'react'`, `'reactDom'`,
 * `'primitives'`, `'components'`, `'compositions'`, `'interact'`,
 * `'wire'`). Legacy window globals (`__REACT`, `__GGUI_PRIMITIVES`,
 * …) are ALSO populated so data-URL shims that still fall back to
 * the legacy path keep working.
 *
 * TOCTOU footgun
 * --------------
 *
 * Generated code's data-URL ESM module imports resolve synchronously
 * (the shim runs `globalThis.__ggui__[key]` at import time). That
 * means the registry MUST be populated BEFORE any `loadModule()` call
 * evaluates generated code. The boot orchestration in
 * `runtime.ts::bootSequence` enforces this by calling
 * `installGlobalRegistry()` BEFORE the subscribe ack's render mounts.
 * Race-free: Node/browser event loop is single-threaded and no other
 * code runs between `installGlobalRegistry()` and the first render
 * invocation.
 */
import type { Context } from 'react';

// =============================================================================
// Registry shape (internal)
// =============================================================================

/**
 * Module-namespace-compatible shape. Accepts both:
 *   - ES module namespace objects returned by `import(...)` (the
 *     production case; `typeof import('react')` has typed exports).
 *   - Plain records of string keys → unknown (the test case; fakes
 *     stand in for the real module).
 *
 * The mapped-type widening is what frees the real module-namespace
 * types from needing a runtime cast.
 */
export type ModuleNamespace = {
  readonly [key: string]: unknown;
};

/**
 * Gadget-package registry shape — package name → that package's whole
 * loaded module namespace. The runtime `gadgets` slot (GG.8.2). The
 * per-package data-URL shims the rewriter substitutes for gadget
 * imports read `__ggui__.gadgets[package][export]` at call/render time.
 */
export type GadgetPackageRegistry = {
  readonly [packageName: string]: ModuleNamespace;
};

/**
 * Internal type for the object installed at `globalThis.__ggui__`.
 *
 * Intentionally NOT exported from the package's public `index.ts` —
 * generated code doesn't type-check against it (it reads via
 * data-URL shims at runtime). Keeping the type local to the renderer
 * avoids leaking a public contract we'd have to version.
 *
 * Module shapes (`ReactModule` / `ReactDomModule` / design-layer
 * modules) are `readonly Record<string, unknown>` because the
 * generated code's data-URL shims pluck named exports by string key;
 * exhaustively typing every React / design-system export would
 * duplicate the upstream package contracts with zero TS benefit for
 * generated code (which is eval'd, not type-checked). This is NOT the
 * `Record<string, unknown>` anti-pattern — the shape IS unbounded by
 * construction (the whole point is: every import the shim might ask
 * for is present).
 */
export interface GguiGlobalRegistry {
  readonly react: ModuleNamespace;
  readonly reactDom: ModuleNamespace;
  readonly primitives: ModuleNamespace;
  readonly components: ModuleNamespace;
  readonly compositions: ModuleNamespace;
  readonly interact: ModuleNamespace;
  readonly wire: ModuleNamespace;
  /**
   * Design tokens module (`@ggui-ai/design/tokens`). Static design-system
   * constants — color scales, spacing, animation presets, typography
   * styles. Generated component code imports from this path via the
   * data-URL shim, which reads from `globalThis.__ggui__.tokens` at
   * load time. 2026-05-15 audit fix.
   */
  readonly tokens: ModuleNamespace;
  /**
   * Gadget-package registry. Read at call/render time by the
   * per-package data-URL shims that
   * `@ggui-ai/design/rendering/rewrite-imports.ts` substitutes for
   * `@ggui-ai/gadgets` AND each operator-registered gadget package
   * specifier.
   *
   * **Keyed by PACKAGE NAME** (GG.8.2 — e.g. `'@ggui-ai/gadgets'`,
   * `'@ggui-samples/gadget-leaflet'`), each slot holding that
   * package's whole loaded module namespace. The shim for
   * `import { useLeafletMap } from '@ggui-samples/gadget-leaflet'`
   * resolves to `gadgets['@ggui-samples/gadget-leaflet'].useLeafletMap`
   * — package-keyed so two packages exporting the same name never
   * collide.
   *
   * Populated at boot with:
   *   - The whole `@ggui-ai/gadgets` STDLIB namespace under
   *     `gadgets['@ggui-ai/gadgets']` (the seed).
   *   - One namespace per registered 3rd-party package, keyed by
   *     package name, from `loadGadgetRegistry()`'s dynamic imports.
   *
   * Why an open record (no exhaustive type): the operator-registered
   * catalog is dynamic; static typing would force a code-gen step on
   * every operator config change.
   */
  readonly gadgets: GadgetPackageRegistry;
  /**
   * Public env values. Populated by the iframe-runtime's boot
   * sequence from `bootstrap.publicEnv` — the union-filtered subset
   * of `App.publicEnv` declared wrappers' `requires` cover.
   * Read at hook-mount time by `getPublicEnv(key)` from
   * `@ggui-ai/gadgets`.
   *
   * Empty record when the bootstrap has no `publicEnv` field (no
   * wrappers required keys). The hook will throw on access to any
   * key, which is the correct fail-fast behavior — the operator
   * either forgot to configure publicEnv OR the wrapper didn't
   * declare `requires`.
   */
  readonly publicEnv: Readonly<Record<string, string>>;
  /**
   * React Context registry. Populated by
   * `runtime.ts::installContextRegistry()` during boot from the
   * bootstrap's `contextSlots` field. Keyed by PascalCase
   * `contextName` (e.g. `'CurrentStepContext'`). The boilerplate
   * destructures these so the LLM-authored component can wrap a tree
   * in `<CurrentStepContext.Provider value={…}>` and the runtime
   * observer reads values back via `useContext`.
   *
   * Mutable across re-mounts: on a second `bootSelfContained` call,
   * the registry is REUSED (entries are keyed by contextName and
   * skipped on re-create) so the LLM's destructured Context
   * references stay live across re-mounts. Only NEW context names
   * append; existing ones are never replaced.
   */
  readonly contexts: GguiContextRegistry;
}

/**
 * React Context registry installed at `globalThis.__ggui__.contexts`.
 * Open-ended record — the runtime adds one entry per declared
 * `contextSpec` slot at boot, and the boilerplate destructures by
 * `contextName`. Values are typed loosely (`Context<unknown>`) at the
 * registry boundary because each slot's value type is schema-derived;
 * the boilerplate's destructure cast narrows for the LLM's component.
 *
 * Mutable to allow per-slot append on re-mount when a new
 * contextSpec adds a slot the previous mount didn't declare. Existing
 * entries are NEVER replaced — the same Context reference must stay
 * stable across re-mounts so the LLM's destructured component code
 * keeps working.
 */
// eslint-disable-next-line @typescript-eslint/consistent-indexed-object-style
export interface GguiContextRegistry {
  [contextName: string]: Context<unknown>;
}

declare global {
  // TypeScript's `declare global` block only recognizes `var` for
  // hoisted top-level globalThis augmentation; `let`/`const` at this
  // position narrow to the module scope and fail to merge onto
  // `globalThis`. This is the canonical declaration-merging pattern;
  // runtime assignment uses direct globalThis indexing, never `var`.
  // eslint-disable-next-line no-var, vars-on-top
  var __ggui__: GguiGlobalRegistry | undefined;
}

// =============================================================================
// Registry install
// =============================================================================

/**
 * The design package's `rewrite-imports.ts` falls back to legacy
 * window globals (`window.__REACT`, `window.__GGUI_PRIMITIVES`, …)
 * when `globalThis.__ggui__[key]` is absent. We populate BOTH paths
 * so any in-flight cached generated code (which pre-dated the
 * __ggui__ consolidation) keeps resolving.
 *
 * Pre-rebuilt design-package fallback — matches the list today's
 * `ReactComponentRenderer.tsx` sets in the host SDK path.
 */
const LEGACY_GLOBAL_KEYS = {
  react: '__REACT',
  primitives: '__GGUI_PRIMITIVES',
  components: '__GGUI_COMPONENTS',
  compositions: '__GGUI_COMPOSITIONS',
  interact: '__GGUI_INTERACT',
  tokens: '__GGUI_TOKENS',
  // Symmetric with the other layer globals. The rewriter's data-URL
  // shim reads from `globalThis.__ggui__.gadgets` directly (no
  // legacy fallback in the shim), but populating the legacy global
  // keeps console debugging
  // (`window.__GGUI_CLIENT_LIBRARIES.useGeolocation`) working
  // uniformly with the other layers.
  gadgets: '__GGUI_CLIENT_LIBRARIES',
  // Symmetric with the other registry layers. The rewriter's
  // `getPublicEnv` shim reads `globalThis.__ggui__.publicEnv`
  // directly; the legacy global is for console-debugging parity
  // (`window.__GGUI_PUBLIC_ENV.GGUI_PUBLIC_APP_FOO`).
  publicEnv: '__GGUI_PUBLIC_ENV',
} as const;

export interface InstallGlobalRegistryOptions {
  readonly react: ModuleNamespace;
  readonly reactDom: ModuleNamespace;
  readonly primitives: ModuleNamespace;
  readonly components: ModuleNamespace;
  readonly compositions: ModuleNamespace;
  readonly interact: ModuleNamespace;
  readonly wire: ModuleNamespace;
  readonly tokens: ModuleNamespace;
  /**
   * Gadget-package registry — package name → that package's loaded
   * module namespace. Production callers compose this from the
   * `@ggui-ai/gadgets` STDLIB seed plus each operator-registered
   * package's dynamic import (see `loadGadgetRegistry`). Tests pass
   * fakes.
   *
   * Optional: callers may omit this and the registry installs an
   * empty record. Generated code that imports a gadget export then
   * fails at the iframe's ESM module-eval (the rewriter emits a
   * per-package shim only for registered packages). Operators who
   * don't register any 3rd-party packages should leave
   * `clientCapabilities.gadgets` off their contracts.
   */
  readonly gadgets?: GadgetPackageRegistry;
  /**
   * Public env values. Forwarded from `bootstrap.publicEnv`
   * verbatim — the server-side projection already filtered down to
   * the union of declared wrappers' `requires`. Wrappers read via
   * `getPublicEnv(key)` from `@ggui-ai/gadgets`.
   *
   * Optional: callers may omit this and the registry installs an
   * empty record (wrappers that need
   * env values will throw at hook-mount with a clear "not provided"
   * message, which is the right fail-fast behavior).
   */
  readonly publicEnv?: Readonly<Record<string, string>>;
}

/**
 * Install the `globalThis.__ggui__` registry. Idempotent — calling
 * twice replaces the module-slot references wholesale; the `contexts`
 * sub-object is the ONE thing reused across re-installs so the LLM's
 * destructured Context references stay stable. The boot sequence calls
 * this exactly once.
 *
 * Caller supplies every module reference. The renderer's `runtime.ts`
 * does the imports at module-load time and passes the resolved
 * namespaces in; tests pass fakes. Dependency injection rather than
 * hard-coded imports keeps globals.ts free of the heavy React +
 * design + wire module graph — makes unit testing a 200-line file
 * rather than a 150KB bundle slice.
 */
export function installGlobalRegistry(
  opts: InstallGlobalRegistryOptions,
  target: typeof globalThis = globalThis,
): GguiGlobalRegistry {
  // Idempotency on re-mount: the LLM's component holds Context
  // references it destructured from `globalThis.__ggui__.contexts` at
  // first boot. Re-creating the contexts record on every re-mount
  // would invalidate those references. Reuse the existing `contexts`
  // sub-object when present; only the module/wire references swap.
  const existing = (target as { __ggui__?: GguiGlobalRegistry }).__ggui__;
  const contexts: GguiContextRegistry = existing?.contexts ?? {};
  const registry: GguiGlobalRegistry = {
    react: opts.react,
    reactDom: opts.reactDom,
    primitives: opts.primitives,
    components: opts.components,
    compositions: opts.compositions,
    interact: opts.interact,
    wire: opts.wire,
    tokens: opts.tokens,
    // Gadget hooks (STDLIB + registered wrappers). Defaults to an
    // empty record so callers who don't bind libraries don't have to
    // thread the slot — generated code that references a hook in
    // that case fails at the LLM's `useFoo()` call (which is
    // correct: there's no impl to call).
    gadgets: opts.gadgets ?? {},
    // Public env values for wrapper hooks to read via
    // `getPublicEnv(key)`. Defaults to an empty record; wrappers
    // that need values throw clearly at hook-mount.
    publicEnv: opts.publicEnv ?? {},
    contexts,
  };

  // Install the consolidated registry.
  (target as { __ggui__?: GguiGlobalRegistry }).__ggui__ = registry;

  // Also populate the legacy window globals — today's
  // `rewrite-imports.ts` shim path falls back to these when
  // `globalThis.__ggui__[key]` misses. Setting both keeps any
  // pre-registry cached generated code working.
  const win = target as { [k: string]: unknown };
  win[LEGACY_GLOBAL_KEYS.react] = opts.react;
  win[LEGACY_GLOBAL_KEYS.primitives] = opts.primitives;
  win[LEGACY_GLOBAL_KEYS.components] = opts.components;
  win[LEGACY_GLOBAL_KEYS.compositions] = opts.compositions;
  win[LEGACY_GLOBAL_KEYS.interact] = opts.interact;
  win[LEGACY_GLOBAL_KEYS.tokens] = opts.tokens;
  win[LEGACY_GLOBAL_KEYS.gadgets] = registry.gadgets;
  win[LEGACY_GLOBAL_KEYS.publicEnv] = registry.publicEnv;

  return registry;
}

/**
 * Read the current registry. Returns `undefined` when
 * `installGlobalRegistry()` has not yet been called — callers MUST
 * handle the absence honestly rather than assuming.
 */
export function getGlobalRegistry(
  target: typeof globalThis = globalThis,
): GguiGlobalRegistry | undefined {
  return (target as { __ggui__?: GguiGlobalRegistry }).__ggui__;
}
