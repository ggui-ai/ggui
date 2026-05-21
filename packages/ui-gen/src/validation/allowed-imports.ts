/**
 * The single source of truth for which packages LLM-generated
 * component code may import.
 *
 * Before this module the allowlist was duplicated — as `startsWith`
 * chains, as literal arrays, as hand-written error strings — across
 * `adapters/tools.ts`, `check/run-tier0.ts`, `check/type-checker.ts`
 * and `validation/component-detailed.ts`. The copies had already
 * drifted (one rejected `react-dom`, others allowed it). Every
 * import-validation site now derives from {@link isAllowedImport}.
 *
 * The design system is imported through ONE specifier — `@ggui-ai/design`
 * — never the `/primitives`, `/components`, `/compositions`, `/interact`
 * subpaths. The barrel re-exports every layer, so the generation LLM
 * never has to predict which subpath a component lives in. Subpaths
 * still resolve (the predicate allows any `@ggui-ai/design/...`), but
 * the prompt and catalog teach the barrel exclusively.
 */

/**
 * Static package specifiers generated code may import. A subpath of
 * any base (`<base>/...`) is allowed too. Per-contract gadget packages
 * are dynamic — pass them to {@link isAllowedImport}.
 */
export const ALLOWED_IMPORT_BASES = [
  'react',
  'react-dom',
  '@ggui-ai/design',
  '@ggui-ai/wire',
  '@ggui-ai/gadgets',
] as const;

/**
 * True if `specifier` is a package generated component code may import:
 * one of {@link ALLOWED_IMPORT_BASES} (or a subpath of one), or a
 * contract-declared gadget package.
 */
export function isAllowedImport(
  specifier: string,
  gadgetPackages?: ReadonlySet<string>,
): boolean {
  for (const base of ALLOWED_IMPORT_BASES) {
    if (specifier === base || specifier.startsWith(`${base}/`)) return true;
  }
  return gadgetPackages?.has(specifier) ?? false;
}

/**
 * Human-readable allowed-import list for error messages shown to the
 * generation LLM.
 */
export function describeAllowedImports(): string {
  return 'react, @ggui-ai/design, @ggui-ai/wire, @ggui-ai/gadgets, or a gadget package declared on the contract';
}
