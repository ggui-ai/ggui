/**
 * Import Rewriter
 *
 * Rewrites bare import specifiers in compiled ESM code to resolve in
 * different rendering contexts. Two modes handle the renderer types:
 *
 * - `data-url` — ReactComponentRenderer (direct React tree, window globals)
 * - `importmap` — Dev-server / serverless (import map handles design packages)
 *
 * A third `blob-url` mode historically targeted an IframeComponentRenderer
 * that rendered generated components inside iframe srcdoc documents. That
 * renderer was retired — all SDK consumers render inline — so the mode was
 * removed along with the iframe path.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RewriteMode = 'data-url' | 'importmap';

/** Options for `data-url` mode (ReactComponentRenderer). */
export interface DataUrlOptions {
  mode: 'data-url';
  /** Window global for React (default: `'__REACT'`) */
  reactGlobal?: string;
  /** Window global for primitives (default: `'__GGUI_PRIMITIVES'`) */
  primitivesGlobal?: string;
  /** Window global for components (default: `'__GGUI_COMPONENTS'`) */
  componentsGlobal?: string;
  /** Window global for compositions (default: `'__GGUI_COMPOSITIONS'`) */
  compositionsGlobal?: string;
  /** Window global for interact (default: `'__GGUI_INTERACT'`) */
  interactGlobal?: string;
  /** Window global for app-components (default: `'__GGUI_APP_COMPONENTS'`) */
  appComponentsGlobal?: string;
  /**
   * Bare npm package names of the operator-registered 3rd-party gadget
   * packages reachable in this render (GG.8.2). Each is rewritten to a
   * per-package data-URL shim resolving `globalThis.__ggui__.gadgets[
   * <package>]`. `@ggui-ai/gadgets` (STDLIB) is ALWAYS rewritten and
   * need not appear here. Defaults to `[]` — STDLIB-only.
   */
  gadgetPackages?: readonly string[];
}


/** Options for `importmap` mode (dev-server / serverless). */
export interface ImportmapOptions {
  mode: 'importmap';
  /** Base URL for React ESM (default: `'https://esm.sh/react@18.2.0'`) */
  reactBaseUrl?: string;
}

export type RewriteOptions = DataUrlOptions | ImportmapOptions;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Known exports from @ggui-ai/wire — public user-facing surface.
 *
 * Drift hazard: this hand-maintained allowlist mirrors the exports of
 * `@ggui-ai/wire`'s root barrel. An LLM-generated component that imports
 * a hook NOT in this list crashes at module-eval with
 * `SyntaxError: ... does not provide an export named '...'` and blanks
 * the iframe. The `verify-shim-allowlists.test.ts` suite enforces that
 * every name here actually exists in the dist module and that every
 * public name in the dist is covered here. */
const WIRE_EXPORTS = [
  // Hooks
  'useAction',
  'useStream',
  'useAuth',
  'useApp',
  'useRender',
  // `useGguiContext` is the contextSpec hook every generated
  // component imports for declared context slots.
  'useGguiContext',
  'useContract',
  'useWireContext',
  // Provider component
  'GguiWireProvider',
] as const;

/** Known exports from @ggui-ai/design/primitives */
const PRIMITIVES_EXPORTS = [
  'Container', 'Card', 'Stack', 'Row', 'Grid', 'Box', 'Divider', 'Spacer',
  'Text', 'Heading', 'Button', 'Input', 'TextArea', 'Select', 'Checkbox',
  'Toggle', 'RadioGroup', 'Slider', 'Badge', 'Spinner', 'Skeleton', 'Avatar',
  'Alert', 'Progress', 'Image', 'Icon', 'Link', 'Tooltip',
  'Table', 'Tabs', 'Toast', 'Accordion',
  'MotionKeyframes', 'useMotion', 'useAnimationKey',
] as const;

/** Known exports from @ggui-ai/design/components */
const COMPONENTS_EXPORTS = [
  'SearchField', 'FormField', 'MenuItem', 'Tag', 'Dropdown',
  'Autocomplete', 'Breadcrumb', 'Pagination', 'EmptyState', 'Stat',
] as const;

