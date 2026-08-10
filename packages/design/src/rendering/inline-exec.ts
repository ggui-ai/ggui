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

/** Merged design-layer proxy — mirrors the data-URL merge shim. */
function mergedLayersProxy(keys: readonly (readonly [string, string])[]): Record<string, unknown> {
  return namespaceProxy(() => {
    const merged: Record<string, unknown> = {};
    // In-order assign, EXACTLY like the data-URL merge shim's
    // `Object.assign({}, primary, ...fallbacks)` — a later fallback
    // overwrites on collision. Layer export names are disjoint by
    // design, so precedence should never decide a lookup; mirroring
    // the shim keeps the two projections behaviorally identical if
    // one ever collides.
    for (const [gguiKey, legacy] of keys) {
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
 * Name of the handoff object the transformed script reads its
 * `resolve` function from and writes `exports` / `error` / `ran` onto.
 * `loadModuleInline` installs it in TWO places around the synchronous
 * evaluation: as an expando on the script ELEMENT (read via
 * `document.currentScript` — valid for synchronously-evaluated classic
 * scripts, and element identity survives realm splits where a test
 * runtime evaluates injected scripts in a different global than the
 * caller's) and on the caller's global (the fallback for direct
 * `new Function`-style evaluation of the transform's output).
 */
export const INLINE_EXEC_HANDOFF_GLOBAL = '__GGUI_INLINE_EXEC__';

const IDENT = '[A-Za-z_$][\\w$]*';

/**
 * Half-open `[start, end)` spans of string literals, template-literal
 * text chunks, and comments — the positions where import/export-shaped
 * TEXT is content, not syntax.
 */
type LiteralRange = readonly [number, number];

/**
 * Single-pass scan for literal/comment spans. Tracks single/double
 * quotes (with escapes), template literals INCLUDING `${…}` expression
 * nesting (expressions are code — their own nested literals are
 * scanned recursively via the context stack), and line / block
 * comments. Regex literals are NOT tracked (the `/`-versus-division
 * ambiguity needs a full parser); an import/export-shaped sequence
 * inside a regex literal body remains a known limitation — see the
 * transform docstring.
 */
function scanLiteralRanges(code: string): LiteralRange[] {
  const ranges: Array<[number, number]> = [];
  type Ctx =
    | { kind: 'code'; braceDepth: number }
    | { kind: 'sq' | 'dq' | 'line' | 'block'; start: number }
    | { kind: 'tpl'; chunkStart: number };
  const stack: Ctx[] = [{ kind: 'code', braceDepth: 0 }];
  let i = 0;
  while (i < code.length) {
    const top = stack[stack.length - 1];
    const c = code[i];
    const c2 = code.slice(i, i + 2);
    switch (top.kind) {
      case 'code': {
        if (c2 === '//') {
          stack.push({ kind: 'line', start: i });
          i += 2;
          continue;
        }
        if (c2 === '/*') {
          stack.push({ kind: 'block', start: i });
          i += 2;
          continue;
        }
        if (c === "'") stack.push({ kind: 'sq', start: i });
        else if (c === '"') stack.push({ kind: 'dq', start: i });
        else if (c === '`') stack.push({ kind: 'tpl', chunkStart: i });
        else if (c === '{') top.braceDepth++;
        else if (c === '}') {
          if (top.braceDepth === 0 && stack.length > 1) {
            // Closing a `${…}` expression — resume the template chunk.
            stack.pop();
            const tpl = stack[stack.length - 1];
            if (tpl.kind === 'tpl') tpl.chunkStart = i + 1;
          } else {
            top.braceDepth--;
          }
        }
        i++;
        continue;
      }
      case 'sq':
      case 'dq': {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if ((top.kind === 'sq' && c === "'") || (top.kind === 'dq' && c === '"')) {
          ranges.push([top.start, i + 1]);
          stack.pop();
        }
        i++;
        continue;
      }
      case 'line': {
        if (c === '\n') {
          ranges.push([top.start, i]);
          stack.pop();
        }
        i++;
        continue;
      }
      case 'block': {
        if (c2 === '*/') {
          ranges.push([top.start, i + 2]);
          stack.pop();
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      case 'tpl': {
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '`') {
          ranges.push([top.chunkStart, i + 1]);
          stack.pop();
          i++;
          continue;
        }
        if (c2 === '${') {
          ranges.push([top.chunkStart, i]);
          stack.push({ kind: 'code', braceDepth: 0 });
          i += 2;
          continue;
        }
        i++;
        continue;
      }
    }
  }
  // Unterminated literal/comment at EOF — close it at the end so its
  // content still counts as literal.
  const top = stack[stack.length - 1];
  if (top.kind === 'sq' || top.kind === 'dq' || top.kind === 'line' || top.kind === 'block') {
    ranges.push([top.start, code.length]);
  } else if (top.kind === 'tpl') {
    ranges.push([top.chunkStart, code.length]);
  }
  return ranges;
}

function insideAny(ranges: readonly LiteralRange[], index: number): boolean {
  for (const [start, end] of ranges) {
    if (index >= start && index < end) return true;
    if (start > index) break;
  }
  return false;
}

/**
 * `String.replace(regex, fn)` that skips matches STARTING inside a
 * literal/comment span. Ranges are rescanned per call — replacements
 * from an earlier pass introduce their own string literals (specifier
 * arguments, export-name keys), and rescanning makes them opaque to
 * every later pass.
 */
function replaceOutsideLiterals(
  code: string,
  regex: RegExp,
  replacer: (match: string, ...groups: Array<string | undefined>) => string,
): string {
  const ranges = scanLiteralRanges(code);
  return code.replace(regex, (match: string, ...rest: unknown[]) => {
    // `String.replace` callback contract: [...capture groups, offset,
    // whole string] — groups are string|undefined, offset is a number.
    const offset = rest[rest.length - 2];
    if (typeof offset === 'number' && insideAny(ranges, offset)) return match;
    const groups = rest.slice(0, -2) as Array<string | undefined>;
    return replacer(match, ...groups);
  });
}

/** Does `regex` match anywhere OUTSIDE literal/comment spans? */
function testOutsideLiterals(code: string, regex: RegExp): boolean {
  const ranges = scanLiteralRanges(code);
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    if (!insideAny(ranges, m.index)) return true;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return false;
}

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
 *
 * Literal safety: every pass (and both guards) skips matches inside
 * string literals, template-literal text, and comments via
 * {@link scanLiteralRanges} — generated UI copy legitimately contains
 * import/export-shaped text ("export data as CSV", code-sample
 * snippets) and must ride through byte-identical. Known limitation:
 * regex-literal bodies are not tracked (the `/`-vs-division ambiguity
 * needs a parser); an import/export-shaped sequence inside one could
 * still be rewritten. Multi-declarator declaration exports
 * (`export const a = 1, b = 2`) export only the first name — esbuild
 * emits one declarator per exported declaration.
 */
export function transformForInlineExec(code: string): string {
  const handoff = `globalThis.${INLINE_EXEC_HANDOFF_GLOBAL}`;
  let out = code;

  // --- imports -----------------------------------------------------------
  // Named (with optional default): `import D, { a, b as c } from 'spec'`
  out = replaceOutsideLiterals(
    out,
    new RegExp(
      `import\\s*(?:(${IDENT})\\s*,\\s*)?\\{([^}]*)\\}\\s*from\\s*(['"])([^'"]+)\\3\\s*;?`,
      'g',
    ),
    (_m, def, clause, _q, spec) => {
      const parts: string[] = [`var __ggui_m = __ggui_mod(${JSON.stringify(spec)});`];
      if (def !== undefined) parts.push(`var ${def} = __ggui_m["default"];`);
      const destructuring = importClauseToDestructuring(clause ?? '');
      if (destructuring.length > 0) parts.push(`var {${destructuring}} = __ggui_m;`);
      // Block-scope the temp so repeated import statements don't
      // collide on `__ggui_m`.
      return `{${parts.join(' ')}}`;
    },
  );
  // Namespace (with optional default): `import D, * as N from 'spec'`
  out = replaceOutsideLiterals(
    out,
    new RegExp(
      `import\\s*(?:(${IDENT})\\s*,\\s*)?\\*\\s*as\\s+(${IDENT})\\s+from\\s*(['"])([^'"]+)\\3\\s*;?`,
      'g',
    ),
    (_m, def, ns, _q, spec) => {
      const parts = [`var ${ns} = __ggui_mod(${JSON.stringify(spec)});`];
      if (def !== undefined) parts.push(`var ${def} = ${ns}["default"];`);
      return parts.join(' ');
    },
  );
  // Default only: `import D from 'spec'`
  out = replaceOutsideLiterals(
    out,
    new RegExp(`import\\s+(${IDENT})\\s+from\\s*(['"])([^'"]+)\\2\\s*;?`, 'g'),
    (_m, def, _q, spec) => `var ${def} = __ggui_mod(${JSON.stringify(spec)})["default"];`,
  );
  // Bare side-effect import: `import 'spec'` — registry-backed modules
  // have no side effects to run; drop.
  out = replaceOutsideLiterals(
    out,
    new RegExp(`import\\s*(['"])[^'"]+\\1\\s*;?`, 'g'),
    () => '',
  );

  // --- exports -----------------------------------------------------------
  // Re-export statements are not transformable without module machinery.
  if (
    testOutsideLiterals(out, /export\s*\{[^}]*\}\s*from\s*['"]/) ||
    testOutsideLiterals(out, /export\s*\*\s*from\s*['"]/)
  ) {
    throw new Error('inline-exec: re-export statements are not supported in inline execution');
  }
  // `export { a as default, b, c as d };` (esbuild's consolidated tail)
  out = replaceOutsideLiterals(out, /export\s*\{([^}]*)\}\s*;?/g, (_m, clause) => {
    const assignments = (clause ?? '')
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
  // `export default function Name(…)` / `export default class Name` —
  // preserve the NAME as a scope binding: the assignment form turns the
  // declaration into a named expression whose name binds only inside
  // itself, and later top-level references to it would throw.
  out = replaceOutsideLiterals(
    out,
    new RegExp(`export\\s+default\\s+(async\\s+function|function|class)([\\s*]+)(${IDENT})`, 'g'),
    (_m, kw, ws, name) => `var ${name} = __ggui_exp["default"] = ${kw}${ws}${name}`,
  );
  // `export default <anonymous function|class|expr>` — assignment
  // covers the rest.
  out = replaceOutsideLiterals(out, /export\s+default\s/g, () => '__ggui_exp["default"] = ');
  // Declaration exports: strip the keyword, assign at the end (function
  // declarations hoist; const/let/var declarations run in order, and
  // end-of-body assignment reads their settled values).
  const declaredExports: string[] = [];
  out = replaceOutsideLiterals(
    out,
    new RegExp(`export\\s+(async\\s+function|const|let|var|function|class)\\s+(${IDENT})`, 'g'),
    (_m, kw, name) => {
      if (name !== undefined) declaredExports.push(name);
      return `${kw} ${name}`;
    },
  );
  if (testOutsideLiterals(out, /(^|[^.\w$])export\s/)) {
    throw new Error('inline-exec: unrecognized export form survived the rewrite');
  }
  const tail = declaredExports
    .map((name) => `__ggui_exp[${JSON.stringify(name)}] = ${name};`)
    .join(' ');

  return `;(function(){
"use strict";
var __ggui_s = typeof document !== "undefined" ? document.currentScript : null;
var __ggui_h = (__ggui_s && __ggui_s.__gguiInlineExec) || ${handoff};
__ggui_h.ran = true;
var __ggui_mod = __ggui_h.resolve;
var __ggui_exp = __ggui_h.exports;
try {
${out}
${tail}
} catch (e) { __ggui_h.error = e; }
})();`;
}
