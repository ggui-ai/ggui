/**
 * `@ggui-ai/embedding-local` — local-model embedding for the
 * self-hosted ggui generation path.
 *
 * Provides two pieces: a cold-start lifecycle with an
 * operator-visible event surface (model download, cache resolution,
 * warmup), and a `@huggingface/transformers`-backed
 * `EmbeddingProvider` wrapper that satisfies
 * `@ggui-ai/mcp-server-core`'s `EmbeddingProvider` contract.
 */
export {
  createEmbeddingBootstrap,
  createNoopDownloader,
  probeCache,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  DEFAULT_MODEL_DIMENSIONS,
} from './bootstrap.js';
export type {
  BootstrapError,
  BootstrapErrorKind,
  BootstrapEvent,
  BootstrapState,
  Downloader,
  EmbeddingBootstrap,
  EmbeddingBootstrapOptions,
  WarmupOptions,
} from './bootstrap.js';
export {
  createInMemoryDownloader,
} from './in-memory-downloader.js';
export type { InMemoryDownloaderOptions } from './in-memory-downloader.js';
export {
  createLocalEmbeddingProvider,
  l2Normalize,
} from './provider.js';
export type {
  EmbeddingProvider,
  LocalEmbeddingProviderOptions,
  PipelineFactory,
  TransformersPipelineFn,
  TransformersPipelineOutput,
} from './provider.js';