/** Known exports from @ggui-ai/design/compositions.
 *
 * Must match `Object.keys(import('@ggui-ai/design/compositions'))` exactly —
 * verify-shim-allowlists.test.ts enforces this. Adding a name that isn't
 * exported by the dist makes the named import resolve to `undefined`
 * (silent runtime crash on render). Omitting an exported name throws
 * `SyntaxError: ... does not provide an export named '…'` at module-eval
 * (blanks the iframe).
 *
 * 2026-05-15 audit fix: dropped phantom `MarketingFeatureGrid`,
 * `MarketingTestimonials`, `MarketingPricing` (never existed in dist) and
 * added missing `MarketingCTA`, `MarketingFeatures` (existed in dist but
 * were unreachable from generated code). */
const COMPOSITIONS_EXPORTS = [
  'Header', 'Sidebar', 'CardGrid', 'CommentThread', 'DataTable',
  'ChatWindow', 'NavigationBar', 'FileUploader', 'UserProfileCard',
  'NotificationCenter', 'Modal', 'CommandPalette', 'Footer', 'Hero',
  'IncidentTimeline', 'MakeTabLayout',
  'MarketingHero', 'MarketingCTA', 'MarketingFeatures',
] as const;

/** Known exports from @ggui-ai/design/interact */
const INTERACT_EXPORTS = [
  'Clickable', 'Hoverable', 'Pressable',
] as const;

/** React hooks and utilities exported by the data-url shim.
 *
 * Curated to user-facing APIs. We intentionally skip internal/test-only
 * exports (`act`, `Profiler`, `__CLIENT_INTERNALS_*`, `__COMPILER_RUNTIME`,
 * `unstable_useCacheRefresh`, etc.) — they're not safe for LLM-generated
 * components and shipping them would normalize fragile patterns. */
const REACT_EXPORTS = [
  // Classic hooks
  'useState',
  'useEffect',
  'useRef',
  'useCallback',
  'useMemo',
  'useContext',
  'useReducer',
  'useId',
  // React 19 user-facing hooks (2026-05-15 audit fix — added)
  'use',
  'useActionState',
  'useOptimistic',
  // Concurrent / advanced hooks
  'useTransition',
  'startTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'useInsertionEffect',
  'useLayoutEffect',
  'useImperativeHandle',
  'useDebugValue',
  // Element / Component primitives
  'createElement',
  'Fragment',
  'Children',
  'cloneElement',
  'createContext',
  'forwardRef',
  'memo',
  'lazy',
  'Suspense',
  'Component',
  'PureComponent',
  'isValidElement',
  'createRef',
] as const;

/** Known exports from @ggui-ai/design/tokens.
 *
 * Tokens are static design-system constants (color scales, spacing values,
 * animation presets, typography styles). The LLM's prompt
 * (`packages/ui-gen/src/design-system-docs.ts`) teaches imports like
 * `import { animation, headingStyles, textStyles } from '@ggui-ai/design/tokens'`;
 * without a shim handler, those bare specifiers escape to the browser and
 * 404, blanking the iframe.
 *
 * 2026-05-15 audit fix: previously NO shim existed for this subpath. */
const TOKENS_EXPORTS = [
  // Animation
  'animation',
  'duration',
  'easing',
  'transition',
  'keyframes',
  'thinkingAnimation',
  'thinkingKeyframes',
  'thinkingPresets',
  'THINKING_DEFAULT_STYLE',
  'motionSafe',
  'reducedMotion',
  'reducedMotionCSS',
  // Color
  'colors',
  'gray',
  'primary',
  'semantic',
  'chartColors',
  'success',
  'warning',
  'error',
  'info',
  'highContrast',
  // Typography
  'typography',
  'fontFamily',
  'fontSize',
  'fontSizeValues',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'headingStyles',
  'textStyles',
  // Layout / shape
  'spacing',
  'spacingValues',
  'radius',
  'shadow',
  'elevation',
  'maxWidth',
  'zIndex',
  // Accessibility
  'accessibility',
  'focusRing',
  // Native (RN parity)
  'nativeTokens',
  // Default barrel export
  'tokens',
] as const;

/**
 * Replace import specifiers in ESM code.
 *
 * Only matches specifiers in actual import contexts:
 *   `from"specifier"`, `from 'specifier'`, `import"specifier"`, `import 'specifier'`
 *
 * This prevents accidental matches inside data-URL shims or string literals
 * that happen to contain the specifier text (e.g. `globalThis.__ggui__['react']`
 * was previously matched when replacing the `react` specifier).
 */
