/**
 * ggui#843 — the runtime is the ONE writer of the document's connection
 * state, and it proves it by claiming the writer eagerly at boot. Doors
 * watched here: (5) after boot nobody else can claim, and a second boot of
 * the same runtime does not throw; (9) a write through the runtime's writer
 * (claimed via `@ggui-ai/wire/internal`) is seen through the ROOT barrel's
 * read view — a real edge across the two dist entries, so a build that
 * inlined the store twice fails here; (5b) a boot that finds the writer
 * held by another party REFUSES, naming the owner, and neither transitions
 * nor notifies; (dup) a second copy of the runtime's module in the same
 * document claims the SAME store and fails naming itself — the error is
 * the duplicate-bundle detector, made real by the document-scoped store;
 * (7) the namespace installed as `__ggui__.wire` carries the read view and
 * never the writer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as wire from '@ggui-ai/wire';
import { connectionSource } from '@ggui-ai/wire';
import {
  ConnectionWriterConflictError,
  claimConnectionWriter,
  isConnectionWriterConflictError,
} from '@ggui-ai/wire/internal';
import { installGlobalRegistry } from '../globals.js';
import {
  __resetRuntimeConnectionWriterForTest,
  runtimeConnectionWriter,
} from '../connection.js';
import { resetRelayLatchForBoot, __resetRelayNoticeForTest } from '../runtime.js';

describe('the runtime claims the connection writer at boot (ggui#843)', () => {
  beforeEach(() => {
    __resetRelayNoticeForTest();
  });

  it('(5) after boot, a second claimant is refused naming the owner — and a second boot in the same document does not throw', () => {
    resetRelayLatchForBoot();
    let thrown: unknown;
    try {
      claimConnectionWriter('connection-claim.test');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectionWriterConflictError);
    if (thrown instanceof ConnectionWriterConflictError) {
      expect(thrown.owner).toBe('iframe-runtime');
      expect(thrown.attemptedBy).toBe('connection-claim.test');
    }
    expect(() => resetRelayLatchForBoot()).not.toThrow();
  });

  it('(9) identity across the two dist entries: a write through the internal writer is seen by a subscriber on the root barrel\'s read view', () => {
    const seen: boolean[] = [];
    const off = connectionSource.subscribe(() => seen.push(connectionSource.getSnapshot()));
    try {
      expect(connectionSource.getSnapshot()).toBe(true);
      runtimeConnectionWriter().set(false);
      expect(connectionSource.getSnapshot()).toBe(false);
      expect(seen).toEqual([false]);
      __resetRelayNoticeForTest();
      expect(connectionSource.getSnapshot()).toBe(true);
      expect(seen).toEqual([false, true]);
    } finally {
      off();
    }
  });
});

describe('(5b) a boot that finds the writer held refuses, naming the owner (ggui#843)', () => {
  afterEach(() => {
    vi.resetModules();
    __resetRelayNoticeForTest();
  });

  it('resetRelayLatchForBoot throws ConnectionWriterConflictError naming the holder; no transition, no notification', async () => {
    // Hand the document's writer to another party first: the runtime's
    // memoized claim is released, then a fresh module graph boots.
    __resetRuntimeConnectionWriterForTest();
    vi.resetModules();
    const wireInternal = await import('@ggui-ai/wire/internal');
    const freshWire = await import('@ggui-ai/wire');
    const held = wireInternal.claimConnectionWriter('another-runtime');
    held.set(false);
    const listener = vi.fn();
    const off = freshWire.connectionSource.subscribe(listener);
    try {
      const runtime = await import('../runtime.js');
      let thrown: unknown;
      try {
        runtime.resetRelayLatchForBoot();
      } catch (err) {
        thrown = err;
      }
      // The store's `claim` belongs to the copy that created it, so the
      // class object differs across copies — detection is by name.
      expect(isConnectionWriterConflictError(thrown)).toBe(true);
      if (isConnectionWriterConflictError(thrown)) {
        expect(thrown.owner).toBe('another-runtime');
        expect(thrown.attemptedBy).toBe('iframe-runtime');
      }
      expect(listener).not.toHaveBeenCalled();
      expect(freshWire.connectionSource.getSnapshot()).toBe(false);
    } finally {
      off();
      held.set(true);
      held.release();
    }
  });
});

describe('(dup) two copies of the runtime in one document (ggui#843)', () => {
  afterEach(() => {
    vi.resetModules();
    __resetRelayNoticeForTest();
  });

  it('the second copy claims the SAME document store and fails naming itself — the error is the detector for a duplicate bundle', async () => {
    resetRelayLatchForBoot(); // the first copy holds the claim
    vi.resetModules();
    const secondCopy = await import('@ggui-ai/wire/internal');
    let thrown: unknown;
    try {
      secondCopy.claimConnectionWriter('iframe-runtime');
    } catch (err) {
      thrown = err;
    }
    expect(secondCopy.isConnectionWriterConflictError(thrown)).toBe(true);
    if (secondCopy.isConnectionWriterConflictError(thrown)) {
      expect(thrown.owner).toBe('iframe-runtime');
      expect(thrown.attemptedBy).toBe('iframe-runtime');
      expect(thrown.message).toMatch(/two copies of 'iframe-runtime' in one document/);
      expect(thrown.message).toMatch(/duplicate bundle/);
    }
  });
});

describe('(7) the installed `__ggui__.wire` namespace carries the read view and never the writer (ggui#843)', () => {
  it('installs the same @ggui-ai/wire namespace the runtime passes; connectionSource is on it, claimConnectionWriter is not', () => {
    const empty: Record<string, never> = {};
    const registry = installGlobalRegistry({
      react: empty,
      reactDom: empty,
      primitives: empty,
      components: empty,
      compositions: empty,
      interact: empty,
      tokens: empty,
      wire,
    });
    const installed = globalThis.__ggui__?.wire;
    expect(installed).toBe(registry.wire);
    expect(installed).toBe(wire);
    const keys = Object.keys(installed ?? {});
    expect(keys).toContain('connectionSource');
    expect(keys).toContain('useRender');
    expect(keys).not.toContain('claimConnectionWriter');
    expect(keys).not.toContain('createConnectionStore');
    expect(keys).not.toContain('connectionStore');
  });
});
