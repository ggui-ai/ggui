/**
 * Inline execution — CSP-resilient fallback for compiled component code.
 *
 * The primary execution path (`module-loader.ts`) imports compiled ESM
 * through a `blob:` URL, with bare specifiers rewritten to `data:` URL
 * shims (`rewrite-imports.ts`, `data-url` mode). Both URL schemes are
 * governed by CSP `script-src`, and a host page whose policy grants only
 * `'unsafe-inline'` blocks them while still executing inline `<script>`
 * elements. This module is the execution path for exactly that
 * environment: it turns the compiled module into classic-script text
 * (imports → bindings resolved from the same `globalThis.__ggui__`
 * registry the data-URL shims read; exports → assignments onto a
 * handoff object) and runs it as a synchronously-evaluated inline
 * script.
 *
 * Split of responsibilities:
 *   - {@link resolveInlineSpecifier} — the runtime twin of the data-URL
 *     shim builders in `rewrite-imports.ts`. One specifier → one
 *     namespace-like object with the SAME lookup semantics (registry
 *     key + legacy window-global fallback, layer merging, jsx bridge,
 *     lazy gadget thunks). Kept in the same package as the shim
 *     builders so the two projections of the specifier map are
 *     reviewed together.
 *   - {@link transformForInlineExec} — specifier-agnostic source
 *     transform: import declarations become `var` bindings against the
 *     handoff's `resolve`, export declarations become assignments onto
 *     the handoff's `exports`, and the whole body is wrapped in a
 *     strict-mode IIFE with an internal try/catch (a classic script's
 *     top-level throw never reaches the code that inserted the script
 *     element, so the error must travel through the handoff).
 *
 * Like `replaceSpecifier`/`hoistImports`, the transform operates on
 * string level and assumes machine-generated (esbuild-shaped) module
 * code: import/export declarations it does not recognize after the
 * rewrite make it throw rather than execute a half-transformed module.
 */

// ---------------------------------------------------------------------------
// Registry access (runtime twin of `globalExpr` in rewrite-imports.ts)
// ---------------------------------------------------------------------------

interface GguiRegistry {
  readonly [key: string]: unknown;
}

function registry(): GguiRegistry {
  const reg = (globalThis as { __ggui__?: GguiRegistry }).__ggui__;
  return reg ?? {};
}

/** `globalThis.__ggui__[key]` with the legacy `window[name]` fallback. */
function layered(gguiKey: string, legacyName?: string): Record<string, unknown> {
  const fromRegistry = registry()[gguiKey];
  if (fromRegistry !== undefined && fromRegistry !== null) {
    return fromRegistry as Record<string, unknown>;
  }
  if (legacyName !== undefined && typeof window !== 'undefined') {
    const legacy = (window as unknown as Record<string, unknown>)[legacyName];
    if (legacy !== undefined && legacy !== null) {
      return legacy as Record<string, unknown>;
    }
  }
  return {};
}

/**
 * Namespace proxy: `default` resolves to the underlying object itself
 * (matching the data-URL shims' `export default M`), every other key
 * reads through lazily so registry population order does not matter.
 */
function namespaceProxy(resolve: () => Record<string, unknown>): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, key: string | symbol) {
        if (typeof key !== 'string') return undefined;
        const ns = resolve();
        if (key === 'default') return ns;
        return ns[key];
      },
      has() {
        return true;
      },
    },
  );
}

/** Merged design-layer proxy — first namespace carrying the key wins. */
function mergedLayersProxy(keys: readonly (readonly [string, string])[]): Record<string, unknown> {
  return namespaceProxy(() => {
    const merged: Record<string, unknown> = {};
    // Later layers first so the PRIMARY (first entry) overwrites on
    // collision — same precedence as `Object.assign({}, ...reversed)`
    // in the data-URL merge shim.
    for (let i = keys.length - 1; i >= 0; i--) {
      const [gguiKey, legacy] = keys[i];
      Object.assign(merged, layered(gguiKey, legacy));
    }
    return merged;
  });
}

// Layer tables — mirror `rewriteDataUrl`'s per-subpath fallback order.
const PRIMITIVES: readonly [string, string] = ['primitives', '__GGUI_PRIMITIVES'];
const COMPONENTS: readonly [string, string] = ['components', '__GGUI_COMPONENTS'];
const COMPOSITIONS: readonly [string, string] = ['compositions', '__GGUI_COMPOSITIONS'];
const INTERACT: readonly [string, string] = ['interact', '__GGUI_INTERACT'];

