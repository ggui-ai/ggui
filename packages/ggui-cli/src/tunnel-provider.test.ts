/**
 * TunnelProvider seam tests. Exercises the interface contract (the
 * null provider round-trips through `open(ctx)`) + the discriminated
 * result shapes (`ready` vs. `unavailable`). No live network calls —
 * the seam is deliberately transport-agnostic.
 */
import { describe, expect, it } from 'vitest';
import {
  createNullTunnelProvider,
  discoverTunnelProvider,
  type TunnelContext,
  type TunnelProvider,
  type TunnelSession,
  type TunnelSessionReady,
  type TunnelSessionUnavailable,
} from './tunnel-provider.js';

function makeCtx(overrides: Partial<TunnelContext> = {}): TunnelContext {
  const controller = new AbortController();
  return {
    localUrl: 'http://127.0.0.1:6780',
    authToken: 'test-token',
    project: { slug: 'demo', name: 'Demo' },
    runtimePort: null,
    signal: controller.signal,
    ...overrides,
  };
}

describe('createNullTunnelProvider', () => {
  it('advertises itself as `null`', () => {
    const provider = createNullTunnelProvider();
    expect(provider.name).toBe('null');
  });

  it('returns an `unavailable` session with the default reason', async () => {
    const provider = createNullTunnelProvider();
    const session = await provider.open(makeCtx());
    expect(session.status).toBe('unavailable');
    if (session.status === 'unavailable') {
      expect(session.reason).toBe('no tunnel provider configured');
      // No hint by default — kept undefined so the banner can skip
      // rendering a second line when there's nothing to add.
      expect(session.hint).toBeUndefined();
    }
  });

  it('propagates a caller-supplied reason + hint for tests / hosts', async () => {
    // The literal hint string is arbitrary fixture data — this test
    // exercises the SHAPE of the round-trip (caller-supplied reason +
    // hint surface unchanged on the session). Use a brand-neutral
    // placeholder so the fixture doesn't pin a specific CLI command.
    const provider = createNullTunnelProvider({
      reason: 'login expired',
      hint: 'run `<your-cli> login`',
    });
    const session = await provider.open(makeCtx());
    expect(session.status).toBe('unavailable');
    if (session.status === 'unavailable') {
      expect(session.reason).toBe('login expired');
      expect(session.hint).toBe('run `<your-cli> login`');
    }
  });

  it('does not throw when configuration is missing — returns `unavailable`', async () => {
    // The entire point of the seam: failure modes are data, not
    // exceptions. Any provider that throws here would break the
    // CLI's "keep local dev working" invariant.
    const provider = createNullTunnelProvider();
    await expect(provider.open(makeCtx())).resolves.toHaveProperty(
      'status',
      'unavailable',
    );
  });

  it('accepts a pre-aborted signal without throwing', async () => {
    // The CLI races tunnel bootstrap against Ctrl-C; providers MUST
    // tolerate an already-aborted signal arriving at `open()`.
    const controller = new AbortController();
    controller.abort();
    const provider = createNullTunnelProvider();
    const session = await provider.open(makeCtx({ signal: controller.signal }));
    expect(session.status).toBe('unavailable');
  });

  it('ignores optional context fields by design', async () => {
    // The null provider exists to prove the seam — it must never
    // depend on any specific context field. Passing a `null` token
    // (which happens when the dev server was booted without a
    // security policy) must still resolve cleanly.
    const provider = createNullTunnelProvider();
    const session = await provider.open(makeCtx({ authToken: null }));
    expect(session.status).toBe('unavailable');
  });
});

describe('TunnelSession discriminated result', () => {
  it('distinguishes `ready` and `unavailable` on `status`', () => {
    // Compile-time shape check disguised as a runtime test — the
    // discriminator MUST be `status` so `if (session.status ===
    // 'ready')` narrows to `TunnelSessionReady` in every consumer.
    const ready: TunnelSessionReady = {
      status: 'ready',
      remoteUrl: 'https://abc.tunnel.example/',
      async close() {
        /* noop */
      },
    };
    const unavailable: TunnelSessionUnavailable = {
      status: 'unavailable',
      reason: 'not configured',
    };
    const sessions: TunnelSession[] = [ready, unavailable];
    expect(sessions[0].status).toBe('ready');
    expect(sessions[1].status).toBe('unavailable');
  });

  it('ready session close() is awaitable', async () => {
    let closed = 0;
    const ready: TunnelSessionReady = {
      status: 'ready',
      remoteUrl: 'https://x.example/',
      async close() {
        closed += 1;
      },
    };
    await ready.close();
    // Contract: close() is idempotent — calling twice must not
    // throw. Providers that own a transport-level handle are
    // expected to guard with a "closed" flag; the null provider
    // has nothing to close, so double-call is a no-op.
    await ready.close();
    expect(closed).toBe(2);
  });
});

describe('discoverTunnelProvider', () => {
  function fakeProvider(): TunnelProvider {
    return {
      name: 'fake',
      async open() {
        return { status: 'unavailable', reason: 'fake' };
      },
    };
  }

  it('returns `none` when no module specifier is configured', async () => {
    const result = await discoverTunnelProvider({ moduleSpecifier: null });
    expect(result.kind).toBe('none');
  });

  it('returns `none` when the specifier is an empty string', async () => {
    const result = await discoverTunnelProvider({ moduleSpecifier: '' });
    expect(result.kind).toBe('none');
  });

  it('returns `found` when a module exports createTunnelProvider()', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:ok',
      resolve: async () => ({ createTunnelProvider: () => fakeProvider() }),
    });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') {
      expect(result.provider.name).toBe('fake');
      expect(result.moduleSpecifier).toBe('virtual:ok');
    }
  });

  it('awaits async factories', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:async',
      resolve: async () => ({
        createTunnelProvider: async () => fakeProvider(),
      }),
    });
    expect(result.kind).toBe('found');
  });

  it('accepts a default export that is a factory function', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:default-fn',
      resolve: async () => ({ default: () => fakeProvider() }),
    });
    expect(result.kind).toBe('found');
  });

  it('accepts a default export that is a pre-built provider object', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:default-obj',
      resolve: async () => ({ default: fakeProvider() }),
    });
    expect(result.kind).toBe('found');
  });

  it('surfaces import failures as `error` with a reason', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: '@nonexistent-org/does-not-exist',
      resolve: async () => {
        throw new Error('Cannot find module');
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.moduleSpecifier).toBe('@nonexistent-org/does-not-exist');
      expect(result.reason).toContain('failed to import');
      expect(result.reason).toContain('Cannot find module');
    }
  });

  it('surfaces factory throws as `error`', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:factory-throws',
      resolve: async () => ({
        createTunnelProvider: () => {
          throw new Error('boom');
        },
      }),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('threw');
      expect(result.reason).toContain('boom');
    }
  });

  it('rejects modules that export no factory', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:no-exports',
      resolve: async () => ({ something: 'else' }),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('neither');
    }
  });

  it('rejects modules that return a non-provider shape', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:bad-shape',
      resolve: async () => ({
        createTunnelProvider: () => ({ name: 'x' }) as unknown as TunnelProvider,
      }),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('not a TunnelProvider');
    }
  });

  it('rejects non-object imports', async () => {
    const result = await discoverTunnelProvider({
      moduleSpecifier: 'virtual:string',
      resolve: async () => 'a string' as unknown,
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.reason).toContain('did not export an object');
    }
  });
});
