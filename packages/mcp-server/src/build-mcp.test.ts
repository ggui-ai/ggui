/**
 * `buildMcpServer` registration-time identity-kind filter (§9 wire 1.1c).
 *
 * Verifies that handlers are skipped/registered correctly based on the
 * intersection of `handler.allowedFor` and `BuildMcpServerOptions.allowedKinds`.
 *
 * The test spies on `McpServer.prototype.registerTool` to observe which
 * handlers actually land on the server — registration-time filtering is
 * load-bearing because `tools/list` reflects what was registered, NOT
 * what the request identity could in principle invoke.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, type ZodRawShape } from 'zod';
import type { HandlerContext, SharedHandler } from '@ggui-ai/mcp-server-handlers';
import { buildMcpServer } from './build-mcp.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};

const baseCtx: HandlerContext = { appId: 'app-1', requestId: 'r-1' };

function makeHandler(
  name: string,
  allowedFor?: ReadonlyArray<'app' | 'user' | 'builder'>,
): SharedHandler<ZodRawShape, ZodRawShape> {
  const inputSchema: ZodRawShape = { x: z.string() };
  const outputSchema: ZodRawShape = { ok: z.boolean() };
  return {
    name,
    description: `${name} test handler`,
    inputSchema,
    outputSchema,
    ...(allowedFor ? { allowedFor } : {}),
    async handler() {
      return { ok: true };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function recordRegistrations(): { names: string[] } {
  const captured: string[] = [];
  vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (
    this: McpServer,
    name: string,
  ) {
    captured.push(name);
    // The SDK returns a registered-tool handle; tests don't read it, so
    // returning `this` satisfies the typed return without spinning up
    // the real registration plumbing.
    return this as unknown as ReturnType<McpServer['registerTool']>;
  });
  return { names: captured };
}

describe('buildMcpServer — allowedKinds filter', () => {
  const info = { name: 'test', version: '0.0.1' };

  it('registers every handler when allowedKinds is omitted (today\'s default)', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('tool_a'),
      makeHandler('tool_b', ['app', 'builder']),
      makeHandler('tool_c', ['user']),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger);
    expect(names).toEqual(['tool_a', 'tool_b', 'tool_c']);
  });

  it('keeps handlers without allowedFor regardless of allowedKinds', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('untagged'),
      makeHandler('app_only', ['app']),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['user'],
    });
    expect(names).toEqual(['untagged']);
  });

  it('keeps handlers whose allowedFor intersects allowedKinds (single overlap)', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('app_or_builder', ['app', 'builder']),
      makeHandler('user_only', ['user']),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['app'],
    });
    expect(names).toEqual(['app_or_builder']);
  });

  it('keeps handlers whose allowedFor intersects allowedKinds (multi overlap)', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('app_only', ['app']),
      makeHandler('user_only', ['user']),
      makeHandler('app_user', ['app', 'user']),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['app', 'user'],
    });
    expect(names).toEqual(['app_only', 'user_only', 'app_user']);
  });

  it('skips handlers whose allowedFor disjoint from allowedKinds', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('app_only', ['app']),
      makeHandler('builder_only', ['builder']),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['user'],
    });
    expect(names).toEqual([]);
  });

  it('treats empty-array allowedFor as "no kind restriction" (defensive — same as omitted)', () => {
    // The SharedHandler contract permits ReadonlyArray<...> which COULD be
    // `[]`. Treating empty as restrictive would silently gate the handler
    // off everywhere, which is the trap the field was designed to avoid.
    // Match the omitted-field semantic instead — anyone authenticated.
    const { names } = recordRegistrations();
    const handlers = [makeHandler('empty_allowed', [])];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['app'],
    });
    expect(names).toEqual(['empty_allowed']);
  });

  // U1 (2026-04-27) retired the per-tool `allowedFor` tags on the live
  // ggui_* handlers — every ggui deployment ships the SAME toolset;
  // auth + billing distinctions live at the adapter layer, not at
  // registration time. The kind-filter machinery itself stays (some
  // future tool may legitimately need to be restricted), so these
  // "kind-restricted handler" tests use synthetic names.

  it('hosted posture (allowedKinds:[\'app\']) registers untagged + app-tagged handlers', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('synthetic_app_only', ['app']),
      makeHandler('synthetic_user_only', ['user']),
      makeHandler('synthetic_untagged'),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['app'],
    });
    expect(names).toEqual(['synthetic_app_only', 'synthetic_untagged']);
  });

  it('connector posture (allowedKinds:[\'user\']) registers untagged + user-tagged handlers', () => {
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('synthetic_app_only', ['app']),
      makeHandler('synthetic_user_only', ['user']),
      makeHandler('synthetic_untagged'),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger, {
      allowedKinds: ['user'],
    });
    expect(names).toEqual(['synthetic_user_only', 'synthetic_untagged']);
  });

  it('unified posture (omitted allowedKinds) — every handler registers regardless of allowedFor', () => {
    // The hosted ggui pod (`mcp.ggui.ai`) and OSS deployments all
    // compose WITHOUT `allowedKinds` post-U1. The filter only fires
    // if a deployment opts in.
    const { names } = recordRegistrations();
    const handlers = [
      makeHandler('synthetic_app_only', ['app']),
      makeHandler('synthetic_user_only', ['user']),
      makeHandler('synthetic_untagged'),
    ];
    buildMcpServer(info, handlers, () => baseCtx, silentLogger);
    expect(names).toEqual([
      'synthetic_app_only',
      'synthetic_user_only',
      'synthetic_untagged',
    ]);
  });
});