function replaceSpecifier(
  code: string,
  specifier: string,
  replacement: string,
): string {
  // Match: from"spec" | from "spec" | from'spec' | from 'spec'
  code = code.split(`from"${specifier}"`).join(`from"${replacement}"`);
  code = code.split(`from "${specifier}"`).join(`from "${replacement}"`);
  code = code.split(`from'${specifier}'`).join(`from'${replacement}'`);
  code = code.split(`from '${specifier}'`).join(`from '${replacement}'`);
  // Bare imports: import"spec" | import 'spec'
  code = code.split(`import"${specifier}"`).join(`import"${replacement}"`);
  code = code.split(`import "${specifier}"`).join(`import "${replacement}"`);
  code = code.split(`import'${specifier}'`).join(`import'${replacement}'`);
  code = code.split(`import '${specifier}'`).join(`import '${replacement}'`);
  return code;
}

/**
 * Resolve a global name from the consolidated `globalThis.__ggui__` registry
 * with fallback to the legacy `window[name]` globals.
 *
 * The expression tries `globalThis.__ggui__[key]` first, then `window[legacyName]`.
 */
function globalExpr(gguiKey: string, legacyName: string): string {
  // Use DOUBLE quotes inside the shim JS — `encodeURIComponent` encodes
  // `"` (→ `%22`) but does NOT encode `'` (RFC 3986 leaves it unreserved).
  // If we used single quotes here, the inner `'react'` literal would
  // terminate the outer single-quoted `import … from '…'` string,
  // breaking parsing with a silent `SyntaxError: Unexpected identifier
  // 'react'` that gets swallowed by the iframe-runtime's catch-all.
  return `(globalThis.__ggui__&&globalThis.__ggui__["${gguiKey}"]||window["${legacyName}"])`;
}

