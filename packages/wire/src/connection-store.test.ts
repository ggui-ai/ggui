/**
 * ggui#843 — the connection store splits into a READ view every reader may
 * hold and a CLAIMED writer exactly one party holds. The read view is the
 * only connection surface generated component code can reach (the root
 * barrel, and through it `globalThis.__ggui__.wire`); the writer lives on
 * `@ggui-ai/wire/internal` and is claimed once, eagerly at boot, by a
 * deployment's runtime. A second claim is a typed, named failure — and when
 * the claimant names itself, the failure IS the detector for two copies of
 * the runtime in one document.
 */
import { describe, expect, it, vi } from 'vitest';
import * as barrel from './index';
import {
  ConnectionWriterConflictError,
  ConnectionWriterReleasedError,
  claimConnectionWriter,
  connectionSource,
  createConnectionStore,
} from './connection-store';

describe('createConnectionStore — one read view, one claimable writer (ggui#843)', () => {
  it('defaults to connected — absent transition means today\'s behavior', () => {
    const { source } = createConnectionStore();
    expect(source.getSnapshot()).toBe(true);
  });

  it('set(false) through the claimed writer notifies subscribers and flips the snapshot', () => {
    const { source, claim } = createConnectionStore();
    const listener = vi.fn();
    source.subscribe(listener);
    claim('runtime').set(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toBe(false);
  });

  it('setting the same value does NOT notify — one transition per edge, structurally', () => {
    const { source, claim } = createConnectionStore();
    const writer = claim('runtime');
    const listener = vi.fn();
    source.subscribe(listener);
    writer.set(true);
    writer.set(true);
    expect(listener).not.toHaveBeenCalled();
    writer.set(false);
    writer.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe stops notifications', () => {
    const { source, claim } = createConnectionStore();
    const listener = vi.fn();
    const off = source.subscribe(listener);
    off();
    claim('runtime').set(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('getSnapshot is synchronous and stable-by-value — a late reader lands on the current state with no first-frame flash', () => {
    const { source, claim } = createConnectionStore();
    const writer = claim('runtime');
    writer.set(false);
    expect(source.getSnapshot()).toBe(false);
    const seen: boolean[] = [];
    source.subscribe(() => seen.push(source.getSnapshot()));
    writer.set(true);
    expect(seen).toEqual([true]);
  });

  it('the read view carries no writer', () => {
    const { source } = createConnectionStore();
    expect('set' in source).toBe(false);
    expect(Object.keys(source).sort()).toEqual(['getSnapshot', 'subscribe']);
  });
});

describe('the writer is claimed by exactly one party (ggui#843)', () => {
  it('a second claim throws ConnectionWriterConflictError naming owner and attemptedBy; the source is untouched', () => {
    const { source, claim } = createConnectionStore();
    const listener = vi.fn();
    source.subscribe(listener);
    claim('a');
    let thrown: unknown;
    try {
      claim('b');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectionWriterConflictError);
    if (!(thrown instanceof ConnectionWriterConflictError)) return;
    expect(thrown.owner).toBe('a');
    expect(thrown.attemptedBy).toBe('b');
    expect(thrown.name).toBe('ConnectionWriterConflictError');
    expect(thrown.message).toContain("'a'");
    expect(thrown.message).toContain("'b'");
    expect(source.getSnapshot()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('when owner === attemptedBy the message says what that is: two copies of the runtime in one document', () => {
    const { claim } = createConnectionStore();
    claim('iframe-runtime');
    expect(() => claim('iframe-runtime')).toThrow(/two copies of 'iframe-runtime' in one document/);
    expect(() => claim('iframe-runtime')).toThrow(/duplicate bundle/);
  });

  it('release() frees the claim — a new claim succeeds; set() through the released writer throws ConnectionWriterReleasedError and notifies nobody', () => {
    const { source, claim } = createConnectionStore();
    const listener = vi.fn();
    source.subscribe(listener);
    const first = claim('a');
    first.release();
    const second = claim('b');
    expect(() => first.set(false)).toThrow(ConnectionWriterReleasedError);
    expect(() => first.set(false)).toThrow(/'a'/);
    expect(listener).not.toHaveBeenCalled();
    expect(source.getSnapshot()).toBe(true);
    second.set(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(source.getSnapshot()).toBe(false);
  });

  it('release() is idempotent and a released writer\'s error names the claimant', () => {
    const { claim } = createConnectionStore();
    const writer = claim('a');
    writer.release();
    writer.release();
    let thrown: unknown;
    try {
      writer.set(true);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectionWriterReleasedError);
    if (thrown instanceof ConnectionWriterReleasedError) expect(thrown.claimant).toBe('a');
  });
});

describe('the document store — root barrel vs internal (ggui#843)', () => {
  it('the root barrel exports the read view and NOTHING of the writer — no connectionStore, no ConnectionStore, no claim', () => {
    const keys = Object.keys(barrel);
    expect(keys).toContain('connectionSource');
    expect(keys).not.toContain('connectionStore');
    expect(keys).not.toContain('claimConnectionWriter');
    expect(keys).not.toContain('createConnectionStore');
    expect('set' in connectionSource).toBe(false);
  });

  it('claimConnectionWriter writes the same store connectionSource reads', () => {
    const writer = claimConnectionWriter('connection-store.test');
    try {
      const listener = vi.fn();
      const off = connectionSource.subscribe(listener);
      writer.set(false);
      expect(connectionSource.getSnapshot()).toBe(false);
      expect(listener).toHaveBeenCalledTimes(1);
      writer.set(true);
      off();
    } finally {
      writer.release();
    }
  });
});

describe('one store per document, whatever the module copy (ggui#843)', () => {
  it('a second evaluation of the module finds the SAME store — a second claim under the same name is the duplicate-bundle conflict, and a write through one copy is seen through the other', async () => {
    const first = await import('./connection-store');
    vi.resetModules();
    const second = await import('./connection-store');
    expect(second).not.toBe(first);
    const writer = first.claimConnectionWriter('iframe-runtime');
    try {
      expect(() => second.claimConnectionWriter('iframe-runtime')).toThrow(/two copies of 'iframe-runtime' in one document/);
      const seen: boolean[] = [];
      const off = second.connectionSource.subscribe(() => seen.push(second.connectionSource.getSnapshot()));
      writer.set(false);
      expect(second.connectionSource.getSnapshot()).toBe(false);
      expect(seen).toEqual([false]);
      writer.set(true);
      off();
    } finally {
      writer.set(true);
      writer.release();
    }
  });
});

describe('the document slot is a cross-copy contract (ggui#843)', () => {
  const KEY = Symbol.for('ai.ggui.wire/connection-store');

  it('a foreign object already at the key — not a connection store — is REFUSED with a typed error naming the key; never adopted, never overwritten', async () => {
    const original = Reflect.get(globalThis, KEY);
    const foreign = { not: 'a store' };
    Reflect.set(globalThis, KEY, foreign);
    try {
      vi.resetModules();
      let thrown: unknown;
      try {
        await import('./connection-store');
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      if (thrown instanceof Error) {
        expect(thrown.name).toBe('ConnectionStoreSlotError');
        expect(thrown.message).toContain('ai.ggui.wire/connection-store');
      }
      expect(Reflect.get(globalThis, KEY)).toBe(foreign);
    } finally {
      Reflect.set(globalThis, KEY, original);
      vi.resetModules();
    }
  });
});