// ---------------------------------------------------------------------------
// jsx bridge (runtime twin of `buildDataUrlJsxShim`)
// ---------------------------------------------------------------------------

interface MinimalReact {
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  Fragment: unknown;
  Component: new (props: unknown) => {
    props: { children?: unknown; g?: string };
    state: { e: unknown };
  };
}

function jsxRuntimeNamespace(): Record<string, unknown> {
  const react = (): MinimalReact => layered('react', '__REACT') as unknown as MinimalReact;
  const jsx = (type: unknown, props: Record<string, unknown> | null, key?: unknown): unknown => {
    const R = react();
    let p: Record<string, unknown> = props ?? {};
    if (key !== undefined) p = { ...p, key };
    else p = { ...p };
    const children = p.children;
    delete p.children;
    if (Array.isArray(children)) return R.createElement(type, p, ...children);
    if (children !== undefined) return R.createElement(type, p, children);
    return R.createElement(type, p);
  };
  return namespaceProxy(() => ({
    jsx,
    jsxs: jsx,
    jsxDEV: jsx,
    get Fragment() {
      return react().Fragment;
    },
  }));
}

// ---------------------------------------------------------------------------
// Gadget namespaces (runtime twin of `buildGadgetPackageShim`)
// ---------------------------------------------------------------------------

