import { describe, expect, it } from 'vitest';
import {
  STDLIB_GADGETS,
  gadgetExportName,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
const STDLIB_PKG = STDLIB_GADGETS[0].package;
import type { GadgetCatalogAdapter } from '@ggui-ai/gadgets';
import type { App, AppMetadataStore } from './app-metadata-store.js';
import {
  AppMetadataGadgetCatalog,
  GadgetCatalogIntegrityError,
} from './app-metadata-gadget-catalog.js';

/** Minimal `AppMetadataStore` stub — returns whatever catalog is keyed. */
function makeStore(
  byApp: Readonly<Record<string, readonly GadgetDescriptor[]>>,
): AppMetadataStore {
  return {
    async get(appId: string): Promise<App | null> {
      const gadgets = byApp[appId];
      if (!gadgets) return null;
      return { id: appId, gadgets };
    },
  };
}

// GG.8.1 — a `GadgetDescriptor` is a PACKAGE bundling `exports[]`.
// Teaching text moved per-export; transport (`typesUrl`, …) stays
// package-level.
const VALID_LEAFLET: GadgetDescriptor = {
  package: '@my-org/ggui-leaflet',
  version: '0.0.1',
  typesUrl: 'https://cdn.example.com/leaflet.d.ts',
  exports: [
    {
      hook: 'useLeafletMap',
      description: 'Leaflet map wrapper.',
      usage: 'Mount when intent names maps.',
      example: { call: 'useLeafletMap()' },
    },
  ],
};

describe('AppMetadataGadgetCatalog', () => {
  it('structurally satisfies GadgetCatalogAdapter', () => {
    // Compile-time conformance pin — `@ggui-ai/mcp-server-core` does not
    // declare `implements GadgetCatalogAdapter` (no runtime dep on the
    // wrapper SDK), so this assertion is the drift guard.
    const adapter: GadgetCatalogAdapter = new AppMetadataGadgetCatalog(
      makeStore({}),
    );
    expect(typeof adapter.list).toBe('function');
  });

  it('returns the registered catalog for a known app (stdlib floor + custom)', async () => {
    const catalog = new AppMetadataGadgetCatalog(
      makeStore({ app1: [VALID_LEAFLET] }),
    );
    const result = await catalog.list('app1');
    // resolveAppGadgets unions — stdlib package is always present as the floor.
    expect(result).toHaveLength(STDLIB_GADGETS.length + 1);
    expect(result.map((g) => g.package)).toEqual(
      expect.arrayContaining([STDLIB_PKG, VALID_LEAFLET.package]),
    );
    const leafletPkg = result.find((g) => g.package === VALID_LEAFLET.package);
    const exp = leafletPkg?.exports[0];
    expect(exp && gadgetExportName(exp)).toBe('useLeafletMap');
  });

  it('falls back to STDLIB_GADGETS when the store has no record', async () => {
    const catalog = new AppMetadataGadgetCatalog(makeStore({}));
    const result = await catalog.list('unknown-app');
    expect(result).toEqual(STDLIB_GADGETS);
  });

  it('accepts a stdlib catalog (stdlib is exempt from the typesUrl rule)', async () => {
    const catalog = new AppMetadataGadgetCatalog(
      makeStore({ app1: STDLIB_GADGETS }),
    );
    await expect(catalog.list('app1')).resolves.toEqual(STDLIB_GADGETS);
  });

  it('throws GadgetCatalogIntegrityError when a non-stdlib descriptor lacks typesUrl', async () => {
    const noTypes: GadgetDescriptor = {
      package: '@my-org/no-types',
      version: '1.0.0',
      exports: [
        {
          hook: 'useNoTypes',
          description: 'Missing its .d.ts URL.',
          usage: 'Should fail registration-strict validation.',
          example: { call: 'useNoTypes()' },
        },
      ],
    };
    const catalog = new AppMetadataGadgetCatalog(
      makeStore({ app1: [noTypes] }),
    );
    try {
      await catalog.list('app1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GadgetCatalogIntegrityError);
      const e = err as GadgetCatalogIntegrityError;
      expect(e.appId).toBe('app1');
      expect(e.violations.some((v) => v.code === 'schema')).toBe(true);
      expect(e.violations.some((v) => v.path.includes('typesUrl'))).toBe(true);
    }
  });

  it('throws GadgetCatalogIntegrityError on a fatal lint (duplicate hook)', async () => {
    const dupA: GadgetDescriptor = { ...VALID_LEAFLET };
    const dupB: GadgetDescriptor = {
      ...VALID_LEAFLET,
      package: '@other-org/leaflet-fork',
      version: '2.0.0',
      typesUrl: 'https://cdn.example.com/leaflet-fork.d.ts',
    };
    const catalog = new AppMetadataGadgetCatalog(
      makeStore({ app1: [dupA, dupB] }),
    );
    try {
      await catalog.list('app1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(GadgetCatalogIntegrityError);
      const e = err as GadgetCatalogIntegrityError;
      expect(
        e.violations.some(
          (v) => v.code === 'LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG',
        ),
      ).toBe(true);
    }
  });

  it('does not throw on a soft lint warning (unscoped package)', async () => {
    const unscoped: GadgetDescriptor = {
      package: 'unscoped-gadget',
      version: '1.0.0',
      typesUrl: 'https://cdn.example.com/unscoped.d.ts',
      exports: [
        {
          hook: 'useUnscoped',
          description: 'Unscoped npm name — soft lint only.',
          usage: 'Mount for the unscoped-package test.',
          example: { call: 'useUnscoped()' },
        },
      ],
    };
    const catalog = new AppMetadataGadgetCatalog(
      makeStore({ app1: [unscoped] }),
    );
    // resolveAppGadgets unions — stdlib floor + unscoped = 2 packages total.
    await expect(catalog.list('app1')).resolves.toHaveLength(STDLIB_GADGETS.length + 1);
  });
});
