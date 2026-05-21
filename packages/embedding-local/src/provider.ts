/**
 * Concrete {@link EmbeddingProvider} backed by `@huggingface/transformers`
 * running the quantized `Xenova/bge-small-en-v1.5` ONNX model locally.
 *
 * Pairs the {@link EmbeddingBootstrap} cold-start lifecycle from
 * this package with the inference path:
 *
 *   1. `transformers.pipeline('feature-extraction', modelId, {cache_dir, dtype:'q8', revision})`
 *      loads the quantized ONNX model — ~33MB to disk, ~60-80MB
 *      ort-node wasm at runtime.
 *   2. Run-warmup embeds a dummy string on boot so the first
 *      real embedding doesn't pay the pipeline cold-start tax
 *      (200-400ms) — warmup at boot, never lazy.
 *   3. L2-normalize every output vector — bge ONNX exports are
 *      NOT pre-normalized. Cosine similarity reduces to dot product
 *      downstream only when vectors are unit-length, so the
 *      normalization happens HERE, once, on the hot path; callers
 *      compute cosine via dot product without second-guessing.
 *
 * **Optional peer dependency.** `@huggingface/transformers` is not
 * a hard dep — OSS installs that use a different embedding provider
 * (hosted Voyage, OpenAI embeddings, a self-hosted Bedrock Titan
 * wrapper) don't need the 60MB ort-node binary. The factory resolves
 * transformers via dynamic import and rewrites the `ERR_MODULE_NOT_FOUND`
 * into a remediation message pointing the operator at
 * `pnpm add @huggingface/transformers`.
 *
 * **What this provider is NOT:**
 *
 *   - NOT the downloader seam from {@link Downloader}. Transformers.js
 *     owns its own HTTP + cache pipeline when `cache_dir` is set;
 *     the bootstrap harness exists for pre-warmup + operator-visible
 *     progress reporting, not byte-level download control.
 *   - NOT a chunker. Inputs longer than `max_length` (512 for
 *     bge-small-v1.5) are truncated by the tokenizer. Callers that
 *     need long-text embedding chunk + average upstream.
 *   - NOT a pool. One `LocalEmbeddingProvider` instance shares a
 *     single `pipeline` instance; concurrent `embed()` calls serialize
 *     through the pipeline's internal queue.
 */
import {
  DEFAULT_MODEL_DIMENSIONS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
} from './bootstrap.js';

/**
 * The `EmbeddingProvider` contract from `@ggui-ai/mcp-server-core`.
 *
 * Inlined as a local interface so this package doesn't pull in
 * `@ggui-ai/mcp-server-core` at runtime (keeps the embedding-local
 * install surface minimal — the types cross the package boundary,
 * but the peer dep direction is enforced by mcp-server-core's
 * consumers wiring the provider in, not by this package importing
 * back).
 *
 * Keep this shape in sync with `mcp-server-core/src/embedding-provider.ts`.
 */
export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

/**
 * Minimal structural shape of a transformers.js `feature-extraction`
 * pipeline. We type only what we call — avoiding a hard dep on
 * `@huggingface/transformers` types so the package typechecks
 * without the optional peer dep installed.
 *
 * At runtime we receive a `Tensor` with a `.data` field that is a
 * `Float32Array` of length `batch * sequence * dims` OR
 * (when `pooling:'mean'`) `batch * dims`. This provider uses
 * `{pooling:'mean', normalize:false}` and normalizes itself — see
 * the L2-normalization note in the file header.
 */
export interface TransformersPipelineOutput {
  readonly data: Float32Array | number[];
}

export type TransformersPipelineFn = (
  text: string | readonly string[],
  options?: {
    readonly pooling?: 'mean' | 'cls' | 'none';
    readonly normalize?: boolean;
  },
) => Promise<TransformersPipelineOutput>;

/**
 * Factory that resolves a transformers.js feature-extraction
 * pipeline. Split out so tests can inject a deterministic stub
 * without loading the 60MB ort-node binary in CI.
 */
export type PipelineFactory = (args: {
  readonly modelId: string;
  readonly revision: string;
  readonly cacheDir: string;
}) => Promise<TransformersPipelineFn>;

export interface LocalEmbeddingProviderOptions {
  /** Model cache directory. REQUIRED — no silent defaults so the
   *  operator owns where artifacts land. The CLI layer resolves
   *  this via `@ggui-ai/cli/paths.getEmbeddingCacheDir()`. */
  readonly cacheDir: string;
  /** Override the default model id (`Xenova/bge-small-en-v1.5`). */
  readonly modelId?: string;
  /** Override the pinned revision. Defaults to
   *  {@link DEFAULT_MODEL_REVISION}. */
  readonly revision?: string;
  /** Override the vector dimension reported on `.dimensions`.
   *  Defaults to {@link DEFAULT_MODEL_DIMENSIONS}. */
  readonly dimensions?: number;
  /** Pipeline factory. Defaults to a closure that dynamically
   *  imports `@huggingface/transformers`. Tests inject a stub. */
  readonly pipelineFactory?: PipelineFactory;
  /** Whether to embed a dummy string at construction time so the
   *  first real `embed()` doesn't pay the pipeline cold-start.
   *  Default true. */
  readonly warmup?: boolean;
}

/**
 * Construct a {@link LocalEmbeddingProvider}.
 *
 * The factory returns immediately; the pipeline load happens lazily
 * on the first `embed()` call UNLESS `warmup:true` is set (default).
 * Callers that want to observe download progress wire this together
 * with {@link EmbeddingBootstrap}: construct the bootstrap, await
 * `warmup()` for event-reporting, THEN construct the provider
 * (which will find the cache populated and load without progress).
 */
