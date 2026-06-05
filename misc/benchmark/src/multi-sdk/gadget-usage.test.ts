/**
 * Plugin slice 1.2.5 — pin the deterministic wrapper-usage check
 * that flags the "LLM ignored the registered catalog" failure mode.
 * Cheap unit-level coverage; no LLM calls.
 */
import { describe, expect, it } from 'vitest';
import type { GadgetDescriptor, GadgetPackageUse } from '@ggui-ai/protocol';
import { checkGadgetUsage } from './runner';
import type { BenchmarkCommit } from './types';

// Synthetic single-hook descriptor fixture (the function under test
// only cares about export shape, not whether it mirrors a real sample).
const leafletDescriptor: GadgetDescriptor = {
  package: '@ggui-samples/gadget-leaflet',
  version: '0.0.1',
  exports: [
    {
      hook: 'useLeafletMap',
      description: 'GguiSession an interactive Leaflet map.',
      usage: 'Mount when intent names a rendered map.',
    },
  ],
};

// MIXED package fixture (GG.8.7) — a component export + a companion
// hook export under one descriptor.
const chartDescriptor: GadgetDescriptor = {
  package: '@ggui-samples/gadget-chart',
  version: '0.0.1',
  exports: [
    {
      component: 'Chart',
      description: 'GguiSession an SVG bar chart.',
      usage: 'GguiSession <Chart data={…} /> for a metric breakdown.',
    },
    {
      hook: 'useChartTheme',
      description: 'Resolved chart theme colors.',
      usage: 'Call for the active theme palette.',
    },
  ],
};

/**
 * Build a fixture commit from a package-keyed `clientCapabilities.gadgets`
 * value — `Record<packageName, GadgetPackageUse>`, the post-GG.8.8 wire
 * shape. The export NAME (inner key) discriminates kind; `version` /
 * `binding` are gone from the wire.
 */
function commitWith(
  gadgets: Record<string, GadgetPackageUse>,
  descriptors: readonly GadgetDescriptor[] = [leafletDescriptor],
): BenchmarkCommit {
  return {
    id: 'fixture-plugin',
    name: 'Fixture',
    description: 'Plugin usage check fixture',
    complexity: 'medium',
    prompt: 'irrelevant for this unit test',
    contract: {
      clientCapabilities: { gadgets },
    },
    appGadgets: descriptors,
  };
}

describe('checkGadgetUsage — plugin-aware bench check', () => {
  it('flags a hook the contract declared + registered but the source never called', () => {
    const sourceCode = `
      export default function Component({ recipientName }: Props) {
        return <div>Hello {recipientName}</div>;
      }
    `;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith({
        '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
      }),
    );
    expect(result.declared).toEqual(['useLeafletMap']);
    expect(result.used).toEqual([]);
    expect(result.missing).toEqual(['useLeafletMap']);
  });

  it('reports `used` when the source calls the hook', () => {
    const sourceCode = `
      import { useLeafletMap } from '@my-org/ggui-leaflet';
      export default function Component({ center, zoom }: Props) {
        const map = useLeafletMap({ center, zoom });
        return <div style={{ height: 400 }} ref={map.containerRef} />;
      }
    `;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith({
        '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
      }),
    );
    expect(result.declared).toEqual(['useLeafletMap']);
    expect(result.used).toEqual(['useLeafletMap']);
    expect(result.missing).toEqual([]);
  });

  it("skips hooks the contract declared but `appGadgets` doesn't register", () => {
    // STDLIB-only hook on the contract, no matching registry entry —
    // the bench check only fires on operator-registered wrappers
    // because pre-plugin STDLIB hooks are validated by other layers.
    const sourceCode = `function Component() { return null; }`;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith({
        '@ggui-ai/gadgets': { useGeolocation: {} },
      }),
    );
    expect(result.declared).toEqual([]);
    expect(result.used).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it('partial-coverage report: 2 declared, 1 used, 1 missing', () => {
    const sourceCode = `
      const map = useLeafletMap({ center: [0, 0], zoom: 10 });
      // useMapboxMap is registered + declared but never called
    `;
    const commit: BenchmarkCommit = {
      id: 'fixture-plugin-2',
      name: 'Fixture 2',
      description: 'Two wrappers',
      complexity: 'medium',
      prompt: 'irrelevant',
      contract: {
        clientCapabilities: {
          gadgets: {
            '@ggui-samples/gadget-leaflet': { useLeafletMap: {} },
            '@ggui-samples/gadget-mapbox': { useMapboxMap: {} },
          },
        },
      },
      appGadgets: [
        leafletDescriptor,
        {
          package: '@ggui-samples/gadget-mapbox',
          version: '0.0.1',
          exports: [
            {
              hook: 'useMapboxMap',
              description: 'Mapbox map.',
              usage: 'Mount when intent names a Mapbox-styled map.',
            },
          ],
        },
      ],
    };
    const result = checkGadgetUsage(sourceCode, commit);
    expect(result.declared).toEqual(['useLeafletMap', 'useMapboxMap']);
    expect(result.used).toEqual(['useLeafletMap']);
    expect(result.missing).toEqual(['useMapboxMap']);
  });
});

