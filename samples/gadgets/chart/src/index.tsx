/**
 * `@ggui-samples/gadget-chart` — reference ggui gadget package that
 * ships BOTH a component AND a hook behind one npm identity.
 *
 * The mixed-kind package — the case `defineGadgetPackage` exists for:
 *
 *   - `Chart` — a COMPONENT gadget. ggui-generated UI code renders it
 *     as JSX (`<Chart data={…} />`); the component owns the whole
 *     render. A pure-SVG bar chart — no 3rd-party charting library, so
 *     nothing to bundle and the published surface stays tiny.
 *   - `useChartTheme` — a companion HOOK gadget. Reads the active
 *     ggui theme's CSS custom properties and returns a resolved
 *     `{ palette, axisColor, … }`. Generated code calls it to pick a
 *     theme-matched `barColor` for `<Chart>`.
 *
 * Both ride one `defineGadgetPackage` descriptor with two `exports[]` —
 * one npm install, one registry entry, two usable exports. Operators
 * register `chartGadget`; generated UIs import `Chart` / `useChartTheme`
 * directly.
 *
 * v1 scope: each export is standalone — flat props, no gadget
 * sub-component composition (`<Chart><Bar/></Chart>` is not a thing).
 */

import { useMemo, type ReactElement } from 'react';
import { defineGadgetPackage } from '@ggui-ai/gadgets';

// ── Chart component ─────────────────────────────────────────────────

/** One bar of the chart — a labelled magnitude. */
export interface ChartDatum {
  /** X-axis label rendered under the bar. */
  readonly label: string;
  /** Bar magnitude. Negative values clamp to a zero-height bar. */
  readonly value: number;
}

/** Props for the {@link Chart} component gadget. */
export interface ChartProps {
  /** Bars to plot, left to right. An empty array renders the
   * `emptyMessage` placeholder instead of an SVG. */
  readonly data: readonly ChartDatum[];
  /** Overall chart height in CSS pixels. Defaults to `240`. */
  readonly height?: number;
  /** Bar fill — any CSS color, including a `var(--…)` reference.
   * Defaults to the ggui primary accent. */
  readonly barColor?: string;
  /** Placeholder text shown when `data` is empty. */
  readonly emptyMessage?: string;
}

const BAR_WIDTH = 44;
const BAR_GAP = 28;
/** Headroom above the tallest bar for its value label. */
const VALUE_BAND = 22;
/** Footer band reserved for x-axis labels. */
const LABEL_BAND = 30;
const DEFAULT_HEIGHT = 240;
const DEFAULT_BAR_COLOR = 'var(--ggui-color-primary-500, #3b82f6)';
const TEXT_COLOR = 'var(--ggui-color-onSurface, #18181b)';
const AXIS_COLOR = 'var(--ggui-color-outline, #d4d4d8)';
const FONT_FAMILY = 'var(--ggui-font-family-sans, sans-serif)';

/**
 * Render a responsive SVG bar chart. Bars scale to the largest
 * `value`; the SVG uses a `viewBox` so it fits its container width.
 * Declarative — re-rendering with new `data` repaints the chart.
 */
