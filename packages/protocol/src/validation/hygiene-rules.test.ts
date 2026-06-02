import { describe, it, expect } from 'vitest';
import type {
  DataContract,
  GadgetDescriptor,
  GadgetHookExport,
} from '../types/data-contract';
import {
  FATAL_CATALOG_LINT_CODES,
  LINT_GADGET_DUPLICATE_EXPORT,
  LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG,
  LINT_GADGET_DUPLICATE_PACKAGE,
  LINT_GADGET_IMMUTABLE_MUTATION,
  LINT_GADGET_MISSING_PERMISSION,
  LINT_GADGET_UNKNOWN_HOOK,
  LINT_GADGET_UNKNOWN_PERMISSION,
  LINT_GADGET_UNSCOPED_PACKAGE,
  LINT_MISSING_EXAMPLE,
  LINT_MISSING_USAGE,
  LINT_ORPHAN_AGENT_TOOL,
  checkDuplicateGadgetHooks,
  checkGadgetHookNames,
  checkHygiene,
  checkMissingExample,
  checkMissingUsage,
  checkOrphanAgentTools,
  lintGadgetCatalog,
} from './hygiene-rules';

const objectSchema = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};

function fullTool(extra: Record<string, unknown> = {}) {
  return {
    toolInfo: { inputSchema: objectSchema },
    usage: 'when to use this',
    example: { input: {}, output: 'ok' },
    ...extra,
  };
}

describe('checkOrphanAgentTools', () => {
  it('returns no warnings when there is no agentCapabilities catalog', () => {
    expect(checkOrphanAgentTools({})).toEqual([]);
  });

  it('returns no warnings when every tool is referenced from actionSpec', () => {
    const contract: DataContract = {
      actionSpec: { archive: { label: 'A', nextStep: 'archive_email' } },
      agentCapabilities: { tools: { archive_email: fullTool() } },
    };
    expect(checkOrphanAgentTools(contract)).toEqual([]);
  });

  it('returns no warnings when every tool is referenced from streamSpec', () => {
    const contract: DataContract = {
      streamSpec: {
        feed: { schema: objectSchema, source: { tool: 'fetch_feed' } },
      },
      agentCapabilities: { tools: { fetch_feed: fullTool() } },
    };
    expect(checkOrphanAgentTools(contract)).toEqual([]);
  });

  it('flags an orphan tool that no spec references', () => {
    const contract: DataContract = {
      actionSpec: { archive: { label: 'A', nextStep: 'archive_email' } },
      agentCapabilities: {
        tools: {
          archive_email: fullTool(),
          orphan: fullTool(),
        },
      },
    };
    const warnings = checkOrphanAgentTools(contract);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(LINT_ORPHAN_AGENT_TOOL);
    expect(warnings[0].path).toBe('agentCapabilities.tools.orphan');
    expect(warnings[0].fixHint).toBeDefined();
  });

  it('flags every orphan, leaving referenced tools alone', () => {
    const contract: DataContract = {
      actionSpec: { archive: { label: 'A', nextStep: 'used' } },
      agentCapabilities: {
        tools: {
          used: fullTool(),
          orphan_a: fullTool(),
          orphan_b: fullTool(),
        },
      },
    };
    const warnings = checkOrphanAgentTools(contract);
    expect(warnings.map((w) => w.path).sort()).toEqual([
      'agentCapabilities.tools.orphan_a',
      'agentCapabilities.tools.orphan_b',
    ]);
  });
});

