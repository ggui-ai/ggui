// GG.8.2 — `loadGadgetRegistry()` composes the per-PACKAGE runtime
// `gadgets` slot for `globalThis.__ggui__`. Tests pin:
//
//   - STDLIB seed is always present under `'@ggui-ai/gadgets'`
//   - registered packages are dynamically imported + stored whole
//     under their package-name key
//   - STDLIB wins on a package-name collision (operator can't shadow
//     the first-party `@ggui-ai/gadgets` package)
//   - failure to dynamic-import a package is logged + skipped (other
//     entries still install)
//   - entries with an empty load target are logged + skipped
//   - `bundleUrl` wins over `package` as the load source
//   - `bundleSri` + `bundleUrl` routes through the integrity loader

import { describe, it, expect, vi } from 'vitest';
import {
  loadGadgetRegistry,
  type DynamicImporter,
  type IntegrityLoader,
  type GadgetRegistration,
} from '../gadget-loader.js';
import type { ModuleNamespace } from '../globals.js';

function makeImporter(
  modules: Record<string, ModuleNamespace | Error>,
): DynamicImporter {
  return async (target: string) => {
    const out = modules[target];
    if (out === undefined) {
      throw new Error(`Unknown module: ${target}`);
    }
    if (out instanceof Error) throw out;
    return out;
  };
}

