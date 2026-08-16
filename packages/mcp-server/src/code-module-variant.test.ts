/**
 * Wire tests for the strict-CSP module-variant family (ggui#522
 * slice 2):
 *
 *   - `GET /code/<hash>.m<rt>.js` — the server-side import-rewritten
 *     ESM variant a strict-CSP frame `import()`s directly. The variant
 *     KEY (`<rt>`, the runtime bundle's 12-hex content hash) lives in
 *     the PATH because the asset CDN's cache policy ignores query
 *     strings — a query-keyed variant would collapse across runtime
 *     versions.
 *   - `GET /_ggui/shims/<rt>/<name>.js` — the static shim assets the
 *     rewrite points at, served immutable for the CURRENT `<rt>` only.
 *
 * Boots the real factory against the real iframe-runtime dist (bundle
 * + shims), so `<rt>` here is whatever the workspace build hashes to —
 * derived via `resolveRuntimeBundleHash()`, the same helper composed
 * deployments (the cloud pod) use to stamp their `codeModuleUrl`s.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import { sha256Hex } from '@ggui-ai/mcp-server-core';
import {
  InMemoryAuthAdapter,
  InMemoryCodeStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  createGguiServer,
  type GguiServer,
} from './server.js';
import {
  composeCodeModuleUrl,
  createCodeModuleUrlMinter,
} from './code-module-variant.js';
import { resolveRuntimeBundleHash } from './runtime-bundle-hash.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const CODE = [
  `import { jsx } from "react/jsx-runtime";`,
  `import { Card } from "@ggui-ai/design/primitives";`,
  `export default function X(){return jsx(Card, {});}`,
].join('\n');

interface Fixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  store: InMemoryCodeStore;
}

async function boot(): Promise<Fixture> {
  const store = new InMemoryCodeStore();
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    wsTokenSecret: 's'.repeat(32),
    codeStore: store,
    publicBaseUrl: 'https://public.test.example',
    codeBaseUrl: 'https://assets.test.example',
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return { server, httpServer, url: `http://127.0.0.1:${addr.port}`, store };
}

// The workspace's built runtime bundle — the same file the factory
// hashes at composition. Skipping (not failing) when absent would hide
// a broken build behind green tests; the dist is a checked build input
// here exactly like it is for the factory.
const rt = resolveRuntimeBundleHash();
if (rt === undefined) {
  throw new Error(
    'iframe-runtime dist bundle missing — run `pnpm --filter @ggui-ai/iframe-runtime build` first',
  );
}

describe('GET /code/<hash>.m<rt>.js — strict-CSP module variant', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('serves the rewritten variant: shim URLs on the code origin, no bare specifiers, immutable', async () => {
    fx = await boot();
    const hash = sha256Hex(CODE);
    await fx.store.put(hash, CODE);

    const res = await fetch(`${fx.url}/code/${hash}.m${rt}.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.text();
    // Every bare specifier resolved to an absolute shim asset under
    // the configured code base URL + the CURRENT runtime hash.
    expect(body).toContain(
      `from "https://assets.test.example/_ggui/shims/${rt}/jsx-runtime.js"`,
    );
    expect(body).toContain(
      `from "https://assets.test.example/_ggui/shims/${rt}/primitives.js"`,
    );
    expect(body).not.toContain('"react/jsx-runtime"');
    expect(body).not.toContain('"@ggui-ai/design/primitives"');
    // No data:/blob: anywhere — the whole point of the variant.
    expect(body).not.toContain('data:text/javascript');
  });

  it('404s (no-store) a foreign runtime hash — stale variant URLs fall back, never lock wrong bytes', async () => {
    fx = await boot();
    const hash = sha256Hex(CODE);
    await fx.store.put(hash, CODE);

    const res = await fetch(`${fx.url}/code/${hash}.m${'0'.repeat(12)}.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('404s (no-store) code importing a package with no static shim — the decline arm', async () => {
    fx = await boot();
    const code = `import { useLeafletMap } from "@acme/gadget-leaflet";\nexport default function X(){return null}`;
    const hash = sha256Hex(code);
    await fx.store.put(hash, code);

    const res = await fetch(`${fx.url}/code/${hash}.m${rt}.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('does not shadow the plain route: /code/<hash>.js still serves raw bytes', async () => {
    fx = await boot();
    const hash = sha256Hex(CODE);
    await fx.store.put(hash, CODE);

    const res = await fetch(`${fx.url}/code/${hash}.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CODE);
  });
});

describe('GET /_ggui/shims/<rt>/<name>.js — static shim assets', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('serves the current-rt shims immutable with CORS *', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/_ggui/shims/${rt}/react.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.text();
    // The data-url shim body, as a file: resolves the __ggui__ registry.
    expect(body).toContain('globalThis.__ggui__');
    expect(body).toContain('export default R;');
  });

  it('404s (no-store) a foreign rt and unknown shim names', async () => {
    fx = await boot();
    const foreign = await fetch(
      `${fx.url}/_ggui/shims/${'0'.repeat(12)}/react.js`,
    );
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('cache-control')).toBe('no-store');

    const unknown = await fetch(`${fx.url}/_ggui/shims/${rt}/nope.js`);
    expect(unknown.status).toBe(404);
  });
});

describe('createCodeModuleUrlMinter — the emitter-side coverability gate', () => {
  it('mints the variant URL for shim-coverable code', () => {
    const mint = createCodeModuleUrlMinter({ runtimeHash: rt! });
    const hash = sha256Hex(CODE);
    expect(mint({ code: CODE, hash, base: 'https://assets.test.example' })).toBe(
      composeCodeModuleUrl({
        base: 'https://assets.test.example',
        hash,
        runtimeHash: rt!,
      }),
    );
  });

  it('declines for code importing a shim-less package — the slice then carries raw carriers only', () => {
    const mint = createCodeModuleUrlMinter({ runtimeHash: rt! });
    const code = `import { X } from "@acme/widgets";\nexport default X;`;
    expect(
      mint({ code, hash: sha256Hex(code), base: 'https://assets.test.example' }),
    ).toBeUndefined();
  });

  it('ignores marker-block content when scanning imports (markers stripped first)', () => {
    const mint = createCodeModuleUrlMinter({ runtimeHash: rt! });
    // Marker content that WOULD read as a bare import if the scanner
    // saw it — proves the mint strips markers before scanning. The
    // same text outside a marker declines the mint (previous test).
    const marker = `/* __GGUI_META__ example: import "@acme/not-shimmed" __GGUI_META_END__ */`;
    const code =
      `import { jsx } from "react/jsx-runtime";\n` +
      `export default function X(){return null}\n` +
      marker;
    const hash = sha256Hex(code);
    expect(
      mint({ code, hash, base: 'https://assets.test.example' }),
    ).toBeTypeOf('string');
  });
});
