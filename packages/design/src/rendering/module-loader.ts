/**
 * Module Loader
 *
 * Browser-only utility that loads compiled ESM code as a dynamic module
 * via a temporary blob URL. Used by ReactComponentRenderer to instantiate
 * generated components inline (no iframe).
 */

/**
 * Hoist static `import` declarations to the top of the module.
 *
 * esbuild's ESM output sometimes places helper declarations (`var`, `const`)
 * before `import` statements. This is valid inside esbuild's own bundle but
 * invalid standalone ESM (spec requires imports before any statements).
 *
 * Call this on raw code BEFORE import rewriting (before specifiers become
 * data-URLs that contain semicolons and confuse simple parsers).
 */
export function hoistImports(code: string): string {
  // Split into top-level statements by semicolon.
  // This is safe for pre-rewrite code where specifiers are simple strings
  // like "react/jsx-runtime" or "@ggui-ai/design/primitives".
  const parts = code.split(';');
  const imports: string[] = [];
  const rest: string[] = [];

  for (const part of parts) {
    const trimmed = part.trimStart();
    if (trimmed.startsWith('import')) {
      imports.push(part);
    } else {
      rest.push(part);
    }
  }

  if (imports.length === 0) return code;

  return imports.join(';') + ';' + rest.join(';');
}

/**
 * Load compiled ESM code as a module and return its exports.
 *
 * Creates a temporary blob URL, dynamically imports it, then immediately
 * revokes the URL to avoid memory leaks.
 *
 * **Browser-only** — requires `Blob`, `URL.createObjectURL`, and dynamic `import()`.
 *
 * @param code - Compiled ESM code string (imports should already be hoisted and rewritten)
 * @returns Module exports as a key-value record
 */
export async function loadModule(code: string): Promise<Record<string, unknown>> {
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return await import(/* webpackIgnore: true */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
