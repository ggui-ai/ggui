/**
 * ggui#1415 — `createGguiServer` wires the view-proof measuring gate where
 * it holds the secret its ws envelopes are signed with (MCP Apps on), and
 * says once at boot, and on each declared call's line, when it cannot
 * verify (MCP Apps off). Over HTTP, through the data plane.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z, type ZodRawShape } from 'zod';
import type { SharedHandler } from '@ggui-ai/mcp-server-handlers';
import { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
import type { Logger } from './logger.js';
import { createGguiServer, type GguiServer } from './server.js';

interface Line {
  readonly level: 'info' | 'warn';
  readonly msg: string;
  readonly data: Readonly<Record<string, unknown>>;
}

function capturingLogger(lines: Line[]): Logger {
  const logger: Logger = {
    info: (msg, data) => void lines.push({ level: 'info', msg, data: data ?? {} }),
    warn: (msg, data) => void lines.push({ level: 'warn', msg, data: data ?? {} }),
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return logger;
}

const dispatch = {
  kind: 'dispatch',
  payload: { intent: 'confirm', actionData: null, uiContext: {} },
  sessionId: 'render_never_minted',
  appId: 'app-x',
  actionId: 'a3f2b1d4',
  firedAt: '2026-09-29T00:00:00.000Z',
};

let server: GguiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function callSubmit(opts: Parameters<typeof createGguiServer>[0]): Promise<Line[]> {
  const lines: Line[] = [];
  server = createGguiServer({ logger: capturingLogger(lines), auth: new InMemoryAuthAdapter({ devAllowAll: true }), ...opts });
  const http = await server.listen(0, '127.0.0.1');
  const addr = http.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  const client = new Client({ name: 'view-proof-gate-server-test', version: '0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
      requestInit: { headers: { Authorization: 'Bearer dev' } },
    }),
  );
  try {
    await client.callTool({ name: 'ggui_runtime_submit_action', arguments: dispatch });
  } finally {
    await client.close();
  }
  return lines;
}

const submitLine = (lines: readonly Line[]): Readonly<Record<string, unknown>> | undefined =>
  lines.filter((l) => l.msg === 'tool_invoked' && l.data['tool'] === 'ggui_runtime_submit_action').at(-1)?.data;

describe('createGguiServer wires the view-proof measuring gate (ggui#1415)', () => {
  it('with MCP Apps on, a declared call is verified: its line carries a verdict, never "unverifiable"', async () => {
    const lines = await callSubmit({ mcpApps: true, renderChannel: true, wsTokenSecret: 'server-gate-secret' });
    const line = submitLine(lines);
    expect(line).toMatchObject({ viewProof: 'missing', viewProofReason: 'meta_absent', viewProofEra: 'row_absent' });
    expect(line).not.toHaveProperty('viewProofUnverifiable');
    expect(lines.some((l) => l.msg === 'view_proof_unverifiable')).toBe(false);
  });

  it('with MCP Apps off, it says once at boot that declared proofs are not verified, and each such line says so', async () => {
    const lines = await callSubmit({});
    const boot = lines.filter((l) => l.msg === 'view_proof_unverifiable');
    expect(boot).toHaveLength(1);
    expect(boot[0]?.data['tools']).toContain('ggui_runtime_submit_action');
    expect(submitLine(lines)).toMatchObject({ viewProofUnverifiable: true });
    expect(submitLine(lines)).not.toHaveProperty('viewProof');
  });

  const unbound: SharedHandler<ZodRawShape, ZodRawShape> = {
    name: 'acme_unbound_tool',
    description: 'declares a view proof on a tool no view can sign',
    inputSchema: {},
    outputSchema: { ok: z.boolean() },
    viewProof: 'measured',
    handler: async () => ({ ok: true }),
  };

  it('refuses to boot with a proof declared on a tool no view can sign, in a mount or an isolated service', () => {
    expect(() => createGguiServer({ mcpMounts: [{ name: 'acme', handlers: [unbound] }] })).toThrow(/acme_unbound_tool, which the view proof's bound-argument table/);
    expect(() => createGguiServer({ mcpServices: [{ name: 'acme', path: '/acme', handlers: [unbound] }] })).toThrow(
      /acme_unbound_tool, which the view proof's bound-argument table/,
    );
  });
});
