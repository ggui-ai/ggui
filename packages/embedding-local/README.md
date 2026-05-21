# @ggui-ai/embedding-local

Local-model text embeddings for self-hosted [ggui](https://ggui.ai).

Runs entirely on-device — no embedding API key required. The default
model is `Xenova/bge-small-en-v1.5` (384-dimensional, MIT-licensed).

This package provides two pieces:

- A **cold-start lifecycle** — cache resolution, model download, and an
  operator-visible event surface (`started` → `downloading` →
  `progress*` → `cached` / `ready`) so operators see progress instead
  of a silent hang on first run.
- A **`@huggingface/transformers`-backed embedding provider** that
  satisfies the `EmbeddingProvider` contract consumed by the ggui MCP
  server.

## Install

```bash
pnpm add @ggui-ai/embedding-local @huggingface/transformers
```

`@huggingface/transformers` is an **optional peer dependency**. It is
only needed when you actually run embedding inference; the bootstrap
lifecycle works without it. The default model downloads roughly 120MB
of weights on first run.

## Usage

```ts
import { createLocalEmbeddingProvider } from "@ggui-ai/embedding-local";

const provider = createLocalEmbeddingProvider({
  cacheDir: "/path/to/model/cache",
});

const vector = await provider.embed("hello world");
// vector.length === provider.dimensions
```

To observe the cold-start lifecycle (e.g. for a CLI progress banner),
use `createEmbeddingBootstrap` and listen to its `BootstrapEvent`
stream.

## License

Apache-2.0
