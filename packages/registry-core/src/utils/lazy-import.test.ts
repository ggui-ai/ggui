import { describe, expect, it, vi } from 'vitest';
import { memoizedRetryingImport } from './lazy-import.js';

describe('memoizedRetryingImport', () => {
  it('caches a successful load — the loader is called exactly once across repeated calls', async () => {
    const loader = vi.fn(async () => 'ok');
    const load = memoizedRetryingImport(loader);

    await expect(load()).resolves.toBe('ok');
    await expect(load()).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent in-flight callers to a single loader call', async () => {
    let resolve!: (value: string) => void;
    const loader = vi.fn(
      () =>
        new Promise<string>((res) => {
          resolve = res;
        }),
    );
    const load = memoizedRetryingImport(loader);

    const first = load();
    const second = load();
    resolve('ok');

    await expect(first).resolves.toBe('ok');
    await expect(second).resolves.toBe('ok');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('clears the cache on rejection — a later call retries fresh instead of re-throwing the stale failure', async () => {
    const loader = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered');
    const load = memoizedRetryingImport(loader);

    await expect(load()).rejects.toThrow('boom');
    await expect(load()).resolves.toBe('recovered');
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('does not re-call the loader for concurrent callers sharing the same in-flight rejection', async () => {
    let reject!: (err: Error) => void;
    const loader = vi.fn(
      () =>
        new Promise<string>((_res, rej) => {
          reject = rej;
        }),
    );
    const load = memoizedRetryingImport(loader);

    const first = load();
    const second = load();
    reject(new Error('boom'));

    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
