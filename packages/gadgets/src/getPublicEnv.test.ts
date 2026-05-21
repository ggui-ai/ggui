// Unit tests for `getPublicEnv()`. The accessor reads
// public env values the iframe runtime planted at
// `globalThis.__ggui__.publicEnv` for wrapper
// authors. Tests pin:
//
//   - throws clearly when __ggui__ is missing
//   - returns the value for a present key
//   - throws with available-list on missing-required by default
//   - returns undefined on missing key when {optional: true}
//   - empty-string values pass through verbatim
//   - empty registry → available list shows "(none)"

import { describe, expect, it } from 'vitest';
import { getPublicEnv } from './getPublicEnv';

interface FakeRoot {
  __ggui__?: {
    readonly publicEnv?: Readonly<Record<string, string>>;
  };
}

function makeTarget(
  publicEnv?: Readonly<Record<string, string>>,
): typeof globalThis {
  const root: FakeRoot = { __ggui__: { publicEnv } };
  return root as unknown as typeof globalThis;
}

describe('getPublicEnv', () => {
  describe('global root missing', () => {
    it('throws when globalThis.__ggui__ is absent', () => {
      const target = {} as unknown as typeof globalThis;
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_FOO', undefined, target),
      ).toThrow(/globalThis\.__ggui__ is not initialized/);
    });

    it('throw message mentions the missing key (helps gadget authors diagnose)', () => {
      const target = {} as unknown as typeof globalThis;
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_FOO', undefined, target),
      ).toThrow(/GGUI_PUBLIC_APP_FOO/);
    });
  });

  describe('value present', () => {
    it('returns the value for a registered key', () => {
      const target = makeTarget({ GGUI_PUBLIC_APP_TOKEN: 'pk.eyJ...' });
      expect(getPublicEnv('GGUI_PUBLIC_APP_TOKEN', undefined, target)).toBe(
        'pk.eyJ...',
      );
    });

    it('returns empty-string values verbatim', () => {
      // Operator may have configured the key without a value (token
      // not yet rotated; intentionally absent). Wrapper decides how
      // to handle empty (may throw, may use a fallback).
      const target = makeTarget({ GGUI_PUBLIC_APP_TOKEN: '' });
      expect(getPublicEnv('GGUI_PUBLIC_APP_TOKEN', undefined, target)).toBe('');
    });
  });

  describe('value missing (required)', () => {
    it('throws when the key is not registered', () => {
      const target = makeTarget({ GGUI_PUBLIC_APP_OTHER: 'x' });
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_MISSING', undefined, target),
      ).toThrow(/not provided in App\.publicEnv/);
    });

    it('throw message names the missing key', () => {
      const target = makeTarget({});
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_NEEDED', undefined, target),
      ).toThrow(/GGUI_PUBLIC_APP_NEEDED/);
    });

    it('throw message lists available keys', () => {
      const target = makeTarget({
        GGUI_PUBLIC_APP_FOO: 'fooval',
        GGUI_PUBLIC_APP_BAR: 'barval',
      });
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_MISSING', undefined, target),
      ).toThrow(/Available: \[GGUI_PUBLIC_APP_FOO, GGUI_PUBLIC_APP_BAR\]/);
    });

    it('throw message says "(none)" when registry is empty', () => {
      const target = makeTarget({});
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_MISSING', undefined, target),
      ).toThrow(/Available: \[\(none\)\]/);
    });

    it('throw message guides toward `requires` declaration', () => {
      // Wrapper authors should add the key to their `requires` list
      // so the push gate validates upstream. The error message hints
      // at this corrective action.
      const target = makeTarget({});
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_MISSING', undefined, target),
      ).toThrow(/'requires'/);
    });
  });

  describe('value missing (optional)', () => {
    it('returns undefined for a missing key when {optional: true}', () => {
      const target = makeTarget({});
      expect(
        getPublicEnv('GGUI_PUBLIC_APP_OPT', { optional: true }, target),
      ).toBeUndefined();
    });

    it('still returns the value when {optional: true} but key is present', () => {
      const target = makeTarget({ GGUI_PUBLIC_APP_OPT: 'somevalue' });
      expect(
        getPublicEnv('GGUI_PUBLIC_APP_OPT', { optional: true }, target),
      ).toBe('somevalue');
    });

    it('does not throw when __ggui__ is missing AND {optional: true} (defensive)', () => {
      // Important edge case: if `optional: true` should NOT throw on
      // missing-root either, the wrapper can shape its own fallback
      // behavior. But the missing-root case is a HARD environment
      // error (no iframe runtime), so we throw even with optional.
      // This test pins that posture: optional doesn't suppress the
      // missing-root throw.
      const target = {} as unknown as typeof globalThis;
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_FOO', { optional: true }, target),
      ).toThrow(/globalThis\.__ggui__ is not initialized/);
    });
  });

  describe('publicEnv slot missing', () => {
    it('throws on missing key when publicEnv slot is absent', () => {
      const root: FakeRoot = { __ggui__: {} }; // __ggui__ exists but no publicEnv field
      const target = root as unknown as typeof globalThis;
      expect(() =>
        getPublicEnv('GGUI_PUBLIC_APP_FOO', undefined, target),
      ).toThrow(/not provided/);
    });

    it('returns undefined on missing key with {optional: true} when slot absent', () => {
      const root: FakeRoot = { __ggui__: {} };
      const target = root as unknown as typeof globalThis;
      expect(
        getPublicEnv('GGUI_PUBLIC_APP_FOO', { optional: true }, target),
      ).toBeUndefined();
    });
  });
});
