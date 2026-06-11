/**
 * End-to-end tests for the MCP Apps outbound delivery path.
 *
 * Exercises the full slice: MCP `initialize` capability advertisement,
 * `ggui_render` tool call with bootstrap `_meta` on the result,
 * `resources/read ui://ggui/render` serving the thin shell, and a
 * real live-channel subscribe with the minted bootstrap token producing
 * an ack with a reconnect `sessionToken`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  MCP_APPS_UI_CAPABILITY,
  GGUI_RENDER_RESOURCE_URI,
  GGUI_RENDER_RESOURCE_MIME,
  parseMcpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { isRecord } from '@ggui-ai/protocol';
import { createHash } from 'node:crypto';
import {
  GGUI_RENDER_SHELL_HTML,
  GGUI_RENDER_SHELL_SCRIPT_HASH,
  advertiseMcpAppsUiCapability,
  registerGguiRenderResource,
} from './mcp-apps-outbound.js';
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
  httpBase: string;
  wsUrl: string;
}

async function bootOutboundServer(): Promise<Fixture> {
  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: true,
    wsTokenSecret: 'test-secret-32bytes-for-hmac-1234',
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const httpBase = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  return { server, httpServer, httpBase, wsUrl };
}

async function connectClient(httpBase: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`${httpBase}/mcp`),
    { requestInit: { headers: { Authorization: 'Bearer dev' } } },
  );
  const client = new Client(
    { name: 'test-client', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

const NOOP_CONTRACT = {};

async function handshakeAndRender(
  client: Client,
  intent: string,
): Promise<Awaited<ReturnType<Client['callTool']>>> {
  // Post-Phase-B (flatten-render-identity): the prior `ggui_new_session`
  // + `ggui_handshake({sessionId})` + `ggui_push` triple collapses to
  // `ggui_handshake({intent, blueprintDraft})` + `ggui_render({handshakeId,
  // props})`. Accept = OMIT `override`; props is REQUIRED (pass {} for a
  // no-propsSpec contract). The sessionId is minted by `ggui_render` itself
  // (returned on the result's structuredContent).
  const handshake = await client.callTool({
    name: 'ggui_handshake',
    arguments: {
      intent,
      blueprintDraft: { contract: NOOP_CONTRACT },
    },
  });
  const handshakeId = (handshake.structuredContent as {
    handshakeId: string;
  }).handshakeId;
  return client.callTool({
    name: 'ggui_render',
    arguments: { handshakeId, props: {} },
  });
}

describe('createGguiServer({ mcpApps: true }) — construction', () => {
  it('throws when renderChannel is not also enabled', () => {
    expect(() =>
      createGguiServer({ logger: silentLogger, mcpApps: true }),
    ).toThrow(/renderChannel: true/);
  });

  it('boots when both mcpApps and renderChannel are enabled', () => {
    const server = createGguiServer({
      logger: silentLogger,
      renderChannel: true,
      mcpApps: true,
      wsTokenSecret: 'secret',
    });
    expect(server.toolCount).toBeGreaterThan(0);
  });
});

describe('advertiseMcpAppsUiCapability + registerGguiRenderResource', () => {
  it('passes the spec-canonical capability name through', () => {
    expect(MCP_APPS_UI_CAPABILITY).toBe('io.modelcontextprotocol/ui');
    // Both helpers exist and are callable; actual wire-level
    // integration is covered by the full-server tests below.
    expect(typeof advertiseMcpAppsUiCapability).toBe('function');
    expect(typeof registerGguiRenderResource).toBe('function');
  });
});

describe('GGUI_RENDER_SHELL_HTML', () => {
  it('GGUI_RENDER_SHELL_SCRIPT_HASH matches the recomputed hash of the actual inline `<script>` body', () => {
    // Drift catch — Reading B (`docs/principles/renderer-as-portable-
    // runtime.md` §6.2) mounts the shell via `srcdoc` from inside
    // `<McpAppIframe>`. The `about:srcdoc` iframe inherits the parent
    // console SPA's CSP, which forbids `'unsafe-inline'`. The shell's
    // inline `<script>` block is authorised by sha-256 hash. If the
    // shell body is edited without regenerating the hash, every spec
    // pinning `data-ggui-mcp-app-iframe-lifecycle="code-ready"` will
    // hang because the inline script is silently CSP-blocked.
    //
    // Re-extract the script body from the actual served HTML, hash
    // it, and compare. Match the same bytes the browser would.
    const m = GGUI_RENDER_SHELL_HTML.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    const scriptBody = m![1]!;
    const recomputed = `'sha256-${createHash('sha256')
      .update(scriptBody)
      .digest('base64')}'`;
    expect(GGUI_RENDER_SHELL_SCRIPT_HASH).toBe(recomputed);
    expect(GGUI_RENDER_SHELL_SCRIPT_HASH).toMatch(
      /^'sha256-[A-Za-z0-9+/]+=*'$/,
    );
  });

  it('carries the thin-shell marker attribute (post-C8)', () => {
    // `data-ggui-shell="thin"` replaces the pre-C8 "live" marker. Hosts
    // introspecting the resource body use this to confirm they're
    // seeing the thin-shell pivot, not a stale inline-JS shell.
    expect(GGUI_RENDER_SHELL_HTML).toContain('data-ggui-shell="thin"');
  });

  it('sends `ui/initialize` to the parent host via postMessage (preflight)', () => {
    expect(GGUI_RENDER_SHELL_HTML).toContain("'ui/initialize'");
    expect(GGUI_RENDER_SHELL_HTML).toContain('window.parent.postMessage');
  });

  it("loads the renderer bundle as <script type='module'> per `@ggui-ai/iframe-runtime`'s ESM contract", () => {
    // `@ggui-ai/iframe-runtime` bundles to ESM with top-level `export`
    // statements (see `packages/iframe-runtime/src/runtime.ts:5` — "the
    // thin-shell HTML loads it via `<script type="module" src=".../
    // renderer.js">`"). A classic `<script src=...>` parses the
    // bundle without module semantics and throws `SyntaxError:
    // Unexpected token 'export'` synchronously at parse time. The
    // renderer never executes, the lifecycle never advances, and
    // every host-side spec pinning `data-ggui-mcp-app-iframe-
    // lifecycle="code-ready"` hangs to timeout.
    //
    // This assertion enforces `type="module"` so a future shell
    // refactor that drops it fails this test loudly instead of
    // silently breaking every Lane 1 spec exercising the live
    // iframe path.
    expect(GGUI_RENDER_SHELL_HTML).toContain("s.type='module'");
  });

  it('does NOT fish runtimeUrl (or any bootstrap field) out of structuredContent', () => {
    // The design rule locks bootstrap fields to _meta; structuredContent
    // is strictly model-facing. Any match of `structuredContent.<field>`
    // where <field> is a bootstrap key is a design regression.
    expect(GGUI_RENDER_SHELL_HTML).not.toMatch(
      /structuredContent\s*[.[]\s*(wsUrl|token|bootstrap|runtimeUrl)/,
    );
  });

});

describe('end-to-end outbound flow', () => {
  let fx: Fixture;
  let client: Client;

  beforeEach(async () => {
    fx = await bootOutboundServer();
    client = await connectClient(fx.httpBase);
  });

  afterEach(async () => {
    await client.close();
    await fx.server.close();
  });

  it('advertises io.modelcontextprotocol/ui on MCP initialize', () => {
    const caps = client.getServerCapabilities();
    expect(caps).toBeDefined();
    expect(caps?.experimental).toBeDefined();
    expect(caps?.experimental?.[MCP_APPS_UI_CAPABILITY]).toBeDefined();
  });

  it('serves ui://ggui/render via resources/read with the right MIME', async () => {
    const resp = await client.readResource({ uri: GGUI_RENDER_RESOURCE_URI });
    expect(resp.contents).toHaveLength(1);
    const c = resp.contents[0] as {
      uri: string;
      mimeType?: string;
      text?: string;
    };
    expect(c.uri).toBe(GGUI_RENDER_RESOURCE_URI);
    expect(c.mimeType).toBe(GGUI_RENDER_RESOURCE_MIME);
    expect(typeof c.text).toBe('string');
    expect(c.text).toContain('data-ggui-shell="thin"');
  });

  it('ggui_render returns structuredContent without bootstrap fields, and ai.ggui/render slice meta with them', async () => {
    const result = await handshakeAndRender(client, 'test render');

    // structuredContent is model-facing — bootstrap fields must NOT appear.
    const sc = result.structuredContent;
    if (!isRecord(sc)) {
      throw new Error('expected a structuredContent object');
    }
    const scKeys = Object.keys(sc);
    for (const bootstrapKey of [
      'wsUrl',
      'token',
      'bootstrap',
      'bootstrapToken',
      'sessionToken',
      'expiresAt',
    ]) {
      expect(scKeys).not.toContain(bootstrapKey);
    }
    expect(sc.sessionId).toBeDefined();
    // Post-R5 cleanup: there is no `url` field on structuredContent.
    // The `/r/<shortCode>` route was deleted; every host either
    // mounts via `_meta.ui.resourceUri` or resolves the render
    // resource from `{sessionId}` itself.
    expect(scKeys).not.toContain('url');

    // The `ai.ggui/render` _meta slice decodes to a flat shape
    // post Phase B (no more nested `session` sub-object).
    expect(result._meta).toBeDefined();
    const parsed = parseMcpAppAiGguiRenderMeta(result._meta);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.meta) return;
    expect(parsed.meta.sessionId).toBeDefined();
    expect(parsed.meta.appId).toBeDefined();
    expect(parsed.meta.runtimeUrl).toBeDefined();
  });

  it('ggui_render declaration exposes _meta.ui.resourceUri on tools/list', async () => {
    const resp = await client.listTools();
    const renderTool = resp.tools.find((t) => t.name === 'ggui_render');
    expect(renderTool).toBeDefined();
    expect(renderTool?._meta).toBeDefined();
    const meta = renderTool?._meta as {
      ui?: { resourceUri?: string; visibility?: string[] };
    };
    expect(meta.ui?.resourceUri).toBe(GGUI_RENDER_RESOURCE_URI);
    expect(meta.ui?.visibility).toEqual(['model']);
  });

  it('ggui_render bootstrap carries runtimeUrl — the URL the thin shell dynamic-script-loads (C8)', async () => {
    const result = await handshakeAndRender(client, 'c8 renderer-url test');
    const parsed = parseMcpAppAiGguiRenderMeta(result._meta);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !parsed.meta) return;
    // Default same-origin path published by `createGguiServer` when
    // `mcpApps: true` — operators override via `renderer.url`.
    expect(parsed.meta.runtimeUrl).toBe('/_ggui/iframe-runtime.js');
  });
});

describe('renderer-bundle static mount (C8 — plan §C8 Deliverable 2)', () => {
  let fx: Fixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('GET /_ggui/iframe-runtime.js serves the renderer bundle with application/javascript MIME', async () => {
    // Default posture: `mcpApps: true` + no explicit `renderer` config
    // → mount is ON, served from @ggui-ai/iframe-runtime's built dist.
    fx = await bootOutboundServer();
    const resp = await fetch(`${fx.httpBase}/_ggui/iframe-runtime.js`);
    expect(resp.status).toBe(200);
    const contentType = resp.headers.get('content-type') ?? '';
    expect(contentType).toMatch(/application\/javascript/);
    const text = await resp.text();
    // Bundle is an esbuild-produced ESM module — it should begin with
    // the esbuild banner (import statement) and be non-trivially sized.
    // Exact contents change per build; assert shape, not bytes.
    expect(text.length).toBeGreaterThan(1000);
  });

  it('GET /_ggui/iframe-runtime.js sends a permissive `Access-Control-Allow-Origin` so srcdoc iframes can `<script type="module">`-import it', async () => {
    // The bundle is loaded from inside a `srcdoc`-mounted
    // `<McpAppIframe>` iframe whose origin is `null` (opaque). The
    // shell HTML uses `<script type="module" src=…>`, which always
    // fetches via CORS. Without `Access-Control-Allow-Origin: *` the
    // browser rejects the script ("from origin 'null' has been
    // blocked by CORS policy") and the renderer never runs — every
    // Lane 1 spec pinning `data-ggui-mcp-app-iframe-lifecycle="code-
    // ready"` hangs to timeout. The bundle is public; `*` is the
    // right shape (no auth state on this route to protect).
    fx = await bootOutboundServer();
    const resp = await fetch(`${fx.httpBase}/_ggui/iframe-runtime.js`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('serves a 503 with remediation hint when the renderer bundle is missing', async () => {
    // Point `runtime.distDir` at a directory that doesn't contain
    // a built bundle. Server logs `renderer_bundle_missing` + serves
    // 503 so operators see "bundle not built" instead of a silent
    // 404 (same posture as the console block).
    fx = await bootOutboundServerWith({
      runtime: { distDir: '/tmp/nonexistent-renderer-dist' },
    });
    const resp = await fetch(`${fx.httpBase}/_ggui/iframe-runtime.js`);
    expect(resp.status).toBe(503);
    const text = await resp.text();
    expect(text).toMatch(/renderer bundle not built/);
    expect(text).toMatch(/pnpm --filter @ggui-ai\/iframe-runtime build/);
  });

  it('does NOT mount the renderer route when `runtime: false` is passed (CDN-only posture)', async () => {
    // Explicit opt-out. Operator takes responsibility for serving
    // the bundle from a CDN / proxy and publishing that URL via
    // `runtime.url` so the bootstrap still carries one.
    fx = await bootOutboundServerWith({ runtime: false });
    const resp = await fetch(`${fx.httpBase}/_ggui/iframe-runtime.js`);
    // No route registered → Express's default 404 handler answers.
    expect(resp.status).toBe(404);
  });

  it('still mounts the renderer route when `runtime: {url: ...}` overrides only the published URL', async () => {
    // Object-form with `url` override keeps the LOCAL mount ON (for
    // any same-origin verification / console introspection) while
    // publishing the CDN URL to clients. Matches the docstring
    // contract: `false` disables the mount; an object without
    // `false` keeps it on.
    fx = await bootOutboundServerWith({
      runtime: { url: 'https://cdn.example/ggui/renderer.js' },
    });
    const resp = await fetch(`${fx.httpBase}/_ggui/iframe-runtime.js`);
    expect(resp.status).toBe(200);
  });

  it('publishes the configured `runtime.url` on bootstrap.runtimeUrl (CDN override)', async () => {
    fx = await bootOutboundServerWith({
      runtime: { url: 'https://cdn.example/ggui/renderer.js' },
    });
    const client = await connectClient(fx.httpBase);
    try {
      const result = await handshakeAndRender(client, 'c8 cdn override');
      const parsed = parseMcpAppAiGguiRenderMeta(result._meta);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok || !parsed.meta) return;
      expect(parsed.meta.runtimeUrl).toBe(
        'https://cdn.example/ggui/renderer.js',
      );
    } finally {
      await client.close();
    }
  });
});

async function bootOutboundServerWith(
  extra: Parameters<typeof createGguiServer>[0],
): Promise<Fixture> {
  const server = createGguiServer({
    logger: silentLogger,
    renderChannel: true,
    mcpApps: true,
    wsTokenSecret: 'test-secret-32bytes-for-hmac-1234',
    ...extra,
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const httpBase = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
  return { server, httpServer, httpBase, wsUrl };
}

describe('end-to-end bootstrap subscribe → ack sessionToken', () => {
  let fx: Fixture;
  let client: Client;

  beforeEach(async () => {
    fx = await bootOutboundServer();
    client = await connectClient(fx.httpBase);
  });

  afterEach(async () => {
    await client.close();
    await fx.server.close();
  });

  async function mintRenderBootstrap(): Promise<{
    wsUrl: string;
    token: string;
    sessionId: string;
    appId: string;
  }> {
    const result = await handshakeAndRender(client, 'bootstrap-test');
    const parsed = parseMcpAppAiGguiRenderMeta(result._meta);
    if (!parsed.ok) {
      throw new Error(`mintRenderBootstrap: combiner failed (${parsed.reason})`);
    }
    const meta = parsed.meta;
    if (!meta) {
      throw new Error('mintRenderBootstrap: ai.ggui/render slice missing');
    }
    if (!meta.wsUrl || !meta.wsToken) {
      throw new Error('mintRenderBootstrap: live-mode auth missing');
    }
    return {
      wsUrl: meta.wsUrl,
      token: meta.wsToken, // local struct retains 'token' for downstream call sites
      sessionId: meta.sessionId,
      appId: meta.appId,
    };
  }

  it('bootstrap-auth subscribe succeeds and ack carries sessionToken', async () => {
    const bootstrap = await mintRenderBootstrap();
    // Open WS with ?wsToken= gate — upgrade-time AuthAdapter is skipped.
    const ws = new WebSocket(
      `${fx.wsUrl}?wsToken=${encodeURIComponent(bootstrap.token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const ackPromise = new Promise<{
      sequence: number;
      sessionToken?: string;
      session?: { id: string; appId: string };
    }>((resolve, reject) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          payload: {
            sequence: number;
            sessionToken?: string;
            session?: { id: string; appId: string };
            code?: string;
          };
        };
        if (msg.type === 'ack') resolve(msg.payload);
        else if (msg.type === 'error') reject(new Error(msg.payload.code));
      });
    });

    ws.send(
      JSON.stringify({
        type: 'subscribe',
        payload: {
          sessionId: bootstrap.sessionId,
          appId: bootstrap.appId,
          wsToken: bootstrap.token,
        },
      }),
    );

    const ack = await ackPromise;
    expect(ack.sequence).toBeDefined();
    expect(typeof ack.sessionToken).toBe('string');
    expect((ack.sessionToken as string).length).toBeGreaterThan(10);
    // Phase B replaced the prior `stack: GguiSession[]` ack slot with a
    // single `session: GguiSession` (a render IS the addressable unit).
    expect(ack.session).toBeDefined();
    expect(ack.session?.id).toBe(bootstrap.sessionId);
    expect(ack.session?.appId).toBe(bootstrap.appId);
    ws.close();
  });

  it('accepts a reused bootstrap token within TTL (G14, 2026-05-23)', async () => {
    // G14: bootstrap envelopes are no longer single-use. Pre-G14 this
    // test asserted the OPPOSITE — second subscribe rejected with
    // `BOOTSTRAP_INVALID`. Under the signed-envelope model, a transient
    // WS drop reconnects with the SAME envelope (no fresh handshake)
    // as long as the envelope is still inside its TTL. Replay defense
    // is now anchored on the signed `exp` claim + the refresh-window
    // cap on the original `iat` (see `refreshWsToken`), not
    // on a server-side jti-claim Map.
    const bootstrap = await mintRenderBootstrap();

    async function subscribeWithBootstrap(): Promise<{ ok: true; sessionToken?: string } | { ok: false; code: string }> {
      const ws = new WebSocket(
        `${fx.wsUrl}?wsToken=${encodeURIComponent(bootstrap.token)}`,
      );
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      const result = await new Promise<
        { ok: true; sessionToken?: string } | { ok: false; code: string }
      >((resolve) => {
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString()) as {
            type: string;
            payload: { sessionToken?: string; code?: string };
          };
          if (msg.type === 'ack') resolve({ ok: true, sessionToken: msg.payload.sessionToken });
          else if (msg.type === 'error') resolve({ ok: false, code: msg.payload.code as string });
        });
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            payload: {
              sessionId: bootstrap.sessionId,
              appId: bootstrap.appId,
              wsToken: bootstrap.token,
            },
          }),
        );
      });
      ws.close();
      return result;
    }

    const first = await subscribeWithBootstrap();
    expect(first.ok).toBe(true);

    const second = await subscribeWithBootstrap();
    expect(second.ok).toBe(true);
    if (second.ok) {
      // Each subscribe still mints a fresh sessionToken — that's the
      // longer-TTL reconnect credential and is per-subscribe by design.
      expect(typeof second.sessionToken).toBe('string');
    }
  });

  it('rejects a tampered bootstrap token', async () => {
    const bootstrap = await mintRenderBootstrap();
    const tampered = bootstrap.token.slice(0, -3) + 'xyz';
    const ws = new WebSocket(
      `${fx.wsUrl}?wsToken=${encodeURIComponent(tampered)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const outcome = await new Promise<{ type: string; code?: string }>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          payload: { code?: string };
        };
        resolve({ type: msg.type, code: msg.payload?.code });
      });
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            sessionId: bootstrap.sessionId,
            appId: bootstrap.appId,
            wsToken: tampered,
          },
        }),
      );
    });

    expect(outcome.type).toBe('error');
    expect(outcome.code).toBe('BOOTSTRAP_INVALID');
    ws.close();
  });

  it('rejects a bootstrap token bound to a different render', async () => {
    const bootstrap = await mintRenderBootstrap();
    const ws = new WebSocket(
      `${fx.wsUrl}?wsToken=${encodeURIComponent(bootstrap.token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const outcome = await new Promise<{ type: string; code?: string }>((resolve) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          payload: { code?: string };
        };
        resolve({ type: msg.type, code: msg.payload?.code });
      });
      ws.send(
        JSON.stringify({
          type: 'subscribe',
          payload: {
            sessionId: 'different-render',
            appId: bootstrap.appId,
            wsToken: bootstrap.token,
          },
        }),
      );
    });

    expect(outcome.type).toBe('error');
    expect(outcome.code).toBe('BOOTSTRAP_SESSION_MISMATCH');
    ws.close();
  });
});
