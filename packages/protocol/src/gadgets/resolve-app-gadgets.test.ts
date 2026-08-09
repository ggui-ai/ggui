import { describe, it, expect } from 'vitest';
import { resolveAppGadgets } from './resolve-app-gadgets';
import { STDLIB_GADGETS } from './stdlib-gadgets';
const PKG = STDLIB_GADGETS[0].package;
describe('resolveAppGadgets', () => {
  it('absent/empty/null → exactly STDLIB_GADGETS', () => {
    expect(resolveAppGadgets()).toEqual(STDLIB_GADGETS);
    expect(resolveAppGadgets([])).toEqual(STDLIB_GADGETS);
    expect(resolveAppGadgets(null)).toEqual(STDLIB_GADGETS);
  });
  it('unions an extension on top of the floor', () => {
    const ext = { ...STDLIB_GADGETS[0], package: '@acme/maps' };
    const out = resolveAppGadgets([ext]);
    expect(out).toHaveLength(STDLIB_GADGETS.length + 1);
    expect(out.map((g) => g.package)).toEqual(expect.arrayContaining([PKG, '@acme/maps']));
  });
  it('declared overrides the stdlib package on collision', () => {
    const out = resolveAppGadgets([{ ...STDLIB_GADGETS[0], version: '9.9.9' }]);
    expect(out).toHaveLength(STDLIB_GADGETS.length);
    expect(out.find((g) => g.package === PKG)?.version).toBe('9.9.9');
  });
  it('dedupes declared (last wins)', () => {
    const out = resolveAppGadgets([
      { ...STDLIB_GADGETS[0], package: '@x/y', version: '1' },
      { ...STDLIB_GADGETS[0], package: '@x/y', version: '2' },
    ]);
    expect(out.filter((g) => g.package === '@x/y')).toHaveLength(1);
    expect(out.find((g) => g.package === '@x/y')?.version).toBe('2');
  });
  it('idempotent when declared already includes stdlib', () => {
    expect(resolveAppGadgets([...STDLIB_GADGETS])).toHaveLength(STDLIB_GADGETS.length);
  });

  describe('installed source (three-source precedence)', () => {
    it('installed-only layers on top of the floor', () => {
      const inst = { ...STDLIB_GADGETS[0], package: '@acme/charts' };
      const out = resolveAppGadgets(undefined, [inst]);
      expect(out).toHaveLength(STDLIB_GADGETS.length + 1);
      expect(out.map((g) => g.package)).toEqual(
        expect.arrayContaining([PKG, '@acme/charts']),
      );
    });
    it('installed overriding the stdlib package wins over the floor', () => {
      const out = resolveAppGadgets(undefined, [
        { ...STDLIB_GADGETS[0], version: '7.7.7' },
      ]);
      expect(out).toHaveLength(STDLIB_GADGETS.length);
      expect(out.find((g) => g.package === PKG)?.version).toBe('7.7.7');
    });
    it('declared beats installed on the SAME package (declared wins)', () => {
      const pkg = '@acme/maps';
      const out = resolveAppGadgets(
        [{ ...STDLIB_GADGETS[0], package: pkg, version: '2.0.0' }],
        [{ ...STDLIB_GADGETS[0], package: pkg, version: '1.0.0' }],
      );
      expect(out.filter((g) => g.package === pkg)).toHaveLength(1);
      expect(out.find((g) => g.package === pkg)?.version).toBe('2.0.0');
    });
    it('absent/empty/null both args ⇒ exactly stdlib', () => {
      expect(resolveAppGadgets(undefined, undefined)).toEqual(STDLIB_GADGETS);
      expect(resolveAppGadgets([], [])).toEqual(STDLIB_GADGETS);
      expect(resolveAppGadgets(null, null)).toEqual(STDLIB_GADGETS);
    });
    it('disjoint installed + declared both union over the floor', () => {
      const out = resolveAppGadgets(
        [{ ...STDLIB_GADGETS[0], package: '@dec/only' }],
        [{ ...STDLIB_GADGETS[0], package: '@inst/only' }],
      );
      expect(out).toHaveLength(STDLIB_GADGETS.length + 2);
    });
    it('idempotent over pre-resolved input', () => {
      const once = resolveAppGadgets(
        [{ ...STDLIB_GADGETS[0], package: '@dec/x', version: '3' }],
        [{ ...STDLIB_GADGETS[0], package: '@inst/y', version: '1' }],
      );
      expect(resolveAppGadgets(once)).toEqual(once);
    });
  });
});
