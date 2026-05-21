import { describe, it, expect } from 'vitest';
import { rewriteImports } from './rewrite-imports';
import { hoistImports } from './module-loader';

describe('rewriteImports — data-url mode', () => {
  const opts = { mode: 'data-url' as const };

  it('rewrites react specifier to a data URL', () => {
    const code = `import React from "react";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('"react"');
  });

  it('rewrites react/jsx-runtime to a data URL', () => {
    const code = `import { jsx } from "react/jsx-runtime";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('"react/jsx-runtime"');
  });

  it('rewrites @ggui-ai/design/primitives to a data URL', () => {
    const code = `import { Button } from "@ggui-ai/design/primitives";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('"@ggui-ai/design/primitives"');
  });

  it('rewrites @ggui-ai/design/components to a data URL', () => {
    const code = `import { SearchField } from "@ggui-ai/design/components";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('"@ggui-ai/design/components"');
  });

  it('rewrites @ggui-ai/design/compositions to a data URL', () => {
    const code = `import { Modal } from "@ggui-ai/design/compositions";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('"@ggui-ai/design/compositions"');
  });

  it('rewrites the bare @ggui-ai/design barrel to a data URL (D1)', () => {
    // D1: the single import path generated code is taught — must
    // resolve a shim carrying every layer's exports.
    const code = `import { Card, Grid, Modal, Clickable } from "@ggui-ai/design";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('from "@ggui-ai/design"');
  });

  it('handles single-quoted imports', () => {
    const code = `import React from 'react';`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toMatch(/from\s+'react'/);
  });

  it('uses custom globals when provided', () => {
    const code = `import React from "react";`;
    const result = rewriteImports(code, {
      mode: 'data-url',
      reactGlobal: 'MyReact',
    });
    expect(result).toContain('MyReact');
  });
});

