// packages/ui-gen/src/check/type-checker.ts
//
// TypeScript type-checker for LLM-generated UI components. Uses the
// TypeScript compiler API with a virtual filesystem to type-check TSX
// code against React types and `@ggui-ai/design` primitives, giving
// the LLM familiar TS error feedback without writing anything to disk.
//
// The checker builds a virtual filesystem seeded with `typescript/lib`,
// `@types/react`, `@ggui-ai/design/dist`, and `@ggui-ai/wire/dist`
// `.d.ts` content, then drives `ts.createProgram` against a synthetic
// `Component.tsx`. Exposed on `@ggui-ai/ui-gen/check` so
// `createUiGenerator` runs the same tier-0 gate as the hosted
// generation path.
//
// Path-resolution note: the three workspace-rooted lookups —
// `.pnpm/@types+react@*`, `packages/design/dist`, and
// `packages/wire/dist` — are anchored relative to this file. tsup
// bundles `src/check/index.ts` (splitting: false) into a flat
// `dist/check/index.js`, so the src and dist locations sit at the same
// depth and both resolve correctly. `typescript/lib/typescript.js`
// keeps using `createRequire(import.meta.url).resolve` —
// position-independent, so no change.
//
// Used by:
//   (1) Tier-0 `type_check` — blocking errors (see BLOCKING_CODES)
//       map to PRODUCTION_FAILED; non-blocking TS diagnostics surface
//       as warnings so the LLM can iterate on non-crash-risk findings
//       without stalling the harness.
//   (2) The `self_check` tool — called from generator SDKs (Anthropic /
//       OpenAI / Google) to give the LLM TS feedback mid-generation.
//   (3) The tier-0 orchestrator `runTier0Checks` — runs in parallel
//       with the wire-preservation + lint checks under the same tier
//       budget.
//
// Design notes that motivate non-obvious choices:
//   - Classic React JSX mode (`ts.JsxEmit.React`). The synthetic
//     prefix (see SYNTHETIC_PREFIX) supplies `import React from
//     'react'` for the classic JSX factory PLUS a self-contained
//     global `JSX` namespace. `@types/react` v19 removed the global
//     `JSX` namespace that classic mode resolves intrinsic elements +
//     the `key`/`ref` carve-out through; without the shim, `<div>`
//     degrades to `any` and every typed component falsely rejects the
//     intrinsic `key` prop. Automatic mode was tried but its
//     `react/jsx-runtime` resolution does not survive the VFS.
//   - `strict: false` + `strictNullChecks: true`: we want the runtime
//     crash classes (`undefined.foo()`, `null.bar`) to surface as
//     blocking, but not the optional-chaining / exhaustive-check
//     noise that full `strict` would emit on LLM code.
//   - `types: []`: prevents the VFS from auto-pulling every
//     `@types/*` package that happens to be hoisted — only react and
//     the design/wire dist types should be reachable, matching the
//     forbidden-import policy enforced by `react-linter` elsewhere.
//   - TS2307 ("Cannot find module") is deliberately NOT blocking —
//     Lambda bundles code without type declarations, so the VFS can't
//     see every package that may exist at runtime. Forbidden imports
//     are caught by `runSelfChecks` regex instead.

import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { describeAllowedImports } from '../validation/allowed-imports.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TypeCheckDiagnostic {
  code: number;
  line: number;
  message: string;
  fix: string;
}

export interface TypeCheckResult {
  errors: TypeCheckDiagnostic[];   // Blocking
  warnings: TypeCheckDiagnostic[]; // Non-blocking
}

// ---------------------------------------------------------------------------
// Blocking error codes — these would break at runtime
// ---------------------------------------------------------------------------

