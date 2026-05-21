// Slice 2.1 — unit tests for `assertPublicEnvSatisfied` +
// `findClosestPublicEnvKey`. The validator complements
// `assertGadgetsRegistered` (Slice 1.1.1): the registry gate
// validates the hook NAME is registered; this gate validates the
// hook's required env keys are configured.
//
// GG.8.8 — `clientCapabilities.gadgets` is package-keyed: a two-level
// map `Record<packageName, Record<exportName, GadgetExportUse>>`. The
// wire carries identity only — no `version`, no `binding` name.

import { describe, it, expect } from 'vitest';
import type {
  GadgetDescriptor,
  DataContract,
  GadgetPackageUse,
} from '@ggui-ai/protocol';
import {
  assertPublicEnvSatisfied,
  GadgetPublicEnvMissingError,
  findClosestPublicEnvKey,
} from './assert-public-env';

function contractWithGadgets(
  gadgets: Record<string, GadgetPackageUse>,
): DataContract {
  return {
    clientCapabilities: { gadgets },
  };
}

const MAPBOX_GADGETS: Record<string, GadgetPackageUse> = {
  '@ggui-samples/gadget-mapbox': { useMapbox: {} },
};
const LEAFLET_GADGETS: Record<string, GadgetPackageUse> = {
  '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
};

// GG.8.1 — a `GadgetDescriptor` is a PACKAGE: `requires` is
// package-level, teaching text is per-export. `overrides` only ever
// touches package-level fields (`version`, `requires`), so a
// `Partial<GadgetDescriptor>` override stays valid.
function mapboxLib(
  overrides: Partial<GadgetDescriptor> = {},
): GadgetDescriptor {
  return {
    package: '@ggui-samples/gadget-mapbox',
    version: '0.0.1',
    requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
    exports: [
      {
        hook: 'useMapbox',
        description: 'Mapbox GL JS interactive map renderer.',
        usage: 'Mount when intent names interactive maps.',
        example: { center: [0, 0], zoom: 2 },
      },
    ],
    ...overrides,
  };
}

function leafletLib(
  overrides: Partial<GadgetDescriptor> = {},
): GadgetDescriptor {
  return {
    package: '@ggui-samples/gadget-leaflet',
    version: '0.0.1',
    // Leaflet doesn't need a token.
    exports: [
      {
        hook: 'useLeafletMap',
        description: 'Leaflet map renderer.',
        usage: 'Mount when intent names interactive maps with markers.',
        example: { center: [0, 0], zoom: 2 },
      },
    ],
    ...overrides,
  };
}

