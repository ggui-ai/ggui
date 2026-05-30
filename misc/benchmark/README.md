# @ggui-ai/benchmark

Open-source benchmark suite for the [ggui generation protocol](https://github.com/ggui-ai/ggui).

Multi-provider × multi-model quality, cost, and latency evals against the
`@ggui-ai/ui-gen` surface — plus A2UI frame timings, SLO floors,
and cross-bench baseline manifests.

## Quick start

```bash
pnpm add -D @ggui-ai/benchmark

# Run a quick smoke bench (one provider, one prompt)
pnpm bench --preset quick

# Full corpus across providers
pnpm bench --provider claude,openai,google --preset full

# List available prompts
pnpm bench --list
```

## What this is NOT

This package benches the OSS generation surface. Cloud-runtime integration
tests (real Bedrock embeddings, hosted blueprint matching, LiteLLM proxy
orchestration) live alongside the cloud runtime, not here.

## License

Apache-2.0