const BLOCKING_CODES = new Set([
  2304, // Cannot find name
  // 2307 (Cannot find module) is NOT blocking — Lambda bundles code without
  // type declarations, so the VFS can't resolve react/@ggui-ai/design.
  // Forbidden imports are caught by runSelfChecks regex instead.
  2305, // Module has no exported member
  2322, // Type not assignable
  2339, // Property does not exist on type
  2741, // Missing required property
  2769, // No overload matches this call
  17004, // Cannot use JSX unless '--jsx' flag
  18047, // 'X' is possibly 'null' — causes runtime crash
  18048, // 'X' is possibly 'undefined' — causes runtime crash
]);

// ---------------------------------------------------------------------------
// Fix suggestions per error code
// ---------------------------------------------------------------------------

function generateFix(code: number, message?: string, sourceLine?: string): string {
  // Source-line hint: when the failing line is short and self-contained,
  // appending it gives the LLM a precise target. Skip for very long lines
  // (>140 chars — usually multi-prop JSX where the line itself is the
  // diagnostic) since they bloat the violation envelope without helping.
  const sourceHint =
    sourceLine && sourceLine.length > 0 && sourceLine.length <= 140
      ? ` Offending line: \`${sourceLine}\``
      : '';

  // Detect event handler on non-interactive primitive
  if ((code === 2322 || code === 2339) && message && /onClick|onDoubleClick|onMouseEnter|onMouseLeave|onPress/.test(message)) {
    return `This structural primitive has no event handlers of its own — add the trait as a PROP: as={Clickable} (then onClick works), imported from @ggui-ai/design. Do NOT wrap it in <Clickable>…</Clickable>; as is a prop, not a wrapper element.${sourceHint}`;
  }

  // Detect underscore-prefix-on-prop trap: `Property '_X' does not exist`.
  // LLM saw an unused-var warning on `X` and tried to silence it by renaming
  // the destructure to `_X`, breaking prop access. Steer back.
  if (code === 2339 && message && /Property '_[a-zA-Z]/.test(message)) {
    return `You renamed a prop with a leading underscore to silence \`no-unused-vars\`, but the prop on \`Props\` doesn't have that prefix. Restore the original name; better, don't destructure props you won't render — access them via \`props.fieldName\` only when needed.${sourceHint}`;
  }

  // Detect "Cannot find name" for destructured props
  if (code === 2304 && message && !message.includes('module') && !message.includes('import')) {
    return `This name is not defined in scope. Either you destructured props (use \`props.fieldName\` directly instead) OR you removed a helper declaration in this patch but kept a JSX/expression reference to it. Read your full patch and either restore the declaration or remove the reference.${sourceHint}`;
  }

  // Detect "unknown is not assignable to ReactNode"
  if ((code === 2322 || code === 2769) && message && /unknown.*ReactNode|ReactNode.*unknown/.test(message)) {
    return `This value has type 'unknown' and cannot be rendered in JSX. Cast it: String(value) or add a type annotation.${sourceHint}`;
  }

  switch (code) {
    case 2307:
      return `Only these imports are allowed: ${describeAllowedImports()}${sourceHint}`;
    case 2322:
    case 2769:
      return `Type mismatch on this expression. Check the offending line below — the prop name in JSX is what TypeScript is rejecting; the message tells you the expected type.${sourceHint}`;
    case 2339:
      return `This prop doesn't exist on this component — check the available props on the component's interface (visible at the top of the file, or in the design-system reference).${sourceHint}`;
    case 2305:
      return `This name is not defined. Check your imports and variable declarations.${sourceHint}`;
    case 2741:
      return `A required prop is missing. Check the component's Props interface.${sourceHint}`;
    case 18047:
    case 18048:
      return `This value might be null/undefined. Every dereference on the same nullable still needs \`?.\` — \`x?.foo && x?.bar\`, NOT \`x?.foo && x.bar\`. Or hoist: \`const v = x; if (!v) return null;\` then access \`v.foo\`/\`v.bar\` unguarded.${sourceHint}`;
    default:
      return `Review the TypeScript error and fix the type issue.${sourceHint}`;
  }
}

// ---------------------------------------------------------------------------
// Virtual Filesystem — lazy singleton
// ---------------------------------------------------------------------------

