/**
 * Wire tests for `GET /ggui/console/config` — the VSCode-settings-
 * style read of the resolved `ggui.json` that drives the console
 * SPA's `/config` page.
 *
 * Covers the three honest source states locked in Phase B Slice 2A:
 *
 *   - found + valid    → manifest + raw + schema
 *   - found + invalid  → raw + error message + schema (no manifest)
 *   - not found        → searchedFrom + schema only
 *
 * Plus the schema description surfacing — `.describe()` calls on
 * `GguiJsonV1` fields land as JSON-Schema `description` strings so
 * the SPA can render them inline.
 *
 * Lane 3 of the 4-lane test taxonomy (vitest, in-process boot,
 * tmp-dir fixtures for the manifest cases).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server as HttpServer } from 'node:http';
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
}

async function boot(
  opts: Parameters<typeof createGguiServer>[0] = {},
): Promise<Fixture> {
  const server = createGguiServer({ logger: silentLogger, ...opts });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return { server, httpServer, url: `http://127.0.0.1:${addr.port}` };
}

interface ConfigResponse {
  readonly source:
    | { readonly found: false; readonly searchedFrom: string }
    | {
        readonly found: true;
        readonly path: string;
        readonly error?: { readonly message: string };
      };
  readonly manifest?: unknown;
  readonly raw?: string;
  readonly schema: unknown;
}

describe('GET /ggui/console/config', () => {
  let fx: Fixture | null = null;
  let originalCwd: string;
  let tmpDir: string | null = null;

  beforeEach(() => {
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
    if (tmpDir) {
      // Restore CWD so it can be removed without "device busy".
      process.chdir(originalCwd);
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    } else {
      process.chdir(originalCwd);
    }
  });

  it('returns source.found:false + schema only when no ggui.json is reachable', async () => {
    // Walk-up start from a tmpdir where no manifest exists. The
    // findGguiJson walker stops at the filesystem root; tmpdir
    // typically has no parent ggui.json on CI. The endpoint must
    // still ship the schema so operators can browse what would be
    // configurable if they created one.
    tmpDir = mkdtempSync(join(tmpdir(), 'ggui-config-noop-'));
    process.chdir(tmpDir);
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/config`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ConfigResponse;
    expect(body.source.found).toBe(false);
    if (body.source.found === false) {
      expect(body.source.searchedFrom).toBe(tmpDir);
    }
    expect(body.manifest).toBeUndefined();
    expect(body.schema).toBeDefined();
    // Schema MUST carry the JSON-Schema description for at least one
    // field — this is the load-bearing surfacing of the
    // `.describe()` calls added on the GguiJsonV1 schema in this
    // slice. The page can't render documentation without it.
    const schema = body.schema as {
      properties?: Record<string, { description?: string }>;
    };
    expect(typeof schema.properties?.['app']?.description).toBe('string');
    expect(schema.properties?.['app']?.description).toMatch(/identity/i);
  });

  it('returns manifest + raw + schema when a valid ggui.json is reachable', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ggui-config-valid-'));
    const manifest = {
      schema: '1',
      protocol: '1.1',
      app: { slug: 'unit-test', name: 'Unit Test' },
    };
    const json = JSON.stringify(manifest, null, 2);
    writeFileSync(join(tmpDir, 'ggui.json'), json, 'utf-8');
    process.chdir(tmpDir);
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/config`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as ConfigResponse;
    expect(body.source.found).toBe(true);
    if (body.source.found === true) {
      expect(body.source.path).toBe(join(tmpDir, 'ggui.json'));
      expect(body.source.error).toBeUndefined();
    }
    expect(body.raw).toBe(json);
    // Manifest is the FULLY-DEFAULTED parse — `blueprints`,
    // `primitives`, `mcpMounts` get their defaults applied even when
    // the source file omits them. `adapters` retired in Bucket B
    // (2026-05-18, LOCKED-22).
    const m = body.manifest as {
      app: { slug: string; name: string };
      blueprints: { include: string[] };
    };
    expect(m.app).toEqual({ slug: 'unit-test', name: 'Unit Test' });
    expect(m.blueprints).toEqual({ include: [] });
  });

  it('returns raw + error message (no manifest) when ggui.json fails validation', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ggui-config-invalid-'));
    // Missing required `app` field — schema rejection.
    const badJson = JSON.stringify({ schema: '1', protocol: '1.1' }, null, 2);
    writeFileSync(join(tmpDir, 'ggui.json'), badJson, 'utf-8');
    process.chdir(tmpDir);
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/config`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    const body = (await res.json()) as ConfigResponse;
    expect(body.source.found).toBe(true);
    if (body.source.found === true) {
      expect(body.source.error).toBeDefined();
      expect(body.source.error?.message.length).toBeGreaterThan(0);
    }
    // The raw bytes still ship — operators inspect them while
    // fixing the validation error.
    expect(body.raw).toBe(badJson);
    // No fully-validated manifest in this state — the source-of-
    // truth on disk does not satisfy the contract.
    expect(body.manifest).toBeUndefined();
  });

  it('404s when console is not enabled', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/ggui/console/config`, { headers: { authorization: `Bearer ${fx.server.adminToken}` } });
    expect(res.status).toBe(404);
  });
});
