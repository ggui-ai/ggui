# @ggui-ai/embedding-local

Local-model text embeddings for self-hosted [ggui](https://ggui.ai).

Runs entirely on-device — no embedding API key required. The default
model is `Xenova/bge-small-en-v1.5` (384-dimensional, MIT-licensed).

This package provides a **`@huggingface/transformers`-backed embedding
provider** that satisfies the `EmbeddingProvider` contract consumed by
the ggui MCP server. Transformers.js owns the model download + cache
pipeline: the first `embed()` (or the construction-time warmup)
fetches the quantized weights into the configured cache directory;
subsequent runs load from disk.

## Install

```bash
pnpm add @ggui-ai/embedding-local @huggingface/transformers
```

`@huggingface/transformers` is an **optional peer dependency** — it is
only needed when you actually run embedding inference. The default
model downloads roughly 33MB of weights on first run.

## Usage

```ts
import { createLocalEmbeddingProvider } from "@ggui-ai/embedding-local";

const provider = createLocalEmbeddingProvider({
  cacheDir: "/path/to/model/cache",
});

const vector = await provider.embed("hello world");
// vector.length === provider.dimensions
```

## License

Apache-2.0