describe('checkGadgetUsage — component gadget detection (GG.8.7)', () => {
  // Package-keyed contract value binding only the `Chart` component
  // export of the mixed `@ggui-samples/gadget-chart` package.
  const chartGadgets: Record<string, GadgetPackageUse> = {
    '@ggui-samples/gadget-chart': { Chart: {} },
  };

  it('flags a component declared + registered but never rendered', () => {
    const sourceCode = `
      export default function Component() {
        return <div>no chart here</div>;
      }
    `;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith(chartGadgets, [chartDescriptor]),
    );
    expect(result.declared).toEqual(['Chart']);
    expect(result.used).toEqual([]);
    expect(result.missing).toEqual(['Chart']);
  });

  it('reports `used` when the component is rendered as a JSX element', () => {
    const sourceCode = `
      import { Chart } from '@ggui-samples/gadget-chart';
      export default function Component({ data }: Props) {
        return <Chart data={data} height={260} />;
      }
    `;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith(chartGadgets, [chartDescriptor]),
    );
    expect(result.used).toEqual(['Chart']);
    expect(result.missing).toEqual([]);
  });

  it('detects the children form `<Chart>…</Chart>`', () => {
    const sourceCode = `function Component() { return <Chart data={[]}></Chart>; }`;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith(chartGadgets, [chartDescriptor]),
    );
    expect(result.used).toEqual(['Chart']);
  });

  it('does NOT count a bare call `Chart(` as a render', () => {
    // A component export is "used" only when rendered as JSX — a
    // function-call shape must not satisfy the component check.
    const sourceCode = `function Component() { const x = Chart({ data: [] }); return null; }`;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith(chartGadgets, [chartDescriptor]),
    );
    expect(result.used).toEqual([]);
    expect(result.missing).toEqual(['Chart']);
  });

  it('does NOT false-positive on a same-prefix component name', () => {
    const sourceCode = `function Component() { return <ChartLegend items={[]} />; }`;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith(chartGadgets, [chartDescriptor]),
    );
    expect(result.used).toEqual([]);
    expect(result.missing).toEqual(['Chart']);
  });

  it('only the contract-bound export of a mixed package is `declared`', () => {
    // `chartDescriptor` registers `Chart` + `useChartTheme`; the
    // contract binds only the component — the companion hook is
    // registered but not declared, so it is neither used nor missing.
    const sourceCode = `function Component({ data }: Props) { return <Chart data={data} />; }`;
    const result = checkGadgetUsage(
      sourceCode,
      commitWith(chartGadgets, [chartDescriptor]),
    );
    expect(result.declared).toEqual(['Chart']);
    expect(result.used).toEqual(['Chart']);
    expect(result.missing).toEqual([]);
  });
});
