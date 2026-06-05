import { describe, expect, it } from 'vitest';
import { strictGadgetDescriptorSchema } from '@ggui-ai/protocol';
import { parseGadgetManifest, type GadgetManifest } from './gadget-manifest.js';
import { manifestToRegistryEntry } from './manifest-to-registry-entry.js';

const FULL_MANIFEST: GadgetManifest = parseGadgetManifest({
  kind: 'gadget',
  scope: '@ggui-samples',
  name: 'gadget-leaflet',
  version: '0.1.0',
  bundle: 'src/index.ts',
  visibility: 'public',
  description: 'Leaflet wrapper for interactive maps',
  exports: [
    {
      hook: 'useLeafletMap',
      description: 'Leaflet wrapper for interactive maps',
      usage: 'Mount a Leaflet map with the registered hook',
      example: { hook: 'useLeafletMap' },
      gotchas: 'Container needs explicit height for the map to render',
    },
  ],
  connect: ['https://tile.openstreetmap.org'],
  requires: ['GGUI_PUBLIC_APP_TILE_TOKEN'],
});

describe('manifestToRegistryEntry', () => {
  it('round-trips through strictGadgetDescriptorSchema with full computed fields', () => {
    const entry = manifestToRegistryEntry(FULL_MANIFEST, {
      version: '0.1.0',
      bundleUrl: 'https://registry.ggui.ai/bundles/@ggui-samples/gadget-leaflet/0.1.0/bundle.js',
      bundleSri:
        'sha384-9XXn1KbBQz3xWvb8K1V/Q1Q1QY9Q1Q1QYZX3aL5gFkqkVk5VZX3aLgFkqkVk5VZX',
    });
    const parsed = strictGadgetDescriptorSchema.safeParse(entry);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.exports).toHaveLength(1);
      const manifestExport = FULL_MANIFEST.exports[0];
      expect(parsed.data.exports[0]).toMatchObject({
        hook: 'useLeafletMap',
        description: manifestExport?.description,
        usage: manifestExport?.usage,
        example: manifestExport?.example,
        gotchas: manifestExport?.gotchas,
      });
      expect(parsed.data.version).toBe('0.1.0');
      expect(parsed.data.connect).toEqual(FULL_MANIFEST.connect);
      expect(parsed.data.requires).toEqual(FULL_MANIFEST.requires);
    }
  });

  it('round-trips with bundleHost instead of bundleUrl', () => {
    const entry = manifestToRegistryEntry(FULL_MANIFEST, {
      version: '0.1.0',
      bundleHost: 'sandbox.registry.ggui.ai',
    });
    const parsed = strictGadgetDescriptorSchema.safeParse({
      ...entry,
      // bundleHost path needs package + version trio to satisfy the
      // refinement.
      package: '@ggui-samples/gadget-leaflet',
    });
    expect(parsed.success).toBe(true);
  });

  it('omits optional fields when computedFields lacks them', () => {
    const entry = manifestToRegistryEntry(FULL_MANIFEST, { version: '0.1.0' });
    expect(entry.bundleUrl).toBeUndefined();
    expect(entry.bundleSri).toBeUndefined();
    expect(entry.bundleHost).toBeUndefined();
  });

  it('omits manifest-side optional fields when absent from the manifest', () => {
    const minimal = parseGadgetManifest({
      kind: 'gadget',
      scope: '@ggui-samples',
      name: 'gadget-minimal',
      version: '0.0.1',
      bundle: 'src/index.ts',
      visibility: 'public',
      description: 'Minimal',
      exports: [
        {
          hook: 'useMinimal',
          description: 'Minimal',
          usage: 'Minimal usage',
          example: { hook: 'useMinimal' },
        },
      ],
    });
    const entry = manifestToRegistryEntry(minimal, { version: '0.0.1' });
    expect(entry.exports[0]?.gotchas).toBeUndefined();
    expect(entry.connect).toBeUndefined();
    expect(entry.requires).toBeUndefined();
  });

  it('projects multiple exports onto the descriptor', () => {
    const multi = parseGadgetManifest({
      kind: 'gadget',
      scope: '@ggui-samples',
      name: 'gadget-charts',
      version: '0.2.0',
      bundle: 'src/index.ts',
      visibility: 'public',
      description: 'Charting gadget with a hook and a component',
      exports: [
        {
          hook: 'useChartData',
          description: 'Resolve chart series data.',
          usage: 'Mount to fetch + memoize chart series.',
          example: { call: 'useChartData()' },
        },
        {
          component: 'Chart',
          description: 'GguiSession a chart from series data.',
          usage: 'GguiSession with series data from useChartData.',
          example: { render: '<Chart data={…} />' },
        },
      ],
    });
    const entry = manifestToRegistryEntry(multi, { version: '0.2.0' });
    expect(entry.exports).toHaveLength(2);
    expect(entry.exports[0]).toMatchObject({ hook: 'useChartData' });
    expect(entry.exports[1]).toMatchObject({
      component: 'Chart',
    });
    const parsed = strictGadgetDescriptorSchema.safeParse(entry);
    expect(parsed.success).toBe(true);
  });
});
