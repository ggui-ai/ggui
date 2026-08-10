/**
 * Inline-exec transform + resolver — the CSP-resilient execution path
 * for hosts whose `script-src` grants only `'unsafe-inline'` (no
 * `blob:`, no `data:`, no external origins).
 *
 * The transform's output is CLASSIC-script text, so these tests
 * evaluate it with `new Function` (same evaluation class as an inline
 * script element: no module machinery) against a stubbed handoff
 * global.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INLINE_EXEC_HANDOFF_GLOBAL,
  resolveInlineSpecifier,
  transformForInlineExec,
} from './inline-exec';

interface Handoff {
  resolve: (spec: string) => Record<string, unknown>;
  exports: Record<string, unknown>;
  error?: unknown;
  ran?: boolean;
}

function runTransformed(
  code: string,
  resolve: (spec: string) => Record<string, unknown>,
): Handoff {
  const handoff: Handoff = { resolve, exports: {} };
  (globalThis as Record<string, unknown>)[INLINE_EXEC_HANDOFF_GLOBAL] = handoff;
  try {
    // eslint-disable-next-line no-new-func
    new Function(transformForInlineExec(code))();
  } finally {
    delete (globalThis as Record<string, unknown>)[INLINE_EXEC_HANDOFF_GLOBAL];
  }
  if (handoff.error !== undefined) throw handoff.error;
  return handoff;
}

describe('transformForInlineExec — imports', () => {
  const modules: Record<string, Record<string, unknown>> = {
    'pkg-a': { default: 'A-default', one: 1, two: 2 },
    'pkg-b': { default: 'B-default', three: 3 },
  };
  const resolve = (spec: string) => {
    const m = modules[spec];
    if (m === undefined) throw new Error(`no module ${spec}`);
    return m;
  };

  it('rewrites named imports (incl. aliases) to handoff-resolved bindings', () => {
    const h = runTransformed(
      `import { one, two as deux } from 'pkg-a';\nexport default one + deux;`,
      resolve,
    );
    expect(h.exports.default).toBe(3);
    expect(h.ran).toBe(true);
  });

  it('rewrites default imports', () => {
    const h = runTransformed(
      `import A from 'pkg-a';\nexport default A;`,
      resolve,
    );
    expect(h.exports.default).toBe('A-default');
  });

  it('rewrites default + named combined imports', () => {
    const h = runTransformed(
      `import A, { one } from 'pkg-a';\nexport default [A, one];`,
      resolve,
    );
    expect(h.exports.default).toEqual(['A-default', 1]);
  });

  it('rewrites namespace imports', () => {
    const h = runTransformed(
      `import * as NS from 'pkg-b';\nexport default NS.three;`,
      resolve,
    );
    expect(h.exports.default).toBe(3);
  });

  it('handles multiple import statements without temp-binding collisions', () => {
    const h = runTransformed(
      `import { one } from 'pkg-a';\nimport { three } from 'pkg-b';\nexport default one + three;`,
      resolve,
    );
    expect(h.exports.default).toBe(4);
  });

  it('handles esbuild-minified spacing (import{a as b}from"x")', () => {
    const h = runTransformed(
      `import{one as uno,two}from"pkg-a";export default uno*10+two;`,
      resolve,
    );
    expect(h.exports.default).toBe(12);
  });

  it('drops bare side-effect imports', () => {
    const h = runTransformed(
      `import 'pkg-a';\nexport default 'ok';`,
      resolve,
    );
    expect(h.exports.default).toBe('ok');
  });

  it('surfaces resolver failures through the handoff error channel', () => {
    expect(() =>
      runTransformed(`import { x } from 'unknown-pkg';\nexport default x;`, resolve),
    ).toThrow(/no module unknown-pkg/);
  });
});

describe('transformForInlineExec — exports', () => {
  const resolve = () => ({});

  it('handles `export default function Name()`', () => {
    const h = runTransformed(
      `export default function Card() { return 'card'; }`,
      resolve,
    );
    expect(typeof h.exports.default).toBe('function');
    expect((h.exports.default as () => string)()).toBe('card');
  });

  it('handles `export default <arrow expression>`', () => {
    const h = runTransformed(`export default () => 'arrow';`, resolve);
    expect((h.exports.default as () => string)()).toBe('arrow');
  });

  it("handles esbuild's consolidated `export { X as default, y };` tail", () => {
    const h = runTransformed(
      `function Card() { return 'c'; }\nvar version = 7;\nexport { Card as default, version };`,
      resolve,
    );
    expect((h.exports.default as () => string)()).toBe('c');
    expect(h.exports.version).toBe(7);
  });

  it('handles declaration exports (const / function)', () => {
    const h = runTransformed(
      `export const answer = 42;\nexport function make() { return answer; }`,
      resolve,
    );
    expect(h.exports.answer).toBe(42);
    expect((h.exports.make as () => number)()).toBe(42);
  });

  it('throws on re-export statements rather than executing half-transformed code', () => {
    expect(() => transformForInlineExec(`export { x } from 'other';`)).toThrow(
      /re-export/,
    );
    expect(() => transformForInlineExec(`export * from 'other';`)).toThrow(
      /re-export/,
    );
  });

  it('propagates top-level throws through the handoff instead of losing them', () => {
    expect(() =>
      runTransformed(`throw new Error('component blew up');`, resolve),
    ).toThrow(/component blew up/);
  });
});

describe('resolveInlineSpecifier', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__ggui__ = {
      react: {
        createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
          type,
          props,
          children,
        }),
        Fragment: 'FRAGMENT',
        useState: (v: unknown) => [v, () => undefined],
      },
      wire: { useAction: () => 'action-hook' },
      primitives: { Button: 'BUTTON', Card: 'CARD' },
      components: { SearchField: 'SEARCH' },
      compositions: {},
      interact: {},
      tokens: { spacing: { md: 8 } },
      gadgets: {
        '@ggui-ai/gadgets': { getPublicEnv: () => ({ KEY: 'v' }) },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ggui__;
  });

  it('resolves react with default === the registry react', () => {
    const ns = resolveInlineSpecifier('react');
    expect(typeof ns.useState).toBe('function');
    expect((ns.default as Record<string, unknown>).Fragment).toBe('FRAGMENT');
  });

  it('bridges the automatic JSX transform to createElement (children + key)', () => {
    const ns = resolveInlineSpecifier('react/jsx-runtime');
    const jsx = ns.jsx as (t: unknown, p: Record<string, unknown>, k?: unknown) => {
      type: unknown;
      props: Record<string, unknown>;
      children: unknown[];
    };
    const single = jsx('div', { children: 'hi', x: 1 }, 'k1');
    expect(single.type).toBe('div');
    expect(single.props.key).toBe('k1');
    expect(single.props.children).toBeUndefined();
    expect(single.children).toEqual(['hi']);
    const multi = jsx('ul', { children: ['a', 'b'] });
    expect(multi.children).toEqual(['a', 'b']);
    expect(ns.Fragment).toBe('FRAGMENT');
    expect(ns.jsxs).toBe(ns.jsx);
  });

  it('merges design layers with cross-path fallback (Input from components path)', () => {
    const fromComponents = resolveInlineSpecifier('@ggui-ai/design/components');
    expect(fromComponents.SearchField).toBe('SEARCH');
    // Cross-layer fallback: primitives names resolve through the
    // components path too, matching the data-url merge shim.
    expect(fromComponents.Button).toBe('BUTTON');
    const fromPrimitives = resolveInlineSpecifier('@ggui-ai/design/primitives');
    expect(fromPrimitives.Button).toBe('BUTTON');
    expect(fromPrimitives.SearchField).toBe('SEARCH');
  });

  it('resolves wire hooks', () => {
    const ns = resolveInlineSpecifier('@ggui-ai/wire');
    expect((ns.useAction as () => string)()).toBe('action-hook');
  });

  it('resolves tokens with the legacy window-global fallback', () => {
    expect((resolveInlineSpecifier('@ggui-ai/design/tokens').spacing as { md: number }).md).toBe(8);
    delete ((globalThis as Record<string, unknown>).__ggui__ as Record<string, unknown>).tokens;
    (window as unknown as Record<string, unknown>).__GGUI_TOKENS = { spacing: { md: 99 } };
    try {
      expect(
        (resolveInlineSpecifier('@ggui-ai/design/tokens').spacing as { md: number }).md,
      ).toBe(99);
    } finally {
      delete (window as unknown as Record<string, unknown>).__GGUI_TOKENS;
    }
  });

  it('resolves STDLIB gadget exports as lazy thunks', () => {
    const ns = resolveInlineSpecifier('@ggui-ai/gadgets');
    const getPublicEnv = ns.getPublicEnv as () => Record<string, string>;
    expect(getPublicEnv()).toEqual({ KEY: 'v' });
  });

  it('gadget thunks fail with the loaded-gadget contract message, not undefined-call', () => {
    const ns = resolveInlineSpecifier('@ggui-ai/gadgets');
    const missing = ns.useMissingHook as () => unknown;
    expect(() => missing()).toThrow(/is not loaded/);
  });

  it('resolves registered 3rd-party gadget packages and rejects unknown specifiers', () => {
    const third = resolveInlineSpecifier('leaflet-gadgets', {
      gadgetPackages: ['leaflet-gadgets'],
    });
    expect(third).toBeDefined();
    expect(() => resolveInlineSpecifier('left-pad')).toThrow(/cannot resolve bare specifier/);
  });

  it('keeps gadget component identity stable across repeated property reads', () => {
    const ns = resolveInlineSpecifier('@ggui-ai/gadgets');
    expect(ns.MapView).toBe(ns.MapView);
  });
});

describe('end-to-end: component-shaped module through transform + resolver', () => {
  beforeEach(() => {
    (globalThis as Record<string, unknown>).__ggui__ = {
      react: {
        createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
          type,
          props,
          children,
        }),
        Fragment: 'FRAGMENT',
        useState: (v: unknown) => [v, () => undefined],
      },
      wire: { useAction: () => () => undefined },
      primitives: { Button: 'BUTTON' },
      components: {},
      compositions: {},
      interact: {},
    };
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__ggui__;
  });

  it('mounts an esbuild-shaped component module fetch-free', () => {
    const code = [
      `import { jsx as _jsx } from "react/jsx-runtime";`,
      `import { useState } from "react";`,
      `import { Button } from "@ggui-ai/design/primitives";`,
      `function Card() {`,
      `  const [n] = useState(1);`,
      `  return _jsx("div", { children: _jsx(Button, { children: n }) });`,
      `}`,
      `export { Card as default };`,
    ].join('\n');
    const h = runTransformed(code, (spec) => resolveInlineSpecifier(spec));
    const Card = h.exports.default as () => { type: unknown; children: unknown[] };
    const tree = Card();
    expect(tree.type).toBe('div');
  });
});
