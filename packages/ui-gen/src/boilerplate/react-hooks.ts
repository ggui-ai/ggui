/**
 * The React hooks the boilerplate's DO NOT EDIT React import always lists, so generated code may use
 * any of them without editing that line. One list: the boilerplate emits its import from it, and
 * tier-0's fix text names the import when one of these names goes missing.
 */
export const BOILERPLATE_REACT_HOOKS = ['useState', 'useCallback', 'useMemo', 'useEffect', 'useLayoutEffect', 'useRef'] as const;

/** The React import line the boilerplate writes, verbatim. */
export const BOILERPLATE_REACT_IMPORT = `import React, { ${BOILERPLATE_REACT_HOOKS.join(', ')} } from 'react';`;
