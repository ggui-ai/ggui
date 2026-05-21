// packages/ui-gen/src/internal/extract-call-signatures.ts
//
// Internal gadget-signature extractor.
//
// Uses the TypeScript Compiler API to parse an in-memory wrapper `.d.ts`
// STRING and, for each requested export, print a prompt-ready type:
//
//   - `extractCallSignaturesFromDts` — for HOOK exports, prints the
//     callable signature as a self-contained TS function-type
//     expression (`(options?: { center: [number, number]; zoom: number })
//     => GadgetHookResult<...>`).
//   - `extractComponentPropsFromDts` (GG.8.5) — for COMPONENT exports,
//     prints the props-object shape (the first parameter's type,
//     structurally expanded) so the prompt can teach the LLM the JSX
//     props of `<Chart data={…} height={…} />`.
//
// Both take the wrapper's already-built `.d.ts` content AS A STRING —
// the push handler fetches each non-stdlib gadget's `.d.ts` over HTTPS
// and threads a `package -> dtsContent` map into the generator
// (`UiGenerateInput.gadgetTypes`). The code-gen prompt builder calls
// these helpers to render a `Type:` / `Props:` line per third-party
// gadget so the LLM sees the real shape it otherwise can't know.
//
// Internal only — NOT re-exported from any public package entry. Lives
// under `src/internal/` deliberately.

import ts from 'typescript';

/**
 * Map of `hookName → call-signature string` produced by
 * {@link extractCallSignaturesFromDts}. Each value is a printed
 * function-type expression suitable for verbatim interpolation into a
 * prompt `Type:` line.
 *
 * Hooks whose signature could not be resolved are omitted — the caller
 * renders a `Type:` line only for hooks that appear here.
 */
export type CallSignatureMap = Record<string, string>;

/**
 * Map of `componentName → props-object type string` produced by
 * {@link extractComponentPropsFromDts}. Each value is a printed object
 * type (`{ data: …; height?: number }`) suitable for a prompt `Props:`
 * line. Components whose props could not be resolved are omitted.
 */
export type ComponentPropsMap = Record<string, string>;

// In-memory `.d.ts` is parsed under a synthetic file name. The leading
// `/` matches the convention `getCurrentDirectory()` (also `/`) so the
// compiler host's path probes line up.
const VIRTUAL_DTS_PATH = '/__gadget__.d.ts';

const EXTRACTOR_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: false,
  jsx: ts.JsxEmit.ReactJSX,
  noEmit: true,
  esModuleInterop: true,
  // skipLibCheck so an unresolvable wrapper-internal import (the
  // sandbox doesn't carry the wrapper's transitive deps) doesn't abort
  // the program before we can read the symbol's callable signature.
  skipLibCheck: true,
  strict: true,
};

/**
 * Process-lifetime memos. Building a `ts.Program` — including
 * default-lib reads — on every call is expensive, and each extractor is
 * invoked once per coding-agent turn while the `.d.ts` content + name
 * set stay constant across a generation. Keying on `(dtsContent, names)`
 * collapses the repeated work. The key set is tiny in practice (a
 * handful of gadgets per process).
 */
const callSignatureCache = new Map<string, CallSignatureMap>();
const componentPropsCache = new Map<string, ComponentPropsMap>();

/**
 * One-shot extractor program for a wrapper `.d.ts`, with the resolved
 * call signatures of every requested export. Shared by both public
 * extractors — they differ only in how they format the result.
 */
interface ExtractorContext {
  readonly checker: ts.TypeChecker;
  /** Render a `ts.Type` as a self-contained, prompt-ready expression. */
  readonly renderType: (t: ts.Type, depth: number) => string;
  /**
   * Requested export name → its resolved call signatures, in
   * declaration order. Only exports that are callable (a hook or a
   * function component) appear; non-callable exports are omitted.
   */
  readonly signaturesByName: ReadonlyMap<string, readonly ts.Signature[]>;
}

/**
 * Build a single-file TS Program over `dtsContent`, resolve the call
 * signatures of every requested export name, and expose the checker +
 * a structural type renderer. Returns `undefined` when the `.d.ts`
 * cannot be parsed.
 */