describe('checkMissingUsage', () => {
  it('returns no warnings when there are no catalogs', () => {
    expect(checkMissingUsage({})).toEqual([]);
  });

  it('returns no warnings when every agentCapabilities tool has usage', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: {
          tool: { ...fullTool() },
        },
      },
    };
    expect(checkMissingUsage(contract)).toEqual([]);
  });

  it('flags agentCapabilities.tools entries without usage', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: {
          bare_tool: { toolInfo: { inputSchema: objectSchema } },
        },
      },
    };
    const warnings = checkMissingUsage(contract);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(LINT_MISSING_USAGE);
    expect(warnings[0].path).toBe('agentCapabilities.tools.bare_tool.usage');
  });

  it('does NOT flag clientCapabilities.gadgets export-uses without usage', () => {
    // `GadgetExportUse.usage` is an OPTIONAL intent-override; the
    // SPEC-documented canonical wire form is the bare identity
    // reference `gadgets[<pkg>][<export>] = {}`. Push-time resolution
    // inherits the registered descriptor's `usage`, so a missing
    // wire-side `usage` is the happy path — not a hygiene issue.
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useMicrophone: {} },
        },
      },
    };
    expect(checkMissingUsage(contract)).toEqual([]);
  });

  it('flags empty-string usage the same as missing usage', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: { tool: { toolInfo: { inputSchema: objectSchema }, usage: '' } },
      },
    };
    const warnings = checkMissingUsage(contract);
    expect(warnings).toHaveLength(1);
  });
});

describe('checkMissingExample', () => {
  it('returns no warnings when there is no agentCapabilities catalog', () => {
    expect(checkMissingExample({})).toEqual([]);
  });

  it('returns no warnings when every tool has an example', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: {
          tool: { ...fullTool() },
        },
      },
    };
    expect(checkMissingExample(contract)).toEqual([]);
  });

  it('flags tools without an example', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: {
          tool: {
            toolInfo: { inputSchema: objectSchema },
            usage: 'when to use this',
          },
        },
      },
    };
    const warnings = checkMissingExample(contract);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(LINT_MISSING_EXAMPLE);
    expect(warnings[0].path).toBe('agentCapabilities.tools.tool.example');
  });
});

// Slice GG.6.E — wire-side gadget hook-name lint. Renamed from
// `checkClientLibraries`; permission checks moved to the
// registry-side `lintGadgetCatalog`.
describe('checkGadgetHookNames', () => {
  it('returns no warnings without a clientCapabilities catalog', () => {
    expect(checkGadgetHookNames({})).toEqual([]);
  });

  it('flags unknown hook names from @ggui-ai/gadgets default package', () => {
    const warnings = checkGadgetHookNames({
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useMystery: { usage: 'x' } },
        },
      },
    });
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain(LINT_GADGET_UNKNOWN_HOOK);
  });

  it('skips hook-registry check when package is third-party', () => {
    const warnings = checkGadgetHookNames({
      clientCapabilities: {
        gadgets: {
          '@acme/wallet-hooks': { useAcmeWallet: { usage: 'wallet' } },
        },
      },
    });
    expect(warnings.map((w) => w.code)).not.toContain(LINT_GADGET_UNKNOWN_HOOK);
  });
});

// Slice GG.8.8 — the wire is package-keyed, so the same export name
// cannot repeat WITHIN a package (object-key uniqueness). The hazard
// `checkDuplicateGadgetHooks` catches is cross-package: two packages
// each exporting the same name. Keys on the export name alone,
// matching the hard gate `assertNoDuplicateGadgetHooks`.
describe('checkDuplicateGadgetHooks', () => {
  it('returns no warnings when there is no clientCapabilities catalog', () => {
    expect(checkDuplicateGadgetHooks({})).toEqual([]);
  });

  it('returns no warnings when every gadget export has a distinct name', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': {
            useMicrophone: { usage: 'audio' },
            useCamera: { usage: 'video' },
          },
        },
      },
    };
    expect(checkDuplicateGadgetHooks(contract)).toEqual([]);
  });

  it('flags two packages exporting the same export name', () => {
    // The boilerplate emits one import per export NAME, so two
    // packages each exporting `useGeolocation` collide in module
    // scope regardless of package.
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': {
            useGeolocation: { usage: 'first-party' },
          },
          '@acme/precise-location': {
            useGeolocation: { usage: 'third-party precise variant' },
          },
        },
      },
    };
    const warnings = checkDuplicateGadgetHooks(contract);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe(LINT_GADGET_DUPLICATE_EXPORT);
    expect(warnings[0].path).toBe(
      'clientCapabilities.gadgets.@acme/precise-location.exports.useGeolocation',
    );
    expect(warnings[0].message).toContain('useGeolocation');
  });
});

