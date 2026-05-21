# @ggui-ai/shared

Shared TypeScript types used across ggui SDK packages — the types that aren't wire-protocol shapes (those live in [`@ggui-ai/protocol`](https://www.npmjs.com/package/@ggui-ai/protocol)) but are still needed by more than one package.

```bash
npm install @ggui-ai/shared
```

Type-only — no runtime code.

## What it exports

- **Self-repair types** — `ComponentErrorReport`, `ComponentRepairResult`, `SelfRepairConfig`, `SelfRepairEvents`, and related shapes for the generated-component error boundary and repair flow.
- **Agent listing types** — `AgentListingItem`, `AgentListingVisibility`, `AgentListingStatus` for the agent marketplace.
- **Benchmark display types** — `BenchmarkReportDisplay` and related shapes for rendering UI-generation benchmark reports.

## License

Apache-2.0.