function buildExtractorContext(
  dtsContent: string,
  names: readonly string[],
): ExtractorContext | undefined {
  // Build a fresh `.d.ts` source file. `setParentNodes: true` is
  // required so the checker can walk the AST.
  const sourceFile = ts.createSourceFile(
    VIRTUAL_DTS_PATH,
    dtsContent,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  // Minimal in-memory compiler host. Only the synthetic `.d.ts` plus
  // the TS default lib files are resolvable; everything else is absent
  // (skipLibCheck keeps that from aborting the program). The checker
  // still resolves intra-file named types, which is all structural
  // fallback needs to inline a self-contained signature.
  const defaultLibName = ts.getDefaultLibFileName(EXTRACTOR_COMPILER_OPTIONS);
  const host: ts.CompilerHost = {
    getSourceFile(fileName) {
      if (fileName === VIRTUAL_DTS_PATH) return sourceFile;
      // Default lib(s) — load from the real `typescript` install so the
      // checker has `lib.d.ts` ambient types. The dts may not need
      // them, but the program won't run without a default lib.
      const libContent = ts.sys.readFile(
        ts.getDefaultLibFilePath(EXTRACTOR_COMPILER_OPTIONS).replace(
          /[^/\\]+$/,
          fileName,
        ),
      );
      if (libContent !== undefined) {
        return ts.createSourceFile(
          fileName,
          libContent,
          ts.ScriptTarget.ESNext,
          true,
          ts.ScriptKind.TS,
        );
      }
      return undefined;
    },
    getDefaultLibFileName() {
      return defaultLibName;
    },
    writeFile() {
      // no-op — noEmit
    },
    getCurrentDirectory() {
      return '/';
    },
    getCanonicalFileName(f) {
      return f;
    },
    useCaseSensitiveFileNames() {
      return true;
    },
    getNewLine() {
      return '\n';
    },
    fileExists(f) {
      if (f === VIRTUAL_DTS_PATH) return true;
      return ts.sys.fileExists(f);
    },
    readFile(f) {
      if (f === VIRTUAL_DTS_PATH) return dtsContent;
      return ts.sys.readFile(f);
    },
  };

  const program = ts.createProgram(
    [VIRTUAL_DTS_PATH],
    EXTRACTOR_COMPILER_OPTIONS,
    host,
  );
  const checker = program.getTypeChecker();
  const parsed = program.getSourceFile(VIRTUAL_DTS_PATH);
  if (parsed === undefined) {
    return undefined;
  }

  const requested = new Set(names);

  // True when a symbol's declaration originates from the wrapper's own
  // `.d.ts`. Only THESE named types get structurally expanded — types
  // from the TS DOM lib (`HTMLDivElement`), `@ggui-ai/gadgets`
  // (`GadgetHookResult`), or any external package keep their name,
  // because (a) the LLM already knows DOM / ggui types and (b)
  // expanding `HTMLDivElement` would dump hundreds of DOM members into
  // the prompt.
  function isWrapperLocal(symbol: ts.Symbol | undefined): boolean {
    const decls = symbol?.getDeclarations();
    if (decls === undefined) return false;
    return decls.some((d) => d.getSourceFile().fileName === VIRTUAL_DTS_PATH);
  }

  // Render a single `ts.Type` as a self-contained TS type expression.
  //
  // The TS node builder keeps a type's NAME whenever that name is
  // reachable in the program — for a `.d.ts` whose option/value types
  // are `export interface`s, that means the printed signature ends up
  // full of `LeafletMapOptions` references the LLM cannot resolve. To
  // produce a prompt-ready, self-contained signature we structurally
  // expand WRAPPER-LOCAL named object types one level: enumerate the
  // apparent properties and render each property's type (recursively,
  // depth-bounded). Non-local named types, primitives, unions, arrays,
  // tuples, and anonymous objects keep `typeToString`'s rendering.
  const MAX_DEPTH = 4;
  function renderType(t: ts.Type, depth: number): string {
    const plain = (): string =>
      checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);

    // Bail to the plain stringifier once we hit the depth cap so a
    // cyclic / deeply-nested type can't blow the stack.
    if (depth >= MAX_DEPTH) return plain();

    // `boolean` is internally `true | false` — `isUnion()` is true for
    // it. Catch it before union-splitting so it prints as `boolean`.
    if ((t.getFlags() & ts.TypeFlags.Boolean) !== 0) return 'boolean';

    // Union types (e.g. `LeafletMapOptions | undefined` from an
    // optional param) — recurse into each constituent so a wrapper-
    // local named object member still expands structurally.
    if (t.isUnion()) {
      return t.types.map((member) => renderType(member, depth)).join(' | ');
    }
    // Intersections — same treatment.
    if (t.isIntersection()) {
      return t.types.map((member) => renderType(member, depth)).join(' & ');
    }

    const symbol = t.getSymbol() ?? t.aliasSymbol;

    // Callable types (e.g. `containerRef: (el) => void`) — render the
    // first call signature inline.
    const callSigs = t.getCallSignatures();
    if (callSigs.length > 0) {
      const cs = callSigs[0]!;
      const params = cs
        .getParameters()
        .map((p) => {
          const decl = p.valueDeclaration ?? p.declarations?.[0];
          const pType =
            decl !== undefined
              ? checker.getTypeOfSymbolAtLocation(p, decl)
              : checker.getDeclaredTypeOfSymbol(p);
          const optional =
            decl !== undefined &&
            ts.isParameter(decl) &&
            (decl.questionToken !== undefined ||
              decl.initializer !== undefined);
          return `${p.getName()}${optional ? '?' : ''}: ${renderType(pType, depth + 1)}`;
        })
        .join(', ');
      const ret = renderType(cs.getReturnType(), depth + 1);
      return `(${params}) => ${ret}`;
    }

    const isObject = (t.getFlags() & ts.TypeFlags.Object) !== 0;
    const isArrayOrTuple =
      checker.isArrayType(t) || checker.isTupleType(t);

    // Generic instantiation of a non-local type (e.g.
    // `GadgetHookResult<LeafletMapValue>`) — keep the outer name (the
    // LLM knows the ggui types) but recurse into the type arguments so
    // a nested wrapper-local type still expands.
    const typeArgs = (t as ts.TypeReference).typeArguments;
    if (
      symbol !== undefined &&
      isObject &&
      !isArrayOrTuple &&
      !isWrapperLocal(symbol) &&
      typeArgs !== undefined &&
      typeArgs.length > 0
    ) {
      const args = typeArgs.map((a) => renderType(a, depth + 1)).join(', ');
      return `${symbol.getName()}<${args}>`;
    }

    // Wrapper-local named object — expand its property shape inline.
    if (
      symbol !== undefined &&
      isObject &&
      !isArrayOrTuple &&
      isWrapperLocal(symbol)
    ) {
      const props = checker.getPropertiesOfType(t);
      if (props.length > 0) {
        const body = props
          .map((p) => {
            const decl = p.valueDeclaration ?? p.declarations?.[0];
            const pType =
              decl !== undefined
                ? checker.getTypeOfSymbolAtLocation(p, decl)
                : checker.getDeclaredTypeOfSymbol(p);
            const optional = (p.getFlags() & ts.SymbolFlags.Optional) !== 0;
            return `${p.getName()}${optional ? '?' : ''}: ${renderType(pType, depth + 1)}`;
          })
          .join('; ');
        return `{ ${body} }`;
      }
    }

    return plain();
  }

  // The exported binding may surface as either:
  //   - `export declare const useLeafletMap: GguiGadget<...>` — a
  //     variable statement, or
  //   - `export declare function useLeafletMap(...): ...` — a function
  //     declaration, or
  //   - `export { useLeafletMap } from '...'` — a re-export.
  // The module-symbol export table covers all three uniformly, so we
  // walk the module symbol's exports rather than top-level statements.
  const moduleSymbol = checker.getSymbolAtLocation(parsed);
  const exportSymbols: ts.Symbol[] =
    moduleSymbol !== undefined ? checker.getExportsOfModule(moduleSymbol) : [];

  const signaturesByName = new Map<string, readonly ts.Signature[]>();
  for (const symbol of exportSymbols) {
    const name = symbol.getName();
    if (!requested.has(name)) continue;
    if (signaturesByName.has(name)) continue;

    // Resolve aliases (re-exports) so we read the real declaration.
    const resolved =
      (symbol.flags & ts.SymbolFlags.Alias) !== 0
        ? checker.getAliasedSymbol(symbol)
        : symbol;

    const declarations = resolved.getDeclarations();
    if (declarations === undefined || declarations.length === 0) continue;
    const declaration = declarations[0]!;

    const type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
    const callSignatures = type.getCallSignatures();
    if (callSignatures.length === 0) continue;

    signaturesByName.set(name, callSignatures);
  }

  return { checker, renderType, signaturesByName };
}

