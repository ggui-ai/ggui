/**
 * Tests for `ggui.json#mcpMounts` discovery.
 *
 * Mix of real filesystem (`mkdtempSync`) + hook-injected module
 * import. The resolver + importer hooks mean we don't have to set
 * up real `node_modules/` trees or ESM-only test fixtures — we just
 * stub each spec with a factory function and assert the discovery
 * contract.
 *
 * Assertion style mirrors `primitive-discovery.test.ts` — one
 * `describe` block per failure mode, one `describe` for happy
 * paths. `issues` ordering is not tested where it would be incidental
 * (the order is declaration-order today but not a load-bearing
 * contract).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from './schema.js';
import {
  discoverMcpMounts,
  GGUI_MCP_MOUNT_FACTORY_EXPORT,
  type DiscoveredMcpMount,
} from './mcp-mount-discovery.js';

/**
 * Build a minimal GguiJsonV1 with `mcpMounts` populated. Default
 * values for other required fields so tests can focus on the mount
 * pipeline.
 */
function makeGgui(mcpMounts: string[]): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include: [] },
    primitives: { packages: [], local: [] },
    mcpMounts,
  };
}

/**
 * Shape of a fake module namespace — mirror what `import()` hands
 * back. Factory hooks can expose `createGguiMcpMount`, `default`, or
 * neither to exercise the picker.
 */
type FakeModule = Record<string, unknown>;

describe('discoverMcpMounts — zero-config', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-mcp-mounts-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns an empty result when mcpMounts is empty', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui([]),
    });
    expect(result.mounts).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('throws when projectRoot is not absolute', async () => {
    await expect(
      discoverMcpMounts({
        projectRoot: 'relative/path',
        manifest: makeGgui(['./x.mjs']),
      }),
    ).rejects.toThrow(/projectRoot must be absolute/);
  });
});

describe('discoverMcpMounts — happy path', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-mcp-mounts-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('invokes the named factory export and returns a validated mount', async () => {
    const modules = new Map<string, FakeModule>();
    const resolvedPath = resolve(tmp, 'tasks.mjs');
    modules.set(resolvedPath, {
      [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => ({
        name: 'tasks',
        handlers: [
          {
            name: 'tasks_list',
            inputSchema: {},
            handler: async () => ({}),
          },
        ],
      }),
    });

    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./tasks.mjs']),
      resolveModule: (_spec) => resolvedPath,
      importModule: async (url) => {
        const path = url.replace(/^file:\/\//, '');
        return modules.get(path);
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]!.spec).toBe('./tasks.mjs');
    expect(result.mounts[0]!.mount.name).toBe('tasks');
    expect(result.mounts[0]!.mount.handlers).toHaveLength(1);
  });

  it('falls back to a default-export function when the named export is absent', async () => {
    const resolvedPath = resolve(tmp, 'default.mjs');
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./default.mjs']),
      resolveModule: () => resolvedPath,
      importModule: async () => ({
        default: () => ({ name: 'via-default', handlers: [] }),
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.mounts[0]!.mount.name).toBe('via-default');
  });

  it('awaits an async factory', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./async.mjs']),
      resolveModule: () => resolve(tmp, 'async.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: async () => ({
          name: 'later',
          handlers: [],
        }),
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.mounts[0]!.mount.name).toBe('later');
  });

  it('preserves declaration order across multiple mounts', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./a.mjs', './b.mjs', './c.mjs']),
      resolveModule: (spec) => resolve(tmp, spec),
      importModule: async (url) => {
        const name = url.replace(/^.*\//, '').replace(/\.mjs$/, '');
        return {
          [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => ({ name, handlers: [] }),
        };
      },
    });

    expect(result.issues).toEqual([]);
    expect(result.mounts.map((m: DiscoveredMcpMount) => m.mount.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('prefers the named export when both named + default are functions', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./dual.mjs']),
      resolveModule: () => resolve(tmp, 'dual.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => ({
          name: 'named-wins',
          handlers: [],
        }),
        default: () => ({ name: 'default-loses', handlers: [] }),
      }),
    });

    expect(result.issues).toEqual([]);
    expect(result.mounts[0]!.mount.name).toBe('named-wins');
  });
});