export function Chart(props: ChartProps): ReactElement {
  const {
    data,
    height = DEFAULT_HEIGHT,
    barColor = DEFAULT_BAR_COLOR,
    emptyMessage = 'No data to display.',
  } = props;

  if (data.length === 0) {
    return (
      <div
        role="img"
        aria-label={emptyMessage}
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: TEXT_COLOR,
          fontFamily: FONT_FAMILY,
          fontSize: 13,
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  const max = Math.max(1, ...data.map((d) => Math.max(0, d.value)));
  const plotHeight = Math.max(1, height - VALUE_BAND - LABEL_BAND);
  const width = data.length * (BAR_WIDTH + BAR_GAP) + BAR_GAP;
  const baselineY = VALUE_BAND + plotHeight;
  const summary = `Bar chart — ${data
    .map((d) => `${d.label}: ${d.value}`)
    .join(', ')}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label={summary}
      style={{ display: 'block', maxWidth: '100%', fontFamily: FONT_FAMILY }}
    >
      <line
        x1={0}
        y1={baselineY}
        x2={width}
        y2={baselineY}
        stroke={AXIS_COLOR}
        strokeWidth={1}
      />
      {data.map((d, i) => {
        const barHeight = Math.max(
          2,
          (Math.max(0, d.value) / max) * plotHeight,
        );
        const x = BAR_GAP + i * (BAR_WIDTH + BAR_GAP);
        const y = baselineY - barHeight;
        const centerX = x + BAR_WIDTH / 2;
        return (
          <g key={`${d.label}-${i}`}>
            <rect
              x={x}
              y={y}
              width={BAR_WIDTH}
              height={barHeight}
              rx={4}
              fill={barColor}
            />
            <text
              x={centerX}
              y={y - 7}
              textAnchor="middle"
              fontSize={12}
              fill={TEXT_COLOR}
            >
              {d.value}
            </text>
            <text
              x={centerX}
              y={height - 10}
              textAnchor="middle"
              fontSize={12}
              fill={TEXT_COLOR}
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── useChartTheme hook ──────────────────────────────────────────────

/** Resolved theme colors for charting, read from the ggui CSS theme. */
export interface ChartTheme {
  /** Categorical color ramp — index into it for multi-series charts. */
  readonly palette: readonly string[];
  /** Axis / baseline stroke color. */
  readonly axisColor: string;
  /** Label + value text color. */
  readonly labelColor: string;
  /** Gridline color. */
  readonly gridColor: string;
}

const FALLBACK_THEME: ChartTheme = {
  palette: ['#3b82f6', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'],
  axisColor: '#d4d4d8',
  labelColor: '#18181b',
  gridColor: '#e4e4e7',
};

function readCssVar(
  style: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  const value = style.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function readChartTheme(): ChartTheme {
  // No DOM (SSR / typecheck / test) — hand back the static fallback.
  if (typeof document === 'undefined') return FALLBACK_THEME;
  const style = getComputedStyle(document.documentElement);
  return {
    palette: [
      readCssVar(style, '--ggui-color-primary-500', '#3b82f6'),
      readCssVar(style, '--ggui-color-info-500', '#0ea5e9'),
      readCssVar(style, '--ggui-color-success-500', '#22c55e'),
      readCssVar(style, '--ggui-color-warning-500', '#f59e0b'),
      readCssVar(style, '--ggui-color-error-500', '#ef4444'),
    ],
    axisColor: readCssVar(style, '--ggui-color-outline', '#d4d4d8'),
    labelColor: readCssVar(style, '--ggui-color-onSurface', '#18181b'),
    gridColor: readCssVar(style, '--ggui-color-outline', '#e4e4e7'),
  };
}

/**
 * Companion hook — returns the active ggui theme's chart colors. Read
 * once on mount; pass a `palette` entry to `<Chart barColor>` so the
 * chart matches the surrounding app theme.
 */
export function useChartTheme(): ChartTheme {
  return useMemo(() => readChartTheme(), []);
}

// ── Package descriptor ──────────────────────────────────────────────

/**
 * The registry descriptor for the mixed chart package. Operators
 * register this on `App.gadgets` (or via `ggui.json#app.gadgets`);
 * generated component code imports `Chart` / `useChartTheme` directly.
 */
export const chartGadget = defineGadgetPackage({
  package: '@ggui-samples/gadget-chart',
  version: '0.0.1',
  exports: [
    {
      component: 'Chart',
      impl: Chart,
      description:
        'Render a responsive SVG bar chart. Each datum is a labelled magnitude; bars scale to the largest value.',
      usage:
        'Render `<Chart data={[{ label, value }]} />` when the intent names a bar chart, a metric breakdown, or a small dataviz panel. Optional `height` (default 240) and `barColor` (any CSS color or `var(--…)`). The component owns the full SVG render — pass plain data, no refs.',
      example: {
        componentSnippet:
          'function RevenuePanel({ quarters }: Props) { return <Chart data={quarters.map((q) => ({ label: q.label, value: q.revenue }))} height={260} />; }',
        props: {
          data: [
            { label: 'Q1', value: 120 },
            { label: 'Q2', value: 180 },
            { label: 'Q3', value: 150 },
            { label: 'Q4', value: 210 },
          ],
          height: 260,
        },
      },
      gotchas:
        'Pass `data` as plain `{ label, value }` objects from props — never hardcode chart values. Negative values clamp to a zero-height bar.',
    },
    {
      hook: 'useChartTheme',
      impl: useChartTheme,
      description:
        'Read the active ggui theme and return resolved chart colors — a categorical palette plus axis / label / grid colors.',
      usage:
        'Call `const theme = useChartTheme();` then pass `theme.palette[0]` (or any index) to `<Chart barColor>` so the chart tracks the app theme. Takes no arguments; safe to call at the top of any component.',
      example: {
        call: 'const theme = useChartTheme();',
        returns: {
          palette: ['#3b82f6', '#0ea5e9', '#22c55e', '#f59e0b', '#ef4444'],
          axisColor: '#d4d4d8',
          labelColor: '#18181b',
          gridColor: '#e4e4e7',
        },
      },
    },
  ],
});
