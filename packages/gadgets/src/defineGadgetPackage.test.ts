// `defineGadgetPackage` is the wrapper-author SDK builder for
// a gadget PACKAGE that ships one or more exports, hooks AND/OR
// components, behind one npm identity. Tests pin: single-hook /
// single-component / MIXED descriptors, transport-field passthrough,
// and the conformance throws (empty exports, non-function impl, missing
// teaching text, malformed export name).

import { describe, it, expect } from 'vitest';
import {
  defineGadgetPackage,
  WrapperConformanceError,
  type GadgetImpl,
} from './index';

// The builder only conformance-checks `impl` is a function — it never
// inspects the signature — so plain functions stand in for the real
// React hook / component.
const hookImpl: GadgetImpl = () => undefined;
const componentImpl: GadgetImpl = () => undefined;

const TEACHING = {
  description: 'Test export for the defineGadgetPackage builder.',
  usage: 'Exercises the SDK code path only — never seen by codegen.',
  example: { call: 'example()' },
} as const;

describe('defineGadgetPackage', () => {
  it('builds a single-hook package descriptor', () => {
    const descriptor = defineGadgetPackage({
      package: '@scope/gadget-foo',
      version: '0.0.1',
      exports: [{ hook: 'useFoo', impl: hookImpl, ...TEACHING }],
    });
    expect(descriptor.package).toBe('@scope/gadget-foo');
    expect(descriptor.version).toBe('0.0.1');
    expect(descriptor.exports).toHaveLength(1);
    expect(descriptor.exports[0]).toMatchObject({
      hook: 'useFoo',
      description: TEACHING.description,
    });
    // `impl` is NOT carried onto the serializable descriptor.
    expect('impl' in descriptor.exports[0]!).toBe(false);
  });

  it('builds a single-component package descriptor', () => {
    const descriptor = defineGadgetPackage({
      package: '@scope/gadget-chart',
      version: '0.0.1',
      exports: [{ component: 'Chart', impl: componentImpl, ...TEACHING }],
    });
    expect(descriptor.exports).toHaveLength(1);
    expect(descriptor.exports[0]).toMatchObject({ component: 'Chart' });
  });

  it('builds a MIXED package — component + hook — as one descriptor', () => {
    const descriptor = defineGadgetPackage({
      package: '@scope/gadget-chart',
      version: '0.0.1',
      styleUrl: 'https://cdn.example.com/chart.css',
      connect: ['https://api.example.com'],
      exports: [
        { component: 'Chart', impl: componentImpl, ...TEACHING },
        { hook: 'useChartTheme', impl: hookImpl, ...TEACHING },
      ],
    });
    expect(descriptor.exports).toHaveLength(2);
    // Export order is preserved.
    expect(descriptor.exports[0]).toMatchObject({ component: 'Chart' });
    expect(descriptor.exports[1]).toMatchObject({ hook: 'useChartTheme' });
    // Transport metadata is per-PACKAGE — declared once.
    expect(descriptor.styleUrl).toBe('https://cdn.example.com/chart.css');
    expect(descriptor.connect).toEqual(['https://api.example.com']);
  });

  it('carries optional per-export fields (gotchas, permission, required)', () => {
    const descriptor = defineGadgetPackage({
      package: '@scope/gadget-foo',
      version: '0.0.1',
      exports: [
        {
          hook: 'useFoo',
          impl: hookImpl,
          ...TEACHING,
          gotchas: 'Mind the footgun.',
          permission: 'geolocation',
          required: true,
        },
      ],
    });
    expect(descriptor.exports[0]).toMatchObject({
      gotchas: 'Mind the footgun.',
      permission: 'geolocation',
      required: true,
    });
  });

  it('throws WrapperConformanceError when exports is empty', () => {
    expect(() =>
      defineGadgetPackage({
        package: '@scope/gadget-foo',
        version: '0.0.1',
        exports: [],
      }),
    ).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError when an impl is not a function', () => {
    const bad = {
      package: '@scope/gadget-foo',
      version: '0.0.1',
      exports: [{ hook: 'useFoo', impl: 'not a function', ...TEACHING }],
    } as unknown as Parameters<typeof defineGadgetPackage>[0];
    expect(() => defineGadgetPackage(bad)).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError when teaching text is empty', () => {
    expect(() =>
      defineGadgetPackage({
        package: '@scope/gadget-foo',
        version: '0.0.1',
        exports: [
          { hook: 'useFoo', impl: hookImpl, ...TEACHING, description: '' },
        ],
      }),
    ).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError on a malformed hook name (not use-prefixed)', () => {
    expect(() =>
      defineGadgetPackage({
        package: '@scope/gadget-foo',
        version: '0.0.1',
        exports: [{ hook: 'foo', impl: hookImpl, ...TEACHING }],
      }),
    ).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError on a malformed component name (not PascalCase)', () => {
    expect(() =>
      defineGadgetPackage({
        package: '@scope/gadget-foo',
        version: '0.0.1',
        exports: [{ component: 'chart', impl: componentImpl, ...TEACHING }],
      }),
    ).toThrow(WrapperConformanceError);
  });

  it('surfaces field-level paths in WrapperConformanceError.violations', () => {
    try {
      defineGadgetPackage({
        package: '@scope/gadget-foo',
        version: '0.0.1',
        exports: [
          { hook: 'useFoo', impl: hookImpl, ...TEACHING, description: '' },
        ],
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WrapperConformanceError);
      const paths = (err as WrapperConformanceError).violations.map((v) =>
        v.path.join('.'),
      );
      expect(paths).toContain('exports.0.description');
    }
  });
});