describe('discoverMcpMounts — resolution + import failures', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-mcp-mounts-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records an issue when resolveModule throws', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['@not-installed/mcp']),
      resolveModule: () => {
        throw new Error('Cannot find module "@not-installed/mcp"');
      },
      importModule: async () => ({}),
    });

    expect(result.mounts).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.path).toBe('@not-installed/mcp');
    expect(result.issues[0]!.message).toMatch(
      /Could not resolve mcpMounts entry/,
    );
  });

  it('records an issue when a relative path does not exist on disk (default resolver)', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./does-not-exist.mjs']),
      // Deliberately omit resolveModule to exercise the production default.
    });

    expect(result.mounts).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toMatch(/does not exist/);
  });

  it('records an issue when importModule throws', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./broken.mjs']),
      resolveModule: () => resolve(tmp, 'broken.mjs'),
      importModule: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    expect(result.mounts).toEqual([]);
    expect(result.issues[0]!.message).toMatch(/Failed to import/);
  });

  it('continues past one bad entry to the next good one', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./bad.mjs', './good.mjs']),
      resolveModule: (spec) => resolve(tmp, spec),
      importModule: async (url) => {
        if (url.endsWith('/bad.mjs')) throw new Error('boom');
        return {
          [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => ({
            name: 'good',
            handlers: [],
          }),
        };
      },
    });

    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]!.mount.name).toBe('good');
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.path).toBe('./bad.mjs');
  });
});

describe('discoverMcpMounts — factory-contract failures', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-pc-mcp-mounts-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('records an issue when no factory export is present', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./no-factory.mjs']),
      resolveModule: () => resolve(tmp, 'no-factory.mjs'),
      importModule: async () => ({ someUnrelatedExport: 42 }),
    });

    expect(result.mounts).toEqual([]);
    expect(result.issues[0]!.message).toMatch(
      /must export a `createGguiMcpMount`/,
    );
  });

  it('records an issue when the named export is not a function', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./bad-factory.mjs']),
      resolveModule: () => resolve(tmp, 'bad-factory.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: 'not a function',
      }),
    });

    expect(result.issues[0]!.message).toMatch(
      /must export a `createGguiMcpMount`/,
    );
  });

  it('records an issue when the factory throws', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./thrower.mjs']),
      resolveModule: () => resolve(tmp, 'thrower.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => {
          throw new Error('bad seed');
        },
      }),
    });

    expect(result.issues[0]!.message).toMatch(/factory threw during invocation/);
    expect(result.issues[0]!.message).toMatch(/bad seed/);
  });

  it('records an issue when the factory returns a non-object', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./wrong.mjs']),
      resolveModule: () => resolve(tmp, 'wrong.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => 'oops',
      }),
    });

    expect(result.issues[0]!.message).toMatch(/unexpected shape/);
    expect(result.issues[0]!.message).toMatch(/expected an object/);
  });

  it('records an issue when name is missing', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./noname.mjs']),
      resolveModule: () => resolve(tmp, 'noname.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => ({ handlers: [] }),
      }),
    });

    expect(result.issues[0]!.message).toMatch(
      /`name` must be a non-empty string/,
    );
  });

  it('records an issue when handlers is not an array', async () => {
    const result = await discoverMcpMounts({
      projectRoot: tmp,
      manifest: makeGgui(['./bad-handlers.mjs']),
      resolveModule: () => resolve(tmp, 'bad-handlers.mjs'),
      importModule: async () => ({
        [GGUI_MCP_MOUNT_FACTORY_EXPORT]: () => ({
          name: 'nope',
          handlers: 'not-an-array',
        }),
      }),
    });

    expect(result.issues[0]!.message).toMatch(
      /`handlers` must be an array/,
    );
  });
});