function gadgetNamespace(packageName: string): Record<string, unknown> {
  const ns = (): Record<string, unknown> => {
    const gadgets = registry().gadgets as Record<string, Record<string, unknown>> | undefined;
    return gadgets?.[packageName] ?? {};
  };
  // Per-name caches keep component identity stable across re-renders of
  // one mount — matching the once-per-module-eval binding the data-URL
  // shim provides.
  const componentCache = new Map<string, unknown>();
  const thunkCache = new Map<string, unknown>();

  const lazyThunk = (name: string): unknown => {
    let cached = thunkCache.get(name);
    if (cached === undefined) {
      cached = function (this: unknown, ...args: unknown[]) {
        const f = ns()[name];
        if (typeof f !== 'function') {
          throw new Error(
            `[gadget] export ${name} from package ${packageName} is not loaded — the package failed to load at iframe boot or is not registered on App.gadgets.`,
          );
        }
        return f.apply(this, args);
      };
      thunkCache.set(name, cached);
    }
    return cached;
  };

  const failBox = (R: MinimalReact, text: string): unknown =>
    R.createElement(
      'div',
      {
        style: {
          padding: '8px',
          border: '1px solid #e0a0c0',
          borderRadius: '6px',
          color: '#a03070',
          font: '13px system-ui',
        },
      },
      text,
    );

  const lazyComponent = (name: string): unknown => {
    let cached = componentCache.get(name);
    if (cached === undefined) {
      cached = function GadgetInline(props: Record<string, unknown>) {
        const R = layered('react', '__REACT') as unknown as MinimalReact;
        const Cmp = ns()[name];
        if (typeof Cmp !== 'function') {
          return failBox(R, `[gadget] component ${name} from package ${packageName} is not loaded`);
        }
        const Boundary = gadgetBoundary(R);
        return R.createElement(Boundary, { g: name }, R.createElement(Cmp, props));
      };
      componentCache.set(name, cached);
    }
    return cached;
  };

  // One boundary class per React identity (a registry swap mid-session
  // would otherwise pin a stale React).
  let boundaryFor: { react: MinimalReact; cls: unknown } | undefined;
  const gadgetBoundary = (R: MinimalReact): never => {
    if (boundaryFor === undefined || boundaryFor.react !== R) {
      class GadgetErrorBoundary extends R.Component {
        constructor(props: unknown) {
          super(props);
          this.state = { e: null };
        }
        static getDerivedStateFromError(e: unknown) {
          return { e };
        }
        render() {
          if (this.state.e) {
            return failBox(R, `[gadget] ${String(this.props.g)} failed to render`);
          }
          return this.props.children;
        }
      }
      boundaryFor = { react: R, cls: GadgetErrorBoundary };
    }
    return boundaryFor.cls as never;
  };

  return new Proxy(
    {},
    {
      get(_t, key: string | symbol) {
        if (typeof key !== 'string') return undefined;
        if (key === 'default') {
          return new Proxy({}, { get: (_d, k) => (typeof k === 'string' ? ns()[k] : undefined) });
        }
        return /^[A-Z]/.test(key) ? lazyComponent(key) : lazyThunk(key);
      },
      has() {
        return true;
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

/** Options for {@link resolveInlineSpecifier} / {@link transformForInlineExec} consumers. */
export interface InlineExecOptions {
  /**
   * Bare npm package names of operator-registered 3rd-party gadget
   * packages reachable in this render — same contract as
   * `DataUrlOptions.gadgetPackages`. `@ggui-ai/gadgets` is always
   * resolvable and need not appear here.
   */
  readonly gadgetPackages?: readonly string[];
}

/**
 * Resolve one bare import specifier to a namespace-like object with the
 * same semantics the corresponding `data-url` shim module would have.
 * Throws for a specifier the data-URL mode would not rewrite either —
 * an unknown bare specifier cannot be resolved without the network.
 */
export function resolveInlineSpecifier(
  specifier: string,
  opts?: InlineExecOptions,
): Record<string, unknown> {
  switch (specifier) {
    case 'react':
      return namespaceProxy(() => layered('react', '__REACT'));
    case 'react/jsx-runtime':
    case 'react/jsx-dev-runtime':
      return jsxRuntimeNamespace();
    case 'react-dom':
      return namespaceProxy(() => layered('reactDom'));
    case '@ggui-ai/design':
    case '@ggui-ai/design/primitives':
      return mergedLayersProxy([PRIMITIVES, COMPONENTS, COMPOSITIONS, INTERACT]);
    case '@ggui-ai/design/components':
      return mergedLayersProxy([COMPONENTS, PRIMITIVES, COMPOSITIONS, INTERACT]);
    case '@ggui-ai/design/compositions':
      return mergedLayersProxy([COMPOSITIONS, PRIMITIVES, COMPONENTS, INTERACT]);
    case '@ggui-ai/design/interact':
      return mergedLayersProxy([INTERACT]);
    case '@ggui-ai/design/templates':
      return mergedLayersProxy([COMPOSITIONS, PRIMITIVES, COMPONENTS]);
    case '@ggui-ai/design/app-components':
      return namespaceProxy(() => layered('appComponents', '__GGUI_APP_COMPONENTS'));
    case '@ggui-ai/design/tokens':
      return namespaceProxy(() => layered('tokens', '__GGUI_TOKENS'));
    case '@ggui-ai/wire':
      return namespaceProxy(() => layered('wire'));
    default: {
      if (specifier === '@ggui-ai/gadgets' || (opts?.gadgetPackages ?? []).includes(specifier)) {
        return gadgetNamespace(specifier);
      }
      throw new Error(
        `inline-exec: cannot resolve bare specifier "${specifier}" — not a registry-backed module. ` +
          'Fetch-free execution can only resolve the design-system, wire, react, and registered gadget packages.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Source transform
// ---------------------------------------------------------------------------

/**
 * Name of the window-scoped handoff object the transformed script reads
 * its `resolve` function from and writes `exports` / `error` / `ran`
 * onto. Installed and removed by `loadModuleInline` around the
 * synchronous script evaluation.
 */
export const INLINE_EXEC_HANDOFF_GLOBAL = '__GGUI_INLINE_EXEC__';

const IDENT = '[A-Za-z_$][\\w$]*';

/** `a, b as c` (import form) → `a, b: c` (destructuring form). */
function importClauseToDestructuring(clause: string): string {
  return clause
    .split(',')
    .map((part) => {
      const trimmed = part.trim();
      if (trimmed.length === 0) return undefined;
      const asMatch = trimmed.match(new RegExp(`^(${IDENT})\\s+as\\s+(${IDENT})$`));
      if (asMatch) return `${asMatch[1]}: ${asMatch[2]}`;
      return trimmed;
    })
    .filter((p): p is string => p !== undefined)
    .join(', ');
}

/**
 * Rewrite compiled ESM into classic-script text executable under a CSP
 * that permits only inline scripts. Pure text transform; see the module
 * docstring for scope and limitations. Throws when an import/export
 * form survives the rewrite (re-export statements, unrecognized
 * clauses) — executing a half-transformed module would fail in a far
 * less diagnosable way.
 */
export function transformForInlineExec(code: string): string {
  const handoff = `globalThis.${INLINE_EXEC_HANDOFF_GLOBAL}`;
  let out = code;

  // --- imports -----------------------------------------------------------
  // Named (with optional default): `import D, { a, b as c } from 'spec'`
  out = out.replace(
    new RegExp(
      `import\\s*(?:(${IDENT})\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*(['"])([^'"]+)\\3\\s*;?`,
      'g',
    ),
    (_m, def: string | undefined, clause: string, _q: string, spec: string) => {
      const parts: string[] = [`var __ggui_m = __ggui_mod(${JSON.stringify(spec)});`];
      if (def !== undefined) parts.push(`var ${def} = __ggui_m["default"];`);
      const destructuring = importClauseToDestructuring(clause);
      if (destructuring.length > 0) parts.push(`var {${destructuring}} = __ggui_m;`);
      // Block-scope the temp so repeated import statements don't
      // collide on `__ggui_m`.
      return `{${parts.join(' ')}}`;
    },
  );
  // Namespace (with optional default): `import D, * as N from 'spec'`
  out = out.replace(
    new RegExp(
      `import\\s*(?:(${IDENT})\\s*,\\s*)?\\*\\s*as\\s+(${IDENT})\\s+from\\s*(['"])([^'"]+)\\3\\s*;?`,
      'g',
    ),
    (_m, def: string | undefined, ns: string, _q: string, spec: string) => {
      const parts = [`var ${ns} = __ggui_mod(${JSON.stringify(spec)});`];
      if (def !== undefined) parts.push(`var ${def} = ${ns}["default"];`);
      return parts.join(' ');
    },
  );
  // Default only: `import D from 'spec'`
  out = out.replace(
    new RegExp(`import\\s+(${IDENT})\\s+from\\s*(['"])([^'"]+)\\2\\s*;?`, 'g'),
    (_m, def: string, _q: string, spec: string) =>
      `var ${def} = __ggui_mod(${JSON.stringify(spec)})["default"];`,
  );
  // Bare side-effect import: `import 'spec'` — registry-backed modules
  // have no side effects to run; drop.
  out = out.replace(new RegExp(`import\\s*(['"])[^'"]+\\1\\s*;?`, 'g'), '');

  // --- exports -----------------------------------------------------------
  // Re-export statements are not transformable without module machinery.
  if (/export\s*\{[^}]*\}\s*from\s*['"]/.test(out) || /export\s*\*\s*from\s*['"]/.test(out)) {
    throw new Error('inline-exec: re-export statements are not supported in inline execution');
  }
  // `export { a as default, b, c as d };` (esbuild's consolidated tail)
  out = out.replace(/export\s*\{([^}]*)\}\s*;?/g, (_m, clause: string) => {
    const assignments = clause
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (trimmed.length === 0) return undefined;
        const asMatch = trimmed.match(new RegExp(`^(${IDENT})\\s+as\\s+(${IDENT})$`));
        if (asMatch) return `__ggui_exp[${JSON.stringify(asMatch[2])}] = ${asMatch[1]};`;
        return `__ggui_exp[${JSON.stringify(trimmed)}] = ${trimmed};`;
      })
      .filter((p): p is string => p !== undefined);
    return assignments.join(' ');
  });
  // `export default <function|class|expr>` — assignment covers all three.
  out = out.replace(/export\s+default\s/g, '__ggui_exp["default"] = ');
  // Declaration exports: strip the keyword, assign at the end (function
  // declarations hoist; const/let/var declarations run in order, and
  // end-of-body assignment reads their settled values).
  const declaredExports: string[] = [];
  out = out.replace(
    new RegExp(`export\\s+(const|let|var|function|class)\\s+(${IDENT})`, 'g'),
    (_m, kw: string, name: string) => {
      declaredExports.push(name);
      return `${kw} ${name}`;
    },
  );
  if (/(^|[^.\w$'"`])export\s/.test(out)) {
    throw new Error('inline-exec: unrecognized export form survived the rewrite');
  }
  const tail = declaredExports
    .map((name) => `__ggui_exp[${JSON.stringify(name)}] = ${name};`)
    .join(' ');

  return `;(function(){
"use strict";
var __ggui_h = ${handoff};
__ggui_h.ran = true;
var __ggui_mod = __ggui_h.resolve;
var __ggui_exp = __ggui_h.exports;
try {
${out}
${tail}
} catch (e) { __ggui_h.error = e; }
})();`;
}
