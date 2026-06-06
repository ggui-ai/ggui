/**
 * Plugin slice 1.2.1 — pin that the code-gen system prompt's
 * `clientCapabilities — registered catalog` section dynamically
 * renders the catalog passed via `appGadgets`. Pre-1.2.1 the
 * 7-hook STDLIB table was hardcoded; operator-registered 3rd-party
 * plugins (Leaflet, Mapbox, Stripe, …) never reached the code-gen
 * LLM and the boilerplate emitted `import { useLeafletMap }` against
 * an LLM that didn't know about it.
 *
 * The synth + decision LLM paths already plumb teaching text via
 * `composeAvailableGadgetsSection`. This file pins
 * the third triad surface — code-gen — agrees with the same source
 * of truth (catalog → table render), so all three LLM surfaces
 * instruct the model uniformly about which libraries are available.
 */
import { describe, expect, it } from 'vitest';
import type { GadgetDescriptor } from '@ggui-ai/protocol';
import {
  buildSystemPrompt,
  formatGadgetsSection,
} from './system-prompt';

describe('formatGadgetsSection — dynamic clientCapabilities table', () => {
  it('renders one row per library with hook + permission + what-it-does', () => {
    const libs: GadgetDescriptor[] = [
      {
        package: '@ggui-ai/gadgets',
        version: '0.1.0-rc.1',
        exports: [
          {
            hook: 'useGeolocation',
            permission: 'geolocation',
            description: "Read the user's latitude/longitude.",
          },
        ],
      },
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            hook: 'useLeafletMap',
            description: 'Render an interactive Leaflet map.',
            usage: 'Mount when the intent names a rendered map.',
          },
        ],
      },
    ];
    const section = formatGadgetsSection(libs);
    expect(section).toContain('`useGeolocation`');
    expect(section).toContain('`geolocation`');
    expect(section).toContain("Read the user's latitude/longitude.");
    expect(section).toContain('`useLeafletMap`');
    expect(section).toContain('(none)');
    expect(section).toContain('Mount when the intent names a rendered map');
  });

  it('falls back to description when usage is absent', () => {
    const section = formatGadgetsSection([
      {
        package: '@example/gadget-stripe',
        version: '0.0.1',
        exports: [
          {
            hook: 'useStripeCheckout',
            description: 'Render a Stripe Checkout session.',
          },
        ],
      },
    ]);
    expect(section).toContain('Render a Stripe Checkout session.');
  });

  it('returns a no-libraries hint when the catalog is empty', () => {
    const section = formatGadgetsSection([]);
    expect(section).toContain('the operator has registered');
    expect(section).not.toContain('|'); // no table rendered
  });

  // `Type:` line rendering for third-party gadgets.
  const LEAFLET_DTS = `
    export interface LeafletMapOptions { center: [number, number]; zoom: number }
    export declare const useLeafletMap: (options?: LeafletMapOptions) => { value: unknown };
  `;

  it('renders a `Type:` line for a THIRD-PARTY gadget when gadgetTypes carries its `.d.ts`', () => {
    const section = formatGadgetsSection(
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          exports: [
            {
              hook: 'useLeafletMap',
              description: 'Render an interactive Leaflet map.',
            },
          ],
        },
      ],
      { '@ggui-samples/gadget-leaflet': LEAFLET_DTS },
    );
    expect(section).toContain('**Type**');
    // The extracted signature carries the param + return shape.
    expect(section).toContain('useLeafletMap');
    expect(section).toContain('center');
    expect(section).toContain('zoom');
    expect(section).toContain('=>');
  });

  it('does NOT render a `Type:` line for a stdlib gadget', () => {
    // Stdlib gadgets never appear in `gadgetTypes`, so even with a map
    // threaded the stdlib hook gets no `Type:` line.
    const section = formatGadgetsSection(
      [
        {
          package: '@ggui-ai/gadgets',
          version: '0.1.0-rc.1',
          exports: [
            {
              hook: 'useGeolocation',
              permission: 'geolocation',
              description: "Read the user's latitude/longitude.",
            },
          ],
        },
      ],
      { '@ggui-samples/gadget-leaflet': LEAFLET_DTS },
    );
    expect(section).not.toContain('**Type**');
  });

  it('omits the `Type:` line when the signature cannot be extracted (graceful)', () => {
    const section = formatGadgetsSection(
      [
        {
          package: '@ggui-samples/gadget-leaflet',
          version: '0.0.1',
          exports: [
            {
              hook: 'useLeafletMap',
              description: 'Render an interactive Leaflet map.',
            },
          ],
        },
      ],
      // `.d.ts` does not declare `useLeafletMap` — extraction misses.
      { '@ggui-samples/gadget-leaflet': 'export declare const useOther: () => void;' },
    );
    expect(section).not.toContain('**Type**');
  });

  it('omits `Type:` lines when no gadgetTypes map is supplied', () => {
    const section = formatGadgetsSection([
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            hook: 'useLeafletMap',
            description: 'Render an interactive Leaflet map.',
          },
        ],
      },
    ]);
    expect(section).not.toContain('**Type**');
  });

  // Component gadgets get their own table + RENDER teaching.
  it('renders a component table with render (not call) teaching', () => {
    const section = formatGadgetsSection([
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            component: 'LeafletMap',
            description: 'Render an interactive Leaflet map.',
            usage: 'Render when the intent names a rendered map.',
          },
        ],
      },
    ]);
    expect(section).toContain('`LeafletMap`');
    expect(section).toContain('`@ggui-samples/gadget-leaflet`');
    // Render-vs-call teaching — a component is mounted as JSX.
    expect(section).toContain('RENDER it as a JSX element');
    expect(section).toContain('Do NOT call it like a hook');
  });

  it('renders BOTH a hook table and a component table for a mixed package', () => {
    const section = formatGadgetsSection([
      {
        package: '@ggui-samples/gadget-chart',
        version: '0.0.1',
        exports: [
          {
            component: 'Chart',
            description: 'Render an SVG bar chart.',
            usage: 'Render for a metric breakdown.',
          },
          {
            hook: 'useChartTheme',
            description: 'Resolved chart theme colors.',
            usage: 'Call for the active theme palette.',
          },
        ],
      },
    ]);
    // Hook subsection.
    expect(section).toContain('`useChartTheme`');
    expect(section).toContain('the hook MUST be one of the registered hooks');
    // Component subsection.
    expect(section).toContain('`Chart`');
    expect(section).toContain('RENDER it as a JSX element');
  });

  it('renders ONLY the component section for a component-only catalog (no empty hook table)', () => {
    const section = formatGadgetsSection([
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        exports: [
          {
            component: 'LeafletMap',
            description: 'Render an interactive Leaflet map.',
          },
        ],
      },
    ]);
    expect(section).toContain('`LeafletMap`');
    // No hook subsection header leaks in when there are zero hooks.
    expect(section).not.toContain('the registered hooks below');
  });

  // Component prop-signature line from the wrapper `.d.ts`.
  it('renders a `Props:` line for a component gadget when gadgetTypes carries its `.d.ts`', () => {
    const CHART_DTS = `
export interface ChartDatum { label: string; value: number }
export interface ChartProps {
  data: readonly ChartDatum[];
  height?: number;
  barColor?: string;
}
export declare function Chart(props: ChartProps): JSX.Element;
`;
    const section = formatGadgetsSection(
      [
        {
          package: '@ggui-samples/gadget-chart',
          version: '0.0.1',
          exports: [
            { component: 'Chart', description: 'Render a bar chart.' },
          ],
        },
      ],
      { '@ggui-samples/gadget-chart': CHART_DTS },
    );
    expect(section).toContain('**Props**');
    // The extracted props line carries the JSX attribute shape.
    expect(section).toContain('`Chart`:');
    expect(section).toContain('data');
    expect(section).toContain('height?');
  });

  it('omits the `Props:` line for a component when no gadgetTypes map is supplied', () => {
    const section = formatGadgetsSection([
      {
        package: '@ggui-samples/gadget-chart',
        version: '0.0.1',
        exports: [{ component: 'Chart', description: 'Render a bar chart.' }],
      },
    ]);
    expect(section).toContain('`Chart`');
    expect(section).not.toContain('**Props**');
  });
});

