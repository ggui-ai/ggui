import { describe, expect, it } from 'vitest';
import type { GadgetHook } from '@ggui-ai/protocol';
import {
  createGguiGadget,
  WrapperConformanceError,
} from './createGguiGadget';

/**
 * Tiny fixture hook — no React internals; the factory doesn't call
 * the hook, it just attaches the descriptor. Returning a plain object
 * is enough to verify the factory plumbs the function through.
 */
const sampleHookImpl: GadgetHook<{ ok: true }, void> = () => ({
  value: { ok: true } as const,
  status: 'idle',
  start: async () => undefined,
});

const validSpec = {
  hook: 'useFixture',
  description: 'Test wrapper for the createGguiGadget factory.',
  usage:
    'Mount in a test render. Synth + code-gen never see this — it only validates the SDK code path.',
  example: { call: 'useFixture()', returns: { status: 'idle' } },
  package: '@ggui-samples/wrapper-fixture',
  version: '0.0.1',
  hookImpl: sampleHookImpl,
} as const;

describe('createGguiGadget', () => {
  it('returns a callable React hook with the descriptor attached', () => {
    const useFixture = createGguiGadget(validSpec);
    expect(typeof useFixture).toBe('function');
    expect(useFixture.descriptor.package).toBe(
      '@ggui-samples/wrapper-fixture',
    );
    expect(useFixture.descriptor.exports).toHaveLength(1);
    const [hookExport] = useFixture.descriptor.exports;
    expect(hookExport).toMatchObject({
      hook: 'useFixture',
      description: validSpec.description,
      usage: validSpec.usage,
      example: validSpec.example,
    });
  });

  it('calls the underlying hook implementation when invoked', () => {
    const useFixture = createGguiGadget(validSpec);
    const result = useFixture();
    expect(result.value).toEqual({ ok: true });
    expect(result.status).toBe('idle');
  });

  it('freezes the descriptor so consumers cannot mutate it', () => {
    const useFixture = createGguiGadget(validSpec);
    expect(Object.isFrozen(useFixture.descriptor)).toBe(true);
  });

  it('throws WrapperConformanceError when description is empty', () => {
    expect(() =>
      createGguiGadget({ ...validSpec, description: '' }),
    ).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError when usage is missing', () => {
    // Cast required because the field is typed as required on the spec.
    const bad = { ...validSpec, usage: undefined } as unknown as typeof validSpec;
    expect(() => createGguiGadget(bad)).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError when example is omitted', () => {
    const bad = {
      ...validSpec,
      example: undefined,
    } as unknown as typeof validSpec;
    expect(() => createGguiGadget(bad)).toThrow(WrapperConformanceError);
  });

  // `package` + `version` are identity, required on every descriptor.
  // Wrappers MUST declare both at registration time.
  it('throws WrapperConformanceError when package is missing', () => {
    const bad = { ...validSpec, package: undefined } as unknown as typeof validSpec;
    expect(() => createGguiGadget(bad)).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError when version is missing', () => {
    const bad = { ...validSpec, version: undefined } as unknown as typeof validSpec;
    expect(() => createGguiGadget(bad)).toThrow(WrapperConformanceError);
  });

  it('throws WrapperConformanceError when hookImpl is not a function', () => {
    const bad = {
      ...validSpec,
      hookImpl: 'not a function',
    } as unknown as typeof validSpec;
    expect(() => createGguiGadget(bad)).toThrow(WrapperConformanceError);
  });

  it('surfaces field-level paths in WrapperConformanceError.violations', () => {
    try {
      createGguiGadget({ ...validSpec, description: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WrapperConformanceError);
      const violations = (err as WrapperConformanceError).violations;
      expect(violations.length).toBeGreaterThan(0);
      // The descriptor reshape nests teaching text under
      // `exports[*]`, so the field path is now `exports.0.description`.
      const paths = violations.map((v) => v.path.join('.'));
      expect(paths).toContain('exports.0.description');
    }
  });

  it('accepts the new optional fields (gotchas, version, styleUrl, connect, requires)', () => {
    const useFixture = createGguiGadget({
      ...validSpec,
      gotchas: 'Beware double-mounting in StrictMode.',
      version: '1.2.3',
      styleUrl: 'https://bundles.example.com/fixture@1.2/fixture.css',
      connect: ['https://api.example.com'],
      requires: ['GGUI_PUBLIC_APP_API_KEY'],
    });
    // `gotchas` is a per-export teaching field — it lands on the hook
    // export, not the package-level descriptor.
    expect(useFixture.descriptor.exports[0]?.gotchas).toBe(
      'Beware double-mounting in StrictMode.',
    );
    // Identity + transport fields stay at the package level.
    expect(useFixture.descriptor.version).toBe('1.2.3');
    expect(useFixture.descriptor.styleUrl).toBe(
      'https://bundles.example.com/fixture@1.2/fixture.css',
    );
    expect(useFixture.descriptor.connect).toEqual([
      'https://api.example.com',
    ]);
    expect(useFixture.descriptor.requires).toEqual([
      'GGUI_PUBLIC_APP_API_KEY',
    ]);
  });
});
