/**
 * `buildMcpServerBackend` integration — proves the OSS first-run
 * bundle is wired end-to-end.
 *
 * This suite is the ONE regression gate on the `ggui serve` → HTTP
 * surface contract. The Slice 1/2/3 console tests live in
 * `@ggui-ai/mcp-server`; the pairing tests live there too. This test
 * asserts the glue — that the CLI's composition actually turns those
 * opt-ins on by default so an operator running `ggui serve` opens a
 * browser at `/` and gets the landing page, not a 404.
 *
 * Why it's not in the pure `serve-command.test.ts`: that file is
 * side-effect-free flag parsing + banner rendering. This file boots
 * the real server factory with an OS-assigned port.
 *
 * Why it's its own module (not just a second describe in the existing
 * e2e file): the existing e2e constructs its own `createGguiServer()`
 * with minimal opts. This one exercises `buildMcpServerBackend`
 * directly so drift on the CLI bundle is caught at CI time.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ManifestBlueprintProvider,
  type DiscoveredPrimitiveCatalog,
  type LoadedTheme,
  type McpServerMount,
  type PairingCompletion,
  type SharedHandler,
} from '@ggui-ai/mcp-server';
import type { UiManifest } from '@ggui-ai/project-config';
import { z, type ZodRawShape } from 'zod';
import { buildMcpServerBackend, pickFreePort } from './mcp-backend.js';
import type { ServeBackend } from './serve-command.js';

/**
 * Mint a pairing token by running the real `initPairing()` + `POST /pair`
 * handshake. Returns the minted bearer + pairingId.
 *
 * Needed because `buildMcpServerBackend` now composes the server with
 * `InMemoryAuthAdapter({ devAllowAll: false })` — `Bearer dev` no
 * longer authenticates anything. The E2E harness has its own
 * PAIR_CODE-from-stdout path; this helper covers the in-process
 * equivalent for these vitest tests which import
 * `buildMcpServerBackend` directly.
 */
/**
 * Drive the canonical handshake-first render flow over MCP and return
 * the raw render result body. Performs `ggui_handshake({intent,
 * blueprintDraft})` → `ggui_render({handshakeId, props})`, all
 * under one bearer token. `props` is required; omitting `override`
 * accepts the handshake proposal as-is (an `override.contract`
 * forces a strict cold-gen, `override.variance` re-aims the agreed
 * contract). Tests that want the structured render
 * response or the bootstrap meta call this instead of fabricating
 * tools/call bodies inline (the direct-render shape was retired
 * post-synth-authority; `ggui_render` REQUIRES a handshakeId).
 *
 * Post-flatten (Phase B): handshake no longer takes `sessionId` —
 * the paired `ggui_render` auto-mints a renderId. The session-create
 * step is gone entirely (`ggui_new_session` deleted).
 */