function makeLogger(): { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

describe('loadGadgetRegistry', () => {
  const stdlib: ModuleNamespace = {
    useGeolocation: () => 'geo',
    useCamera: () => 'cam',
  };

  it('returns the STDLIB seed under its package key when no registrations are present', async () => {
    const out = await loadGadgetRegistry(stdlib, []);
    // The whole STDLIB namespace lands under '@ggui-ai/gadgets'.
    expect(out['@ggui-ai/gadgets']).toBe(stdlib);
  });

  it('stores a registered package namespace under its package key', async () => {
    const leafletNamespace: ModuleNamespace = {
      useLeafletMap: () => 'leaflet',
      LeafletMap: () => null,
    };
    const importer = makeImporter({
      '@ggui-samples/gadget-leaflet': leafletNamespace,
    });
    const registrations: GadgetRegistration[] = [
      { package: '@ggui-samples/gadget-leaflet' },
    ];
    const out = await loadGadgetRegistry(stdlib, registrations, {
      importer,
    });
    // The whole imported namespace is stored under the package key —
    // both hook AND component exports are reachable through it.
    expect(out['@ggui-samples/gadget-leaflet']).toBe(leafletNamespace);
    // STDLIB still present under its own key.
    expect(out['@ggui-ai/gadgets']).toBe(stdlib);
  });

  it('prefers bundleUrl over package as the load source', async () => {
    const fromBundle: ModuleNamespace = { useLeafletMap: () => 'bundle' };
    const fromPkg: ModuleNamespace = { useLeafletMap: () => 'pkg' };
    const importer = makeImporter({
      'https://cdn.example/leaflet.js': fromBundle,
      '@ggui-samples/gadget-leaflet': fromPkg,
    });
    const out = await loadGadgetRegistry(
      stdlib,
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          bundleUrl: 'https://cdn.example/leaflet.js',
        },
      ],
      { importer },
    );
    // Loaded from the bundleUrl, still keyed by package name.
    expect(out['@ggui-samples/gadget-leaflet']).toBe(fromBundle);
  });

  it('STDLIB wins on package-name collision (operator cannot shadow first-party)', async () => {
    const evilNamespace: ModuleNamespace = {
      useGeolocation: () => 'evil',
    };
    const importer = makeImporter({
      '@ggui-ai/gadgets': evilNamespace,
    });
    const out = await loadGadgetRegistry(
      stdlib,
      [{ package: '@ggui-ai/gadgets' }],
      { importer },
    );
    // The STDLIB seed is NOT replaced by an operator registration for
    // the same package name.
    expect(out['@ggui-ai/gadgets']).toBe(stdlib);
  });

  it('logs and skips an entry whose dynamic import throws', async () => {
    const okNamespace: ModuleNamespace = { useOther: () => 'other' };
    const importer = makeImporter({
      '@broken/wrapper': new Error('network error'),
      '@ok/wrapper': okNamespace,
    });
    const logger = makeLogger();
    const out = await loadGadgetRegistry(
      stdlib,
      [
        { package: '@broken/wrapper' },
        { package: '@ok/wrapper' },
      ],
      { importer, logger },
    );
    expect(out['@broken/wrapper']).toBeUndefined();
    // The OK package still installs.
    expect(out['@ok/wrapper']).toBe(okNamespace);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load package '@broken/wrapper'"),
      expect.any(Error),
    );
  });

  it('logs and skips an entry with an empty package string', async () => {
    const importer = makeImporter({});
    const logger = makeLogger();
    const out = await loadGadgetRegistry(
      stdlib,
      // Cast through unknown to bypass the type-level invariant
      // (`package` is required) — the parser enforces it; the loader
      // still needs runtime resilience against a corrupted entry.
      [
        {
          package: '',
        } as unknown as GadgetRegistration,
      ],
      { importer, logger },
    );
    expect(out['']).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('empty load target'),
    );
  });

  // GG.8.2 — when an entry carries `bundleSri`, the loader routes
  // through the integrity-aware path instead of dynamic `import()`.
  // The injected loader is what tests assert on; the production path
  // emits a `<link rel="modulepreload" integrity>` + post-preload
  // `import()`.
  it('routes through the integrity loader when bundleSri + bundleUrl are present', async () => {
    const mapboxNamespace: ModuleNamespace = { useMapbox: () => 'mapbox' };
    const integrityLoader: IntegrityLoader = vi
      .fn()
      .mockResolvedValue(mapboxNamespace);
    const importer: DynamicImporter = vi
      .fn()
      .mockRejectedValue(new Error('importer should NOT fire when SRI present'));
    const out = await loadGadgetRegistry(
      stdlib,
      [
        {
          package: '@ggui-samples/gadget-mapbox',
          bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
          bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
        },
      ],
      { importer, integrityLoader },
    );
    expect(out['@ggui-samples/gadget-mapbox']).toBe(mapboxNamespace);
    expect(integrityLoader).toHaveBeenCalledWith({
      url: 'https://registry.ggui.ai/bundles/mapbox.js',
      integrity: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
      name: '@ggui-samples/gadget-mapbox',
    });
    expect(importer).not.toHaveBeenCalled();
  });

  it('falls back to dynamic import when bundleSri is absent (back-compat)', async () => {
    const fallbackNamespace: ModuleNamespace = { useFallback: () => 'fallback' };
    const importer = makeImporter({
      'https://registry.ggui.ai/bundles/no-sri.js': fallbackNamespace,
    });
    const integrityLoader: IntegrityLoader = vi
      .fn()
      .mockRejectedValue(new Error('integrity loader should NOT fire here'));
    const out = await loadGadgetRegistry(
      stdlib,
      [
        {
          package: '@ggui-samples/gadget-fallback',
          bundleUrl: 'https://registry.ggui.ai/bundles/no-sri.js',
        },
      ],
      { importer, integrityLoader },
    );
    expect(out['@ggui-samples/gadget-fallback']).toBe(fallbackNamespace);
    expect(integrityLoader).not.toHaveBeenCalled();
  });

  it('falls back to dynamic import when bundleSri is present but bundleUrl is absent', async () => {
    // SRI is only meaningful on the modulepreload path; a stray SRI
    // on a package-only entry must not route through the integrity
    // loader (the integrity loader's contract requires a URL).
    const edgeNamespace: ModuleNamespace = { useEdge: () => 'edge' };
    const importer = makeImporter({
      '@only/pkg': edgeNamespace,
    });
    const integrityLoader: IntegrityLoader = vi
      .fn()
      .mockRejectedValue(new Error('integrity loader should NOT fire here'));
    const out = await loadGadgetRegistry(
      stdlib,
      [
        {
          package: '@only/pkg',
          bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
        },
      ],
      { importer, integrityLoader },
    );
    expect(out['@only/pkg']).toBe(edgeNamespace);
    expect(integrityLoader).not.toHaveBeenCalled();
  });

  it('logs and skips when the integrity loader rejects (SRI mismatch path)', async () => {
    const integrityLoader: IntegrityLoader = vi
      .fn()
      .mockRejectedValue(new Error('integrity check failed'));
    const logger = makeLogger();
    const out = await loadGadgetRegistry(
      stdlib,
      [
        {
          package: '@tampered/wrapper',
          bundleUrl: 'https://evil.example/tampered.js',
          bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
        },
      ],
      { integrityLoader, logger },
    );
    expect(out['@tampered/wrapper']).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to load package '@tampered/wrapper'"),
      expect.any(Error),
    );
  });

  it('continues loading remaining entries after a failure', async () => {
    const a: ModuleNamespace = { useA: () => 'a' };
    const c: ModuleNamespace = { useC: () => 'c' };
    const importer = makeImporter({
      '@a/pkg': a,
      '@b/pkg': new Error('boom'),
      '@c/pkg': c,
    });
    const out = await loadGadgetRegistry(
      stdlib,
      [
        { package: '@a/pkg' },
        { package: '@b/pkg' },
        { package: '@c/pkg' },
      ],
      { importer, logger: makeLogger() },
    );
    expect(out['@a/pkg']).toBe(a);
    expect(out['@b/pkg']).toBeUndefined();
    expect(out['@c/pkg']).toBe(c);
  });
});
