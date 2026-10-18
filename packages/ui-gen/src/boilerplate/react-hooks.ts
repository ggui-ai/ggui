/**
 * The React hooks the boilerplate's DO NOT EDIT React import always lists, so generated code may use
 * any of them without editing that line. One list: the boilerplate emits its import from it, and
 * tier-0's fix text names the import when one of these names goes missing.
 */
export const BOILERPLATE_REACT_HOOKS = ['useState', 'useCallback', 'useMemo', 'useEffect', 'useLayoutEffect', 'useRef'] as const;

/** The React import line the boilerplate writes, verbatim. */
export const BOILERPLATE_REACT_IMPORT = `import React, { ${BOILERPLATE_REACT_HOOKS.join(', ')} } from 'react';`;

/** What {@link restoreReactImport} did: the source to build, and the boilerplate hooks it put back (empty: untouched). */
export interface ReactImportRestore {
  readonly source: string;
  readonly added: readonly string[];
}

const REACT_IMPORT_ANY = /^[ \t]*import\b[^;]*?\bfrom\s*['"]react['"]/gm;
const REACT_IMPORT_LINE = /^[ \t]*import[ \t]+React(?:[ \t]*,[ \t]*\{([^}\n]*)\})?[ \t]*from[ \t]*['"]react['"];?[ \t]*$/m;

/**
 * ggui#1932 — keep the boilerplate's DO NOT EDIT React import, in code, before tier-0 reads the source.
 *
 * - The line exists (`import React …from 'react'`) but lacks a boilerplate hook: it becomes the boilerplate
 *   hooks in order, then every other name the model listed, in its order. The result is a superset of the
 *   model's line, so nothing it uses is dropped; with no extra names it is byte-for-byte
 *   {@link BOILERPLATE_REACT_IMPORT}.
 * - No import from 'react' at all, and the source calls a boilerplate hook: the boilerplate line is inserted
 *   at the top, where the boilerplate has it. A source that calls none is left alone: inserting would shift
 *   every line for nothing, and the model patches by line number.
 * - Any other 'react' import form (named-only, namespace, more than one, spanning lines, or carrying `type`
 *   specifiers or comments): untouched. Rewriting it could declare a name twice or drop what the model meant;
 *   tier-0 and its fix text handle it.
 * Every boilerplate hook already imported (plain or aliased): untouched.
 */
export function restoreReactImport(source: string): ReactImportRestore {
  const imports = source.match(REACT_IMPORT_ANY) ?? [];
  if (imports.length === 0) {
    const called = BOILERPLATE_REACT_HOOKS.some((h) => new RegExp(`\\b${h}\\s*[(<]`).test(source));
    if (!called) return { source, added: [] };
    return { source: `${BOILERPLATE_REACT_IMPORT}\n${source}`, added: [...BOILERPLATE_REACT_HOOKS] };
  }
  if (imports.length > 1) return { source, added: [] };
  const line = REACT_IMPORT_LINE.exec(source);
  if (line === null) return { source, added: [] };
  const inner = line[1] ?? '';
  if (/\btype\b|\/\*|\/\//.test(inner)) return { source, added: [] };
  const specs = inner.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  // The IMPORTED name (left of `as`): `useMemo as memo` is `useMemo` present.
  const imported = new Set(specs.map((s) => s.split(/\s+as\s+/)[0]));
  const added = BOILERPLATE_REACT_HOOKS.filter((h) => !imported.has(h));
  if (added.length === 0) return { source, added: [] };
  const hooks: readonly string[] = BOILERPLATE_REACT_HOOKS;
  const names = [...hooks, ...specs.filter((s) => !hooks.includes(s))];
  const restored = `import React, { ${names.join(', ')} } from 'react';`;
  return { source: source.replace(line[0], restored), added };
}
