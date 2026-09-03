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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z, type ZodRawShape } from 'zod';
import { renderOutputSchema } from '@ggui-ai/protocol';
import {
  handlerFailure,
  type HandlerContext,
  type HandlerFailure,
  type SharedHandler,
} from '@ggui-ai/mcp-server-handlers';
import { buildMcpServer } from './build-mcp.js';
import type { Logger } from './logger.js';

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

describe('buildMcpServer — in-result isError failure channel (ruling B)', () => {
  const info = { name: 'test', version: '0.0.1' };

  /**
   * Boot the REAL server + client over a linked in-memory transport
   * pair. Full wire fidelity: the client's `callTool` validates
   * `structuredContent` against the declared `outputSchema` whenever
   * it is present — INCLUDING `isError: true` results — which is the
   * exact contract that forces the failure envelope to stay
   * schema-conformant.
   */
  async function bootLinked(
    handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
    opts: { withholdResultMeta?: boolean } = {},
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = buildMcpServer(info, handlers, () => baseCtx, silentLogger, opts);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'ruling-b-test', version: '0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('projects a HandlerFailure marker to isError:true + errorText content + schema-validated structuredContent + NO _meta', async () => {
    const resultMetaSpy = vi.fn(() => ({ never: 'emitted' }));
    const failing: SharedHandler<
      ZodRawShape,
      ZodRawShape,
      | { ok: boolean; internal: string }
      | HandlerFailure<{ ok: boolean; internal: string }>
    > = {
      name: 'synth_failing',
      description: 'synthetic failing handler',
      inputSchema: {},
      outputSchema: { ok: z.boolean(), detail: z.string().optional() },
      async handler() {
        return handlerFailure(
          { ok: false, internal: 'stripped-by-outputSchema' },
          'CODE: it broke. Fix it; retry.',
        );
      },
      resultMeta: resultMetaSpy,
    };
    const { client, close } = await bootLinked([failing]);
    try {
      // callTool performing client-side outputSchema validation on the
      // isError result IS part of the assertion — a non-conformant
      // structuredContent would make this call throw.
      const result = await client.callTool({
        name: 'synth_failing',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: 'text', text: 'CODE: it broke. Fix it; retry.' },
      ]);
      // Zod-validated data — unknown keys strip before the wire.
      expect(result.structuredContent).toEqual({ ok: false });
      // NO _meta on failures — resultMeta is never consulted.
      expect(result._meta).toBeUndefined();
      expect(resultMetaSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('a failure payload that violates outputSchema fails loudly (no silent non-conformant wire)', async () => {
    const failing: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'synth_bad_failure',
      description: 'synthetic non-conformant failure',
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      async handler() {
        return handlerFailure({ wrong: 'shape' }, 'text');
      },
    };
    const { client, close } = await bootLinked([failing]);
    try {
      // The server-side zod parse rejects the non-conformant failure
      // data; the SDK wraps the throw as an isError result WITHOUT
      // structuredContent (the auto-wrap path) whose text carries the
      // validation failure — never a silently non-conformant envelope.
      const result = await client.callTool({
        name: 'synth_bad_failure',
        arguments: {},
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('success results are unaffected: no isError, _meta still emitted', async () => {
    const succeeding: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'synth_ok',
      description: 'synthetic success handler',
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      async handler() {
        return { ok: true };
      },
      resultMeta: () => ({ ui: { resourceUri: 'ui://x' } }),
    };
    const { client, close } = await bootLinked([succeeding]);
    try {
      const result = await client.callTool({ name: 'synth_ok', arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ ok: true });
      expect(result._meta).toEqual({ ui: { resourceUri: 'ui://x' } });
    } finally {
      await close();
    }
  });

  it('withholdResultMeta publishes the durable identity only — structuredContent intact, _meta = the spec pointer alone, resultMeta never consulted', async () => {
    // Read-plane-only mounting: a host receiving this result holds a
    // `ui://` locator and nothing to mount directly, so it MUST resolve
    // via authenticated resources/read. The locator is published on
    // BOTH wire slots hosts read — `structuredContent.resourceUri`
    // (ggui-aware hosts) and `_meta.ui.resourceUri` (spec-canonical
    // MCP Apps hosts: claude.ai, Claude Desktop, mcp-apps-react's
    // chat-helpers) — and the bootstrap MATERIAL (`ai.ggui/render`) is
    // what stays withheld. The first arm stripped `_meta` wholesale and
    // blinded every spec host (ggui#537). Same value on both slots:
    // the identity, never material.
    const resultMetaSpy = vi.fn(() => ({ 'ai.ggui/render': { runtimeUrl: 'https://x/rt.js' } }));
    const rendering: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'synth_render',
      description: 'synthetic render-shaped handler',
      inputSchema: {},
      outputSchema: { sessionId: z.string(), resourceUri: z.string() },
      async handler() {
        return { sessionId: 's1', resourceUri: 'ui://ggui/render/s1' };
      },
      resultMeta: resultMetaSpy,
    };
    const { client, close } = await bootLinked([rendering], { withholdResultMeta: true });
    try {
      const result = await client.callTool({ name: 'synth_render', arguments: {} });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ sessionId: 's1', resourceUri: 'ui://ggui/render/s1' });
      expect(result._meta).toEqual({
        ui: { resourceUri: 'ui://ggui/render/s1' },
        'ui/resourceUri': 'ui://ggui/render/s1',
      });
      // Not merely stripped after the fact — never assembled, so no
      // bootstrap token is minted for a slice nobody will receive; the
      // pointer above is derived from the OUTPUT, not from resultMeta.
      expect(resultMetaSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('withholdResultMeta publishes NO _meta for outputs without a ui:// locator — no pointer to mirror, nothing invented', async () => {
    const resultMetaSpy = vi.fn(() => ({ 'ai.ggui/render': { runtimeUrl: 'https://x/rt.js' } }));
    const plain: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'synth_plain',
      description: 'synthetic non-render handler',
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      async handler() {
        return { ok: true };
      },
      resultMeta: resultMetaSpy,
    };
    const { client, close } = await bootLinked([plain], { withholdResultMeta: true });
    try {
      const result = await client.callTool({ name: 'synth_plain', arguments: {} });
      expect(result.structuredContent).toEqual({ ok: true });
      expect(result._meta).toBeUndefined();
      expect(resultMetaSpy).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});

/**
 * Pre-generation refusal on the wire (ggui#786, ruling items 2 + 7).
 *
 * The MECHANISM is unchanged — a refusal rides the same in-result
 * `isError` channel as the §7.1 failure envelope. Two things are new and
 * both are asserted here against the REAL `renderOutputSchema`, not a
 * synthetic shape, because the whole claim is that a refusal is
 * schema-conformant structuredContent on the render tool's own declared
 * output:
 *
 *   1. The envelope: `outcome: 'refused'` + `refusal`, no identity
 *      fields, no `_meta`, and `content[0].text` leading with the code.
 *      The client's own `outputSchema` validation of `structuredContent`
 *      (which the SDK performs even when `isError` is set) is part of the
 *      assertion — a non-conformant payload makes `callTool` throw.
 *   2. The ops line: `tool_invoked` carries `outcome` (from the payload
 *      when present) and `code`. Today it hard-codes `'tool_error'` and
 *      no code, so a refusal is indistinguishable from a generation
 *      failure in the logs — which is what makes cloud's
 *      `generation_refused` accounting impossible from the transport.
 *
 * The THROW path is deliberately untouched (`outcome: 'error'` +
 * `errorClass`) — that is what makes "a gate that throws is a
 * conformance failure" observable in ops rather than silent.
 */
describe('buildMcpServer — pre-generation refusal envelope (#786)', () => {
  const info = { name: 'test', version: '0.0.1' };

  const REFUSAL = {
    code: 'hard_cap_exceeded',
    message: 'the configured render cap for this app was reached',
    fix: 'the cap resets at the start of the next period',
    retry: 'next-period',
    handshake: 'intact',
  };

  const REFUSAL_TEXT = `${REFUSAL.code}: ${REFUSAL.message} ${REFUSAL.fix}`;

  /** One captured structured-log call. */
  interface LogCall {
    readonly level: 'info' | 'warn' | 'error';
    readonly event: string;
    readonly fields: Record<string, unknown>;
  }

  function capturingLogger(calls: LogCall[]): Logger {
    const logger: Logger = {
      info: (event, fields) => calls.push({ level: 'info', event, fields: fields ?? {} }),
      warn: (event, fields) => calls.push({ level: 'warn', event, fields: fields ?? {} }),
      error: (event, fields) =>
        calls.push({ level: 'error', event, fields: fields ?? {} }),
      debug: () => undefined,
      child: () => logger,
    };
    return logger;
  }

  /**
   * A handler declaring the REAL render output shape whose only
   * behaviour is to refuse. Stands in for `ggui_render` with a
   * deployment gate bound — the transport cannot tell the difference,
   * which is the point.
   */
  function refusingRenderHandler(
    data: unknown,
    text: string = REFUSAL_TEXT,
  ): SharedHandler<ZodRawShape, ZodRawShape> {
    return {
      name: 'ggui_render',
      description: 'render, refusing',
      inputSchema: {},
      outputSchema: renderOutputSchema.shape,
      async handler() {
        return handlerFailure(data, text);
      },
    };
  }

  async function bootWithLogger(
    handlers: ReadonlyArray<SharedHandler<ZodRawShape, ZodRawShape>>,
    logger: Logger,
  ): Promise<{ client: Client; close: () => Promise<void> }> {
    const server = buildMcpServer(info, handlers, () => baseCtx, logger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'refusal-test', version: '0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }

  it('projects a refusal to isError + refused structuredContent + no _meta', async () => {
    const calls: LogCall[] = [];
    const { client, close } = await bootWithLogger(
      [refusingRenderHandler({ outcome: 'refused', refusal: REFUSAL })],
      capturingLogger(calls),
    );
    try {
      const result = await client.callTool({ name: 'ggui_render', arguments: {} });
      expect(result.isError).toBe(true);
      // The whole payload, so a stray identity field would fail here.
      expect(result.structuredContent).toEqual({
        outcome: 'refused',
        refusal: REFUSAL,
      });
      expect(result.content).toEqual([{ type: 'text', text: REFUSAL_TEXT }]);
      expect(result._meta).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('logs tool_invoked with outcome:refused and the registry code', async () => {
    const calls: LogCall[] = [];
    const { client, close } = await bootWithLogger(
      [refusingRenderHandler({ outcome: 'refused', refusal: REFUSAL })],
      capturingLogger(calls),
    );
    try {
      await client.callTool({ name: 'ggui_render', arguments: {} });
      const invoked = calls.filter((c) => c.event === 'tool_invoked');
      expect(invoked.length).toBe(1);
      expect(invoked[0]?.fields).toMatchObject({
        tool: 'ggui_render',
        appId: 'app-1',
        outcome: 'refused',
        code: 'hard_cap_exceeded',
      });
      // The throw path's marker must NOT appear — a refusal is a wire
      // state, not an exception.
      expect(invoked[0]?.fields).not.toHaveProperty('errorClass');
    } finally {
      await close();
    }
  });

  it("keeps outcome:'tool_error' on a failure payload that declares no outcome", async () => {
    // The §7.1 arm and any other HandlerFailure keep today's line, so
    // the log change is additive rather than a rename.
    const calls: LogCall[] = [];
    const plainFailure: SharedHandler<ZodRawShape, ZodRawShape> = {
      name: 'synth_plain_failure',
      description: 'synthetic failure with no outcome field',
      inputSchema: {},
      outputSchema: { ok: z.boolean() },
      async handler() {
        return handlerFailure({ ok: false }, 'CODE: it broke.');
      },
    };
    const { client, close } = await bootWithLogger(
      [plainFailure],
      capturingLogger(calls),
    );
    try {
      await client.callTool({ name: 'synth_plain_failure', arguments: {} });
      const invoked = calls.filter((c) => c.event === 'tool_invoked');
      expect(invoked.length).toBe(1);
      expect(invoked[0]?.fields).toMatchObject({ outcome: 'tool_error' });
      expect(invoked[0]?.fields).not.toHaveProperty('code');
    } finally {
      await close();
    }
  });

  /**
   * Drive one refusal payload and report what reached the wire. Used by
   * the two "fails loudly" tests so each can assert the CLEAN payload
   * conforms in the SAME test as the poisoned one — otherwise a schema
   * that rejects every refusal would satisfy them vacuously.
   */
  async function callWith(data: unknown): Promise<{
    isError: boolean | undefined;
    structuredContent: unknown;
  }> {
    const { client, close } = await bootWithLogger(
      [refusingRenderHandler(data)],
      capturingLogger([]),
    );
    try {
      const result = await client.callTool({ name: 'ggui_render', arguments: {} });
      return {
        isError: result.isError,
        structuredContent: result.structuredContent,
      };
    } finally {
      await close();
    }
  }

  it('a refusal carrying a sessionId fails loudly — never a silent wire state', async () => {
    // The registry code is valid; the ENVELOPE is not. The refused arm
    // commits nothing, so an identity field on it means the projection
    // leaked committed state.
    const clean = await callWith({ outcome: 'refused', refusal: REFUSAL });
    expect(clean.structuredContent).toEqual({
      outcome: 'refused',
      refusal: REFUSAL,
    });

    const poisoned = await callWith({
      outcome: 'refused',
      refusal: REFUSAL,
      sessionId: 'render_1',
    });
    expect(poisoned.isError).toBe(true);
    // Server-side validation rejects it; the SDK auto-wraps the throw
    // WITHOUT structuredContent — loud, never silently non-conformant.
    expect(poisoned.structuredContent).toBeUndefined();
  });

  it('an unregistered refusal code fails loudly at the transport', async () => {
    const clean = await callWith({ outcome: 'refused', refusal: REFUSAL });
    expect(clean.structuredContent).toEqual({
      outcome: 'refused',
      refusal: REFUSAL,
    });

    const poisoned = await callWith({
      outcome: 'refused',
      refusal: { ...REFUSAL, code: 'not_a_registered_code' },
    });
    expect(poisoned.isError).toBe(true);
    expect(poisoned.structuredContent).toBeUndefined();
  });
});
