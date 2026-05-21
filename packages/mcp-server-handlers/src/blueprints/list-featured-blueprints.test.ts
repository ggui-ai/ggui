import { describe, expect, it } from 'vitest';
import { ManifestBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';
import type { HandlerContext } from '../types.js';
import { createListFeaturedBlueprintsHandler } from './list-featured-blueprints.js';

const ctx: HandlerContext = { appId: 'app-a', requestId: 'r-1' };
const now = () => new Date('2026-04-20T00:00:00Z').getTime();

describe('createListFeaturedBlueprintsHandler — zero-config (no provider)', () => {
  it('has the canonical MCP name + zod schemas', () => {
    const handler = createListFeaturedBlueprintsHandler();
    expect(handler.name).toBe('ggui_list_featured_blueprints');
    expect(handler.inputSchema).toBeDefined();
    expect(handler.outputSchema).toBeDefined();
  });

  it('returns an empty catalog when no provider is bound', async () => {
    const handler = createListFeaturedBlueprintsHandler();
    const result = await handler.handler({}, ctx);
    expect(result).toEqual({ blueprints: [], total: 0 });
  });

  // The `category` input was retired 2026-05-13 — it was only ever
  // forwarded as `tag` and confused callers into thinking it filtered
  // categories independently. Use `tag` instead.
});

describe('createListFeaturedBlueprintsHandler — ManifestBlueprintProvider wiring', () => {
  it('enumerates the provider catalog when bound', async () => {
    const blueprints = new ManifestBlueprintProvider({
      now,
      manifests: [
        {
          id: 'weather-card',
          name: 'Weather',
          description: 'City forecast',
          category: 'data',
        },
        {
          id: 'contact-form',
          name: 'Contact',
          description: 'Send a message',
          category: 'form',
        },
      ],
    });
    const handler = createListFeaturedBlueprintsHandler({ blueprints });
    const result = await handler.handler({}, ctx);
    expect(result.total).toBe(2);
    expect(result.blueprints.map((b) => b['id']).sort()).toEqual([
      'contact-form',
      'weather-card',
    ]);
    // Each entry surfaces the canonical BlueprintEntry shape.
    const weather = result.blueprints.find((b) => b['id'] === 'weather-card');
    expect(weather).toMatchObject({
      id: 'weather-card',
      name: 'Weather',
      description: 'City forecast',
      source: 'user',
    });
  });

});
