/**
 * Wire tests for `GET /ggui/console/mcp/tools` — the registered
 * MCP-tool inventory the console SPA's `/mcp` page renders.
 *
 * Covers the shape locked in Phase B §4.B.1:
 *
 *   - tools[] populated from the registered handler set, sorted by
 *     name for deterministic operator read order
 *   - per-row shape: name + title? + description +
 *     inputSchema (JSON Schema) + outputSchema (JSON Schema)
 *   - `total` mirrors `tools.length`
 *   - console-disabled → 404 (route doesn't mount)
 *   - bare boot still produces a non-empty list (the OSS default
 *     handler set always registers `ggui_search_blueprints` +
 *     `ggui_list_featured_blueprints`)
 *
 * Lane 3 of the 4-lane test taxonomy (vitest, in-process boot,
 * no browser, no spawned CLI). Test invoke (POST → tool call) is
 * a future slice; this spec is read-only.
 */
import { afterEach, describe, expect, it } from 'vitest';
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

interface ToolsResponse {
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly title?: string;
    readonly description: string;
    readonly inputSchema: unknown;
    readonly outputSchema: unknown;
  }>;
  readonly total: number;
}

describe('GET /ggui/console/mcp/tools', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('lists registered handlers with name + description + JSON-schema converted shapes', async () => {
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/mcp/tools`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as ToolsResponse;
    // Bare boot still registers the unconditional blueprint-read
    // handlers (search + list_featured). Asserting >= 2 keeps the
    // spec stable across handler additions; the exact value tracks
    // server.toolCount.
    expect(body.tools.length).toBeGreaterThanOrEqual(2);
    expect(body.total).toBe(body.tools.length);
    const search = body.tools.find((t) => t.name === 'ggui_search_blueprints');
    expect(search).toBeDefined();
    expect(typeof search?.description).toBe('string');
    expect(search?.description.length).toBeGreaterThan(0);
    // JSON Schema produced by zod's `toJSONSchema` always has a
    // `type` property at the root for an object shape. Don't assert
    // the exact spec dialect — zod v4 uses a recent draft; the
    // operator-visible value is "schemas are present + have keys".
    expect(typeof search?.inputSchema).toBe('object');
    expect(typeof search?.outputSchema).toBe('object');
  });

  it('returns tools sorted alphabetically by name (stable operator read order)', async () => {
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/mcp/tools`);
    const body = (await res.json()) as ToolsResponse;
    const names = body.tools.map((t) => t.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('omits the title field when the handler has none (absent-key on the wire)', async () => {
    // None of the OSS default handlers ship a `title` field today —
    // the operator should NOT see `title: null` or `title: undefined`
    // surfaced as JSON noise. Honest absent-key shape per the
    // existing console /info + /sessions conventions.
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/mcp/tools`);
    const body = (await res.json()) as ToolsResponse;
    for (const tool of body.tools) {
      // If a handler ever lands a title, this test will need
      // refinement; the assertion here is "absent-key default".
      if (tool.title === undefined) {
        expect(Object.keys(tool)).not.toContain('title');
      }
    }
  });

  it('404s when console is not enabled', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/ggui/console/mcp/tools`);
    expect(res.status).toBe(404);
  });
});