interface VfsEntry {
  content: string;
  sourceFile: ts.SourceFile;
}

let vfsCache: Map<string, VfsEntry> | null = null;

function parseAndStore(
  vfs: Map<string, VfsEntry>,
  virtualPath: string,
  content: string,
): void {
  const sourceFile = ts.createSourceFile(
    virtualPath,
    content,
    ts.ScriptTarget.ES2020,
    true,
    virtualPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  vfs.set(virtualPath, { content, sourceFile });
}

/**
 * Recursively walk a directory and return all file paths matching a filter.
 */
function walkDir(dir: string, filter: (f: string) => boolean): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(full, filter));
    } else if (filter(full)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Resolve `@types/react`'s root directory through Node's module
 * resolution. Position-independent — walks the consumer's node_modules
 * chain. Works in monorepo (where the type package is hoisted under
 * `<root>/node_modules/.pnpm/@types+react@*`) and in standalone
 * `packages/`-only installs (e.g. the projected public OSS repo where
 * the `packages/` prefix is stripped, so a hardcoded `../../../..`
 * walk lands in the wrong place).
 */
function findReactTypesDir(): string | null {
  try {
    // `@types/react` doesn't expose `package.json` as a public subpath,
    // so resolve via the always-present `index.d.ts`.
    const indexDts = createRequire(import.meta.url).resolve('@types/react/index.d.ts');
    return path.dirname(indexDts);
  } catch {
    return null;
  }
}

/**
 * Resolve a workspace package's `dist/` directory through Node's
 * module resolution. Like `findReactTypesDir`, this works in both
 * monorepo (where the package is hoisted/symlinked) and standalone
 * installs — no relative-path math required.
 */
function findPackageDistDir(pkg: string): string | null {
  try {
    const pkgJson = createRequire(import.meta.url).resolve(`${pkg}/package.json`);
    const dist = path.join(path.dirname(pkgJson), 'dist');
    return fs.existsSync(dist) ? dist : null;
  } catch {
    return null;
  }
}

async function loadVfs(): Promise<Map<string, VfsEntry>> {
  if (vfsCache) return vfsCache;

  const vfs = new Map<string, VfsEntry>();

  // ---- 1. TypeScript lib files ----
  // `createRequire(import.meta.url).resolve('typescript/lib/typescript.js')`
  // is position-independent — it walks the consumer's node_modules chain,
  // so this lookup works identically from core/, packages/ui-gen/, and any
  // future host package.
  const require_ = createRequire(import.meta.url);
  const tsDir = path.dirname(require_.resolve('typescript/lib/typescript.js'));
  const libFiles = fs.readdirSync(tsDir).filter((f) => /^lib\..*\.d\.ts$/.test(f));
  for (const file of libFiles) {
    const content = fs.readFileSync(path.join(tsDir, file), 'utf-8');
    parseAndStore(vfs, file, content);
  }

  // ---- 2. React types ----
  // Resolved through `createRequire(import.meta.url).resolve('@types/
  // react/index.d.ts')` — position-independent. Works the same in
  // monorepo (hoisted to root) and in standalone `packages/`-only
  // installs (the projected public OSS repo strips the `packages/`
  // prefix, so a hardcoded `../../../..` walk would miss).
  const reactDir = findReactTypesDir();
  if (reactDir) {
    const reactDts = fs.readdirSync(reactDir).filter((f) => f.endsWith('.d.ts'));
    for (const file of reactDts) {
      const content = fs.readFileSync(path.join(reactDir, file), 'utf-8');
      parseAndStore(vfs, `node_modules/@types/react/${file}`, content);
    }
  }

  // ---- 3. Design system types ----
  const designDist = findPackageDistDir('@ggui-ai/design');
  if (designDist) {
    const dtsFiles = walkDir(designDist, (f) => f.endsWith('.d.ts') && !f.endsWith('.d.ts.map'));
    for (const file of dtsFiles) {
      const rel = path.relative(designDist, file);
      const content = fs.readFileSync(file, 'utf-8');
      parseAndStore(vfs, `node_modules/@ggui-ai/design/${rel}`, content);
    }
  }

  // ---- 4. Wire module types ----
  const wireDist = findPackageDistDir('@ggui-ai/wire');
  if (wireDist) {
    const dtsFiles = walkDir(wireDist, (f) => f.endsWith('.d.ts') && !f.endsWith('.d.ts.map'));
    for (const file of dtsFiles) {
      const rel = path.relative(wireDist, file);
      const content = fs.readFileSync(file, 'utf-8');
      parseAndStore(vfs, `node_modules/@ggui-ai/wire/${rel}`, content);
    }
  }

  // ---- 5. Gadgets types ----
  // Generated component code direct-imports standard-library gadget
  // hooks — `import { useGeolocation } from '@ggui-ai/gadgets'`.
  // Loading the `@ggui-ai/gadgets` package's shipped `.d.ts` into the
  // VFS makes those bare-named imports resolve against the real hook
  // declarations (named option/return types preserved). The standard
  // gadget hooks are plain named exports the resolver finds directly.
  const clientLibsDist = findPackageDistDir('@ggui-ai/gadgets');
  if (clientLibsDist) {
    const dtsFiles = walkDir(
      clientLibsDist,
      (f) => f.endsWith('.d.ts') && !f.endsWith('.d.ts.map'),
    );
    for (const file of dtsFiles) {
      const rel = path.relative(clientLibsDist, file);
      const content = fs.readFileSync(file, 'utf-8');
      parseAndStore(vfs, `node_modules/@ggui-ai/gadgets/${rel}`, content);
    }
  }

  vfsCache = vfs;
  return vfs;
}

// ---------------------------------------------------------------------------
// Module resolution helper
// ---------------------------------------------------------------------------

/**
 * Try to resolve a relative import within the VFS.
 * Given `containingFile` (e.g. `node_modules/@ggui-ai/design/primitives/index.d.ts`)
 * and `importPath` (e.g. `./Card`), try:
 *   - <resolved>.d.ts
 *   - <resolved>/index.d.ts
 *   - <resolved>.ts
 */
function resolveRelativeInVfs(
  vfs: Map<string, VfsEntry>,
  containingFile: string,
  importPath: string,
): string | undefined {
  // Strip leading '/' from containingFile — TS may prepend getCurrentDirectory()
  const normalized = containingFile.startsWith('/') ? containingFile.slice(1) : containingFile;
  const dir = path.posix.dirname(normalized);
  const resolved = path.posix.normalize(`${dir}/${importPath}`);

  // Try .d.ts extension
  const withDts = `${resolved}.d.ts`;
  if (vfs.has(withDts)) return withDts;

  // Try /index.d.ts
  const withIndexDts = `${resolved}/index.d.ts`;
  if (vfs.has(withIndexDts)) return withIndexDts;

  // Try .ts extension
  const withTs = `${resolved}.ts`;
  if (vfs.has(withTs)) return withTs;

  // Might already be the exact path
  if (vfs.has(resolved)) return resolved;

  return undefined;
}

// ---------------------------------------------------------------------------
// CompilerHost factory
// ---------------------------------------------------------------------------

const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.ESNext,
  // Classic React JSX mode. The synthetic prefix (SYNTHETIC_PREFIX)
  // supplies `import React from 'react'` plus a `declare global` JSX
  // namespace shim: `@types/react` v19 removed the *global* `JSX`
  // namespace (it lives at `React.JSX` now), which classic mode needs
  // for `JSX.IntrinsicElements` and the `key`/`ref` carve-out. Without
  // the shim, `<div>` degrades to `any` and every typed component
  // falsely rejects the intrinsic `key` prop.
  jsx: ts.JsxEmit.React,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: false,
  strictNullChecks: true,  // Catch undefined.foo() errors that cause runtime crashes
  noEmit: true,
  skipLibCheck: true,
  noImplicitAny: true,
  types: [],
  esModuleInterop: true,
};

