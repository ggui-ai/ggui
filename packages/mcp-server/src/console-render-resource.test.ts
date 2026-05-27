/**
 * Tests for the console session-resource pair (Reading B per
 * `docs/principles/renderer-as-portable-runtime.md` §6.2):
 *
 *   - `GET /ggui/console/session-resource?session=<id>` — returns the
 *     production thin-shell HTML wrapped as a ResourceContents blob.
 *     NO inlined bootstrap — console fetches that separately.
 *   - `GET /ggui/console/session-bootstrap?session=<id>` — returns
 *     `{bootstrap: McpAppAiGguiMeta}` JSON. Console feeds this to
 *     `<McpAppIframe bootstrap={...}>` which forwards via Reading B.
 *
 * Both routes share the cookie-auth + session-scope gate. The
 * bootstrap route additionally requires `mcpApps: true` (503 when
 * mintBootstrap is absent).
 *
 * Lane 3 of the 4-lane taxonomy (in-process fake, no browser). The
 * viewer-side mount proof lives in
 * `packages/console/src/routes/SessionViewer.test.tsx`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
import {
  InMemoryRenderStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface Fixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  renderId: string;
  appId: string;
  cookiePair: string;
}

/**
 * Boot a server with the full console + mcpApps + sessionChannel
 * stack, create a session, mint a short-code for it, POST to
 * `/session-cookie` to get a real cookie, and return the header pair
 * so callers can ride it on subsequent requests.
 */
async function bootAndMintCookie(): Promise<Fixture> {
  const renderStore = new InMemoryRenderStore();
  const session = await renderStore.create({ appId: 'app-console' });
  const shortCodeIndex = new InMemoryShortCodeIndex();
  await shortCodeIndex.put('scode1234', {
    sessionId: session.id,
    appId: session.appId,
  });

  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    sessionChannel: true,
    renderStore,
    shortCodeIndex,
    console: { sessionCookie: true },
    wsTokenSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const url = `http://127.0.0.1:${addr.port}`;
  const mintRes = await fetch(`${url}/ggui/console/session-cookie`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ shortCode: 'scode1234' }),
  });
  if (mintRes.status !== 200) {
    throw new Error(`cookie mint failed: ${mintRes.status}`);
  }
  const setCookie = mintRes.headers.get('set-cookie') ?? '';
  const cookiePair = setCookie.split(';')[0]; // `ggui_console_session=<token>`
  return {
    server,
    httpServer,
    url,
    renderId: session.id,
    appId: session.appId,
    cookiePair,
  };
}

describe('GET /ggui/console/session-resource', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 400 when `session` query is missing', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(`${fx.url}/ggui/console/session-resource`, {
      headers: { cookie: fx.cookiePair },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns 401 when the console cookie is missing', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-resource?session=${fx.renderId}`,
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('missing_cookie');
  });

  it('returns 401 when the console cookie is invalid', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-resource?session=${fx.renderId}`,
      {
        headers: { cookie: 'ggui_console_session=bogus-token' },
      },
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_cookie');
  });

  it('returns 403 when the cookie is scoped to a different session', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-resource?session=some-other-session`,
      {
        headers: { cookie: fx.cookiePair },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cookie_session_mismatch');
  });

  it('returns 200 with the PRODUCTION thin-shell ResourceContents on the happy path', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-resource?session=${fx.renderId}`,
      {
        headers: { cookie: fx.cookiePair },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      contents: Array<{ uri: string; mimeType: string; text: string }>;
    };
    expect(Array.isArray(body.contents)).toBe(true);
    expect(body.contents).toHaveLength(1);
    const [content] = body.contents;
    // Reading-B shape: the resource URI is the production constant
    // (`ui://ggui/render`), mime is the production constant, and the
    // text body is the production thin-shell — same shell Claude
    // Desktop fetches via MCP `resources/read`.
    expect(content.uri).toBe('ui://ggui/render');
    expect(content.mimeType).toBe('text/html;profile=mcp-app');
    expect(typeof content.text).toBe('string');
    expect(content.text).toContain('<!doctype html>');
    // Production thin-shell marker — NOT the wrapped console shell.
    expect(content.text).toContain('data-ggui-shell="thin"');
    expect(content.text).not.toContain('data-ggui-shell="console"');
    // No inlined bootstrap on this route — console fetches it separately.
    expect(content.text).not.toMatch(/"renderId":"[^"]+"/);
    expect(content.text).not.toMatch(/"token":"[^"]+"/);
  });
});

