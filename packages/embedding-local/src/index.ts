/**
 * `@ggui-ai/embedding-local` — local-model embedding for the
 * self-hosted ggui generation path.
 *
 * Provides a `@huggingface/transformers`-backed `EmbeddingProvider`
 * wrapper that satisfies `@ggui-ai/mcp-server-core`'s
 * `EmbeddingProvider` contract. The model (quantized
 * `Xenova/bge-small-en-v1.5`, ~33MB) downloads into the configured
 * cache directory on first use.
 */
export {
  createLocalEmbeddingProvider,
  l2Normalize,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  DEFAULT_MODEL_DIMENSIONS,
} from './provider.js';
export type {
  EmbeddingProvider,
  LocalEmbeddingProviderOptions,
  PipelineFactory,
  TransformersPipelineFn,
  TransformersPipelineOutput,
} from './provider.js';
