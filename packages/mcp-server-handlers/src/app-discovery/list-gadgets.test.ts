import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STDLIB_GADGETS, type GadgetDescriptor } from '@ggui-ai/protocol';
const STDLIB_PKG = STDLIB_GADGETS[0].package;
import { InMemoryAppMetadataStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { HandlerContext } from '../types.js';
import { createGguiListGadgetsHandler } from './list-gadgets.js';
import { AppAccessDeniedError } from './errors.js';

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: 'req-1' };
}

describe('createGguiListGadgetsHandler', () => {
  it('returns app.gadgets when the app is registered (stdlib seed, content-equal)', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    appMetadataStore.register('app-1');
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    const result = await tool.handler({}, makeCtx('app-1'));
    // resolveAppGadgets is applied at both composeApp and list-gadgets handler
    // layers — the result is content-equal to STDLIB_GADGETS but may be a
    // new array reference (idempotent by value, not by identity).
    expect(result.gadgets).toEqual(STDLIB_GADGETS);
  });

  it('returns a custom catalog unioned with stdlib floor', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    const custom: GadgetDescriptor[] = [
      {
        package: '@acme/x',
        version: '0.0.1',
        exports: [
          {
            hook: 'useCustom',
            description: 'Custom hook for the test',
            usage: 'Mounts the custom widget',
            example: { hook: 'useCustom' },
          },
        ],
      },
    ];
    appMetadataStore.register('app-1', { gadgets: custom });
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    const result = await tool.handler({}, makeCtx('app-1'));
    // resolveAppGadgets unions — stdlib floor is always present.
    expect(result.gadgets.map((g) => g.package)).toEqual(
      expect.arrayContaining([STDLIB_PKG, '@acme/x']),
    );
  });

  it('falls back to STDLIB_GADGETS when the app is not registered', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    const result = await tool.handler({}, makeCtx('unknown-app'));
    expect(result.gadgets).toBe(STDLIB_GADGETS);
  });

  it('accepts an explicit appId matching ctx.appId', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    appMetadataStore.register('app-1');
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    const result = await tool.handler({ appId: 'app-1' }, makeCtx('app-1'));
    // Content-equal to STDLIB_GADGETS (resolveAppGadgets applied twice = idempotent by value).
    expect(result.gadgets).toEqual(STDLIB_GADGETS);
  });

  it('throws AppAccessDeniedError when the explicit appId does not match ctx.appId', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    appMetadataStore.register('app-1');
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    await expect(
      tool.handler({ appId: 'app-2' }, makeCtx('app-1')),
    ).rejects.toBeInstanceOf(AppAccessDeniedError);
  });

  it('exposes audience=[agent] and the canonical tool name', () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    expect(tool.name).toBe('ggui_list_gadgets');
    expect(tool.audience).toEqual(['agent']);
  });

  it('rejects malformed input (empty appId string)', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    await expect(
      tool.handler({ appId: '' }, makeCtx('app-1')),
    ).rejects.toThrow();
  });

  it('handler result survives the MCP-boundary outputSchema parse (stdlib seed)', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    const result = await tool.handler({}, makeCtx('unknown-app'));
    // Mirrors build-mcp.ts:205 — the MCP transport runs every handler
    // result through `z.object(handler.outputSchema).parse(...)`.
    expect(() =>
      z.object(tool.outputSchema).parse(result),
    ).not.toThrow();
  });

  it('handler result survives the MCP-boundary outputSchema parse (custom package descriptor)', async () => {
    const appMetadataStore = new InMemoryAppMetadataStore();
    const custom: GadgetDescriptor[] = [
      {
        package: '@acme/x',
        version: '0.0.1',
        exports: [
          {
            hook: 'useCustom',
            description: 'Custom hook for the test',
            usage: 'Mounts the custom widget',
            example: { hook: 'useCustom' },
          },
          {
            component: 'CustomWidget',
            description: 'Custom component for the test',
            usage: 'Renders the custom widget',
            example: { component: 'CustomWidget' },
          },
        ],
      },
    ];
    appMetadataStore.register('app-1', { gadgets: custom });
    const tool = createGguiListGadgetsHandler({ appMetadataStore });
    const result = await tool.handler({}, makeCtx('app-1'));
    expect(() =>
      z.object(tool.outputSchema).parse(result),
    ).not.toThrow();
  });
});