export function createLocalEmbeddingProvider(
  options: LocalEmbeddingProviderOptions,
): EmbeddingProvider {
  const modelId = options.modelId ?? DEFAULT_MODEL_ID;
  const revision = options.revision ?? DEFAULT_MODEL_REVISION;
  const dimensions = options.dimensions ?? DEFAULT_MODEL_DIMENSIONS;
  const factory = options.pipelineFactory ?? defaultPipelineFactory;
  const wantWarmup = options.warmup ?? true;

  // Derive a stable id for the provider — includes the short model
  // name so a VectorStore written by bge-small-v1.5 doesn't silently
  // get mixed with vectors from another local model.
  const shortName = modelId.split('/').pop() ?? modelId;
  const providerId = `local:${shortName}`;

  let pipelinePromise: Promise<TransformersPipelineFn> | null = null;

  function getPipeline(): Promise<TransformersPipelineFn> {
    if (pipelinePromise === null) {
      pipelinePromise = factory({
        modelId,
        revision,
        cacheDir: options.cacheDir,
      }).catch((err: unknown) => {
        // Reset so a subsequent call retries instead of rethrowing
        // a stale failure forever.
        pipelinePromise = null;
        throw err;
      });
    }
    return pipelinePromise;
  }

  // Fire-and-forget warmup. Errors are swallowed here — the next
  // `embed()` call will surface them explicitly.
  if (wantWarmup) {
    getPipeline().catch(() => {
      // Swallowed by design — see comment above.
    });
  }

  return {
    id: providerId,
    dimensions,
    async embed(text: string): Promise<number[]> {
      if (typeof text !== 'string') {
        throw new Error(
          `LocalEmbeddingProvider.embed: expected string, got ${typeof text}`,
        );
      }
      const pipeline = await getPipeline();
      const output = await pipeline(text, {
        pooling: 'mean',
        normalize: false,
      });
      const raw = toNumberArray(output.data);
      if (raw.length !== dimensions) {
        throw new Error(
          `LocalEmbeddingProvider(${providerId}): pipeline returned ${raw.length}d vector but provider is configured for ${dimensions}d`,
        );
      }
      return l2Normalize(raw);
    },
  };
}

/**
 * L2-normalize a vector in place-equivalent (returns a new array —
 * input is treated as read-only). Returns a **copy** because the
 * upstream pipeline may reuse buffers; mutating in place would
 * corrupt a cached tensor on subsequent inference calls.
 *
 * Defensive: a zero-magnitude vector is returned unchanged rather
 * than producing NaN via divide-by-zero. This matches transformers.js's
 * own `normalize:true` behavior (verified empirically) and keeps
 * downstream cosine similarity from poisoning the index.
 *
 * Exported for test visibility.
 */
export function l2Normalize(vec: readonly number[]): number[] {
  let sumOfSquares = 0;
  for (let i = 0; i < vec.length; i++) {
    const value = vec[i] ?? 0;
    sumOfSquares += value * value;
  }
  const magnitude = Math.sqrt(sumOfSquares);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    return vec.slice();
  }
  const out = new Array<number>(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] ?? 0) / magnitude;
  }
  return out;
}

function toNumberArray(data: Float32Array | number[]): number[] {
  if (Array.isArray(data)) return data.slice();
  // Float32Array → plain number[]. Array.from copies, which is the
  // correct defensive move here — the tensor buffer is reused across
  // inference calls.
  return Array.from(data);
}

/**
 * Default pipeline factory — dynamically imports
 * `@huggingface/transformers` and returns a `feature-extraction`
 * pipeline. Rewrites missing-peer-dep into a remediation message so
 * operators see `pnpm add @huggingface/transformers` instead of
 * `ERR_MODULE_NOT_FOUND`.
 */
const defaultPipelineFactory: PipelineFactory = async ({
  modelId,
  revision,
  cacheDir,
}) => {
  let mod: unknown;
  try {
    mod = await import('@huggingface/transformers');
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (
      errMsg.includes('ERR_MODULE_NOT_FOUND') ||
      errMsg.includes('Cannot find package') ||
      errMsg.includes('Could not resolve') ||
      errMsg.includes('Cannot find module') ||
      (errMsg.includes('@huggingface/transformers') &&
        /(resolve|find|installed|install)/i.test(errMsg))
    ) {
      throw new Error(
        [
          "@ggui-ai/embedding-local requires '@huggingface/transformers' as an optional peer dependency.",
          "Install it in the host project:",
          "  pnpm add @huggingface/transformers",
          "  # or: npm install @huggingface/transformers",
          'The default embedding model downloads roughly 120MB of weights on first run.',
        ].join('\n'),
      );
    }
    throw err;
  }

  const transformers = mod as {
    readonly env?: {
      cacheDir?: string;
      localModelPath?: string;
      allowRemoteModels?: boolean;
    };
    readonly pipeline?: (
      task: string,
      model?: string,
      opts?: Record<string, unknown>,
    ) => Promise<TransformersPipelineFn>;
  };

  // transformers.env is a live singleton — writing here configures
  // where the subsequent pipeline() call looks for / writes model
  // artifacts. Done BEFORE calling pipeline().
  if (transformers.env) {
    transformers.env.cacheDir = cacheDir;
  }

  if (typeof transformers.pipeline !== 'function') {
    throw new Error(
      '@ggui-ai/embedding-local: @huggingface/transformers did not expose pipeline() — installed a non-compatible version?',
    );
  }

  return transformers.pipeline('feature-extraction', modelId, {
    revision,
    dtype: 'q8',
    cache_dir: cacheDir,
  });
};