/**
 * Normalize a path that TS's internal module resolution might generate.
 * Since getCurrentDirectory() returns '/', TS will probe paths like
 * '/node_modules/@types/react/jsx-runtime.d.ts'. We strip the leading
 * '/' to match our VFS keys.
 */
function normalizeVfsPath(f: string): string | null {
  if (f.startsWith('/')) {
    return f.slice(1);
  }
  return null;
}

/**
 * Core module resolution logic shared between resolveModuleNameLiterals
 * (for user imports) and resolveModuleNames (for TS-internal imports
 * like jsxImportSource).
 */
function resolveModuleName(
  vfs: Map<string, VfsEntry>,
  name: string,
  containingFile: string,
): ts.ResolvedModuleWithFailedLookupLocations {
  // React core
  if (name === 'react') {
    return resolved('node_modules/@types/react/index.d.ts');
  }
  if (name === 'react/jsx-runtime') {
    return resolved('node_modules/@types/react/jsx-runtime.d.ts');
  }
  if (name === 'react/jsx-dev-runtime') {
    const p = 'node_modules/@types/react/jsx-dev-runtime.d.ts';
    if (vfs.has(p)) return resolved(p);
    return resolved('node_modules/@types/react/jsx-runtime.d.ts');
  }

  // @ggui-ai/design sub-paths
  const designPrefix = '@ggui-ai/design/';
  if (name.startsWith(designPrefix)) {
    const subpath = name.slice(designPrefix.length);
    const indexPath = `node_modules/@ggui-ai/design/${subpath}/index.d.ts`;
    if (vfs.has(indexPath)) return resolved(indexPath);
    const directPath = `node_modules/@ggui-ai/design/${subpath}.d.ts`;
    if (vfs.has(directPath)) return resolved(directPath);
  }

  // @ggui-ai/design root
  if (name === '@ggui-ai/design') {
    return resolved('node_modules/@ggui-ai/design/index.d.ts');
  }

  // @ggui-ai/wire
  if (name === '@ggui-ai/wire') {
    return resolved('node_modules/@ggui-ai/wire/index.d.ts');
  }

  // @ggui-ai/gadgets — the STDLIB gadget package. Generated
  // code direct-imports the seven STDLIB hooks (`useGeolocation`, …)
  // as plain named exports from this specifier. The shipped `.d.ts`
  // (loaded into the VFS above) carries their real declarations.
  if (name === '@ggui-ai/gadgets') {
    return resolved('node_modules/@ggui-ai/gadgets/index.d.ts');
  }

  // Relative imports — resolve within VFS
  if (name.startsWith('./') || name.startsWith('../')) {
    const resolvedPath = resolveRelativeInVfs(vfs, containingFile, name);
    if (resolvedPath) return resolved(resolvedPath);
  }

  // Third-party gadget wrapper packages. The render handler fetches each
  // non-stdlib gadget's `.d.ts` and `typecheck` overlays it at
  // `node_modules/<package>/index.d.ts`. A generated direct import
  // `import { useX } from '<package>'` resolves through this
  // bare-specifier branch against the overlaid `.d.ts` — named
  // option/return types preserved instead of collapsing to `any`.
  // Generic VFS lookup — no per-package allow-list.
  const bareIndex = `node_modules/${name}/index.d.ts`;
  if (vfs.has(bareIndex)) return resolved(bareIndex);

  // Unknown module
  return { resolvedModule: undefined };
}