describe('assertPublicEnvSatisfied', () => {
  describe('no-op paths', () => {
    it('no-ops when contract is undefined', () => {
      expect(() =>
        assertPublicEnvSatisfied(undefined, [mapboxLib()], {}),
      ).not.toThrow();
    });

    it('no-ops when appGadgets is undefined', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(contract, undefined, {}),
      ).not.toThrow();
    });

    it('no-ops when contract has no clientCapabilities.gadgets', () => {
      const contract: DataContract = {};
      expect(() =>
        assertPublicEnvSatisfied(contract, [mapboxLib()], {}),
      ).not.toThrow();
    });

    it('no-ops when declared wrappers have no requires', () => {
      const contract = contractWithGadgets(LEAFLET_GADGETS);
      // No publicEnv configured, but Leaflet doesn't require any.
      expect(() =>
        assertPublicEnvSatisfied(contract, [leafletLib()], undefined),
      ).not.toThrow();
    });
  });

  describe('satisfied paths', () => {
    it('passes when every declared wrapper requirement is met', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(contract, [mapboxLib()], {
          GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
        }),
      ).not.toThrow();
    });

    it('ignores App.publicEnv values that no declared wrapper needs', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(contract, [mapboxLib()], {
          GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
          GGUI_PUBLIC_APP_UNUSED_KEY: 'value',
        }),
      ).not.toThrow();
    });

    it('passes when an UNUSED registered wrapper has unsatisfied requires', () => {
      // Registry has Mapbox (needs token) AND Leaflet (no token needed).
      // Contract only declares Leaflet. Push must not fail just because
      // Mapbox's token isn't configured — Mapbox isn't being used here.
      const contract = contractWithGadgets(LEAFLET_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(
          contract,
          [mapboxLib(), leafletLib()],
          {}, // no Mapbox token configured
        ),
      ).not.toThrow();
    });

    it('allows empty-string values to satisfy a requirement', () => {
      // Empty string is a configured value — operator chose to declare
      // the key with no value (a downstream wrapper that tolerates empty
      // will mount; one that throws on empty is the wrapper's choice).
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(contract, [mapboxLib()], {
          GGUI_PUBLIC_APP_MAPBOX_TOKEN: '',
        }),
      ).not.toThrow();
    });
  });

  describe('rejection paths', () => {
    it('throws when a declared wrapper requires a missing key', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(contract, [mapboxLib()], {}),
      ).toThrow(GadgetPublicEnvMissingError);
    });

    it('throws when App.publicEnv is undefined and wrapper requires a key', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      expect(() =>
        assertPublicEnvSatisfied(contract, [mapboxLib()], undefined),
      ).toThrow(/MAPBOX_TOKEN/);
    });

    it('error carries every missing-key violation, not just the first', () => {
      const contract = contractWithGadgets({
        '@ggui-samples/gadget-mapbox': { useMapbox: {} },
        '@ggui-ai/gadgets': { useGeolocation: {} },
      });
      const libs: GadgetDescriptor[] = [
        mapboxLib({ requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'] }),
        {
          package: '@ggui-ai/gadgets',
          version: '0.1.0-rc.1',
          requires: ['GGUI_PUBLIC_APP_GEO_KEY'],
          exports: [
            {
              hook: 'useGeolocation',
              description: '…',
              usage: '…',
              example: {},
            },
          ],
        },
      ];
      try {
        assertPublicEnvSatisfied(contract, libs, {});
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(GadgetPublicEnvMissingError);
        const e = err as GadgetPublicEnvMissingError;
        expect(e.violations).toHaveLength(2);
        expect(e.violations.map((v) => v.missingKey).sort()).toEqual([
          'GGUI_PUBLIC_APP_GEO_KEY',
          'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
        ]);
      }
    });

    it('error includes the package and the hook', () => {
      // The error message lets an author locate the violating
      // declaration by `(package, export name)`.
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      try {
        assertPublicEnvSatisfied(contract, [mapboxLib()], {});
        throw new Error('expected throw');
      } catch (err) {
        const e = err as GadgetPublicEnvMissingError;
        expect(e.violations[0]?.package).toBe('@ggui-samples/gadget-mapbox');
        expect(e.violations[0]?.hook).toBe('useMapbox');
      }
    });

    it('suggests a close-by configured key (did-you-mean)', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      try {
        assertPublicEnvSatisfied(
          contract,
          [mapboxLib({ requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKE'] })], // typo: missing N
          { GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...' },
        );
        throw new Error('expected throw');
      } catch (err) {
        const e = err as GadgetPublicEnvMissingError;
        expect(e.violations[0]?.suggestion).toBe(
          'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
        );
      }
    });

    it('null suggestion when no configured key is close', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      try {
        assertPublicEnvSatisfied(contract, [mapboxLib()], {
          GGUI_PUBLIC_APP_TOTALLY_UNRELATED_KEY: 'value',
        });
        throw new Error('expected throw');
      } catch (err) {
        const e = err as GadgetPublicEnvMissingError;
        expect(e.violations[0]?.suggestion).toBeNull();
      }
    });

    it('error message mentions the missing key, hook, and package', () => {
      const contract = contractWithGadgets(MAPBOX_GADGETS);
      try {
        assertPublicEnvSatisfied(contract, [mapboxLib()], {});
        throw new Error('expected throw');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
        expect(message).toContain('useMapbox');
        expect(message).toContain('@ggui-samples/gadget-mapbox');
        expect(message).toContain('App.publicEnv');
      }
    });
  });
});

describe('findClosestPublicEnvKey', () => {
  it('returns the closest match within distance < 3', () => {
    expect(
      findClosestPublicEnvKey('GGUI_PUBLIC_APP_MAPBOX_TOKE', [
        'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
        'GGUI_PUBLIC_APP_OTHER_KEY',
      ]),
    ).toBe('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
  });

  it('returns null when no key is within distance < 3', () => {
    expect(
      findClosestPublicEnvKey('GGUI_PUBLIC_APP_MAPBOX_TOKEN', [
        'GGUI_PUBLIC_APP_TOTALLY_DIFFERENT',
      ]),
    ).toBeNull();
  });

  it('returns null on empty provided list', () => {
    expect(findClosestPublicEnvKey('GGUI_PUBLIC_APP_X', [])).toBeNull();
  });

  it('lowercase-normalizes (casing typo matches)', () => {
    // App.publicEnv schema rejects lowercase keys upstream, so this
    // path is defensive — protects against any caller that bypasses
    // the schema check.
    expect(
      findClosestPublicEnvKey('ggui_public_app_mapbox_token', [
        'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
      ]),
    ).toBe('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
  });
});