async function renderOverMcp(args: {
  readonly url: string;
  readonly token: string;
  readonly intent: string;
  readonly contract?: Record<string, unknown>;
  readonly id?: string;
}): Promise<{ body: unknown; res: Response }> {
  const post = async (method: string, params: unknown, id: string) => {
    const r = await fetch(`${args.url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    if (!r.ok) {
      throw new Error(
        `renderOverMcp: ${method} HTTP ${r.status} — ${await r.text()}`,
      );
    }
    return r;
  };
  const idBase = args.id ?? 'render-flow';
  const contract = args.contract ?? {
    contextSpec: {
      smoke: { schema: { type: 'string' }, default: 'ok' },
    },
  };
  // Handshake input is {intent, blueprintDraft} post-flatten.
  // blueprintDraft is required (commit 80c639338, 2026-05-14); pass the
  // contract here so the negotiator has something to validate. The
  // test asserts wire-shape, not draft contents.
  const hsRes = await post(
    'tools/call',
    {
      name: 'ggui_handshake',
      arguments: {
        intent: args.intent,
        blueprintDraft: { contract },
      },
    },
    `${idBase}-handshake`,
  );
  const hsBody = await readJsonOrSse(hsRes);
  const handshakeId = (
    (hsBody.result as { structuredContent: { handshakeId: string } })
      .structuredContent
  ).handshakeId;
  const renderRes = await post(
    'tools/call',
    {
      name: 'ggui_render',
      arguments: { handshakeId, props: {} },
    },
    `${idBase}-render`,
  );
  const body = await readJsonOrSse(renderRes);
  return { body, res: renderRes };
}

async function mintPairToken(
  backend: ServeBackend,
  baseUrl: string,
  deviceName = 'unit-test',
): Promise<string> {
  if (!backend.pairingService) {
    throw new Error(
      'mintPairToken: backend has no pairingService — did buildMcpServerBackend stop wiring pairing?',
    );
  }
  const init = await backend.pairingService.initPairing();
  const res = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: init.code, deviceName }),
  });
  if (!res.ok) {
    throw new Error(`POST /pair failed: HTTP ${res.status} ${await res.text()}`);
  }
  const completion = (await res.json()) as PairingCompletion;
  return completion.token;
}

describe('buildMcpServerBackend', () => {
  let backend: ServeBackend | null = null;
  let boundPort: number | null = null;

  afterEach(async () => {
    if (backend) {
      await backend.close();
      backend = null;
      boundPort = null;
    }
  });

  async function boot(): Promise<{ url: string; port: number }> {
    // `mcpApps.wsUrl` + `runtime.url` are captured at composition
    // time, so the port must be resolved before `buildMcpServerBackend`
    // runs — matches the CLI's `runServeCommand` ordering.
    const port = await pickFreePort();
    backend = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port,
    });
    boundPort = await backend.listen(port, '127.0.0.1');
    return { url: `http://127.0.0.1:${boundPort}`, port: boundPort };
  }

  it('serves the console landing page at / (first-run story)', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/`);
    // 200 = landing bundle present + wired. A 404 would mean
    // console wasn't mounted at all (the original regression
    // this test guards). A 503 would mean the bundle wasn't built;
    // the workspace always builds `@ggui-ai/console` as part
    // of the CI dependency graph, so 503 here would itself be a
    // build-ordering regression worth surfacing. Either way the
    // test should see 200.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    // CSP lives on every console response path — further
    // regression signal that the bundle is actually being served
    // through the `@ggui-ai/mcp-server` console mount and not
    // some stray middleware.
    expect(res.headers.get('content-security-policy')).toBeTruthy();
  });

  it('exposes pair endpoints so Portal + third-party clients can pair', async () => {
    const { url } = await boot();
    // POST /pair without a valid code → 400/401/403, NEVER 404. The
    // 404 result is the regression: it means `pairing: true` wasn't
    // wired and the route doesn't exist at all.
    const res = await fetch(`${url}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'nope', deviceName: 'test' }),
    });
    expect(res.status).not.toBe(404);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('exposes the console info endpoint (landing page data source)', async () => {
    const { url } = await boot();
    // /ggui/console/info is admin-gated — operators authenticate with
    // the boot-time admin token. Without it the route 401s, which is
    // also a wiring proof (route is mounted, just demanding auth).
    const res = await fetch(`${url}/ggui/console/info`, {
      headers: { authorization: `Bearer ${backend!.adminToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      server: string;
      pairing: { enabled: boolean };
    };
    // Pairing is bundled on — the landing page needs this to render
    // the pair-code card.
    expect(body.pairing.enabled).toBe(true);
  });

  it('exposes the render-cookie endpoint so /s/<shortCode> can bootstrap', async () => {
    const { url } = await boot();
    // POST /ggui/console/render-cookie without a valid shortCode
    // → 400 (missing) or 404 (unknown), NEVER 404-on-route. A
    // route-level 404 means the `console.sessionCookie` flow
    // wasn't wired.
    const res = await fetch(`${url}/ggui/console/render-cookie`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    // 400 is the missing-shortCode branch — which itself proves the
    // route was matched + the handler ran. Anything else (especially
    // 404 on an EMPTY body, which Express produces when the route
    // isn't mounted at all) is a regression.
    expect(res.status).toBe(400);
  });

  it('rejects /mcp under an unrecognised bearer (strict-auth default)', async () => {
    // Regression gate for the devAllowAll:false flip. The CLI's
    // `buildMcpServerBackend` composition must leave the /mcp path
    // rejecting any bearer that isn't pair-minted / pre-registered.
    // If this test ever passes with a random bearer, the
    // `InMemoryAuthAdapter({devAllowAll: false})` wiring has
    // regressed to the permissive default.
    const { url } = await boot();
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer not-a-real-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'unauth',
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      jsonrpc?: string;
      error?: { code?: number; message?: string };
    };
    // JSON-RPC envelope on the 401 matches `/mcp`'s `auth_failed`
    // branch in `server.ts` — pinning the shape here makes a silent
    // rewrite of the auth response visible in CI.
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error?.code).toBe(-32000);
    expect(body.error?.message).toBe('No valid credentials');
  });

  it('serves /ggui/health (regression gate — basic surface stays live)', async () => {
    const { url } = await boot();
    const res = await fetch(`${url}/ggui/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      channel?: { path: string };
    };
    expect(body.status).toBe('ok');
    // `sessionChannel: true` in the bundle → /ggui/health reports
    // the channel block. Absent = channel wire regressed.
    expect(body.channel).toBeDefined();
    expect(body.channel?.path).toBe('/ws');
  });

  it('echoes the passed cliVersion on the backend handle', () => {
    // Construction-only assertion so a drift on the version plumbing
    // is caught without needing a live listener. `port` is an
    // arbitrary value in the valid range; no socket is bound.
    const b = buildMcpServerBackend({
      cliVersion: '9.8.7',
      host: '127.0.0.1',
      port: 12345,
    });
    expect(b.serverVersion).toBe('9.8.7');
    expect(b.serverName).toBe('ggui-mcp-server');
    expect(typeof b.toolCount).toBe('number');
  });

  it('rejects `port: 0` at construction — the composed URLs need a real port', () => {
    // Guards the invariant the CLI relies on: `--port 0` is resolved
    // via `pickFreePort` BEFORE reaching `buildMcpServerBackend`. If
    // that pre-resolution ever regresses, we want a crisp error here
    // instead of an agent-returned URL pointing at `http://host:0/s/…`.
    expect(() =>
      buildMcpServerBackend({
        cliVersion: 'x',
        host: '127.0.0.1',
        port: 0,
      }),
    ).toThrow(/concrete TCP port/);
  });

  it('registers `ggui_render` with the MCP Apps entry-point stamp (tools/list)', async () => {
    // The single load-bearing invariant for the OSS first-run story:
    // without `ggui_render`, nothing mints shortCodes → the console
    // `/s/<code>` viewer is orphaned. This test goes over the real
    // MCP wire to catch wiring regressions that a toolCount check
    // alone would miss.
    const { url } = await boot();
    // The OSS default surface grows over time as new lifecycle /
    // observability tools land (Phase 3's `ggui_list_gadgets`, the
    // various `ggui_get_*` / `ggui_consume` / `ggui_emit` queries,
    // etc.). Pin a floor for catastrophic regressions but leave
    // headroom for additive growth; the real wiring check lives below
    // on the `ggui_render` `_meta` stamp. `ggui_render_blueprint` is
    // still conditional on a wired `uiRegistry`.
    expect(backend!.toolCount).toBeGreaterThanOrEqual(13);

    // Strict-auth: `Bearer dev` no longer authenticates — we mint a
    // real pairing token first so the MCP POST uses a bearer the
    // adapter recognises.
    const token = await mintPairToken(backend!, url, 'tools-list-smoke');

    const listRes = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-list',
        method: 'tools/list',
        params: {},
      }),
    });
    expect(listRes.ok).toBe(true);
    const body = await readJsonOrSse(listRes);
    const tools = (body.result as { tools: Array<{ name: string; _meta?: { ui?: { resourceUri?: string; visibility?: readonly string[] } } }> }).tools;
    const render = tools.find((t) => t.name === 'ggui_render');
    expect(render).toBeTruthy();
    // `_meta.ui.*` is the MCP Apps §2.4.1 "sole entry-point tool"
    // stamp — lost if the CLI ever reverts to the old bundle.
    expect(render?._meta?.ui?.resourceUri).toBe('ui://ggui/render');
    expect(render?._meta?.ui?.visibility).toEqual(expect.arrayContaining(['model']));
  });

  it('the composed `ggui_render` structuredContent carries a renderId — and no dead `url` field', async () => {
    // End-to-end: drive the canonical handshake-first flow and assert
    // the LLM-visible surface. Post-R5 the `/r/<shortCode>` route was
    // deleted; the wire-output schema no longer ships a `url` (it was
    // hallucination bait — see fix-A 2026-05-26). Hosts mount via
    // `_meta.ui.resourceUri` or resolve `{renderId}` through their own
    // render-resource fetch.
    const { url } = await boot();
    const token = await mintPairToken(backend!, url, 'ggui-render-smoke');
    const { body } = await renderOverMcp({
      url,
      token,
      intent: 'unit-test smoke',
      id: 'shortcode-url-smoke',
    });
    const result = body.result as {
      structuredContent: Record<string, unknown>;
    };
    expect(typeof result.structuredContent.renderId).toBe('string');
    expect(Object.keys(result.structuredContent)).not.toContain('url');
  });

  it('publishes an absolute `runtimeUrl` on `_meta["ai.ggui/render"]` (Task #382 — srcdoc posture)', async () => {
    // `<McpAppIframe>` mounts inline resource text via `srcdoc`, which
    // gives the iframe `about:srcdoc` as its URL. A relative
    // `runtimeUrl` (`/_ggui/iframe-runtime.js`) resolves against `about:`
    // and the `<script src>` fetch silently fails. The CLI MUST
    // publish an absolute URL built from its own known `baseUrl` so
    // srcdoc mount works without operator action.
    //
    // This test proves the CLI's `runtime: { url: baseUrl + path }`
    // wire-up reaches the slice metadata the shell reads — i.e.
    // that Task #382's fix is actually in the render result, not just
    // set on construction. Post-B.1 the carrier is the single
    // `ai.ggui/render` slice (renderId + appId + runtimeUrl +
    // wsToken + caps).
    const { url } = await boot();
    const token = await mintPairToken(backend!, url, 'renderer-url-smoke');
    const { body } = await renderOverMcp({
      url,
      token,
      intent: 'renderer-url smoke',
      id: 'renderer-url-smoke',
    });
    const result = body.result as {
      _meta?: Record<string, unknown>;
    };
    const renderSlice = result._meta?.['ai.ggui/render'] as
      | { runtimeUrl?: string }
      | undefined;
    const runtimeUrl = renderSlice?.runtimeUrl;
    expect(runtimeUrl).toBeDefined();
    // Absolute URL: starts with the server's own `baseUrl`, NOT the
    // bare `/_ggui/iframe-runtime.js` relative path (which would fail in
    // srcdoc iframes).
    expect(runtimeUrl).toBe(`${url}/_ggui/iframe-runtime.js`);
    expect(runtimeUrl!.startsWith('http://')).toBe(true);
  });

  it('defaults `primitiveCatalogCount` to 0 when the CLI passes no catalogs', () => {
    // Mirrors the zero-config first-run: no `primitives.packages` /
    // `primitives.local` declared → discovery returns zero catalogs
    // → `buildMcpServerBackend` receives no `primitiveCatalogs` opt
    // → backend reports zero. Construction-only assertion.
    const b = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port: 12345,
    });
    expect(b.primitiveCatalogCount).toBe(0);
  });

  it('threads primitive catalogs from the CLI discovery phase to the backend handle (OSS Phase 4 #3/#4 wiring)', () => {
    // The CLI runs `discoverPrimitives()` before building the backend
    // and forwards the resolved catalogs through
    // `buildMcpServerBackend({ primitiveCatalogs })`. This test fakes
    // the discovery output and proves the count surfaces on the
    // returned `ServeBackend` — i.e. the declaration is no longer
    // inert, there is a boot-time "capability was consumed" signal
    // the serve banner / future consumers can read.
    const catalogs: DiscoveredPrimitiveCatalog[] = [
      {
        source: 'package',
        import: '@ggui-ai/design/primitives',
        manifestPath: '/tmp/design/ggui.primitives.json',
        manifest: {
          schema: '1',
          import: '@ggui-ai/design/primitives',
          primitives: [{ name: 'Button' }, { name: 'Card' }],
        },
      },
      {
        source: 'local',
        import: './ui/primitives/index.js',
        manifestPath: '/tmp/app/ui/primitives/ggui.primitives.json',
        manifest: {
          schema: '1',
          import: './ui/primitives/index.js',
          primitives: [{ name: 'Brand' }],
        },
      },
    ];
    const b = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port: 12345,
      primitiveCatalogs: catalogs,
    });
    expect(b.primitiveCatalogCount).toBe(catalogs.length);
  });

  it('defaults `themeSource` to "default" when the CLI passes no theme', () => {
    // Mirrors zero-config first-run: no `ggui.json#theme` declared
    // → `loadTheme` returns default → CLI passes no `theme` opt →
    // `createGguiServer` falls back internally → backend reports
    // `themeSource: 'default'`. Construction-only assertion.
    const b = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port: 12345,
    });
    expect(b.themeSource).toBe('default');
  });

  it('threads a file-sourced LoadedTheme from the CLI loader phase to the backend handle (OSS Phase 4 #4 wiring)', () => {
    // The CLI runs `loadTheme()` before building the backend and
    // forwards the resolved `LoadedTheme` through
    // `buildMcpServerBackend({ theme })`. This test fakes a
    // file-sourced load and proves the source surfaces on the
    // returned `ServeBackend` — i.e. the declaration is no longer
    // inert, there is a boot-time "capability was consumed" signal
    // the serve banner / future consumers can read.
    const theme: LoadedTheme = {
      source: 'file',
      path: '/tmp/app/theme.json',
      document: {
        color: {
          primary: { '500': { $type: 'color', $value: '#ff00ff' } },
          surface: { $type: 'color', $value: '#000000' },
        },
        spacing: { '4': { $type: 'dimension', $value: '16px' } },
        typography: {
          fontFamily: {
            sans: { $type: 'fontFamily', $value: 'Brand Sans' },
          },
          fontSize: { md: { $type: 'dimension', $value: '16px' } },
          fontWeight: {
            regular: { $type: 'fontWeight', $value: 400 },
          },
          lineHeight: { normal: { $type: 'number', $value: 1.5 } },
        },
        radius: { md: { $type: 'dimension', $value: '8px' } },
        shadow: {
          sm: {
            $type: 'shadow',
            $value: {
              offsetX: '0',
              offsetY: '1px',
              blur: '2px',
              spread: '0',
              color: 'rgba(0,0,0,.05)',
            },
          },
        },
      },
      cssVariables: ':root {\n  --ggui-color-primary-500: #ff00ff;\n}',
    };
    const b = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port: 12345,
      theme,
    });
    expect(b.themeSource).toBe('file');
  });

  it('surfaces manifest-declared UIs through ggui_list_featured_blueprints (OSS Phase 4 #4 wiring)', async () => {
    // End-to-end proof of the blueprint-consumption path. The CLI
    // normally constructs the provider from a `discoverLocalUis()`
    // result; here we feed pre-parsed seeds so the test stays scoped
    // to the "provider → handler → MCP tool" leg. The "ggui.json glob
    // → manifests" leg is covered by `discovery.test.ts` in
    // `@ggui-ai/project-config`.
    const blueprintProvider = new ManifestBlueprintProvider({
      manifests: [
        {
          id: 'weather-card',
          name: 'Weather Card',
          description: 'Shows a city forecast',
          category: 'data',
        },
      ],
    });
    // Pre-assign a port so the backend composes deterministic URLs.
    const port = await pickFreePort();
    backend = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port,
      blueprintProvider,
    });
    boundPort = await backend.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${boundPort}`;

    const token = await mintPairToken(backend, base, 'blueprint-smoke');
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test-list-featured',
        method: 'tools/call',
        params: { name: 'ggui_list_featured_blueprints', arguments: {} },
      }),
    });
    expect(res.ok).toBe(true);
    const body = await readJsonOrSse(res);
    const result = body.result as {
      structuredContent: {
        blueprints: Array<{ id: string; name: string }>;
        total: number;
      };
    };
    expect(result.structuredContent.total).toBe(1);
    expect(result.structuredContent.blueprints).toHaveLength(1);
    expect(result.structuredContent.blueprints[0]).toMatchObject({
      id: 'weather-card',
      name: 'Weather Card',
      source: 'user',
    });
  });

  // `adapters` opt + handle field retired in Bucket B (2026-05-18,
  // LOCKED-22). Grant model lives entirely on
  // `clientCapabilities.gadgets[*].permission`. No handle field, no
  // opt — anyone wanting to lock down hardware access does it via the
  // gadget catalog now.

  it('aggregates a Slice 6 mcpMounts bundle onto tools/list (operator-facing mount path)', async () => {
    // End-to-end proof of the operator-facing Slice 6 seam. The CLI
    // normally resolves each `ggui.json#mcpMounts` entry via
    // `discoverMcpMounts()` — here we skip the discovery step and
    // feed a pre-constructed `McpServerMount` directly (discovery's
    // own tests live in `@ggui-ai/project-config`). What THIS test
    // covers: that a `McpServerMount` reaching `buildMcpServerBackend`
    // actually aggregates through `composeHandlersWithMounts` and
    // the mounted tools are visible on the real `/mcp` wire
    // alongside `ggui_render` under strict-auth.
    //
    // Uses 2 trivial tools (slice6_demo_ping + slice6_demo_echo) so
    // the assertion is shape-based + doesn't duplicate the Tasks
    // fixture's full surface. The E2E proof that the CLI binary's
    // `runServeCommand` actually reaches this path via `ggui.json`
    // lives in `e2e/ggui-oss/tests/mcp-mount-via-serve.spec.ts`.
    const mount: McpServerMount = {
      name: 'slice6-demo',
      handlers: [
        {
          name: 'slice6_demo_ping',
          description: 'Return "pong". Proves aggregation into tools/list.',
          inputSchema: {},
          outputSchema: { pong: z.literal('pong') },
          async handler() {
            return { pong: 'pong' } as const;
          },
        } as SharedHandler<ZodRawShape, ZodRawShape>,
        {
          name: 'slice6_demo_echo',
          description: 'Return the supplied `message`. Proves tools/call dispatches to the mount handler, not ggui-native.',
          inputSchema: { message: z.string() },
          outputSchema: { echoed: z.string() },
          async handler(raw: unknown) {
            const parsed = z
              .object({ message: z.string() })
              .parse(raw);
            return { echoed: parsed.message };
          },
        } as SharedHandler<ZodRawShape, ZodRawShape>,
      ],
    };

    const port = await pickFreePort();
    backend = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port,
      mcpMounts: [mount],
    });
    // toolCount surfaces ggui-native (≥13 after the master-plan
    // additions — see the floor comment above) + 2 mounted. Pin the
    // exact delta (`baseline + 2`) instead of the absolute number so
    // the additive-mount invariant stays load-bearing without
    // re-litigating the floor on every new tool.
    const baselineBackend = buildMcpServerBackend({
      cliVersion: 'test-0.0.0',
      host: '127.0.0.1',
      port: port + 1,
    });
    expect(backend.toolCount).toBe(baselineBackend.toolCount + 2);

    boundPort = await backend.listen(port, '127.0.0.1');
    const base = `http://127.0.0.1:${boundPort}`;
    const token = await mintPairToken(backend, base, 'mcp-mounts-smoke');

    // tools/list surfaces BOTH families through the same bearer.
    const listRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mount-list',
        method: 'tools/list',
        params: {},
      }),
    });
    expect(listRes.ok).toBe(true);
    const listBody = await readJsonOrSse(listRes);
    const tools = (listBody.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('ggui_render');
    expect(names).toContain('slice6_demo_ping');
    expect(names).toContain('slice6_demo_echo');

    // tools/call reaches the mount's handler — not some accidental
    // ggui-native passthrough. Round-trips `{ message }` → `{ echoed }`.
    const callRes = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'mount-echo',
        method: 'tools/call',
        params: {
          name: 'slice6_demo_echo',
          arguments: { message: 'hello from slice 6' },
        },
      }),
    });
    expect(callRes.ok).toBe(true);
    const callBody = await readJsonOrSse(callRes);
    const callResult = callBody.result as {
      structuredContent: { echoed: string };
      isError?: boolean;
    };
    expect(callResult.isError).not.toBe(true);
    expect(callResult.structuredContent.echoed).toBe('hello from slice 6');
  });

  // Slice 5 follow-up (2026-05-18, M1): proves the CLI's
  // `buildMcpServerBackend` install-bridge wiring passes through
  // `createGguiServer`'s H1 reference-equality enforcement without
  // throwing. Pre-Slice-5 the CLI integration path was entirely
  // untested — a regression that broke instance-sharing between
  // bridge.deps.vectorStore and server.vectors would have shipped
  // silently. H1 now throws at boot on mismatch; this test
  // structurally confirms that the CLI's mcp-backend.ts wiring
  // produces a non-throwing composition.
  it('wires installedBlueprints with shared embedding+vectorStore (Slice 5 M1)', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'ggui-m1-install-bridge-'));
    try {
      const installSub = join(
        projectRoot,
        '.ggui/installed-blueprints/test__counter__1.0.0',
      );
      mkdirSync(installSub, { recursive: true });
      const manifestPath = join(installSub, 'ggui.ui.json');
      const manifest: UiManifest = {
        id: 'test:counter:1.0.0',
        name: '@test/counter',
        contract: {
          contextSpec: {
            count: { schema: { type: 'number' }, default: 0 },
          },
        },
      } as UiManifest;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(
        join(installSub, 'index.tsx'),
        'export default function C() { return null; }',
      );

      const port = await pickFreePort();
      backend = buildMcpServerBackend({
        cliVersion: 'test-0.0.0',
        host: '127.0.0.1',
        port,
        installedBlueprints: {
          projectRoot,
          entries: [
            {
              id: 'test:counter:1.0.0',
              manifestPath,
              manifest,
            },
          ],
        },
      });
      // H1's reference-equality enforcement runs during
      // createGguiServer construction. If the CLI's wiring drifts —
      // e.g. constructing the provider with a different vectorStore
      // than what the server resolves — boot would have thrown
      // before this line. Reaching it proves the wiring is intact.
      boundPort = await backend.listen(port, '127.0.0.1');
      expect(boundPort).toBe(port);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts an empty installedBlueprints entries array without wiring a provider (Slice 5 M1)', async () => {
    // Defensive: operators with no marketplace installs still pass
    // `installedBlueprints` (the CLI's filter may return an empty
    // entries array). mcp-backend.ts gates provider construction on
    // `entries.length > 0`, so the H1 enforcement also skips.
    const projectRoot = mkdtempSync(join(tmpdir(), 'ggui-m1-empty-bridge-'));
    try {
      const port = await pickFreePort();
      backend = buildMcpServerBackend({
        cliVersion: 'test-0.0.0',
        host: '127.0.0.1',
        port,
        installedBlueprints: {
          projectRoot,
          entries: [], // empty
        },
      });
      boundPort = await backend.listen(port, '127.0.0.1');
      expect(boundPort).toBe(port);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

async function readJsonOrSse(res: Response): Promise<{ result?: unknown; error?: unknown }> {
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    const dataLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!dataLine) throw new Error(`MCP SSE response had no data frame: ${text}`);
    return JSON.parse(dataLine.slice(5).trim()) as { result?: unknown; error?: unknown };
  }
  return (await res.json()) as { result?: unknown; error?: unknown };
}