describe('rewriteImports — importmap mode', () => {
  const opts = { mode: 'importmap' as const };

  it('rewrites react to esm.sh URL', () => {
    const code = `import React from "react";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('https://esm.sh/react@18.2.0');
    expect(result).not.toContain('"react"');
  });

  it('rewrites react/jsx-runtime to esm.sh URL', () => {
    const code = `import { jsx } from "react/jsx-runtime";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('https://esm.sh/react@18.2.0/jsx-runtime');
  });

  it('leaves @ggui-ai/design/* untouched', () => {
    const code = `import { Button } from "@ggui-ai/design/primitives";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('"@ggui-ai/design/primitives"');
  });

  it('uses custom reactBaseUrl when provided', () => {
    const code = `import React from "react";`;
    const result = rewriteImports(code, {
      mode: 'importmap',
      reactBaseUrl: 'https://cdn.example.com/react@19',
    });
    expect(result).toContain('https://cdn.example.com/react@19');
  });

  it('handles both quote styles simultaneously', () => {
    const code = `import React from "react";\nimport { jsx } from 'react/jsx-runtime';`;
    const result = rewriteImports(code, opts);
    expect(result).not.toContain('"react"');
    expect(result).not.toContain("'react/jsx-runtime'");
    expect(result).toContain('https://esm.sh/react@18.2.0');
  });
});

// ---------------------------------------------------------------------------
// Bundled registered UI tests — covers the full hoistImports + rewriteImports
// pipeline for pre-bundled components with CJS interop and extended React APIs.
// ---------------------------------------------------------------------------

describe('bundled registered UI — React shim completeness', () => {
  const opts = { mode: 'data-url' as const };

  // These are React APIs used by popular libraries (embla-carousel, recharts,
  // framer-motion, etc.) that get bundled into registered UIs.
  const requiredExports = [
    'useState', 'useEffect', 'useRef', 'useCallback', 'useMemo',
    'useContext', 'useReducer', 'useId', 'createElement', 'Fragment',
    'Children', 'cloneElement', 'createContext', 'forwardRef', 'memo',
    'lazy', 'Suspense', 'useLayoutEffect', 'useInsertionEffect',
    'useImperativeHandle', 'Component', 'PureComponent', 'isValidElement',
    'createRef', 'useDebugValue',
  ];

  for (const name of requiredExports) {
    it(`React shim exports ${name}`, () => {
      const code = `import{${name} as x}from"react";export default x;`;
      const result = rewriteImports(code, opts);
      // The shim should be a data URL that exports this name
      const shimUrl = result.match(/from"(data:text\/javascript,[^"]*)"/)?.[1];
      expect(shimUrl).toBeDefined();
      const shimCode = decodeURIComponent(shimUrl!.replace('data:text/javascript,', ''));
      expect(shimCode).toContain(`export const ${name}`);
    });
  }
});

describe('bundled registered UI — react-dom rewriting', () => {
  const opts = { mode: 'data-url' as const };

  it('rewrites react-dom import to data URL', () => {
    const code = `import{createPortal as p}from"react-dom";`;
    const result = rewriteImports(code, opts);
    expect(result).toContain('data:text/javascript,');
    expect(result).not.toContain('"react-dom"');
  });

  it('react-dom shim exports createPortal', () => {
    const code = `import{createPortal}from"react-dom";`;
    const result = rewriteImports(code, opts);
    const shimUrl = result.match(/from"(data:text\/javascript,[^"]*)"/)?.[1];
    expect(shimUrl).toBeDefined();
    const shimCode = decodeURIComponent(shimUrl!.replace('data:text/javascript,', ''));
    expect(shimCode).toContain('createPortal');
  });

  it('react-dom shim exports flushSync', () => {
    const code = `import{flushSync}from"react-dom";`;
    const result = rewriteImports(code, opts);
    const shimUrl = result.match(/from"(data:text\/javascript,[^"]*)"/)?.[1];
    const shimCode = decodeURIComponent(shimUrl!.replace('data:text/javascript,', ''));
    expect(shimCode).toContain('flushSync');
  });
});

describe('bundled registered UI — CJS interleaved imports', () => {
  const opts = { mode: 'data-url' as const };

  it('handles CJS shim before ESM imports (bundled code pattern)', () => {
    // Real esbuild bundle output pattern: CJS require shim then ESM imports
    const code = [
      'var us=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(t,a)=>(typeof require<"u"?require:t)[a]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error(\'Dynamic require of "\'+e+\'" is not supported\')});',
      'import{useState as gu}from"react";',
      'import{Container as Vf}from"@ggui-ai/design/primitives";',
      'import{jsx as nf}from"react/jsx-runtime";',
      'function App(props){return nf("div",{children:gu(0)[0]})}',
      'export{App as default}',
    ].join('');

    // 1. Hoist imports above CJS var declarations
    const hoisted = hoistImports(code);
    // Imports should now be before the var declaration
    const firstImportIdx = hoisted.indexOf('import{');
    const firstVarIdx = hoisted.indexOf('var us=');
    expect(firstImportIdx).toBeLessThan(firstVarIdx);

    // 2. Rewrite bare specifiers
    const rewritten = rewriteImports(hoisted, opts);
    expect(rewritten).not.toContain('from"react"');
    expect(rewritten).not.toContain('from"@ggui-ai/design/primitives"');
    expect(rewritten).not.toContain('from"react/jsx-runtime"');
    // All imports rewritten to data URLs
    expect(rewritten).toContain('data:text/javascript,');
  });

  it('handles multiple scattered react imports (bundled lib pattern)', () => {
    // Libraries like embla-carousel have multiple import statements from react
    // scattered throughout the bundled code
    const code = [
      'import{useState as a}from"react";',
      'var helper=function(){return 42};',
      'import{useRef as b}from"react";',
      'var another=helper();',
      'import{useEffect as c}from"react";',
      'import{jsx as j}from"react/jsx-runtime";',
      'export default function(){return j("div",{})}',
    ].join('');

    const hoisted = hoistImports(code);
    const rewritten = rewriteImports(hoisted, opts);

    // No bare react specifiers should remain
    expect(rewritten).not.toContain('from"react"');
    expect(rewritten).not.toContain('from"react/jsx-runtime"');
  });

  it('handles react-dom import in bundled code', () => {
    const code = [
      'import{useState}from"react";',
      'import{createPortal}from"react-dom";',
      'import{jsx}from"react/jsx-runtime";',
      'export default function(){return jsx("div",{})}',
    ].join('');

    const rewritten = rewriteImports(code, opts);
    expect(rewritten).not.toContain('from"react-dom"');
    expect(rewritten).not.toContain('from"react"');
    expect(rewritten).not.toContain('from"react/jsx-runtime"');
  });
});

// =============================================================================
// GG.8.2 — gadget direct-import rewriting
// =============================================================================
//
// GG.8.2 retires the `loadGadgets()` accessor. Generated component
// code DIRECT-IMPORTS each gadget export
// (`import { useGeolocation } from '@ggui-ai/gadgets'`). The rewriter
// turns every gadget-package specifier — `@ggui-ai/gadgets` (STDLIB,
// always) plus each 3rd-party package threaded via
// `opts.gadgetPackages` — into a per-package data-URL shim. The shim's
// named exports are DERIVED from the generated code's own import
// statement (via `extractNamedImports`), so the shim provides exactly
// what the code imports — drift-immune (no export allowlist to
// maintain). The runtime registry is per-package:
// `globalThis.__ggui__.gadgets[<package>]` holds each package's loaded
// module namespace.
describe('rewriteImports — gadget direct-import (GG.8.2)', () => {
  const opts = { mode: 'data-url' as const };

  /** Pull the data-URL shim body for a given source specifier. */
  function shimFor(rewritten: string, specifier: string): string {
    // The shim follows `from "data:..."` for the rewritten specifier.
    // After rewrite the original specifier is gone, so just take the
    // first (and only) data-URL — these tests rewrite one package at a
    // time except where noted.
    const match = rewritten.match(/data:text\/javascript,([^"]*)/);
    if (!match) throw new Error(`no data-url shim for ${specifier}`);
    return decodeURIComponent(match[1]);
  }

  it('rewrites @ggui-ai/gadgets to a per-package data-URL shim', () => {
    const code = `import { useGeolocation } from "@ggui-ai/gadgets";`;
    const rewritten = rewriteImports(code, opts);
    expect(rewritten).not.toContain(`from "@ggui-ai/gadgets"`);
    expect(rewritten).toContain('data:text/javascript,');
  });

  it('shim is keyed off globalThis.__ggui__.gadgets[<package>]', () => {
    // GG.8.2 — the runtime registry is per-package. Pin the read
    // path so a refactor away from the per-package slot is caught.
    const code = `import { useGeolocation } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    expect(decoded).toContain('globalThis.__ggui__');
    expect(decoded).toContain('gadgets');
    // The package literal is baked into the shim — the slot key.
    expect(decoded).toContain('"@ggui-ai/gadgets"');
  });

  it('a hook import becomes a real named export (lazy thunk)', () => {
    const code = `import { useGeolocation } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    // Lowercase/`use`-prefixed name → `export const useX = ...`.
    expect(decoded).toContain('export const useGeolocation=');
  });

  it('exports exactly the names the code imports — drift-immune', () => {
    // Only `useCamera` is imported, so only `useCamera` is exported.
    const code = `import { useCamera } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    expect(decoded).toContain('export const useCamera=');
    // A STDLIB hook NOT imported by the code is NOT pre-declared —
    // the shim is import-derived, not allowlist-derived.
    expect(decoded).not.toContain('export const useGeolocation=');
  });

  it('getPublicEnv is exported as a lazy thunk when imported', () => {
    const code = `import { getPublicEnv } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    // lowercase name → `H()` thunk factory.
    expect(decoded).toContain('export const getPublicEnv=');
  });

  it('the shim has NO loadGadgets export', () => {
    // GG.8.2 — `loadGadgets` is retired. Even if generated code
    // (somehow) imports it, the shim only exports import-derived
    // names; there is no special-cased `loadGadgets` accessor.
    const code = `import { useGeolocation } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    expect(decoded).not.toContain('loadGadgets');
    expect(decoded).not.toContain('GadgetsCatalog');
  });

  it('a PascalCase export becomes an error-boundary-wrapped component', () => {
    const code = `import { MapView } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    // PascalCase name → `C()` component factory; the shim wires an
    // error boundary class (`GEB`) so a throwing gadget component
    // renders an inline fallback instead of nuking the host UI.
    expect(decoded).toContain('export const MapView=');
    expect(decoded).toContain('getDerivedStateFromError');
  });

  it('a 3rd-party package threaded via gadgetPackages gets its own shim', () => {
    const code = `import { useLeafletMap } from "@ggui-samples/gadget-leaflet";`;
    const rewritten = rewriteImports(code, {
      mode: 'data-url',
      gadgetPackages: ['@ggui-samples/gadget-leaflet'],
    });
    // The 3rd-party specifier is rewritten to a data-URL shim.
    expect(rewritten).not.toContain(`from "@ggui-samples/gadget-leaflet"`);
    expect(rewritten).toContain('data:text/javascript,');
    const decoded = shimFor(rewritten, '@ggui-samples/gadget-leaflet');
    // The shim is keyed off the 3rd-party package's own slot.
    expect(decoded).toContain('"@ggui-samples/gadget-leaflet"');
    expect(decoded).toContain('export const useLeafletMap=');
  });

  it('a 3rd-party package NOT threaded via gadgetPackages is left untouched', () => {
    // Only `@ggui-ai/gadgets` is rewritten unconditionally. An
    // unregistered 3rd-party specifier escapes the rewriter — the
    // push gate (registry-membership check) catches the upstream
    // cause before render.
    const code = `import { useLeafletMap } from "@ggui-samples/gadget-leaflet";`;
    const rewritten = rewriteImports(code, opts);
    expect(rewritten).toContain(`from "@ggui-samples/gadget-leaflet"`);
  });

  it('rewrites both STDLIB and a 3rd-party package in the same module', () => {
    const code = [
      `import { useGeolocation } from "@ggui-ai/gadgets";`,
      `import { useLeafletMap } from "@ggui-samples/gadget-leaflet";`,
    ].join('\n');
    const rewritten = rewriteImports(code, {
      mode: 'data-url',
      gadgetPackages: ['@ggui-samples/gadget-leaflet'],
    });
    expect(rewritten).not.toContain(`from "@ggui-ai/gadgets"`);
    expect(rewritten).not.toContain(`from "@ggui-samples/gadget-leaflet"`);
    const decoded = decodeURIComponent(rewritten);
    // Per-package: each shim is keyed off its own package slot.
    expect(decoded).toContain('"@ggui-ai/gadgets"');
    expect(decoded).toContain('"@ggui-samples/gadget-leaflet"');
  });

  it('shim hook thunk forwards to the per-package runtime namespace', () => {
    // Eval the shim's `useGeolocation` thunk in a `new Function`
    // sandbox with a fake `globalThis.__ggui__.gadgets[<package>]`
    // installed — exercises the same lazy lookup the iframe hits.
    const code = `import { useGeolocation } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    // Strip module-level export keywords so the body runs in a
    // non-module `new Function` scope. The default export is the
    // LAST statement (a `new Proxy(...)` whose body contains `;`), so
    // drop everything from `export default` to end-of-string.
    const body = decoded
      .replace(/export const useGeolocation=/, 'var useGeolocation=')
      .replace(/export default[\s\S]*$/, '');
    const probe = new Function(`${body}; return useGeolocation;`);
    const useGeolocation = probe() as () => string;

    const fakeImpl = () => 'geo-ran';
    const restore = (globalThis as { __ggui__?: unknown }).__ggui__;
    (globalThis as { __ggui__?: unknown }).__ggui__ = {
      gadgets: { '@ggui-ai/gadgets': { useGeolocation: fakeImpl } },
    };
    try {
      expect(useGeolocation()).toBe('geo-ran');
    } finally {
      if (restore === undefined) {
        delete (globalThis as { __ggui__?: unknown }).__ggui__;
      } else {
        (globalThis as { __ggui__?: unknown }).__ggui__ = restore;
      }
    }
  });

  it('shim hook thunk throws a clear error when the package failed to load', () => {
    const code = `import { useGeolocation } from "@ggui-ai/gadgets";`;
    const decoded = shimFor(rewriteImports(code, opts), '@ggui-ai/gadgets');
    // Strip module-level export keywords so the body runs in a
    // non-module `new Function` scope. The default export is the
    // LAST statement (a `new Proxy(...)` whose body contains `;`), so
    // drop everything from `export default` to end-of-string.
    const body = decoded
      .replace(/export const useGeolocation=/, 'var useGeolocation=')
      .replace(/export default[\s\S]*$/, '');
    const probe = new Function(`${body}; return useGeolocation;`);
    const useGeolocation = probe() as () => unknown;

    const restore = (globalThis as { __ggui__?: unknown }).__ggui__;
    // `__ggui__` present but the gadget package never loaded.
    (globalThis as { __ggui__?: unknown }).__ggui__ = { gadgets: {} };
    try {
      expect(() => useGeolocation()).toThrow(
        /\[gadget\].*useGeolocation.*not loaded/,
      );
    } finally {
      if (restore === undefined) {
        delete (globalThis as { __ggui__?: unknown }).__ggui__;
      } else {
        (globalThis as { __ggui__?: unknown }).__ggui__ = restore;
      }
    }
  });

  it('does NOT rewrite per-wrapper specifiers absent from gadgetPackages', () => {
    // The rewriter has no per-wrapper handler; a wrapper-specifier
    // import not declared in `gadgetPackages` escapes untouched.
    const code = `import { useLeafletMap } from "@ggui-samples/gadget-leaflet";`;
    const rewritten = rewriteImports(code, opts);
    expect(rewritten).toContain(`from "@ggui-samples/gadget-leaflet"`);
  });
});
