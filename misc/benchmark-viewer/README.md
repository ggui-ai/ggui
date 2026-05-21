# @ggui-ai/benchmark-viewer

React component package for rendering [@ggui-ai/benchmark](../benchmark)
daily reports.

Source-agnostic — pass any `BenchmarkDataSource` and the dashboard
renders. Production points at a public S3 URL; local dev points at a
static file server.

## Quick start

```tsx
import { BenchmarksDashboard, httpJsonSource } from "@ggui-ai/benchmark-viewer";

export default function Page() {
  const source = httpJsonSource("https://bench.ggui.ai/data/");
  return <BenchmarksDashboard dataSource={source} />;
}
```

## Path convention

Whatever URL you pass as the data-source root, the viewer expects:

```
<base-url>/index.json                   ← list of available runs
<base-url>/<date>/multi-sdk.json        ← one report per day
```

`index.json` shape (`BenchmarkIndex`):

```json
{
  "schemaVersion": "benchmark-index.v0",
  "generatedAt": "2026-05-06T03:00:00Z",
  "runs": [
    {
      "date": "2026-05-06",
      "multiSdk": {
        "reportPath": "2026-05-06/multi-sdk.json",
        "successRate": 0.92,
        "totalRuns": 25,
        "headline": "claude 88 / openai 81 / google 75"
      }
    }
  ]
}
```

`<date>/multi-sdk.json` is the runner's emitted `BenchmarkReport` (see
`@ggui-ai/benchmark/multi-sdk/types`) — written verbatim by the runner.

## Components

- **`<BenchmarksDashboard>`** — top-level. Date selector + run grid + detail.
- **`<TrendChart>`** — score-per-provider over time, pure SVG.
- **`<VariantGrid>`** — provider × prompt grid; click any cell.
- **`<ResultDetail>`** — selected-cell panel with prompt, top-line metrics,
  **dimension scores breakdown** (5-axis bar rows), **live render iframe**,
  source code, compiled code.
- **`<DimensionScores>`** — 5-axis quality breakdown (completeness,
  visualPolish, interactivity, accessibility, codeQuality).
- **`<LiveRenderFrame>`** — iframe rendering compiled output via import
  map (React from esm.sh, `@ggui-ai/design/{primitives,tokens}` from
  pre-bundled local files). Caller is responsible for serving the
  bundles at `/runtime/*.bundle.js`.

## Local dev

Point the dashboard at any HTTP server serving the convention:

```bash
npx serve ./my-bench-results
```

```tsx
const source = httpJsonSource("http://localhost:3000/");
```

Or use a Next.js `public/` directory — files there are served at the
site root, so `httpJsonSource('/sample-data/')` works without a second
server.

## License

Apache-2.0
