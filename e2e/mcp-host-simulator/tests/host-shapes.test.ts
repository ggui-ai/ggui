/**
 * Tier 2 host-shape parity: prove every documented host preset
 * (`claude-ai`, `claude-desktop`, `goose`) passes the same
 * happy-path lifecycle against the OSS server.
 *
 * Today the server doesn't branch on `clientInfo.name`, so this
 * test essentially asserts the simulator's preset machinery
 * works. If a future server release introduces a name-keyed
 * branch (e.g. for a host-specific compatibility shim), this
 * test catches every host that newly fails — no per-host test
 * file proliferation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  HostSimulator,
  bootOssServer,
  claudeAiShape,
  claudeDesktopShape,
  gooseShape,
  ALL_HOST_SHAPES,
  type OssFixture,
} from '../src/index.js';

describe('host-simulator: host-shape presets', () => {
  let fixture: OssFixture | null = null;

  afterEach(async () => {
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
  });

  it('exposes 3 named presets via ALL_HOST_SHAPES', () => {
    const names = ALL_HOST_SHAPES.map((f) => f().shape).sort();
    expect(names).toEqual(['claude-ai', 'claude-desktop', 'goose']);
  });

  it('each preset returns a usable HostSimulatorOptions partial', () => {
    expect(claudeAiShape().clientInfo).toEqual({
      name: 'claude-ai',
      version: '2026.05',
    });
    expect(claudeDesktopShape().clientInfo).toEqual({
      name: 'claude-desktop',
      version: '2026.05',
    });
    expect(gooseShape().clientInfo).toEqual({ name: 'goose', version: '1.0' });
  });

  it.each(ALL_HOST_SHAPES.map((f) => [f().shape, f] as const))(
    '%s shape: tools/list works against OSS server',
    async (_name, shapeFactory) => {
      fixture = await bootOssServer();
      const shape = shapeFactory();
      const host = new HostSimulator({
        url: fixture.url,
        bearer: 'host-simulator-test',
        ...shape,
      });
      try {
        await host.connect();
        const tools = await host.listTools();
        expect(tools.find((t) => t.name === 'ggui_render')).toBeDefined();
      } finally {
        await host.close();
      }
    },
  );
});
