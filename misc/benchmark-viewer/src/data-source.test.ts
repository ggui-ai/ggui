import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { httpJsonSource } from './data-source';

describe('httpJsonSource', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('throws when baseUrl lacks trailing slash', () => {
    expect(() => httpJsonSource('https://example.com/data')).toThrow(
      /must end with a slash/,
    );
  });

  it('accepts baseUrl with trailing slash', () => {
    expect(() => httpJsonSource('https://example.com/data/')).not.toThrow();
    expect(() => httpJsonSource('http://localhost:3000/')).not.toThrow();
  });

  it('getIndex composes URL relative to baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ schemaVersion: 'benchmark-index.v0', generatedAt: 'x', runs: [] }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const src = httpJsonSource('https://bench.example.com/data/');
    await src.getIndex();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bench.example.com/data/index.json',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('getIndex throws on non-OK response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Not Found', { status: 404 })) as unknown as typeof globalThis.fetch;

    const src = httpJsonSource('https://bench.example.com/data/');
    await expect(src.getIndex()).rejects.toThrow(/404/);
  });

  it('getMultiSdkReport composes URL from runMeta.multiSdk.reportPath', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ meta: {}, results: [], variantSummaries: [], commitSummaries: [], sdkComparison: {} }), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const src = httpJsonSource('https://bench.example.com/data/');
    await src.getMultiSdkReport({
      date: '2026-05-06',
      multiSdk: { reportPath: '2026-05-06/multi-sdk.json', successRate: 1, totalRuns: 12 },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://bench.example.com/data/2026-05-06/multi-sdk.json',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('getMultiSdkReport throws when runMeta has no multiSdk', async () => {
    const src = httpJsonSource('https://bench.example.com/data/');
    await expect(
      src.getMultiSdkReport({ date: '2026-05-06' }),
    ).rejects.toThrow(/no multi-sdk report/);
  });

  it('getMultiSdkReport throws on non-OK response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Server Error', { status: 500 })) as unknown as typeof globalThis.fetch;

    const src = httpJsonSource('https://bench.example.com/data/');
    await expect(
      src.getMultiSdkReport({
        date: '2026-05-06',
        multiSdk: { reportPath: '2026-05-06/multi-sdk.json', successRate: 1, totalRuns: 12 },
      }),
    ).rejects.toThrow(/500/);
  });
});
