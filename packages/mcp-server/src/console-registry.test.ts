/**
 * Wire tests for `GET /ggui/console/registry` — the JSON catalog the
 * console SPA's `/registry` page consumes.
 *
 * Covers the shape locked in
 * `docs/plans/2026-04-22-console-page-construction.md` §3.1:
 *
 *   - zero-config empty shape (no uiRegistry, no primitiveCatalogs)
 *   - blueprints[] populated from uiRegistry.list() with optional
 *     description + category surfacing
 *   - primitives[] populated from opts.primitiveCatalogs, flattened
 *     one primitive per row with catalog.source + catalog.import
 *   - stable sort order so the SPA's filter-as-you-type UI doesn't
 *     need a second sort pass (blueprints by id, primitives by
 *     catalog then name)
 *   - console-disabled → 404 (route doesn't even mount)
 *   - blueprint list failure bubbles to 500 with a structured error
 *
 * Lane 3 of the 4-lane test taxonomy (vitest + in-process fake
 * registry, no browser, no spawned CLI).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type {
  UiBundle,
  UiManifestEntry,
  UiRegistry,
  UiRegistryCapabilities,
} from '@ggui-ai/ui-registry';
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

interface FakeBlueprintSeed {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly category?: string;
}

/**
 * Test-only `UiRegistry` — seeded with the minimal `UiManifest`
 * subset the /registry endpoint reads. Casts through the manifest
 * shape to avoid depending on `@ggui-ai/project-config`'s full schema
 * parser; the endpoint reads only `id`, `manifest.name`,
 * `manifest.description?`, `manifest.category?`.
 */
function makeFakeRegistry(
  seeds: readonly FakeBlueprintSeed[],
  opts: { failList?: Error } = {},
): UiRegistry {
  const capabilities: UiRegistryCapabilities = {
    writable: false,
    observable: false,
  };
  return {
    capabilities,
    async list(): Promise<UiManifestEntry[]> {
      if (opts.failList) throw opts.failList;
      return seeds.map((s) => {
        const manifest = {
          id: s.id,
          name: s.name,
          ...(s.description !== undefined ? { description: s.description } : {}),
          ...(s.category !== undefined ? { category: s.category } : {}),
        } as UiManifestEntry['manifest'];
        return { id: s.id, contentHash: `hash-${s.id}`, manifest };
      });
    },
    async get(id: string): Promise<UiManifestEntry | undefined> {
      const seed = seeds.find((s) => s.id === id);
      if (!seed) return undefined;
      const manifest = {
        id: seed.id,
        name: seed.name,
      } as UiManifestEntry['manifest'];
      return { id: seed.id, contentHash: `hash-${seed.id}`, manifest };
    },
    async getBundle(): Promise<UiBundle | undefined> {
      return undefined;
    },
  };
}

interface RegistryResponse {
  readonly blueprints: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly category?: string;
  }>;
  readonly primitives: ReadonlyArray<{
    readonly name: string;
    readonly source: 'package' | 'local';
    readonly catalog: string;
  }>;
}

