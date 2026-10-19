/**
 * `drainWithin` — `ggui serve`'s close waits for the install walks still in flight
 * (ggui#1907), and never longer than the bound.
 */
import { describe, expect, it } from 'vitest';
import { drainWithin } from './mcp-backend.js';

describe('drainWithin (ggui#1907)', () => {
  it('resolves only once the drain does, when the drain settles inside the bound', async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => (release = resolve));
    let done = false;
    const closing = drainWithin({ drain: () => drained }, 60_000).then(() => (done = true));
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    release();
    await closing;
    expect(done).toBe(true);
  });

  it('resolves at the bound when the drain never settles', async () => {
    const started = Date.now();
    await drainWithin({ drain: () => new Promise<void>(() => undefined) }, 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  it('no provider (no installed blueprints) resolves at once', async () => {
    await expect(drainWithin(undefined, 60_000)).resolves.toBeUndefined();
  });
});
