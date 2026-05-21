import { describe, expect, it } from 'vitest';
import type {
  DataContract,
  GadgetDescriptor,
  GadgetPackageUse,
} from '../types/data-contract';
import {
  filterDescriptorsToContract,
  gadgetExportName,
  gadgetIdentityKey,
  listContractGadgets,
} from './resolve-contract-gadgets';

describe('gadgetExportName', () => {
  it('returns the `hook` field for a hook export', () => {
    expect(gadgetExportName({ hook: 'useLeafletMap' })).toBe('useLeafletMap');
  });

  it('returns the `component` field for a component export', () => {
    expect(gadgetExportName({ component: 'MapView' })).toBe('MapView');
  });

  it('reads the export name off a descriptor-side GadgetExport', () => {
    expect(gadgetExportName({ hook: 'useGeolocation' })).toBe('useGeolocation');
    expect(gadgetExportName({ component: 'Chart' })).toBe('Chart');
  });
});

describe('gadgetIdentityKey', () => {
  it('keys on the (name, package) tuple', () => {
    expect(
      gadgetIdentityKey({ name: 'useLeafletMap', package: '@my-org/leaflet' }),
    ).toBe('useLeafletMap\t@my-org/leaflet');
  });

  it('a hook export and a component export never collide on the key', () => {
    // The hook / component name grammars are disjoint (use-prefixed
    // camelCase vs PascalCase), so even within one package the two
    // export identities are always distinct.
    expect(
      gadgetIdentityKey({ name: 'useChart', package: '@my-org/charts' }),
    ).not.toBe(
      gadgetIdentityKey({ name: 'Chart', package: '@my-org/charts' }),
    );
  });

  it('two exports with the same name in different packages differ', () => {
    expect(
      gadgetIdentityKey({ name: 'useGeolocation', package: '@org-a/geo' }),
    ).not.toBe(
      gadgetIdentityKey({ name: 'useGeolocation', package: '@org-b/geo' }),
    );
  });

  it('version is NOT part of the key — identity is (name, package) only', () => {
    // `version` is not on the wire; an App registers at most one
    // descriptor per package, so (name, package) resolves uniquely.
    expect(
      gadgetIdentityKey({ name: 'useLeafletMap', package: '@my-org/leaflet' }),
    ).toBe(
      gadgetIdentityKey({ name: 'useLeafletMap', package: '@my-org/leaflet' }),
    );
  });
});

/**
 * Minimal `DataContract` carrying only `clientCapabilities.gadgets` —
 * the only field `filterDescriptorsToContract` / `listContractGadgets`
 * read. The wire shape is package-keyed with no `exports` wrapper:
 * `Record<package, Record<exportName, GadgetExportUse>>`.
 */
function contractWith(
  gadgets: Record<string, GadgetPackageUse>,
): DataContract {
  const contract: DataContract = {
    clientCapabilities: { gadgets },
  };
  return contract;
}

/** A `DataContract` with no `clientCapabilities` at all. */
const emptyContract: DataContract = {};

describe('listContractGadgets', () => {
  it('returns an empty array when the contract declares no gadgets', () => {
    expect(listContractGadgets(emptyContract)).toEqual([]);
  });

  it('returns an empty array for an empty gadgets map', () => {
    expect(listContractGadgets(contractWith({}))).toEqual([]);
  });

  it('flattens a single-package single-export contract', () => {
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {} },
    });
    expect(listContractGadgets(contract)).toEqual([
      { package: '@my-org/leaflet', name: 'useLeafletMap' },
    ]);
  });

  it('flattens every export across every package', () => {
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {}, MapView: {} },
      '@my-org/charts': { useChart: {} },
    });
    const flat = listContractGadgets(contract);
    expect(flat).toHaveLength(3);
    expect(
      flat.map((g) => `${g.package}/${g.name}`).sort(),
    ).toEqual([
      '@my-org/charts/useChart',
      '@my-org/leaflet/MapView',
      '@my-org/leaflet/useLeafletMap',
    ]);
  });

  it('carries through intent-override description + usage', () => {
    const contract = contractWith({
      '@my-org/leaflet': {
        useLeafletMap: {
          description: 'Display venue locations on a map.',
          usage: 'Mount for the venue picker screen.',
        },
      },
    });
    expect(listContractGadgets(contract)).toEqual([
      {
        package: '@my-org/leaflet',
        name: 'useLeafletMap',
        description: 'Display venue locations on a map.',
        usage: 'Mount for the venue picker screen.',
      },
    ]);
  });

  it('omits description / usage keys when the contract sets neither', () => {
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {} },
    });
    const [gadget] = listContractGadgets(contract);
    expect(gadget).toBeDefined();
    expect('description' in gadget!).toBe(false);
    expect('usage' in gadget!).toBe(false);
  });
});

const leafletDescriptor: GadgetDescriptor = {
  package: '@my-org/leaflet',
  version: '1.0.0',
  exports: [{ hook: 'useLeafletMap' }, { component: 'MapView' }],
};

const chartsDescriptor: GadgetDescriptor = {
  package: '@my-org/charts',
  version: '2.0.0',
  exports: [{ hook: 'useChart' }],
};

describe('filterDescriptorsToContract', () => {
  it('returns an empty array when the contract declares no gadgets', () => {
    expect(
      filterDescriptorsToContract(emptyContract, [leafletDescriptor]),
    ).toEqual([]);
  });

  it('returns an empty array when appGadgets is empty', () => {
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {} },
    });
    expect(filterDescriptorsToContract(contract, [])).toEqual([]);
  });

  it('resolves a descriptor by its package key', () => {
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {} },
    });
    expect(
      filterDescriptorsToContract(contract, [leafletDescriptor]),
    ).toEqual([leafletDescriptor]);
  });

  it('dedup is automatic — one package key resolves to one descriptor', () => {
    // A hook export and a component export of the same package live
    // under one package key — the resolved descriptor appears once.
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {}, MapView: {} },
    });
    expect(
      filterDescriptorsToContract(contract, [leafletDescriptor]),
    ).toEqual([leafletDescriptor]);
  });

  it('orders descriptors by first-appearance of their package key', () => {
    const contract = contractWith({
      // `@my-org/charts` key appears first → chartsDescriptor leads.
      '@my-org/charts': { useChart: {} },
      '@my-org/leaflet': { useLeafletMap: {} },
    });
    const resolved = filterDescriptorsToContract(contract, [
      leafletDescriptor,
      chartsDescriptor,
    ]);
    expect(resolved).toEqual([chartsDescriptor, leafletDescriptor]);
  });

  it('drops a package key absent from appGadgets', () => {
    const contract = contractWith({
      '@my-org/leaflet': { useLeafletMap: {} },
      '@nobody/ghost': { useGhost: {} },
    });
    expect(
      filterDescriptorsToContract(contract, [leafletDescriptor]),
    ).toEqual([leafletDescriptor]);
  });
});