describe('GET /ggui/console/sessions/:renderId/meta', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 401 when the console cookie is missing', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/sessions/${fx.renderId}/meta`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the cookie is scoped to a different session', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/sessions/some-other-session/meta`,
      {
        headers: { cookie: fx.cookiePair },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cookie_session_mismatch');
  });

  it('returns 200 with a well-shaped slice envelope on the happy path', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/sessions/${fx.renderId}/meta`,
      {
        headers: { cookie: fx.cookiePair },
      },
    );
    expect(res.status).toBe(200);
    const envelope = (await res.json()) as Record<string, unknown>;
    // Phase B collapsed the previous `ai.ggui/session` + `ai.ggui/stack-item`
    // pair to a single flat `ai.ggui/render` slice. Fields the consoles
    // previously read from `envelope['ai.ggui/session'].*` now live
    // directly on `envelope['ai.ggui/render'].*`.
    const renderSlice = envelope['ai.ggui/render'] as
      | Record<string, unknown>
      | undefined;
    expect(renderSlice).toBeDefined();
    expect(renderSlice?.['renderId']).toBe(fx.renderId);
    expect(renderSlice?.['appId']).toBe(fx.appId);
    expect(typeof renderSlice?.['wsUrl']).toBe('string');
    expect((renderSlice?.['wsUrl'] as string).length).toBeGreaterThan(0);
    expect(typeof renderSlice?.['wsToken']).toBe('string');
    expect((renderSlice?.['wsToken'] as string).length).toBeGreaterThan(10);
    expect(typeof renderSlice?.['expiresAt']).toBe('string');
    // `<McpAppIframe>` mounts the resource via `srcdoc`; the iframe's
    // URL is `about:srcdoc` and same-origin paths would resolve against
    // that opaque origin. The route absolutises the same-origin
    // `runtimeUrl` to `${req.protocol}://${req.get('host')}${path}` so
    // the inline shell `<script src=...>` lands on the dev server.
    // Operators who configured a CDN-absolute `renderer.url` pass
    // through unchanged. Pin both the absolutised default + the suffix
    // so a regression of either invariant fails loudly.
    expect(renderSlice?.['runtimeUrl']).toMatch(
      /^https?:\/\/.+\/_ggui\/iframe-runtime\.js$/,
    );
    expect(
      (renderSlice?.['runtimeUrl'] as string).endsWith(
        '/_ggui/iframe-runtime.js',
      ),
    ).toBe(true);
  });

  it('returns 503 when mcpApps is disabled (no mintBootstrap)', async () => {
    // Same console + session-channel wiring but WITHOUT mcpApps —
    // the meta route must honestly 503 instead of minting a token the
    // subscribe path would reject at handshake.
    const renderStore = new InMemoryRenderStore();
    const session = await renderStore.create({ appId: 'app-console' });
    const shortCodeIndex = new InMemoryShortCodeIndex();
    await shortCodeIndex.put('scode1234', {
      sessionId: session.id,
      appId: session.appId,
    });
    const server = createGguiServer({
      logger: silentLogger,
      auth: new InMemoryAuthAdapter({ devAllowAll: true }),
      // NOTE: no mcpApps — this is the gate we're asserting.
      sessionChannel: true,
      renderStore,
      shortCodeIndex,
      console: { sessionCookie: true },
      wsTokenSecret: 'deterministic-test-secret-' + 'x'.repeat(32),
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    try {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('server.address() did not return AddressInfo');
      }
      const url = `http://127.0.0.1:${addr.port}`;
      const mintRes = await fetch(`${url}/ggui/console/session-cookie`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ shortCode: 'scode1234' }),
      });
      const cookiePair = (mintRes.headers.get('set-cookie') ?? '').split(
        ';',
      )[0];
      const res = await fetch(
        `${url}/ggui/console/sessions/${session.id}/meta`,
        {
          headers: { cookie: cookiePair },
        },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('mcp_apps_disabled');
    } finally {
      await server.close();
    }
  });
});

describe('GET /ggui/console/session-stack', () => {
  // Slice J observation surface — console-only stack snapshot.
  // Console's `<SessionViewer>` reads this once on mount to
  // render `<SessionInspector>` per stack entry. The iframe owns
  // the live WS subscription (single-use bootstrap token), so the
  // outer DOM has no live signal — this endpoint is the snapshot
  // source.
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 400 when `session` query is missing', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(`${fx.url}/ggui/console/session-stack`, {
      headers: { cookie: fx.cookiePair },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('returns 401 when the console cookie is missing', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-stack?session=${fx.renderId}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when the cookie is scoped to a different session', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-stack?session=some-other-session`,
      {
        headers: { cookie: fx.cookiePair },
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('cookie_session_mismatch');
  });

  it('returns 200 with the stack snapshot on the happy path', async () => {
    fx = await bootAndMintCookie();
    const res = await fetch(
      `${fx.url}/ggui/console/session-stack?session=${fx.renderId}`,
      {
        headers: { cookie: fx.cookiePair },
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stack: unknown[];
      currentStackIndex: number;
      eventSequence: number;
    };
    // Freshly created session — empty stack, index = -1, sequence
    // = 0. We don't pin the exact index/sequence semantics here
    // (that's session-store's contract); just assert the wire
    // shape is honest.
    expect(Array.isArray(body.stack)).toBe(true);
    expect(typeof body.currentStackIndex).toBe('number');
    expect(typeof body.eventSequence).toBe('number');
  });

});
