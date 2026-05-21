import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  buildRequestContextMiddleware,
  getRequestContext,
  resolvePublicBaseUrl,
  resolveRuntimeUrl,
  requestContextStore,
} from './request-context.js';

/**
 * Probe the middleware end-to-end by booting a tiny Express server,
 * issuing a real HTTP request, and capturing what the request context
 * looks like inside a downstream handler. End-to-end is the only way
 * to exercise the real `req.socket.remoteAddress` path — Express's
 * test helpers stub it.
 */
async function withProbe(
  args: { headers?: Record<string, string> },
  expect: (
    ctx: ReturnType<typeof getRequestContext>,
    response: { status: number; body: string },
  ) => void | Promise<void>,
) {
  const app = express();
  app.use(buildRequestContextMiddleware());
  let captured: ReturnType<typeof getRequestContext>;
  app.get('/probe', (_req, res) => {
    captured = getRequestContext();
    res.json({
      base: resolvePublicBaseUrl(),
      runtimeRelative: resolveRuntimeUrl({
        runtimeUrl: '/_ggui/iframe-runtime.js',
      }),
      runtimeAbsolute: resolveRuntimeUrl({
        runtimeUrl: 'https://example.test/runtime.js',
      }),
      runtimeWithConfigured: resolveRuntimeUrl({
        configuredPublicBaseUrl: 'https://override.test',
        runtimeUrl: '/_ggui/iframe-runtime.js',
      }),
    });
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const addr = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${addr.port}/probe`;
    const resp = await fetch(url, { headers: args.headers });
    const body = await resp.text();
    await expect(captured!, { status: resp.status, body });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

describe('request-context middleware', () => {
  it('captures peer-is-local for a direct loopback request', async () => {
    await withProbe({}, (ctx) => {
      expect(ctx).toBeDefined();
      expect(ctx!.peerIsLocal).toBe(true);
      expect(ctx!.forwardedHostHonored).toBe(false);
    });
  });

  it('honors X-Forwarded-Host when the peer is loopback', async () => {
    await withProbe(
      {
        headers: {
          'x-forwarded-host': 'tunnel.example.com',
          'x-forwarded-proto': 'https',
        },
      },
      (ctx) => {
        expect(ctx!.peerIsLocal).toBe(true);
        expect(ctx!.forwardedHostHonored).toBe(true);
        expect(ctx!.host).toBe('tunnel.example.com');
        expect(ctx!.proto).toBe('https');
      },
    );
  });

  it('takes the first entry of a comma-separated X-Forwarded-Host chain', async () => {
    // Defense against header chains the operator's reverse proxy may
    // pass through. RFC 7239 lets a chain append; the outermost (left)
    // is the public host.
    await withProbe(
      { headers: { 'x-forwarded-host': 'public.example.com,internal-1' } },
      (ctx) => {
        expect(ctx!.host).toBe('public.example.com');
        expect(ctx!.forwardedHostHonored).toBe(true);
      },
    );
  });

  it('does NOT honor X-Forwarded-Host if missing (direct browser hit)', async () => {
    await withProbe({}, (ctx) => {
      expect(ctx!.forwardedHostHonored).toBe(false);
    });
  });
});

describe('resolvePublicBaseUrl', () => {
  it('returns the explicit configured value verbatim (trailing slash stripped)', async () => {
    await withProbe({}, (_ctx, resp) => {
      const body = JSON.parse(resp.body);
      // The probe's runtimeWithConfigured includes the configured base.
      expect(body.runtimeWithConfigured).toBe(
        'https://override.test/_ggui/iframe-runtime.js',
      );
    });
  });

  it('returns undefined when peer is local but no X-Forwarded-Host', async () => {
    // Direct browser hit case. Iframe loads from the same origin, so
    // a relative URL still resolves — no need to auto-derive.
    await withProbe({}, (_ctx, resp) => {
      const body = JSON.parse(resp.body);
      expect(body.base).toBeUndefined();
      expect(body.runtimeRelative).toBe('/_ggui/iframe-runtime.js');
    });
  });

  it('returns absolute base from X-Forwarded-Host when peer is local', async () => {
    await withProbe(
      {
        headers: {
          'x-forwarded-host': 'tunnel.example.com',
          'x-forwarded-proto': 'https',
        },
      },
      (_ctx, resp) => {
        const body = JSON.parse(resp.body);
        expect(body.base).toBe('https://tunnel.example.com');
        expect(body.runtimeRelative).toBe(
          'https://tunnel.example.com/_ggui/iframe-runtime.js',
        );
      },
    );
  });

  it('preserves already-absolute runtimeUrl regardless of request context', async () => {
    await withProbe(
      { headers: { 'x-forwarded-host': 'tunnel.example.com' } },
      (_ctx, resp) => {
        const body = JSON.parse(resp.body);
        expect(body.runtimeAbsolute).toBe('https://example.test/runtime.js');
      },
    );
  });

  it('outside request context (no ALS), returns undefined', () => {
    // No store set → resolver bails to undefined.
    expect(resolvePublicBaseUrl()).toBeUndefined();
  });

  it('outside request context, configured value still works', () => {
    expect(resolvePublicBaseUrl('https://cfg.test/')).toBe('https://cfg.test');
  });
});

describe('non-loopback peer is NOT trusted (trust gate)', () => {
  // This is the core trust property — X-Forwarded-Host from a non-
  // loopback TCP peer means "off-machine attacker shipped this
  // header." We assert by simulating an ALS scope with peerIsLocal
  // false; the resolver MUST refuse.
  it('returns undefined when forwardedHostHonored is false even if host is populated', () => {
    requestContextStore.run(
      {
        proto: 'https',
        host: 'attacker.example.com',
        peerIsLocal: false,
        forwardedHostHonored: false,
      },
      () => {
        expect(resolvePublicBaseUrl()).toBeUndefined();
      },
    );
  });

  it('configured value still wins over a hostile ALS context', () => {
    requestContextStore.run(
      {
        proto: 'https',
        host: 'attacker.example.com',
        peerIsLocal: false,
        forwardedHostHonored: false,
      },
      () => {
        expect(resolvePublicBaseUrl('https://config.test')).toBe(
          'https://config.test',
        );
      },
    );
  });
});