describe('checkHygiene (aggregate)', () => {
  it('returns no warnings for a polished contract', () => {
    const contract: DataContract = {
      actionSpec: { archive: { label: 'A', nextStep: 'archive_email' } },
      agentCapabilities: { tools: { archive_email: fullTool() } },
    };
    expect(checkHygiene(contract)).toEqual([]);
  });

  it('aggregates orphan + missing-usage + missing-example warnings in stable order', () => {
    const contract: DataContract = {
      agentCapabilities: { tools: { bare: { toolInfo: { inputSchema: objectSchema } } } },
    };
    const warnings = checkHygiene(contract);
    expect(warnings.map((w) => w.code)).toEqual([
      LINT_ORPHAN_AGENT_TOOL,
      LINT_MISSING_USAGE,
      LINT_MISSING_EXAMPLE,
    ]);
  });

  it('includes duplicate-hook warnings from checkHygiene', () => {
    const contract: DataContract = {
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': {
            useGeolocation: { usage: 'first' },
          },
          '@acme/precise-location': {
            useGeolocation: { usage: 'second' },
          },
        },
      },
    };
    const warnings = checkHygiene(contract);
    expect(warnings.map((w) => w.code)).toContain(LINT_GADGET_DUPLICATE_EXPORT);
  });
});

// ───────────────────────────────────────────────────────────────────
// Slice GG.6.E — registry-side `lintGadgetCatalog`
// ───────────────────────────────────────────────────────────────────

/**
 * Minimal valid registry descriptor — a one-hook-export package with
 * every required field present.
 *
 * Slice GG.8.1 — `GadgetDescriptor` is a PACKAGE carrying an `exports`
 * array. `exportOver` overrides the single hook export's fields
 * (`hook` / `permission` / teaching text); `packageOver` overrides
 * package-level fields (`package` / `version` / `bundleSri` / …).
 */
function descriptor(
  exportOver: Partial<GadgetHookExport> = {},
  packageOver: Partial<Omit<GadgetDescriptor, 'exports'>> = {},
): GadgetDescriptor {
  return {
    package: '@my-org/leaflet',
    version: '0.0.1',
    ...packageOver,
    exports: [
      {
        hook: 'useLeafletMap',
        description: 'Leaflet map wrapper.',
        usage: 'Mount when intent names maps.',
        example: { call: 'useLeafletMap()' },
        ...exportOver,
      },
    ],
  };
}

