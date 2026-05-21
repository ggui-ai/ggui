/**
 * `createRenderBlueprintHandler` — happy-path + failure-mode coverage
 * against a fake `UiRegistry`. No esbuild; the stub returns canned
 * bundle strings so the handler's resolve → fetch → materialize →
 * emit chain is the whole subject under test.
 *
 * The OSS reference registry (`@ggui-ai/dev-stack::LocalUiRegistry`)
 * has its own compile-on-demand coverage; layering esbuild here would
 * double-test the registry contract without surfacing anything the
 * handler owns.
 */
import { describe, expect, it } from 'vitest';
import type {
  UiBundle,
  UiManifestEntry,
  UiRegistry,
  UiRegistryCapabilities,
} from '@ggui-ai/ui-registry';
import type { HandlerContext } from '../types.js';
import { createRenderBlueprintHandler } from './render-blueprint.js';

const ctx: HandlerContext = { appId: 'app-a', requestId: 'r-1' };

/**
 * Minimal `UiManifest`-shaped record — matches the subset the handler
 * reads. The full `UiManifest` parser (`@ggui-ai/project-config`) fills
 * lots of fields the render handler doesn't look at; the test casts
 * through a narrow object to avoid importing a schema dep just to
 * satisfy structural typing.
 */
function makeManifest(id: string, name: string): UiManifestEntry['manifest'] {
  return { id, name } as UiManifestEntry['manifest'];
}

function makeEntry(id: string, name: string): UiManifestEntry {
  return {
    id,
    contentHash: `hash-${id}`,
    manifest: makeManifest(id, name),
  };
}

/** Test-only `UiRegistry` — seeded at construction, read-only. */
function makeFakeRegistry(
  entries: ReadonlyArray<{
    id: string;
    name: string;
    /** Pass `null` to simulate "entry known, bundle missing" (source-only). */
    bundle: UiBundle | null;
  }>,
): UiRegistry {
  const byId = new Map(entries.map((e) => [e.id, e] as const));
  const capabilities: UiRegistryCapabilities = {
    writable: false,
    observable: false,
  };
  return {
    capabilities,
    async list(): Promise<UiManifestEntry[]> {
      return Array.from(byId.values()).map((e) => makeEntry(e.id, e.name));
    },
    async get(id: string): Promise<UiManifestEntry | undefined> {
      const seed = byId.get(id);
      return seed ? makeEntry(seed.id, seed.name) : undefined;
    },
    async getBundle(id: string): Promise<UiBundle | undefined> {
      const seed = byId.get(id);
      if (!seed || seed.bundle === null) return undefined;
      return seed.bundle;
    },
  };
}

const COMPILED_WEATHER_BUNDLE = `export default function WeatherCard(){return null;}`;

describe('createRenderBlueprintHandler', () => {
  it('exposes the canonical MCP name + schemas', () => {
    const handler = createRenderBlueprintHandler({
      uiRegistry: makeFakeRegistry([]),
    });
    expect(handler.name).toBe('ggui_render_blueprint');
    expect(handler.inputSchema).toBeDefined();
    expect(handler.outputSchema).toBeDefined();
  });

  it('resolves a known blueprint to inline code + metadata (happy path)', async () => {
    const registry = makeFakeRegistry([
      {
        id: 'weather-card-fixture',
        name: 'Weather Card Fixture',
        bundle: {
          code: COMPILED_WEATHER_BUNDLE,
          contentType: 'application/javascript+react',
        },
      },
    ]);
    const handler = createRenderBlueprintHandler({ uiRegistry: registry });
    const out = await handler.handler(
      { blueprintId: 'weather-card-fixture' },
      ctx,
    );
    expect(out.blueprintId).toBe('weather-card-fixture');
    expect(out.blueprintName).toBe('Weather Card Fixture');
    expect(out.code).toBe(COMPILED_WEATHER_BUNDLE);
    expect(out.contentType).toBe('application/javascript+react');
  });

  it('materializes a ReadableStream bundle to a plain string', async () => {
    // Some UiRegistry implementations (cloud origins) return a
    // ReadableStream for large bundles. The handler drains the
    // stream so the MCP wire carries a plain string field.
    const chunks = [
      new TextEncoder().encode('export default '),
      new TextEncoder().encode(`function Streamed(){return null;}`),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
    const registry = makeFakeRegistry([
      {
        id: 'streamed',
        name: 'Streamed Bundle',
        bundle: { code: stream, contentType: 'application/javascript+react' },
      },
    ]);
    const handler = createRenderBlueprintHandler({ uiRegistry: registry });
    const out = await handler.handler({ blueprintId: 'streamed' }, ctx);
    expect(out.code).toBe(
      'export default function Streamed(){return null;}',
    );
  });

  it('throws when the id is unknown (registry.get returns undefined)', async () => {
    const registry = makeFakeRegistry([
      {
        id: 'known',
        name: 'Known',
        bundle: {
          code: COMPILED_WEATHER_BUNDLE,
          contentType: 'application/javascript+react',
        },
      },
    ]);
    const handler = createRenderBlueprintHandler({ uiRegistry: registry });
    await expect(
      handler.handler({ blueprintId: 'unknown-id' }, ctx),
    ).rejects.toThrow(/no blueprint registered with id/);
  });

  it('throws when the id is known but the bundle is absent (source-only / compile-failed)', async () => {
    // Load-bearing distinction between "unknown id" and "known id,
    // no bundle today". The error message must carry the
    // blueprint's human name + a hint about missing TSX / compile
    // failure so operators can fix the root cause.
    const registry = makeFakeRegistry([
      {
        id: 'missing-bundle',
        name: 'No TSX Entry',
        bundle: null,
      },
    ]);
    const handler = createRenderBlueprintHandler({ uiRegistry: registry });
    await expect(
      handler.handler({ blueprintId: 'missing-bundle' }, ctx),
    ).rejects.toThrow(/has no bundle available/);
    await expect(
      handler.handler({ blueprintId: 'missing-bundle' }, ctx),
    ).rejects.toThrow(/No TSX Entry/);
  });

  it('rejects empty blueprintId via zod before touching the registry', async () => {
    const registry = makeFakeRegistry([]);
    const handler = createRenderBlueprintHandler({ uiRegistry: registry });
    await expect(handler.handler({ blueprintId: '' }, ctx)).rejects.toThrow();
  });
});
