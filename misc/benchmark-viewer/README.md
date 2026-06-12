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
        "headline": "claude 88 (n=8) / openai 81 (n=8) / google 75 (n=9) · judge claude-haiku-4-5-20251001 (aesthetic-eval.v1)"
      }
    }
  ]
}
```

`<date>/multi-sdk.json` is the runner's emitted `BenchmarkReportDisplay`
(see `@ggui-ai/shared` benchmark display types) — the serialization-safe
shape `toDisplayReport` writes, not the runner-internal `BenchmarkReport`.

## Components

- **`<BenchmarksDashboard>`** — top-level. Date selector + run grid + detail.
- **`<TrendChart>`** — score-per-variant over time, pure SVG. Unevaluated
  runs (`avgScore === -1`) render as gaps, not zero scores.
- **`<VariantGrid>`** — variant × prompt grid; click any cell. Cells show
  the judge score, `fail` on errored cells, and `—` when no score exists.
- **`<ResultDetail>`** — selected-cell panel with top-line metrics
  (score / time / cost / turns / tokens), judge disclosure, and the
  **dimension scores breakdown** (5-axis bar rows).
- **`<DimensionScores>`** — the 5 dimensions the aesthetic judge measures
  (layout, designTokens, hierarchy, polish, dataPresentation).

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
