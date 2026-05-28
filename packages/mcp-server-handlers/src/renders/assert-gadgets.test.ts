import { describe, expect, it } from 'vitest';
import {
  gadgetExportName,
  type GadgetDescriptor,
  type DataContract,
} from '@ggui-ai/protocol';
import {
  assertGadgetsRegistered,
  GadgetNotRegisteredError,
  GadgetPackageMismatchError,
  filterDescriptorsToContract,
  findClosestRegisteredHook,
} from './assert-gadgets';

// GG.8.8 — `clientCapabilities.gadgets` is package-keyed: a two-level
// map `Record<packageName, Record<exportName, GadgetExportUse>>`. The
// export NAME is the inner key; its grammar discriminates kind. There
// is no `binding` name, no `hook`/`component` field, no `version` on
// the wire — `App.gadgets` owns the version pin. A `GadgetDescriptor`
// remains a PACKAGE: each `(package, version)` bundles one or more
// `exports[]`.
const SAMPLE_APP_LIBRARIES: readonly GadgetDescriptor[] = [
  {
    package: '@ggui-ai/gadgets',
    version: '0.1.0-rc.1',
    exports: [
      {
        hook: 'useGeolocation',
        description: 'lat/long reader',
        usage: 'Mount when intent names location.',
        example: { call: 'useGeolocation()' },
      },
    ],
  },
  {
    package: '@my-org/ggui-leaflet',
    version: '0.0.1',
    exports: [
      {
        hook: 'useLeafletMap',
        description: 'Leaflet map wrapper.',
        usage: 'Mount when intent names maps.',
        example: { call: 'useLeafletMap()' },
      },
    ],
  },
];

describe('assertGadgetsRegistered', () => {
  it('returns without throwing when every declared gadget is registered', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
          '@my-org/ggui-leaflet': { useLeafletMap: {} },
        },
      },
    };
    expect(() =>
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES),
    ).not.toThrow();
  });

  it('returns without throwing when the contract declares no libraries', () => {
    const contract: DataContract = { propsSpec: { properties: {} } };
    expect(() =>
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES),
    ).not.toThrow();
  });

  it('returns without throwing when no appGadgets are bound (graceful degrade)', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/unregistered': { useUnregistered: {} },
        },
      },
    };
    expect(() =>
      assertGadgetsRegistered(contract, undefined),
    ).not.toThrow();
  });

  it('throws GadgetNotRegisteredError when a hook is missing', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
          '@acme/doordash': { useDoorDashCheckout: {} },
        },
      },
    };
    expect(() =>
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES),
    ).toThrow(GadgetNotRegisteredError);
  });

  it('emits did-you-mean suggestion when a close match exists', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeoLocation: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GadgetNotRegisteredError);
      const e = err as GadgetNotRegisteredError;
      expect(e.unregistered).toHaveLength(1);
      expect(e.unregistered[0]?.hook).toBe('useGeoLocation');
      expect(e.unregistered[0]?.suggestion).toBe('useGeolocation');
      expect(e.message).toContain('did you mean');
    }
  });

  it('omits suggestion when no registered hook is within distance < 3', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/unrelated': { useCompletelyUnrelatedThing: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GadgetNotRegisteredError;
      expect(e.unregistered[0]?.suggestion).toBeNull();
    }
  });

  // Slice GG.6 F1 regression — export-name-only match would silently
  // accept a ref whose package disagrees with the registered
  // descriptor. The filter would then drop the ref → empty sidecar →
  // permissions/CSP under-derive. The `(name, package)` identity match
  // guards against this. Slice GG.5 sharpens the reject code: a
  // hook-match/package-miss is a `gadget_package_mismatch`, not an
  // opaque `gadget_not_registered`.
  it('throws GadgetPackageMismatchError when hook matches but package is wrong', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          // Right hook, wrong package — operator registered
          // `@my-org/ggui-leaflet`.
          '@evil/hijack-leaflet': { useLeafletMap: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GadgetPackageMismatchError);
      const e = err as GadgetPackageMismatchError;
      expect(e.code).toBe('gadget_package_mismatch');
      expect(e.mismatches).toHaveLength(1);
      expect(e.mismatches[0]?.hook).toBe('useLeafletMap');
      expect(e.mismatches[0]?.requestedPackage).toBe('@evil/hijack-leaflet');
      expect(e.mismatches[0]?.registered).toEqual(['@my-org/ggui-leaflet']);
      expect(e.message).toContain('@my-org/ggui-leaflet');
    }
  });

  // Slice GG.5 — a hook registered under two packages: a package
  // miss must carry BOTH registered packages so the author sees the
  // full set of valid identities.
  it('GadgetPackageMismatchError carries every registered package for the hook', () => {
    const multiPackage: readonly GadgetDescriptor[] = [
      ...SAMPLE_APP_LIBRARIES,
      {
        package: '@other-org/leaflet-fork',
        version: '2.0.0',
        exports: [
          {
            hook: 'useLeafletMap',
            description: 'A fork.',
            usage: 'Mount for maps.',
            example: { call: 'useLeafletMap()' },
          },
        ],
      },
    ];
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@evil/hijack-leaflet': { useLeafletMap: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, multiPackage);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GadgetPackageMismatchError;
      expect(e).toBeInstanceOf(GadgetPackageMismatchError);
      expect(e.mismatches[0]?.registered).toEqual([
        '@my-org/ggui-leaflet',
        '@other-org/leaflet-fork',
      ]);
    }
  });

  // Slice GG.5 — when a push hits multiple miss categories at once,
  // the gate throws the most fundamental one first: an unknown hook
  // name can't be acted on as a "wrong package" message. The
  // lower-priority misses ride on `secondary` so the author fixes
  // every category in one round trip.
  it('prioritizes gadget_not_registered and carries the package miss on secondary', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/absent': { useTotallyAbsentHook: {} },
          '@evil/hijack-leaflet': { useLeafletMap: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GadgetNotRegisteredError);
      const e = err as GadgetNotRegisteredError;
      expect(e.unregistered).toHaveLength(1);
      expect(e.secondary?.packageMismatches).toHaveLength(1);
      expect(e.secondary?.packageMismatches[0]?.hook).toBe('useLeafletMap');
      expect(e.message).toContain('ALSO has gadget refs failing');
      expect(e.message).toContain('gadget_package_mismatch');
    }
  });

  it('leaves secondary undefined on a single-category miss', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@evil/hijack-leaflet': { useLeafletMap: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GadgetPackageMismatchError;
      expect(e).toBeInstanceOf(GadgetPackageMismatchError);
      expect(e.message).not.toContain('ALSO has gadget refs failing');
    }
  });

  // Slice GG.5 — same-category misses aggregate into one error.
  it('aggregates every package miss into a single GadgetPackageMismatchError', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@evil/hijack-a': { useLeafletMap: {} },
          '@evil/hijack-b': { useGeolocation: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GadgetPackageMismatchError;
      expect(e).toBeInstanceOf(GadgetPackageMismatchError);
      expect(e.mismatches).toHaveLength(2);
      expect(e.mismatches.map((m) => m.hook).sort()).toEqual([
        'useGeolocation',
        'useLeafletMap',
      ]);
    }
  });

  it('lists every unregistered hook in one error, not one error per hook', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/unknown-a': { useUnknownA: {} },
          '@acme/unknown-b': { useUnknownB: {} },
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    try {
      assertGadgetsRegistered(contract, SAMPLE_APP_LIBRARIES);
      throw new Error('expected throw');
    } catch (err) {
      const e = err as GadgetNotRegisteredError;
      expect(e.unregistered).toHaveLength(2);
      expect(e.unregistered.map((u) => u.hook).sort()).toEqual([
        'useUnknownA',
        'useUnknownB',
      ]);
    }
  });
});