function createVfsHost(
  vfs: Map<string, VfsEntry>,
  componentCode: string,
): ts.CompilerHost {
  // Create fresh source file for the user component
  const componentFile = ts.createSourceFile(
    'Component.tsx',
    componentCode,
    ts.ScriptTarget.ES2020,
    true,
    ts.ScriptKind.TSX,
  );

  const host: ts.CompilerHost = {
    getSourceFile(fileName: string) {
      if (fileName === 'Component.tsx') return componentFile;
      const entry = vfs.get(fileName);
      if (entry) return entry.sourceFile;
      // Try normalized path (strip leading '/')
      const normalized = normalizeVfsPath(fileName);
      if (normalized) return vfs.get(normalized)?.sourceFile;
      return undefined;
    },
    getDefaultLibFileName() {
      return 'lib.es2020.full.d.ts';
    },
    writeFile() {
      // no-op
    },
    getCurrentDirectory() {
      return '/';
    },
    getCanonicalFileName(f: string) {
      return f;
    },
    useCaseSensitiveFileNames() {
      return true;
    },
    getNewLine() {
      return '\n';
    },
    fileExists(f: string) {
      if (f === 'Component.tsx' || vfs.has(f)) return true;
      // Normalize bare-specifier lookups that TS's internal resolver
      // turns into relative-looking paths from getCurrentDirectory '/'.
      const normalized = normalizeVfsPath(f);
      if (normalized && vfs.has(normalized)) return true;
      return false;
    },
    readFile(f: string) {
      if (f === 'Component.tsx') return componentCode;
      const direct = vfs.get(f);
      if (direct) return direct.content;
      const normalized = normalizeVfsPath(f);
      if (normalized) return vfs.get(normalized)?.content;
      return undefined;
    },
    resolveModuleNameLiterals(
      moduleLiterals: readonly ts.StringLiteralLike[],
      containingFile: string,
    ): readonly ts.ResolvedModuleWithFailedLookupLocations[] {
      return moduleLiterals.map((literal) =>
        resolveModuleName(vfs, literal.text, containingFile),
      );
    },
  };

  return host;
}

