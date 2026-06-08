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
});