/**
 * Print one call signature as a self-contained `(params) => ret`
 * expression.
 */
function printCallSignature(sig: ts.Signature, ctx: ExtractorContext): string {
  const params = sig
    .getParameters()
    .map((p) => {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      const pType =
        decl !== undefined
          ? ctx.checker.getTypeOfSymbolAtLocation(p, decl)
          : ctx.checker.getDeclaredTypeOfSymbol(p);
      const optional =
        decl !== undefined &&
        ts.isParameter(decl) &&
        (decl.questionToken !== undefined || decl.initializer !== undefined);
      return `${p.getName()}${optional ? '?' : ''}: ${ctx.renderType(pType, 0)}`;
    })
    .join(', ');
  const ret = ctx.renderType(sig.getReturnType(), 0);
  return `(${params}) => ${ret}`.trim();
}

/**
 * Render a function component's props — the first parameter's type,
 * structurally expanded into a self-contained object type. A
 * zero-parameter component yields `{}`. Returns `undefined` when the
 * expander bottoms out on an unresolvable token.
 */
function printComponentProps(
  sig: ts.Signature,
  ctx: ExtractorContext,
): string | undefined {
  const params = sig.getParameters();
  // A zero-parameter component takes no props.
  if (params.length === 0) return '{}';
  const propsParam = params[0]!;
  const decl = propsParam.valueDeclaration ?? propsParam.declarations?.[0];
  const propsType =
    decl !== undefined
      ? ctx.checker.getTypeOfSymbolAtLocation(propsParam, decl)
      : ctx.checker.getDeclaredTypeOfSymbol(propsParam);
  const rendered = ctx.renderType(propsType, 0);
  // A surviving virtual-file qualifier means the structural expander
  // bottomed out on something it couldn't inline — drop it rather than
  // feed the LLM an unresolvable `import("/__gadget__")` token.
  if (rendered.length === 0 || rendered.includes('import("')) return undefined;
  return rendered;
}

