import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEmbeddingBootstrap,
  createNoopDownloader,
  createInMemoryDownloader,
  probeCache,
  DEFAULT_MODEL_DIMENSIONS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REVISION,
  type BootstrapEvent,
} from './index.js';

let tmpRoot: string;
let cachePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-embedding-bootstrap-'));
  cachePath = join(tmpRoot, 'models');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('probeCache', () => {
  it('returns null when the directory does not exist', () => {
    expect(probeCache(cachePath)).toBeNull();
  });

  it('returns null when the directory exists but contains no files', () => {
    mkdirSync(cachePath, { recursive: true });
    expect(probeCache(cachePath)).toBeNull();
  });

  it('returns aggregated sizeBytes when files are present', () => {
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'a.bin'), Buffer.alloc(100));
    writeFileSync(join(cachePath, 'b.bin'), Buffer.alloc(50));
    const result = probeCache(cachePath);
    expect(result).toEqual({ sizeBytes: 150 });
  });

  it('ignores subdirectories at the root level (V1 heuristic)', () => {
    mkdirSync(join(cachePath, 'sub'), { recursive: true });
    expect(probeCache(cachePath)).toBeNull();
  });
});

describe('createEmbeddingBootstrap — defaults', () => {
  it('reports cold state when the cache directory does not exist', () => {
    const harness = createEmbeddingBootstrap({ cachePath });
    const state = harness.state();
    expect(state.kind).toBe('cold');
    expect(state.cachePath).toBe(cachePath);
  });

  it('uses the locked default model id, revision, and dimensions', async () => {
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({ sizeBytes: 64, progressSteps: 1 }),
    });
    await harness.warmup();
    const state = harness.state();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.modelId).toBe(DEFAULT_MODEL_ID);
    expect(state.revision).toBe(DEFAULT_MODEL_REVISION);
    expect(state.dimensions).toBe(DEFAULT_MODEL_DIMENSIONS);
    expect(DEFAULT_MODEL_ID).toBe('Xenova/bge-small-en-v1.5');
    expect(DEFAULT_MODEL_DIMENSIONS).toBe(384);
  });
});

describe('createEmbeddingBootstrap — cold-path warmup event sequence', () => {
  it('emits the locked event order: started → downloading → progress* → ready', async () => {
    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({
        sizeBytes: 1000,
        progressSteps: 4,
      }),
    });
    await harness.warmup({ onEvent: (e) => events.push(e) });

    const types = events.map((e) => e.type);
    // First: started.
    expect(types[0]).toBe('started');
    // Second: downloading (cache was cold).
    expect(types[1]).toBe('downloading');
    // Then >=1 progress events.
    expect(types.filter((t) => t === 'progress').length).toBeGreaterThan(0);
    // Last: ready.
    expect(types[types.length - 1]!).toBe('ready');
    // No 'cached' on cold path.
    expect(types).not.toContain('cached');
    // No 'error' on happy path.
    expect(types).not.toContain('error');
  });

  it('progress events are monotonically non-decreasing', async () => {
    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({
        sizeBytes: 800,
        progressSteps: 8,
      }),
    });
    await harness.warmup({ onEvent: (e) => events.push(e) });

    const progressEvents = events.filter(
      (e): e is Extract<BootstrapEvent, { type: 'progress' }> =>
        e.type === 'progress',
    );
    expect(progressEvents.length).toBeGreaterThan(0);
    let last = -1;
    for (const e of progressEvents) {
      expect(e.bytesReceived).toBeGreaterThanOrEqual(last);
      last = e.bytesReceived;
    }
  });

  it('reports totalBytes:null on the downloading event when downloader does not report a total', async () => {
    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({
        sizeBytes: 200,
        progressSteps: 2,
        reportTotal: false,
      }),
    });
    await harness.warmup({ onEvent: (e) => events.push(e) });

    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBeGreaterThan(0);
    for (const e of progressEvents) {
      if (e.type !== 'progress') continue;
      expect(e.totalBytes).toBeNull();
    }
  });

  it('transitions to ready state with sizeBytes from the downloader', async () => {
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({ sizeBytes: 4096, progressSteps: 1 }),
    });
    await harness.warmup();
    const state = harness.state();
    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.sizeBytes).toBe(4096);
  });
});