function buildDataUrlReactShim(globalName: string): string {
  const namedExports = REACT_EXPORTS.map(
    (e) => `export const ${e} = R.${e};`,
  ).join(' ');
  const resolve = globalExpr('react', globalName);
  const js = `const R = ${resolve}; export default R; ${namedExports}`;
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

function buildDataUrlReactDomShim(): string {
  const REACT_DOM_EXPORTS = ['createPortal', 'flushSync', 'unstable_batchedUpdates'];
  const namedExports = REACT_DOM_EXPORTS.map(
    (e) => `export const ${e} = D.${e};`,
  ).join(' ');
  const js = `const D = globalThis.__ggui__["reactDom"]; export default D; ${namedExports}`;
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

function buildDataUrlJsxShim(globalName: string): string {
  // The automatic JSX transform calls jsx(type, props, key) where:
  //   - props.children contains the children
  //   - key is the 3rd argument (optional)
  // React.createElement(type, props, ...children) expects children as positional args.
  // We must bridge the difference: extract children from props and pass them positionally,
  // and set key on the props object.
  const resolve = globalExpr('react', globalName);
  const js = [
    `const R = ${resolve};`,
    `function jsx(t,p,k){`,
      `if(k!==undefined){p={...p,key:k}}`,
      `const c=p.children;`,
      `delete p.children;`,
      `return Array.isArray(c)?R.createElement(t,p,...c):c!==undefined?R.createElement(t,p,c):R.createElement(t,p)`,
    `}`,
    `export{jsx,jsx as jsxs,jsx as jsxDEV};`,
    `export const Fragment=R.Fragment;`,
  ].join('');
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

/**
 * Build a data-url shim that re-exports from a window global.
 * Supports multiple fallback globals so that importing a primitive from
 * the wrong path (e.g., `import { Input } from '@ggui-ai/design/components'`)
 * still resolves correctly.
 *
 * @param globalName - Legacy window global name (e.g. `'__GGUI_PRIMITIVES'`)
 * @param gguiKey - Key on `globalThis.__ggui__` (e.g. `'primitives'`)
 * @param exportNames - Named exports to generate
 * @param fallbackGlobals - Additional legacy globals to merge (for cross-layer imports)
 * @param fallbackGguiKeys - Additional `__ggui__` keys to merge
 */
function buildDataUrlGlobalShim(
  globalName: string,
  gguiKey: string,
  exportNames?: readonly string[],
  fallbackGlobals?: readonly string[],
  fallbackGguiKeys?: readonly string[],
): string {
  if (exportNames && exportNames.length > 0) {
    // Build a merged module from the primary global + fallbacks
    // Try __ggui__ registry first, then legacy window globals
    const globals = [globalName, ...(fallbackGlobals || [])];
    const gguiKeys = [gguiKey, ...(fallbackGguiKeys || [])];
    const resolveExprs = globals.map((g, i) =>
      // Double quotes inside the shim JS — see globalExpr() comment for
      // the encodeURIComponent / single-quote interaction.
      `(globalThis.__ggui__&&globalThis.__ggui__["${gguiKeys[i]}"]||window["${g}"]||{})`,
    );
    const mergeExpr = resolveExprs.join(',');
    const named = exportNames.map(n => `export const ${n} = M["${n}"];`).join(' ');
    const js = resolveExprs.length > 1
      ? `const M = Object.assign({}, ${mergeExpr}); ${named} export default M;`
      : `const M = ${resolveExprs[0]}; ${named} export default M;`;
    return `data:text/javascript,${encodeURIComponent(js)}`;
  }
  // Fallback: Proxy-based default export for unknown export sets
  const resolve = globalExpr(gguiKey, globalName);
  const js = `const M = ${resolve} || {}; const handler = { get(_, key) { return M[key]; } }; export default new Proxy({}, handler);`;
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

/**
 * Build a data-url shim for `@ggui-ai/wire` that re-exports hook functions
 * from `globalThis.__ggui__.wire`.
 */
function buildDataUrlWireShim(): string {
  const named = WIRE_EXPORTS.map(
    (e) => `export const ${e} = w.${e};`,
  ).join(' ');
  const js = `const w = globalThis.__ggui__.wire; ${named} export default w;`;
  return `data:text/javascript,${encodeURIComponent(js)}`;
}

/**
 * Extract the named-import bindings a piece of ESM code imports from
 * one specifier — the SOURCE names (left of `as`), de-duplicated
 * across every `import { … } from '<specifier>'` statement.
 *
 * The per-package gadget shim ({@link buildGadgetPackageShim}) emits a
 * named export per returned name, so the shim provides EXACTLY what the
 * generated code imports — drift-immune by construction (no
 * hand-maintained export allowlist to fall out of sync).
 */
function extractNamedImports(code: string, specifier: string): string[] {
  const esc = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `import { a, b as c } from "spec"` — tolerates an optional default
  // binding before the brace (`import D, { a } from "spec"`), any/no
  // whitespace, and single or double quotes.
  const re = new RegExp(
    `import\\s*(?:[A-Za-z_$][\\w$]*\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*['"]${esc}['"]`,
    'g',
  );
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    for (const raw of m[1].split(',')) {
      // `name` or `name as alias` — the shim exports the SOURCE name.
      const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Build a data-URL shim for one gadget package (GG.8.2).
 *
 * Each `exportName` the generated code imports becomes a real named
 * export resolving the runtime value LAZILY from
 * `globalThis.__ggui__.gadgets[<package>]` — the per-package slot the
 * iframe-runtime's `loadGadgetRegistry` populates:
 *
 *   - PascalCase name → a React component wrapped in a per-component
 *     error boundary. A throwing gadget component renders an inline
 *     fallback instead of nuking the whole host UI.
 *   - any other name (a `use`-prefixed hook, `getPublicEnv`, …) → a
 *     lazy function thunk that forwards to the runtime value at CALL
 *     time. Lazy resolution is robust against the WS-boot path, which
 *     installs 3rd-party package namespaces asynchronously.
 *
 * Both forms throw / render a clear `[gadget] … is not loaded` message
 * when the package failed to load at boot — never a silent `undefined`
 * that crashes deep inside React.
 *
 * `loadGadgets()` is retired — there is no accessor export; generated
 * component code direct-imports each gadget export.
 */
function buildGadgetPackageShim(
  packageName: string,
  exportNames: readonly string[],
): string {
  const pkgLit = JSON.stringify(packageName);
  const hasComponent = exportNames.some((n) => /^[A-Z]/.test(n));
  const parts: string[] = [];
  parts.push(`var P=${pkgLit};`);
  // `NS()` — the package's loaded module namespace (or `{}` pre-load).
  parts.push(
    `function NS(){return(globalThis.__ggui__&&globalThis.__ggui__.gadgets&&globalThis.__ggui__.gadgets[P])||{};}`,
  );
  // `H(name)` — lazy function thunk (hooks + plain functions).
  // The shim JS uses ONLY double quotes — `encodeURIComponent` encodes
  // `"` (→ %22) but leaves `'` intact, so an apostrophe would survive
  // into the data-URL and could terminate a single-quoted outer
  // `import … from '…'` string (see `globalExpr`).
  parts.push(
    `function H(n){return function(){` +
      `var f=NS()[n];` +
      `if(typeof f!=="function")throw new Error("[gadget] export "+n+" from package "+P+" is not loaded — the package failed to load at iframe boot or is not registered on App.gadgets.");` +
      `return f.apply(this,arguments);` +
      `};}`,
  );
  if (hasComponent) {
    // React is needed for the per-component error boundary. `__ggui__`
    // is installed before any generated module evaluates (globals.ts
    // TOCTOU ordering), so `R.Component` is defined here.
    parts.push(`var R=globalThis.__ggui__&&globalThis.__ggui__.react;`);
    parts.push(
      `class GEB extends R.Component{` +
        `constructor(p){super(p);this.state={e:null};}` +
        `static getDerivedStateFromError(e){return{e:e};}` +
        `render(){` +
        `if(this.state.e)return R.createElement("div",{style:{padding:"8px",border:"1px solid #e0a0c0",borderRadius:"6px",color:"#a03070",font:"13px system-ui"}},"[gadget] "+this.props.g+" failed to render");` +
        `return this.props.children;` +
        `}}`,
    );
    // `C(name)` — lazy component wrapped in the error boundary.
    parts.push(
      `function C(n){return function(props){` +
        `var Cmp=NS()[n];` +
        `if(typeof Cmp!=="function")return R.createElement("div",{style:{padding:"8px",border:"1px solid #e0a0c0",borderRadius:"6px",color:"#a03070",font:"13px system-ui"}},"[gadget] component "+n+" from package "+P+" is not loaded");` +
        `return R.createElement(GEB,{g:n},R.createElement(Cmp,props));` +
        `};}`,
    );
  }
  for (const name of exportNames) {
    const factory = /^[A-Z]/.test(name) ? 'C' : 'H';
    parts.push(`export const ${name}=${factory}(${JSON.stringify(name)});`);
  }
  // Default export — Proxy over the package namespace for `import *` /
  // default consumers.
  parts.push(
    `export default new Proxy({},{get:function(_,k){return NS()[k];}});`,
  );
  return `data:text/javascript,${encodeURIComponent(parts.join(''))}`;
}

function rewriteDataUrl(code: string, opts: DataUrlOptions): string {
  const reactGlobal = opts.reactGlobal ?? '__REACT';
  const primitivesGlobal = opts.primitivesGlobal ?? '__GGUI_PRIMITIVES';
  const componentsGlobal = opts.componentsGlobal ?? '__GGUI_COMPONENTS';
  const compositionsGlobal = opts.compositionsGlobal ?? '__GGUI_COMPOSITIONS';
  const interactGlobal = opts.interactGlobal ?? '__GGUI_INTERACT';
  const appComponentsGlobal = opts.appComponentsGlobal ?? '__GGUI_APP_COMPONENTS';

  const reactUrl = buildDataUrlReactShim(reactGlobal);
  const jsxUrl = buildDataUrlJsxShim(reactGlobal);

  // React specifiers
  code = replaceSpecifier(code, 'react/jsx-runtime', jsxUrl);
  code = replaceSpecifier(code, 'react/jsx-dev-runtime', jsxUrl);
  // react-dom (used by bundled components with portals, etc.)
  const reactDomUrl = buildDataUrlReactDomShim();
  code = replaceSpecifier(code, 'react-dom', reactDomUrl);
  code = replaceSpecifier(code, 'react', reactUrl);

  // All known export names across all layers — LLMs sometimes import from the wrong path
  const ALL_EXPORTS = [...PRIMITIVES_EXPORTS, ...COMPONENTS_EXPORTS, ...COMPOSITIONS_EXPORTS, ...INTERACT_EXPORTS] as const;

  // Design package specifiers — each path exports ALL names from ALL layers
  // so `import { Input } from '@ggui-ai/design/components'` still works
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/primitives',
    buildDataUrlGlobalShim(primitivesGlobal, 'primitives', ALL_EXPORTS, [componentsGlobal, compositionsGlobal, interactGlobal], ['components', 'compositions', 'interact']),
  );
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/components',
    buildDataUrlGlobalShim(componentsGlobal, 'components', ALL_EXPORTS, [primitivesGlobal, compositionsGlobal, interactGlobal], ['primitives', 'compositions', 'interact']),
  );
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/compositions',
    buildDataUrlGlobalShim(compositionsGlobal, 'compositions', ALL_EXPORTS, [primitivesGlobal, componentsGlobal, interactGlobal], ['primitives', 'components', 'interact']),
  );
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/interact',
    buildDataUrlGlobalShim(interactGlobal, 'interact', [...INTERACT_EXPORTS]),
  );
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/templates',
    buildDataUrlGlobalShim(compositionsGlobal, 'compositions', ALL_EXPORTS, [primitivesGlobal, componentsGlobal], ['primitives', 'components']),
  );
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/app-components',
    buildDataUrlGlobalShim(appComponentsGlobal, 'appComponents'),
  );

  // Tokens — `@ggui-ai/design/tokens` reads from globalThis.__ggui__.tokens.
  // Static design-system constants (color scales, spacing, animation presets,
  // typography styles). 2026-05-15 audit fix: previously this subpath had NO
  // shim handler, so generated imports like `import {animation} from
  // '@ggui-ai/design/tokens'` escaped to the browser and 404'd, blanking the
  // iframe identically to the useAnimationKey bug. Uses the legacy fallback
  // `__GGUI_TOKENS` for parity with the other layer globals.
  code = replaceSpecifier(
    code,
    '@ggui-ai/design/tokens',
    buildDataUrlGlobalShim('__GGUI_TOKENS', 'tokens', [...TOKENS_EXPORTS]),
  );

  // Bare `@ggui-ai/design` — the barrel, and the ONE design import path
  // the code-gen LLM is taught. Serves ALL_EXPORTS (every layer) just
  // like each subpath shim above. Replaced after the subpaths so their
  // longer specifiers are already rewritten.
  code = replaceSpecifier(
    code,
    '@ggui-ai/design',
    buildDataUrlGlobalShim(primitivesGlobal, 'primitives', ALL_EXPORTS, [componentsGlobal, compositionsGlobal, interactGlobal], ['components', 'compositions', 'interact']),
  );

  // Wire hooks — `@ggui-ai/wire` reads from globalThis.__ggui__.wire
  code = replaceSpecifier(code, '@ggui-ai/wire', buildDataUrlWireShim());

  // Gadget packages (GG.8.2) — `@ggui-ai/gadgets` (STDLIB, always
  // rewritten: its STDLIB hooks + `getPublicEnv` may be imported
  // regardless of whether the contract declares 3rd-party gadgets)
  // plus each operator-registered 3rd-party package threaded via
  // `opts.gadgetPackages`. Each rewrites to a per-package data-URL
  // shim whose named exports are derived from the generated code's own
  // import statement — drift-immune (no export allowlist to maintain).
  const gadgetPackages = [
    ...new Set(['@ggui-ai/gadgets', ...(opts.gadgetPackages ?? [])]),
  ];
  for (const pkg of gadgetPackages) {
    const names = extractNamedImports(code, pkg);
    code = replaceSpecifier(code, pkg, buildGadgetPackageShim(pkg, names));
  }

  return code;
}

// ---------------------------------------------------------------------------
// importmap mode
// ---------------------------------------------------------------------------

function rewriteImportmap(code: string, opts: ImportmapOptions): string {
  const base = opts.reactBaseUrl ?? 'https://esm.sh/react@18.2.0';

  // Only rewrite React specifiers — import map handles @ggui-ai/design/*
  code = replaceSpecifier(code, 'react/jsx-runtime', `${base}/jsx-runtime`);
  code = replaceSpecifier(code, 'react/jsx-dev-runtime', `${base}/jsx-runtime`);
  code = replaceSpecifier(code, 'react', base);

  return code;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Rewrite bare import specifiers in compiled ESM code.
 *
 * @param code - Compiled ESM code with bare `import` specifiers
 * @param options - Rewrite mode and mode-specific configuration
 * @returns Code with specifiers replaced according to the chosen mode
 */
export function rewriteImports(code: string, options: RewriteOptions): string {
  switch (options.mode) {
    case 'data-url':
      return rewriteDataUrl(code, options);
    case 'importmap':
      return rewriteImportmap(code, options);
  }
}