function resolved(resolvedFileName: string): ts.ResolvedModuleWithFailedLookupLocations {
  return {
    resolvedModule: {
      resolvedFileName,
      isExternalLibraryImport: true,
      extension: ts.Extension.Dts,
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function typecheck(
  code: string,
  /**
   * A `package -> .d.ts content` map for third-party gadget wrappers.
   * The render handler parallel-fetches each non-stdlib gadget's `.d.ts`
   * (via `GadgetDescriptor.typesUrl` + SRI) and threads the result
   * here. Each entry is overlaid into the per-call VFS at
   * `node_modules/<package>/index.d.ts`. A generated direct import
   * `import { useX } from '<package>'` resolves through the
   * bare-specifier branch in `resolveModuleName` directly against this
   * overlaid entry — named option/return types preserved, so a
   * wrong-typed hook call surfaces a blocking TS error instead of
   * collapsing to `any`.
   *
   * Stdlib gadgets (`package: '@ggui-ai/gadgets'`) need no entry —
   * `@ggui-ai/gadgets` ships its `.d.ts` into the VFS unconditionally.
   * Omit for standard-library-only callers.
   */
  dtsMap?: Readonly<Record<string, string>>,
): Promise<TypeCheckResult> {
  const vfs = await loadVfs();

  // Overlay each third-party gadget wrapper's `.d.ts` per-call without
  // mutating the cached VFS. The bare-specifier branch in
  // `resolveModuleName` resolves a generated `import { useX } from
  // '<package>'` against the overlaid entry, so the LLM sandbox sees
  // the wrapper's strict hook/component types (named option/return
  // shapes) rather than `any`. A third-party wrapper with no `dtsMap`
  // entry collapses to `any` (TS2307 is non-blocking) — degraded UX,
  // not a generation blocker; the fix is to thread `gadgetTypes`.
  // Stdlib (`@ggui-ai/gadgets`) ships its `.d.ts` unconditionally.
  const effectiveVfs = (() => {
    const dtsEntries = dtsMap !== undefined ? Object.entries(dtsMap) : [];
    if (dtsEntries.length === 0) {
      return vfs;
    }
    const overlay = new Map(vfs);
    for (const [pkg, content] of dtsEntries) {
      parseAndStore(overlay, `node_modules/${pkg}/index.d.ts`, content);
    }
    return overlay;
  })();

  // Prepend a synthetic prefix for classic JSX mode:
  //  - `import React from 'react'` — the classic-mode JSX factory
  //    (`React.createElement`) needs the React namespace in scope.
  //  - a `declare global` JSX shim — `@types/react` v19 dropped the
  //    GLOBAL `JSX` namespace (it is `React.JSX` now); classic mode
  //    resolves intrinsic elements + the `key`/`ref` carve-out through
  //    the global `JSX`, so without this `<div>` degrades to `any` and
  //    every typed component falsely rejects the intrinsic `key` prop.
  //    Mirrors `react/jsx-runtime`'s own JSX namespace, hoisted global.
  // All prefix lines are skipped from diagnostics via `lineOffset`.
  // `@types/react` v19 removed the GLOBAL `JSX` namespace (it lives at
  // `React.JSX` now — un-exported, not reliably reachable through the
  // VFS). Classic JSX mode resolves intrinsic elements + the `key`
  // carve-out through the global `JSX`, so declare a self-contained
  // one. Intrinsic elements are permissive (`[elem]: any`): the
  // type-checker's value is on the design components — which keep
  // their real prop types regardless of this namespace — and on
  // runtime-crash detection, not on deep typing of raw HTML (which the
  // generation prompt discourages anyway).
  const globalJsxShim =
    'declare global { namespace JSX {' +
    ' type ElementType = string | ((props: any) => any) | (new (props: any) => any);' +
    ' interface Element { type: any; props: any; key: string | number | null; }' +
    ' interface ElementClass { render(): any; }' +
    ' interface ElementAttributesProperty { props: object; }' +
    ' interface ElementChildrenAttribute { children: object; }' +
    ' interface IntrinsicAttributes { key?: string | number | bigint | null; }' +
    ' interface IntrinsicClassAttributes<T> { ref?: any; }' +
    ' interface IntrinsicElements { [elem: string]: any; }' +
    ' } }\n';
  const SYNTHETIC_PREFIX = "import React from 'react';\n" + globalJsxShim;
  const prefixedCode = SYNTHETIC_PREFIX + code;
  const lineOffset = SYNTHETIC_PREFIX.split('\n').length - 1;

  const host = createVfsHost(effectiveVfs, prefixedCode);

  const program = ts.createProgram(['Component.tsx'], COMPILER_OPTIONS, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);

  const errors: TypeCheckDiagnostic[] = [];
  const warnings: TypeCheckDiagnostic[] = [];

  for (const diag of diagnostics) {
    // Only report diagnostics from the user's component file
    if (diag.file && diag.file.fileName !== 'Component.tsx') continue;
    // Global diagnostics (no file) — skip as they come from config
    if (!diag.file) continue;
    // Skip diagnostics on the synthetic import prefix line
    const diagLine = ts.getLineAndCharacterOfPosition(diag.file, diag.start ?? 0).line;
    if (diagLine < lineOffset) continue;

    const rawLine = diag.file
      ? ts.getLineAndCharacterOfPosition(diag.file, diag.start ?? 0).line + 1
      : 0;
    // Subtract the synthetic import line to get the user's original line number
    const line = Math.max(1, rawLine - lineOffset);
    const message = ts.flattenDiagnosticMessageText(diag.messageText, '\n');
    const code_ = diag.code;

    // Extract the offending source line for the fix hint — without it
    // "Type 'string' is not assignable to type 'number'" is unactionable
    // because the LLM doesn't know which prop on which primitive. With
    // the line ("<Icon size=\"md\" ...>"), the LLM can target precisely.
    const sourceLines = diag.file.text.split('\n');
    const sourceLine =
      rawLine >= 1 && rawLine <= sourceLines.length
        ? sourceLines[rawLine - 1]?.trim() ?? ''
        : '';

    const entry: TypeCheckDiagnostic = {
      code: code_,
      line,
      message,
      fix: generateFix(code_, message, sourceLine),
    };

    if (BLOCKING_CODES.has(code_)) {
      errors.push(entry);
    } else {
      warnings.push(entry);
    }
  }

  return { errors, warnings };
}
