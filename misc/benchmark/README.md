# @ggui-ai/benchmark

Open-source benchmark suite for the [ggui generation protocol](https://github.com/ggui-ai/ggui).

Multi-provider × multi-model quality, cost, and latency evals against the
`@ggui-ai/ui-gen` surface — plus A2UI frame timings, SLO floors,
and cross-bench baseline manifests.

## Quick start

The runner is source-available (not published to npm). Clone the monorepo
and run a cell locally:

```bash
git clone https://github.com/ggui-ai/ggui && cd ggui
pnpm install

# set a provider key, then run a cell locally (writes JSON to benchmark-results/):
ANTHROPIC_API_KEY=… pnpm --filter @ggui-ai/benchmark bench --provider claude --commit weather-card --threshold 70

# Full corpus across providers
pnpm --filter @ggui-ai/benchmark bench --provider claude,openai,google --commit weather-card,survey-form,kanban-board --threshold 70
```

### Publish your own dashboard

Build the runner image and publish results to your own S3 bucket:

```bash
make bench-image
docker run --env-file .env -e S3_BUCKET=… ggui-benchmark
```

## What this is NOT

This package benches the OSS generation surface. Cloud-runtime integration
tests (real Bedrock embeddings, hosted blueprint matching, LiteLLM proxy
orchestration) live alongside the cloud runtime, not here.

## License

Apache-2.0