describe('lintGadgetCatalog', () => {
  it('returns no warnings for a clean single-descriptor catalog', () => {
    expect(lintGadgetCatalog([descriptor()])).toEqual([]);
  });

  it('returns no warnings for an empty catalog', () => {
    expect(lintGadgetCatalog([])).toEqual([]);
  });

  it('flags a duplicate hook in the catalog (fatal)', () => {
    const warnings = lintGadgetCatalog([
      descriptor({ hook: 'useMap' }, { package: '@a/one' }),
      descriptor({ hook: 'useMapAlias' }, { package: '@b/two' }),
      descriptor({ hook: 'useMap' }, { package: '@c/three' }),
    ]);
    const dup = warnings.find(
      (w) => w.code === LINT_GADGET_DUPLICATE_EXPORT_IN_CATALOG,
    );
    expect(dup).toBeDefined();
    expect(FATAL_CATALOG_LINT_CODES.has(dup!.code)).toBe(true);
  });

  it('flags two descriptors registered under the same package (fatal)', () => {
    // Slice GG.8.8 — `(name, package)` ref resolution needs at most
    // ONE descriptor per package; `version` is no longer on the wire
    // to disambiguate. Two descriptors sharing a `package` name make
    // resolution silently pick one.
    const warnings = lintGadgetCatalog([
      descriptor({ hook: 'useMapA' }, { package: '@my-org/maps' }),
      descriptor({ hook: 'useMapB' }, { package: '@my-org/maps' }),
    ]);
    const dup = warnings.find(
      (w) => w.code === LINT_GADGET_DUPLICATE_PACKAGE,
    );
    expect(dup).toBeDefined();
    expect(FATAL_CATALOG_LINT_CODES.has(dup!.code)).toBe(true);
  });

  it('does NOT flag distinct package names', () => {
    const warnings = lintGadgetCatalog([
      descriptor({ hook: 'useMapA' }, { package: '@my-org/maps' }),
      descriptor({ hook: 'useMapB' }, { package: '@my-org/charts' }),
    ]);
    expect(
      warnings.map((w) => w.code),
    ).not.toContain(LINT_GADGET_DUPLICATE_PACKAGE);
  });

  it('flags an immutable-bundle mutation — same (package, version), different bundleSri (fatal)', () => {
    const warnings = lintGadgetCatalog([
      descriptor(
        { hook: 'useMapA' },
        {
          package: '@my-org/maps',
          version: '1.0.0',
          bundleSri: 'sha384-aaaaaaaaaaaaaaaaaaaaaaaa',
        },
      ),
      descriptor(
        { hook: 'useMapB' },
        {
          package: '@my-org/maps',
          version: '1.0.0',
          bundleSri: 'sha384-bbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ),
    ]);
    const mut = warnings.find(
      (w) => w.code === LINT_GADGET_IMMUTABLE_MUTATION,
    );
    expect(mut).toBeDefined();
    expect(FATAL_CATALOG_LINT_CODES.has(mut!.code)).toBe(true);
  });

  it('does NOT flag matching bundleSri for the same (package, version)', () => {
    const warnings = lintGadgetCatalog([
      descriptor(
        { hook: 'useMapA' },
        {
          package: '@my-org/maps',
          version: '1.0.0',
          bundleSri: 'sha384-samehashsamehashsamehash',
        },
      ),
      descriptor(
        { hook: 'useMapB' },
        {
          package: '@my-org/maps',
          version: '1.0.0',
          bundleSri: 'sha384-samehashsamehashsamehash',
        },
      ),
    ]);
    expect(
      warnings.map((w) => w.code),
    ).not.toContain(LINT_GADGET_IMMUTABLE_MUTATION);
  });

  it('flags a known-permission hook registered without a permission', () => {
    const warnings = lintGadgetCatalog([
      descriptor({ hook: 'useGeolocation' }, { package: '@ggui-ai/gadgets' }),
    ]);
    expect(
      warnings.map((w) => w.code),
    ).toContain(LINT_GADGET_MISSING_PERMISSION);
  });

  it('does NOT flag a known-permission hook that declares its permission', () => {
    const warnings = lintGadgetCatalog([
      descriptor(
        { hook: 'useGeolocation', permission: 'geolocation' },
        { package: '@ggui-ai/gadgets' },
      ),
    ]);
    expect(
      warnings.map((w) => w.code),
    ).not.toContain(LINT_GADGET_MISSING_PERMISSION);
  });

  it('flags a non-standard permission value', () => {
    const warnings = lintGadgetCatalog([
      descriptor({ permission: 'geolocaiton' }),
    ]);
    expect(
      warnings.map((w) => w.code),
    ).toContain(LINT_GADGET_UNKNOWN_PERMISSION);
  });

  it('flags an unscoped package name (soft recommend)', () => {
    const warnings = lintGadgetCatalog([
      descriptor({}, { package: 'leaflet' }),
    ]);
    const unscoped = warnings.find(
      (w) => w.code === LINT_GADGET_UNSCOPED_PACKAGE,
    );
    expect(unscoped).toBeDefined();
    expect(FATAL_CATALOG_LINT_CODES.has(unscoped!.code)).toBe(false);
  });

  it('does NOT flag a scoped package name', () => {
    const warnings = lintGadgetCatalog([descriptor({}, { package: '@org/x' })]);
    expect(
      warnings.map((w) => w.code),
    ).not.toContain(LINT_GADGET_UNSCOPED_PACKAGE);
  });
});
