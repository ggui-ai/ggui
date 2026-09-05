/**
 * Tests for `createGguiGetRenderSourceHandler` (#282 data-plane source
 * read). Mirrors get-session.test.ts's structure — same
 * InMemoryGguiSessionStore harness, same seedRender shape.
 *
 * `source` must always be the AUTHORED text, never the compiled
 * bundle — fixtures below deliberately use DISTINCT `componentCode`
 * (looks compiled) vs `sourceCode` (real authored TSX, `export
 * default`) so a regression that silently falls back to
 * `componentCode` fails loudly here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentGguiSession, SystemGguiSession } from '@ggui-ai/protocol';
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiGetRenderSourceHandler } from './get-render-source.js';
import { GguiSessionNotFoundError } from './errors.js';

const NOW_MS = Date.parse('2026-05-09T00:00:00.000Z');

/** Looks compiled — never contains `export default`. */
const COMPILED = '"use strict";var Widget=()=>null;export{Widget as default};';
/** Real authored TSX — the D16-bar shape a save-as-blueprint selfCheck demands. */
const AUTHORED = 'export default function Widget() { return null; }';

async function seedComponentRender(
  store: InMemoryGguiSessionStore,
  opts: {
    sessionId?: string;
    appId?: string;
    componentCode?: string;
    /** Explicit `undefined` (as opposed to omitted) suppresses the
     *  default — used to simulate a commit that never recorded one. */
    sourceCode?: string | undefined;
    omitSourceCode?: boolean;
    propsSpec?: ComponentGguiSession['propsSpec'];
    props?: ComponentGguiSession['props'];
  } = {},
): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? 'render-1';
  const appId = opts.appId ?? 'app-1';
  const componentCode = opts.componentCode ?? COMPILED;
  const render: ComponentGguiSession = {
    id: sessionId,
    appId,
    type: 'component',
    componentCode,
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
    ...(opts.propsSpec !== undefined ? { propsSpec: opts.propsSpec } : {}),
    ...(opts.props !== undefined ? { props: opts.props } : {}),
  };
  const sourceCode = opts.omitSourceCode ? undefined : (opts.sourceCode ?? AUTHORED);
  await store.commit({ render, appId, ...(sourceCode !== undefined ? { sourceCode } : {}) });
  return { sessionId };
}

describe('createGguiGetRenderSourceHandler', () => {
  let renderStore: InMemoryGguiSessionStore;

  beforeEach(() => {
    renderStore = new InMemoryGguiSessionStore();
  });

  describe('declaration metadata', () => {
    it('exposes ggui_get_render_source name + agent audience', () => {
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      expect(handler.name).toBe('ggui_get_render_source');
      expect(handler.audience).toEqual(['agent']);
    });
  });

  describe('happy path', () => {
    it('returns the AUTHORED source, never the compiled componentCode', async () => {
      const { sessionId } = await seedComponentRender(renderStore);
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out).toEqual({
        sessionId,
        blueprint: { source: AUTHORED },
      });
      expect(out.blueprint.source).not.toBe(COMPILED);
    });

    it('D16-bar proxy: the returned source is authorable TSX with a default export', async () => {
      const { sessionId } = await seedComponentRender(renderStore);
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.blueprint.source).toContain('export default');
    });

    it('reassembles contract from propsSpec when present', async () => {
      const { sessionId } = await seedComponentRender(renderStore, {
        propsSpec: { properties: { city: { schema: { type: 'string' } } } },
      });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.blueprint.contract).toEqual({
        propsSpec: { properties: { city: { schema: { type: 'string' } } } },
      });
    });

    it('surfaces fixtureProps from the render\'s live props when present', async () => {
      const { sessionId } = await seedComponentRender(renderStore, {
        props: { city: 'Seoul', temperature: 15 },
      });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.blueprint.fixtureProps).toEqual({ city: 'Seoul', temperature: 15 });
    });

    it('omits contract and fixtureProps when the render declares neither', async () => {
      const { sessionId } = await seedComponentRender(renderStore);
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      const out = await handler.handler(
        { sessionId },
        { appId: 'app-1', requestId: 'r1' },
      );
      expect(out.blueprint).not.toHaveProperty('contract');
      expect(out.blueprint).not.toHaveProperty('fixtureProps');
    });
  });

  describe('tenancy + missing (uniform not-found)', () => {
    it('throws GguiSessionNotFoundError on cross-app access (no leak)', async () => {
      const { sessionId } = await seedComponentRender(renderStore, { appId: 'app-1' });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler(
          { sessionId },
          { appId: 'app-OTHER', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });

    it('throws GguiSessionNotFoundError on unknown sessionId', async () => {
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler(
          { sessionId: 'never-existed' },
          { appId: 'app-1', requestId: 'r1' },
        ),
      ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
    });
  });

  describe('variant handling — no source to fetch', () => {
    it('an mcpApps locator-only render throws a typed no-source error, never an empty-string source', async () => {
      const sessionId = 'render-mcpapps';
      const render: McpAppsGguiSession = {
        type: 'mcpApps',
        id: sessionId,
        createdAt: new Date(NOW_MS).toISOString(),
        source: {
          connectorId: 'connector_1',
          toolName: 'open_widget',
          resourceUri: 'ui://example/widget',
        },
      };
      await renderStore.commit({ render, appId: 'app-1' });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' }),
      ).rejects.toThrow(/render_source_unavailable/);
    });

    it('a system-card render throws the same typed no-source error', async () => {
      const sessionId = 'render-system';
      const render: SystemGguiSession = {
        type: 'system',
        id: sessionId,
        appId: 'app-1',
        kind: 'no-credentials',
        eventSequence: 0,
        createdAt: NOW_MS,
        lastActivityAt: NOW_MS,
        expiresAt: NOW_MS + 60_000,
      };
      await renderStore.commit({ render, appId: 'app-1' });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' }),
      ).rejects.toThrow(/render_source_unavailable/);
    });

    it('a component render that never committed (empty componentCode) throws the same typed error, not a hollow envelope', async () => {
      const { sessionId } = await seedComponentRender(renderStore, { componentCode: '' });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' }),
      ).rejects.toThrow(/render_source_unavailable/);
    });

    it('a render whose commit never recorded authored source throws the same typed error, never falls back to componentCode', async () => {
      const { sessionId } = await seedComponentRender(renderStore, { omitSourceCode: true });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' }),
      ).rejects.toThrow(/render_source_unavailable/);
    });

    it('a render whose authored source collapsed to the same text as componentCode (generator never distinguished) throws the same typed error', async () => {
      const { sessionId } = await seedComponentRender(renderStore, {
        componentCode: COMPILED,
        sourceCode: COMPILED,
      });
      const handler = createGguiGetRenderSourceHandler({ renderStore });
      await expect(
        handler.handler({ sessionId }, { appId: 'app-1', requestId: 'r1' }),
      ).rejects.toThrow(/render_source_unavailable/);
    });
  });
});
