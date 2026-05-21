import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  createLocalEmbeddingProvider,
  l2Normalize,
  type PipelineFactory,
  type TransformersPipelineFn,
} from './index.js';
import {
  DEFAULT_MODEL_DIMENSIONS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
} from './bootstrap.js';

// ─── l2Normalize ─────────────────────────────────────────────

describe('l2Normalize', () => {
  it('produces a unit vector with magnitude 1', () => {
    const input = [3, 4];
    const out = l2Normalize(input);
    const magnitude = Math.hypot(out[0]!, out[1]!);
    expect(magnitude).toBeCloseTo(1.0, 10);
    expect(out[0]).toBeCloseTo(0.6, 10);
    expect(out[1]).toBeCloseTo(0.8, 10);
  });

  it('returns a copy — does not mutate the input', () => {
    const input = [3, 4];
    l2Normalize(input);
    expect(input).toEqual([3, 4]);
  });

  it('returns the input unchanged for a zero vector (no divide-by-zero)', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('normalizes a 384d random vector to unit length', () => {
    const vec = Array.from({ length: 384 }, (_, i) => Math.sin(i) * 7.3);
    const out = l2Normalize(vec);
    const magnitude = Math.sqrt(out.reduce((acc, v) => acc + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 10);
  });

  it('preserves direction — normalized vector is a positive scalar multiple of input', () => {
    const input = [1, 2, 3, 4];
    const out = l2Normalize(input);
    // Every element should be input[i] / magnitude, so ratios match.
    const ratio = out[0]! / input[0]!;
    for (let i = 1; i < input.length; i++) {
      expect(out[i]! / input[i]!).toBeCloseTo(ratio, 10);
    }
    expect(ratio).toBeGreaterThan(0);
  });

  it('handles NaN magnitude by returning input unchanged', () => {
    // Construct a vector whose square-sum overflows to Infinity.
    const big = Number.MAX_VALUE;
    const vec = [big, big];
    const out = l2Normalize(vec);
    // Infinity magnitude → out === input copy.
    expect(out).toEqual(vec);
  });
});

// ─── createLocalEmbeddingProvider — identity + shape ─────────

describe('createLocalEmbeddingProvider', () => {
  const makeStubPipeline =
    (payload: Float32Array | number[]): PipelineFactory =>
    async () => {
      const fn: TransformersPipelineFn = async (_text, _options) => ({
        data: payload,
      });
      return fn;
    };

  it('reports dimensions = 384 by default', () => {
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: makeStubPipeline(new Float32Array(384)),
      warmup: false,
    });
    expect(provider.dimensions).toBe(DEFAULT_MODEL_DIMENSIONS);
    expect(provider.dimensions).toBe(384);
  });

  it('reports provider id derived from model shortname', () => {
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: makeStubPipeline(new Float32Array(384)),
      warmup: false,
    });
    expect(provider.id).toBe('local:bge-small-en-v1.5');
  });

  it('id reflects overridden model', () => {
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      modelId: 'Xenova/gte-small',
      dimensions: 384,
      pipelineFactory: makeStubPipeline(new Float32Array(384)),
      warmup: false,
    });
    expect(provider.id).toBe('local:gte-small');
  });

  it('default model id + revision are locked defaults', () => {
    expect(DEFAULT_MODEL_ID).toBe('Xenova/bge-small-en-v1.5');
    expect(DEFAULT_MODEL_REVISION).toBe('main');
    expect(DEFAULT_MODEL_DIMENSIONS).toBe(384);
  });

  it('embed() returns an L2-normalized 384-d vector', async () => {
    // Stub pipeline returns a non-normalized vector.
    const raw = new Float32Array(384);
    for (let i = 0; i < 384; i++) raw[i] = (i + 1) * 0.01;
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: makeStubPipeline(raw),
      warmup: false,
    });
    const vec = await provider.embed('hello world');
    expect(vec).toHaveLength(384);
    const magnitude = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 6);
  });

  it('embed() preserves direction — normalized vector is proportional to raw', async () => {
    const raw = [1, 2, 3];
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      dimensions: 3,
      pipelineFactory: makeStubPipeline(raw),
      warmup: false,
    });
    const vec = await provider.embed('text');
    const ratios = vec.map((v, i) => v / raw[i]!);
    expect(ratios[0]).toBeCloseTo(ratios[1]!, 10);
    expect(ratios[1]).toBeCloseTo(ratios[2]!, 10);
  });

  it('embed() throws when the pipeline returns wrong-size vector', async () => {
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: makeStubPipeline(new Float32Array(128)), // wrong size
      warmup: false,
    });
    await expect(provider.embed('x')).rejects.toThrow(/128d vector.*384d/);
  });

  it('embed() throws TypeError for non-string input', async () => {
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: makeStubPipeline(new Float32Array(384)),
      warmup: false,
    });
    // @ts-expect-error — proving the runtime guard
    await expect(provider.embed(42)).rejects.toThrow(/expected string/);
  });

  it('passes {pooling:"mean", normalize:false} to the pipeline', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const pipelineFactory: PipelineFactory = async () => {
      const fn: TransformersPipelineFn = async (_text, options) => {
        capturedOptions = options as Record<string, unknown>;
        return { data: new Float32Array(384) };
      };
      return fn;
    };
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory,
      warmup: false,
    });
    await provider.embed('x');
    expect(capturedOptions?.['pooling']).toBe('mean');
    expect(capturedOptions?.['normalize']).toBe(false);
  });

  it('forwards cacheDir + modelId + revision to the pipeline factory', async () => {
    let capturedArgs: Parameters<PipelineFactory>[0] | undefined;
    const pipelineFactory: PipelineFactory = async (args) => {
      capturedArgs = args;
      const fn: TransformersPipelineFn = async () => ({
        data: new Float32Array(384),
      });
      return fn;
    };
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/var/ggui/models',
      modelId: 'test/model',
      revision: 'abc123',
      pipelineFactory,
      warmup: false,
    });
    await provider.embed('x');
    expect(capturedArgs?.cacheDir).toBe('/var/ggui/models');
    expect(capturedArgs?.modelId).toBe('test/model');
    expect(capturedArgs?.revision).toBe('abc123');
  });

  it('loads the pipeline only once across multiple embed calls', async () => {
    const factory = vi.fn<PipelineFactory>(async () => {
      const fn: TransformersPipelineFn = async () => ({
        data: new Float32Array(384),
      });
      return fn;
    });
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: factory,
      warmup: false,
    });
    await provider.embed('one');
    await provider.embed('two');
    await provider.embed('three');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('warmup:true triggers the pipeline factory at construction time', async () => {
    const factory = vi.fn<PipelineFactory>(async () => {
      const fn: TransformersPipelineFn = async () => ({
        data: new Float32Array(384),
      });
      return fn;
    });
    createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: factory,
      warmup: true,
    });
    // Yield a microtask for the fire-and-forget warmup.
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('warmup:false does NOT trigger the pipeline factory until embed()', async () => {
    const factory = vi.fn<PipelineFactory>(async () => {
      const fn: TransformersPipelineFn = async () => ({
        data: new Float32Array(384),
      });
      return fn;
    });
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: factory,
      warmup: false,
    });
    // Yield to be fair.
    await Promise.resolve();
    await Promise.resolve();
    expect(factory).not.toHaveBeenCalled();
    await provider.embed('x');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('recovers after a factory failure — next embed() retries', async () => {
    let call = 0;
    const factory: PipelineFactory = async () => {
      call += 1;
      if (call === 1) throw new Error('first attempt fails');
      const fn: TransformersPipelineFn = async () => ({
        data: new Float32Array(384),
      });
      return fn;
    };
    const provider = createLocalEmbeddingProvider({
      cacheDir: '/tmp/embed-test',
      pipelineFactory: factory,
      warmup: false,
    });
    await expect(provider.embed('x')).rejects.toThrow(/first attempt fails/);
    // Second attempt should succeed using the retry.
    const vec = await provider.embed('y');
    expect(vec).toHaveLength(384);
    expect(call).toBe(2);
  });
});

// ─── Missing peer dep remediation ─────────────────────────────

describe('createLocalEmbeddingProvider — missing peer dep', () => {
  // Behavior under test only manifests when @huggingface/transformers is
  // not resolvable. In workspaces where another package pulls it in
  // (e.g. @ggui-ai/ui-gen), the default factory loads successfully and
  // this assertion can't be exercised. Skip rather than fail.
  let transformersInstalled = false;
  try {
    createRequire(import.meta.url).resolve('@huggingface/transformers');
    transformersInstalled = true;
  } catch {
    transformersInstalled = false;
  }

  (transformersInstalled ? it.skip : it)(
    'rewrites @huggingface/transformers ERR_MODULE_NOT_FOUND into remediation message',
    async () => {
      const provider = createLocalEmbeddingProvider({
        cacheDir: '/tmp/embed-test',
        warmup: false,
      });
      await expect(provider.embed('x')).rejects.toThrow(
        /@huggingface\/transformers/,
      );
      await expect(provider.embed('x')).rejects.toThrow(/pnpm add/);
    },
  );
});