describe('filterDescriptorsToContract', () => {
  // Slice GG.6: `enrichContractGadgets` (wire-overlay merge) is retired.
  // `filterDescriptorsToContract` instead returns the SUBSET of
  // `appGadgets` whose npm PACKAGE key is referenced by
  // `contract.clientCapabilities?.gadgets` — deduplicated, in
  // contract-ref insertion order. The wire stays the wire; resolved
  // descriptors land as a sidecar on `Render.gadgetDescriptors`.

  it('returns an empty array when no clientCapabilities.gadgets declared', () => {
    const contract: DataContract = { propsSpec: { properties: {} } };
    expect(
      filterDescriptorsToContract(contract, SAMPLE_APP_LIBRARIES),
    ).toEqual([]);
  });

  it('returns an empty array when appGadgets is empty', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    expect(filterDescriptorsToContract(contract, [])).toEqual([]);
  });

  it('returns the package descriptor whose package key matches a ref', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    const result = filterDescriptorsToContract(
      contract,
      SAMPLE_APP_LIBRARIES,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.package).toBe('@ggui-ai/gadgets');
    expect(result[0]?.version).toBe('0.1.0-rc.1');
    const exp = result[0]?.exports[0];
    expect(exp && gadgetExportName(exp)).toBe('useGeolocation');
    expect(exp?.description).toBe('lat/long reader');
    expect(exp?.usage).toBe('Mount when intent names location.');
    expect(exp?.example).toEqual({ call: 'useGeolocation()' });
  });

  it('returns descriptors in contract-ref insertion order', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@my-org/ggui-leaflet': { useLeafletMap: {} },
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    const result = filterDescriptorsToContract(
      contract,
      SAMPLE_APP_LIBRARIES,
    );
    expect(result.map((d) => d.package)).toEqual([
      '@my-org/ggui-leaflet',
      '@ggui-ai/gadgets',
    ]);
  });

  it('drops refs whose package has no matching descriptor', () => {
    // The push-time `assertGadgetsRegistered` gate rejects this case
    // before the resolver runs, but a silent drop here keeps the
    // happy path total — see `resolve-contract-gadgets.ts`.
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@acme/unknown': { useUnknownHook: {} },
        },
      },
    };
    expect(
      filterDescriptorsToContract(contract, SAMPLE_APP_LIBRARIES),
    ).toEqual([]);
  });

  it('returns one descriptor per package even with multiple exports referenced', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    const result = filterDescriptorsToContract(
      contract,
      SAMPLE_APP_LIBRARIES,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.package).toBe('@ggui-ai/gadgets');
  });

  it('does not mutate the input contract', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    };
    const before = JSON.stringify(contract);
    filterDescriptorsToContract(contract, SAMPLE_APP_LIBRARIES);
    expect(JSON.stringify(contract)).toBe(before);
  });
});

describe('findClosestRegisteredHook', () => {
  it('returns the closest match within distance 3', () => {
    expect(
      findClosestRegisteredHook('useGeoLocation', SAMPLE_APP_LIBRARIES),
    ).toBe('useGeolocation');
  });

  it('returns null when no hook is within distance 3', () => {
    expect(
      findClosestRegisteredHook('useDoorDash', SAMPLE_APP_LIBRARIES),
    ).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(
      findClosestRegisteredHook('USEGEOLOCATION', SAMPLE_APP_LIBRARIES),
    ).toBe('useGeolocation');
  });
});
