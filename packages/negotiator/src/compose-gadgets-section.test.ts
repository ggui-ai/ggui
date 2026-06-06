import { describe, expect, it } from 'vitest';
import { composeAvailableGadgetsSection } from './synthesize-contract';

describe('composeAvailableGadgetsSection — synth-prompt teaching text plumb', () => {
  it('returns undefined when no gadgets are supplied', () => {
    expect(composeAvailableGadgetsSection(undefined)).toBeUndefined();
    expect(composeAvailableGadgetsSection([])).toBeUndefined();
  });

  it('renders each export on its own line with kind tag + name + package + description', () => {
    const section = composeAvailableGadgetsSection([
      {
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: [
          {
            hook: 'useGeolocation',
            description: "Resolve the device's current geolocation.",
            usage:
              'Mount when intent names current location, maps, nearby search.',
          },
        ],
      },
    ]);
    expect(section).toContain('hook `useGeolocation`');
    expect(section).toContain('(package `@ggui-ai/gadgets`)');
    expect(section).toContain("Resolve the device's current geolocation.");
    expect(section).toContain('Mount when intent names current location');
  });

  it('tags component exports with the `component` kind', () => {
    const section = composeAvailableGadgetsSection([
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            component: 'LeafletMap',
            description: 'Interactive Leaflet map component.',
            usage: 'Render when intent names a rendered map.',
          },
        ],
      },
    ]);
    expect(section).toContain('component `LeafletMap`');
    expect(section).toContain('(package `@ggui-samples/gadget-leaflet`)');
    // The render idiom — a component is RENDERED, never CALLED.
    expect(section).toContain('RENDERED as JSX');
  });

  it('skips exports whose description AND usage are both empty', () => {
    const section = composeAvailableGadgetsSection([
      {
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: [
          { hook: 'useEmpty' },
          { hook: 'useReal', description: 'Real gadget.', usage: 'Use here.' },
        ],
      },
    ]);
    expect(section).not.toContain('useEmpty');
    expect(section).toContain('useReal');
  });

  it('truncates usage when entry text exceeds per-export budget', () => {
    const longUsage = 'A'.repeat(500);
    const section = composeAvailableGadgetsSection([
      {
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: [
          { hook: 'useLong', description: 'Short description.', usage: longUsage },
        ],
      },
    ]);
    expect(section).toBeDefined();
    // Per-export text (~300) + section header + render-idiom footer.
    expect(section!.length).toBeLessThan(900);
    expect(section).toContain('…');
  });

  it('caps total section length at the 3KB budget', () => {
    const section = composeAvailableGadgetsSection([
      {
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: Array.from({ length: 200 }, (_, i) => ({
          hook: `useLib${i}`,
          description: 'X'.repeat(200),
          usage: 'Y'.repeat(80),
        })),
      },
    ]);
    expect(section).toBeDefined();
    // Lines portion stays at 3KB; the render-idiom footer adds a few
    // hundred chars but doesn't squeeze out any registered export.
    expect(section!.length).toBeLessThan(3700);
  });

  // Every non-empty AVAILABLE GADGETS section MUST
  // surface BOTH render idioms (hook = CALL, component = RENDER) so
  // synth-emitted contracts line up with what the code-gen boilerplate
  // direct-imports from each gadget package.
  it('appends the hook + component render-idiom hint to every non-empty section', () => {
    const section = composeAvailableGadgetsSection([
      {
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: [
          {
            hook: 'useGeolocation',
            description: 'Resolve the device location.',
            usage: 'Mount when intent names current location.',
          },
        ],
      },
    ]);
    expect(section).toBeDefined();
    expect(section).toContain('GadgetHook<TOutput, TOptions>');
    expect(section).toContain('status, value, error, start, stop');
    expect(section).toContain('direct-imports');
    expect(section).toContain('RENDERED as JSX');
    expect(section).toContain('contextSpec');
    expect(section).toContain('actionSpec');
  });
});
