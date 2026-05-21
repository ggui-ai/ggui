// packages/ui-gen/src/check/extract-wire-calls.ts
//
// AST helper for wire-call-site extraction + sibling `checkWireImports`
// for OSS tier-0 gate coverage.
//
// Used by:
//   (1) Tier-0 `wire_preservation` check — verifies the LLM hasn't
//       deleted a boilerplate-emitted hook call via `apply_patch`.
//       Deletion cannot be caught by `pnpm typecheck` alone because a
//       hook that is never called simply doesn't fire; the TypeScript
//       checker has no opinion on absence.
//   (2) Tier-0 `wire_import` check — verifies every
//       wire hook the component calls also appears as a named import
//       from `@ggui-ai/wire` at top level. Missing imports turn into
//       `ReferenceError` at mount because `rewriteImports` only
//       activates the data-URL shim for specifiers that already exist
//       in the code.
//   (3) Axis check (future) — same report shape, surfaced at eval tier
//       alongside the other deterministic axes.
//
// Keying is on the STRING-LITERAL first argument of the hook call, NOT
// the variable name bound to its result. An LLM that renames
// `const submit = useAction('submit')` to `const onSubmit =
// useAction('submit')` is authoring the SAME wire — the identifier is
// ergonomic sugar, the wire contract is the string. This matches the
// `@ggui-ai/wire` hook semantics: the dispatcher routes by name.
//
// Regex was deliberately rejected for the call-site walk. Hook calls
// inside callbacks, behind variable aliases, or wrapped in `useMemo`/
// `useCallback` dependency arrays would fool a regex scan. The TS
// compiler API walks the real AST and never confuses `useAction`
// identifier references (e.g. in a dependency array) with actual
// `useAction(...)` call expressions.

import ts from "typescript";
import type { DataContract } from "@ggui-ai/protocol";

/**
 * The four contract-declared wire kinds, matching `@ggui-ai/wire` hooks.
 *
 * `'context'` covers `useGguiContext` calls. The iframe-runtime mounts
 * Contexts only when the bootstrap envelope carries `contextSlots`,
 * which fires only when the persisted StackItem has `contextSpec`,
 * which happens only when the agent authored
 * `story.contract.contextSpec` AND push.ts plumbed it to the
 * generator. The symptom of a missing slot is a blank `/r/<id>` direct
 * preview when the LLM emitted `useGguiContext('X')` without a
 * declared slot. The undeclared-wire-call check (tier-0
 * `wire_undeclared`) catches the drift fail-loud at gen time so the
 * agent gets a remediation message instead of a silent blank page.
 *
 * `'clientTool'` retired 2026-05-11 alongside `useClientTool` +
 * `clientTools` → `clientCapabilities` reframe. Capability hooks
 * import from `@ggui-ai/gadgets` (or other vendor packages),
 * not from `@ggui-ai/wire`, so they fall outside the wire-import
 * tier-0 gate by construction.
 */
export type WireKind =
  | "action"
  | "stream"
  | "context";

/** A single extracted wire reference — either from code or from the contract. */
export interface WireCallSite {
  readonly kind: WireKind;
  /** The string-literal argument to the hook, matching the contract key. */
  readonly name: string;
}

/**
 * Bidirectional completeness report between a contract and a component's
 * hook call sites. `missing` = contract-declared but absent from code;
 * `extra` = present in code but not declared on the contract. Item 3b
 * compile narrowing (`InferActionNames<T>` / `InferStreamNames<T>`)
 * already rejects `extra` at typecheck time — this report is primarily
 * consumed by the `wire_preservation` tier-0 check for the `missing`
 * direction.
 */
export interface WirePreservationReport {
  readonly missing: WireCallSite[];
  readonly extra: WireCallSite[];
}

/**
 * Report from `checkWireImports`. Each entry names a wire hook the
 * component CALLS at least once but does NOT import from
 * `@ggui-ai/wire` at the top level. Hook-name collisions (e.g. a
 * user-defined `useAction` in the same scope) are out of scope —
 * generated code lives inside the boilerplate frame, which declares
 * the hooks as imports and nothing else by that name.
 */
export interface WireImportReport {
  /** Hooks the component calls but does not import. */
  readonly missing: readonly WireImportSite[];
}

export interface WireImportSite {
  /** The hook function name — `useAction` / `useStream` / etc. */
  readonly hook: string;
  /** The matching `WireKind` for reporting symmetry. */
  readonly kind: WireKind;
}

const HOOK_TO_KIND: Readonly<Record<string, WireKind>> = {
  useAction: "action",
  useStream: "stream",
  // `useGguiContext('slot')` is the client→agent observable-state
  // hook. Treated as a wire call site for tier-0 preservation +
  // undeclared detection because the runtime registers one
  // React.Context per declared contextSpec slot at boot — referencing
  // an undeclared slot throws synchronously at first paint.
  useGguiContext: "context",
  // Pre-rename component-side tool hooks are retired. The contract's
  // `agentCapabilities.tools` catalog is agent-side declaration only —
  // no component hook surface. Cross-refs surface via
  // `actionSpec[*].nextStep` (already covered by the `action` kind)
  // and `streamSpec[*].source.tool` (covered by `stream`).
};

/** All known wire hook names — iteration source for `checkWireImports`. */
const ALL_WIRE_HOOKS = Object.keys(HOOK_TO_KIND) as ReadonlyArray<
  keyof typeof HOOK_TO_KIND
>;

/**
 * Walk the TSX AST and collect every call expression whose callee is one
 * of the four wire hooks AND whose first argument is a string literal.
 * Non-literal first arguments (e.g. `useAction(dynamicName)`) are
 * intentionally ignored — the generator always emits string literals,
 * and the contract keys by literal, so an indirection through a
 * variable can't carry the wiring.
 */