describe('buildSystemPrompt — clientCapabilities section integration', () => {
  it('defaults to STDLIB when no appGadgets are passed (pre-plugin parity)', () => {
    const prompt = buildSystemPrompt({ userRequest: 'show a counter' });
    // STDLIB seed surfaces every first-party hook — pin a representative pair
    // to catch regressions (full STDLIB list lives in @ggui-ai/protocol).
    expect(prompt).toContain('`useGeolocation`');
    expect(prompt).toContain('`useCamera`');
    expect(prompt).toContain('clientCapabilities — registered catalog');
  });

  it('threads appGadgets → table rows when callers provide a catalog', () => {
    const prompt = buildSystemPrompt({
      userRequest: 'show a Leaflet map of San Francisco',
      appGadgets: [
        {
          package: '@my-org/ggui-leaflet',
          version: '0.0.1',
          bundleUrl: 'https://registry.ggui.ai/leaflet@0.0.1/bundle.js',
          exports: [
            {
              hook: 'useLeafletMap',
              description: 'Render an interactive Leaflet map.',
              usage:
                'Mount when the intent names a rendered map (location browsing, route preview).',
            },
          ],
        },
      ],
    });
    expect(prompt).toContain('`useLeafletMap`');
    expect(prompt).toContain('Mount when the intent names a rendered map');
    // The replacement caps the catalog table at what's passed — no
    // STDLIB row bleed-through when the operator has explicitly
    // registered a narrower (or wider, plugin-bearing) catalog. We
    // assert against the table-row syntax (`| `useFoo`  |`) rather
    // than bare hook names, since `useGeolocation` STILL appears as
    // an EXAMPLE in surrounding prose (the catalog-table is one
    // section; the prose mentions the hook generically elsewhere).
    expect(prompt).not.toMatch(/\|\s*`useGeolocation`\s*\|/);
  });

  it('surfaces a "no libraries registered" hint when the catalog is empty', () => {
    const prompt = buildSystemPrompt({
      userRequest: 'show a static card',
      appGadgets: [],
    });
    expect(prompt).toContain("Don't declare `clientCapabilities.gadgets`");
    expect(prompt).not.toMatch(/\|\s*`useGeolocation`\s*\|/);
  });

  it("preserves the `gadget_not_registered` enforcement nudge", () => {
    // Plugin slice 1.2.1 carries the gate awareness into the code-gen
    // prompt so the LLM doesn't author a contract the gate would
    // reject at render time.
    const prompt = buildSystemPrompt({ userRequest: 'show a counter' });
    expect(prompt).toContain('`gadget_not_registered`');
  });
});