describe('GET /ggui/console/registry', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns an honest empty shape when neither uiRegistry nor primitiveCatalogs are wired', async () => {
    fx = await boot({ console: {} });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as RegistryResponse;
    expect(body).toEqual({ blueprints: [], primitives: [] });
  });

  it('surfaces blueprint id + name from uiRegistry.list()', async () => {
    const uiRegistry = makeFakeRegistry([
      { id: 'weather-card', name: 'Weather Card' },
      { id: 'kanban-board', name: 'Kanban Board' },
    ]);
    fx = await boot({ console: {}, uiRegistry });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RegistryResponse;
    // Stable sort by id — alphabetical, regardless of seed order.
    expect(body.blueprints.map((b) => b.id)).toEqual([
      'kanban-board',
      'weather-card',
    ]);
    expect(body.blueprints[0]).toEqual({
      id: 'kanban-board',
      name: 'Kanban Board',
    });
  });

  it('surfaces blueprint description + category when present on the manifest', async () => {
    const uiRegistry = makeFakeRegistry([
      {
        id: 'weather-card',
        name: 'Weather Card',
        description: 'Shows current conditions for a city',
        category: 'data',
      },
      // No description/category — must not appear in the summary.
      { id: 'plain', name: 'Plain' },
    ]);
    fx = await boot({ console: {}, uiRegistry });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    const body = (await res.json()) as RegistryResponse;
    const withMeta = body.blueprints.find((b) => b.id === 'weather-card');
    expect(withMeta).toEqual({
      id: 'weather-card',
      name: 'Weather Card',
      description: 'Shows current conditions for a city',
      category: 'data',
    });
    const withoutMeta = body.blueprints.find((b) => b.id === 'plain');
    // Absence must mean the key is ABSENT on the wire — not present-
    // with-undefined. Downstream JSON.stringify would serialize
    // undefined as "null" on arrays but strip it on objects, so the
    // guard is that neither key appears when the manifest omits it.
    expect(withoutMeta).toEqual({ id: 'plain', name: 'Plain' });
    expect(Object.keys(withoutMeta ?? {})).not.toContain('description');
    expect(Object.keys(withoutMeta ?? {})).not.toContain('category');
  });

  it('flattens primitives per row with source + catalog tags', async () => {
    fx = await boot({
      console: {},
      primitiveCatalogs: [
        {
          source: 'package' as const,
          import: '@ggui-ai/design/primitives',
          manifestPath: '/tmp/design/ggui.primitives.json',
          manifest: {
            schema: '1' as const,
            import: '@ggui-ai/design/primitives',
            primitives: [{ name: 'Button' }, { name: 'Card' }],
          },
        },
        {
          source: 'local' as const,
          import: './ui/primitives/index.js',
          manifestPath: '/tmp/app/ui/primitives/ggui.primitives.json',
          manifest: {
            schema: '1' as const,
            import: './ui/primitives/index.js',
            primitives: [{ name: 'Brand' }],
          },
        },
      ],
    });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    const body = (await res.json()) as RegistryResponse;
    expect(body.primitives).toHaveLength(3);
    // Sort: primary by catalog import, secondary by name. '.' sorts
    // before '@' in locale-aware comparison, so the local catalog
    // lands first. Operators see "everything from one catalog" as a
    // contiguous block, which matches the registry page's two-column
    // read order.
    expect(body.primitives).toEqual([
      { name: 'Brand', source: 'local', catalog: './ui/primitives/index.js' },
      {
        name: 'Button',
        source: 'package',
        catalog: '@ggui-ai/design/primitives',
      },
      {
        name: 'Card',
        source: 'package',
        catalog: '@ggui-ai/design/primitives',
      },
    ]);
  });

  it('404s when console is not enabled', async () => {
    // Even with uiRegistry + primitiveCatalogs wired, the JSON
    // endpoint only mounts when `console` is enabled. Operators
    // running in pure-MCP mode (no SPA) shouldn't see a surprise
    // JSON surface.
    fx = await boot({
      uiRegistry: makeFakeRegistry([{ id: 'any', name: 'Any' }]),
    });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    expect(res.status).toBe(404);
  });

  it('500s with a structured error when the registry list() throws', async () => {
    const uiRegistry = makeFakeRegistry([], {
      failList: new Error('registry backend unavailable'),
    });
    fx = await boot({ console: {}, uiRegistry });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('registry_unavailable');
    expect(body.message).toContain('registry backend unavailable');
  });

  it('composes both sources together in one response when both are wired', async () => {
    fx = await boot({
      console: {},
      uiRegistry: makeFakeRegistry([
        { id: 'weather-card', name: 'Weather Card', category: 'data' },
      ]),
      primitiveCatalogs: [
        {
          source: 'package' as const,
          import: '@ggui-ai/design/primitives',
          manifestPath: '/tmp/design/ggui.primitives.json',
          manifest: {
            schema: '1' as const,
            import: '@ggui-ai/design/primitives',
            primitives: [{ name: 'Button' }],
          },
        },
      ],
    });
    const res = await fetch(`${fx.url}/ggui/console/registry`);
    const body = (await res.json()) as RegistryResponse;
    expect(body.blueprints).toHaveLength(1);
    expect(body.blueprints[0]?.category).toBe('data');
    expect(body.primitives).toHaveLength(1);
    expect(body.primitives[0]?.name).toBe('Button');
  });
});