export function extractWireCallSites(code: string): WireCallSite[] {
  const sf = ts.createSourceFile(
    "component.tsx",
    code,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  );
  const sites: WireCallSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // Match bare hook identifiers. We do NOT match
      // `React.useAction(...)` or other member-accessed forms — wire
      // hooks are always imported by name from `@ggui-ai/wire`.
      if (ts.isIdentifier(callee)) {
        const kind = HOOK_TO_KIND[callee.text];
        if (kind) {
          const firstArg = node.arguments[0];
          if (firstArg && ts.isStringLiteral(firstArg)) {
            sites.push({ kind, name: firstArg.text });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return sites;
}

/**
 * Walk top-level `import` statements and collect named specifiers
 * imported from `@ggui-ai/wire`. Returns the set of local-binding
 * names (not aliased source names) because the checker compares
 * against identifiers USED by call expressions in the body.
 *
 * Default imports and namespace imports (`import * as w from ...`) are
 * ignored — the `@ggui-ai/wire` shim exports named members only, and
 * generated code always reaches for them by name.
 */
export function extractWireImports(code: string): ReadonlySet<string> {
  const sf = ts.createSourceFile(
    "component.tsx",
    code,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    ts.ScriptKind.TSX,
  );
  const imported = new Set<string>();

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpecifier = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpecifier)) continue;
    if (moduleSpecifier.text !== "@ggui-ai/wire") continue;

    const clause = stmt.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (!ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      // `import { useAction as a }` — the LOCAL name is what the body
      // references. But generated code never aliases wire hooks, so
      // reading `el.name.text` for both aliased and bare forms stays
      // correct either way (local = bare when no alias).
      imported.add(el.name.text);
    }
  }

  return imported;
}

/**
 * Enumerate every wire a contract declares. Parallels the generator's
 * emission order in `generateBoilerplate` — actions, streams, context
 * slots. Contract-key typing matches the `@ggui-ai/protocol` canonical
 * flat-map shape.
 *
 * `agentTools` and `clientCapabilities` are NOT enumerated:
 *   - `agentTools` is a catalog the AGENT invokes (no component hook).
 *     Cross-references surface via `actionSpec[*].nextStep` and
 *     `streamSpec[*].source.tool`, already covered by `action` / `stream`.
 *   - `clientCapabilities` are declarations of browser-capability hooks
 *     imported from `@ggui-ai/gadgets` (or another vendor package).
 *     They are NOT `@ggui-ai/wire` hooks and do NOT participate in the
 *     wire-import tier-0 gate.
 */
export function collectExpectedWires(contract: DataContract): WireCallSite[] {
  const expected: WireCallSite[] = [];

  const actionsMap = contract.actionSpec ?? {};
  for (const name of Object.keys(actionsMap)) {
    expected.push({ kind: "action", name });
  }

  const streamsMap = contract.streamSpec ?? {};
  for (const name of Object.keys(streamsMap)) {
    expected.push({ kind: "stream", name });
  }

  // contextSpec slots. Each declared slot becomes one
  // `useGguiContext('<slot>')` call site the boilerplate auto-emits
  // at the top of the component body. Without this in the expected
  // set, an LLM emitting an undeclared useGguiContext call slips
  // through and the runtime throws on mount (no Context registered
  // for that slot), blanking the iframe.
  const contextMap = contract.contextSpec ?? {};
  for (const name of Object.keys(contextMap)) {
    expected.push({ kind: "context", name });
  }

  return expected;
}

/**
 * Diff the component's observed wire call sites against the contract's
 * expected wires. Symmetric set difference by `(kind, name)` pair.
 */
export function checkWirePreservation(
  code: string,
  contract: DataContract,
): WirePreservationReport {
  const expected = collectExpectedWires(contract);
  const actual = extractWireCallSites(code);

  const actualKeys = new Set(actual.map((s) => `${s.kind}:${s.name}`));
  const expectedKeys = new Set(expected.map((s) => `${s.kind}:${s.name}`));

  const missing = expected.filter((s) => !actualKeys.has(`${s.kind}:${s.name}`));
  const extra = actual.filter((s) => !expectedKeys.has(`${s.kind}:${s.name}`));

  return { missing, extra };
}

/**
 * Guards against this failure class: componentCode calls a wire hook
 * but doesn't import it, so the data-URL shim rewrite has no
 * specifier to attach to and the hook is undeclared at eval time. Run
 * `extractWireCallSites` for the used set, `extractWireImports` for
 * the imported set, and emit the setwise difference.
 *
 * This is purely a STATIC check — it doesn't care whether the contract
 * declares each hook (that's `checkWirePreservation`'s job). Its only
 * question is: every hook the generated code CALLS, is it imported?
 * Yes → silent. No → report. A hook that is imported but unused is
 * caught by the existing `no-unused-vars` lint, not by this check.
 */
export function checkWireImports(code: string): WireImportReport {
  const used = extractWireCallSites(code);
  const imports = extractWireImports(code);
  const usedHookSet = new Set(
    used.map(
      (s) =>
        // Reverse the kind → hook-name lookup. Closed set of 5 —
        // hardcoded to stay cheap and explicit.
        ({
          action: "useAction",
          stream: "useStream",
          context: "useGguiContext",
        })[s.kind],
    ),
  );

  const missing: WireImportSite[] = [];
  for (const hook of ALL_WIRE_HOOKS) {
    if (!usedHookSet.has(hook)) continue;
    if (imports.has(hook)) continue;
    missing.push({ hook, kind: HOOK_TO_KIND[hook] });
  }

  return { missing };
}