/**
 * Print the inferred call signature of every requested HOOK found in
 * the supplied wrapper `.d.ts` string.
 *
 * For each exported declaration whose name matches a requested hook,
 * the checker's callable signature is printed with structural-fallback
 * so wrapper-specific named types expand to their structural form — the
 * resulting string is self-contained and safe to drop into a prompt. A
 * hook declared with multiple overloads renders each, joined with ` | `.
 *
 * Hooks that aren't found, or that resolve to a value with no callable
 * signature, are omitted from the result (no throw) — the caller is
 * expected to render a `Type:` line only for hooks that resolved.
 *
 * Memoized on `(dtsContent, hookNames)`.
 */
export function extractCallSignaturesFromDts(
  dtsContent: string,
  hookNames: readonly string[],
): CallSignatureMap {
  if (hookNames.length === 0 || dtsContent.trim().length === 0) {
    return {};
  }

  const cacheKey = `${dtsContent} ${[...hookNames].sort().join(',')}`;
  const cached = callSignatureCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result: CallSignatureMap = {};
  const ctx = buildExtractorContext(dtsContent, hookNames);
  if (ctx === undefined) {
    callSignatureCache.set(cacheKey, result);
    return result;
  }

  for (const [name, signatures] of ctx.signaturesByName) {
    // A hook declared with multiple overloads renders ALL of them,
    // joined as a union of function types. A surviving virtual-file
    // qualifier means the structural expander bottomed out on something
    // it couldn't inline — drop that overload rather than feed the LLM
    // an unresolvable `import("/__gadget__")` token.
    const printed = signatures
      .map((sig) => printCallSignature(sig, ctx))
      .filter((s) => s.length > 0 && !s.includes('import("'))
      .join(' | ');
    if (printed.length > 0) {
      result[name] = printed;
    }
  }

  callSignatureCache.set(cacheKey, result);
  return result;
}

/**
 * Print the props-object shape of every requested COMPONENT found in
 * the supplied wrapper `.d.ts` string (GG.8.5).
 *
 * A function component's props are its first parameter's type. The
 * type is structurally expanded the same way hook signatures are, so
 * the printed value (`{ data: …; height?: number }`) is self-contained
 * and prompt-ready — the code-gen prompt renders it as a `Props:` line
 * so the LLM knows the JSX attributes of `<Component … />`.
 *
 * Components not found, or that resolve to a non-callable value, are
 * omitted (no throw). Memoized on `(dtsContent, componentNames)`.
 */
export function extractComponentPropsFromDts(
  dtsContent: string,
  componentNames: readonly string[],
): ComponentPropsMap {
  if (componentNames.length === 0 || dtsContent.trim().length === 0) {
    return {};
  }

  const cacheKey = `${dtsContent} ${[...componentNames].sort().join(',')}`;
  const cached = componentPropsCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const result: ComponentPropsMap = {};
  const ctx = buildExtractorContext(dtsContent, componentNames);
  if (ctx === undefined) {
    componentPropsCache.set(cacheKey, result);
    return result;
  }

  for (const [name, signatures] of ctx.signaturesByName) {
    // A component is single-signature by convention — use the first.
    const first = signatures[0];
    if (first === undefined) continue;
    const props = printComponentProps(first, ctx);
    if (props !== undefined) {
      result[name] = props;
    }
  }

  componentPropsCache.set(cacheKey, result);
  return result;
}