describe('createEmbeddingBootstrap — cached short-circuit', () => {
  it('emits started → cached when the cache is already warm', async () => {
    // Pre-warm the cache.
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'preexisting.bin'), Buffer.alloc(2048));

    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({ cachePath });
    await harness.warmup({ onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual(['started', 'cached']);
    const cached = events[1];
    if (cached?.type !== 'cached') throw new Error('expected cached event');
    expect(cached.sizeBytes).toBe(2048);
  });

  it('cached state reflects existing files on disk before warmup', () => {
    mkdirSync(cachePath, { recursive: true });
    writeFileSync(join(cachePath, 'm.bin'), Buffer.alloc(512));
    const harness = createEmbeddingBootstrap({ cachePath });
    const state = harness.state();
    expect(state.kind).toBe('cached');
    if (state.kind !== 'cached') return;
    expect(state.sizeBytes).toBe(512);
  });

  it('idempotent: a second warmup after success is a no-op', async () => {
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({ sizeBytes: 64, progressSteps: 1 }),
    });
    await harness.warmup();
    const events: BootstrapEvent[] = [];
    await harness.warmup({ onEvent: (e) => events.push(e) });
    expect(events).toEqual([]);
  });
});

describe('createEmbeddingBootstrap — failure paths', () => {
  it('emits error event + transitions to error state when downloader throws', async () => {
    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({
        sizeBytes: 1000,
        progressSteps: 4,
        failAt: 250,
        failKind: 'download-failed',
        failMessage: 'simulated network drop',
      }),
    });
    await harness.warmup({ onEvent: (e) => events.push(e) });

    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== 'error') return;
    expect(errorEvent.error.kind).toBe('download-failed');
    expect(errorEvent.error.modelId).toBe(DEFAULT_MODEL_ID);
    expect(errorEvent.error.message).toBe('simulated network drop');

    const state = harness.state();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.kind).toBe('download-failed');
  });

  it('classifies an arbitrary Error from the downloader as kind:"unknown"', async () => {
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: {
        async download() {
          throw new Error('opaque crash');
        },
      },
    });
    const events: BootstrapEvent[] = [];
    await harness.warmup({ onEvent: (e) => events.push(e) });
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type !== 'error') return;
    expect(errorEvent.error.kind).toBe('unknown');
    expect(errorEvent.error.message).toBe('opaque crash');
  });

  it('createNoopDownloader is the default and surfaces a helpful error', async () => {
    const noop = createNoopDownloader();
    await expect(
      noop.download({
        modelId: DEFAULT_MODEL_ID,
        revision: 'main',
        cachePath,
      }),
    ).rejects.toMatchObject({
      kind: 'download-failed',
      modelId: DEFAULT_MODEL_ID,
    });
  });
});

describe('createEmbeddingBootstrap — abort', () => {
  it('aborts before start: emits started → error{kind:"aborted"}', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({ sizeBytes: 1000, progressSteps: 8 }),
    });
    await harness.warmup({
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    expect(events.map((e) => e.type)).toEqual(['started', 'error']);
    const errEvt = events[1];
    if (errEvt?.type !== 'error') throw new Error('expected error event');
    expect(errEvt.error.kind).toBe('aborted');
  });

  it('aborts mid-download: error{kind:"aborted"} is recorded', async () => {
    const controller = new AbortController();
    const events: BootstrapEvent[] = [];
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({
        sizeBytes: 10_000,
        progressSteps: 100,
      }),
    });
    const promise = harness.warmup({
      signal: controller.signal,
      onEvent: (e) => events.push(e),
    });
    // Abort after the first microtask so the downloader has started
    // emitting progress.
    await Promise.resolve();
    controller.abort();
    await promise;

    const state = harness.state();
    expect(state.kind).toBe('error');
    if (state.kind !== 'error') return;
    expect(state.error.kind).toBe('aborted');
  });
});

describe('createEmbeddingBootstrap — onEvent sink resilience', () => {
  it('catches throws from onEvent — lifecycle still completes', async () => {
    const harness = createEmbeddingBootstrap({
      cachePath,
      downloader: createInMemoryDownloader({ sizeBytes: 64, progressSteps: 1 }),
    });
    await harness.warmup({
      onEvent: () => {
        throw new Error('consumer crashed');
      },
    });
    expect(harness.state().kind).toBe('ready');
  });
});
