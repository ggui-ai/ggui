/**
 * Sub-tier B — cache-hit scenario. Talks DIRECTLY to the scaffolded app's ggui
 * MCP server (no browser) and proves cross-session blueprint reuse via the
 * LATENCY channel: turn-1 is a real cold generation (forceCreate, > 1s);
 * turn-2 (matcher allowed to run) reuses turn-1's blueprint (< 10s). `/r/<short>`
 * was dropped from the wire, so latency is the only observable — never url-nav.
 *
 * Auth: the scaffolded ggui runs `ggui serve --mcp-only --dev-allow-all`, which
 * accepts ANY non-empty bearer as `builder` — no pairing/handshake-token needed.
 *
 * PENDING (test.fixme): cross-session blueprint reuse is being (re)implemented
 * in a separate slice and is NOT yet on this test base. The scenario is
 * behaviour-based (turn-2 fast = reuse), so it will pass with whatever cache
 * impl ships — un-`fixme` the test once that lands on the test base.
 */
import { test, expect } from '@playwright/test';
import { spawnScaffoldedApp, type ScaffoldAppHandle } from './scaffold-app-harness';

// --dev-allow-all accepts any non-empty bearer as `builder`.
const DEV_BEARER = 'dev';

// A niche contract → no built-in blueprint match → turn-1 is a genuine cold
// generation, and turn-2's hit is attributable to turn-1, not a shipped default.
const INTENT = 'Render a soil-moisture gauge panel for a greenhouse zone labelled "Bed 7"';
const CONTRACT = {
  propsSpec: {
    description: 'gauge',
    properties: {
      zoneLabel: { schema: { type: 'string' }, required: false },
      moisturePct: { schema: { type: 'number' }, required: false },
    },
  },
} as const;

// MCP JSON-RPC envelope. `result` is the CallToolResult — a per-tool shape, so
// Record<string, unknown> is the honest transport-boundary type (the same shape
// the journeys ggui-serve-harness uses); specs narrow it with the named result
// interfaces below.
interface McpEnvelope {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
/** ggui_handshake CallToolResult (the bit we read). */
interface HandshakeResult {
  structuredContent?: { handshakeId?: string };
}
/** ggui_render CallToolResult (the bits we check). */
interface RenderResult {
  isError?: boolean;
  renderId?: string;
}

/**
 * Minimal MCP JSON-RPC over Streamable-HTTP. Inlined (rather than importing the
 * journeys harness) so this spec is fully self-contained — it speaks to the
 * scaffolded app's ggui server, not a workspace-spawned one, and pulls in no
 * import-time filesystem-walking helpers.
 */
async function mcpCall(gguiUrl: string, method: string, params: unknown): Promise<McpEnvelope> {
  const res = await fetch(`${gguiUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${DEV_BEARER}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: `cache-${Date.now()}`, method, params }),
  });
  if (!res.ok) throw new Error(`MCP ${method} → HTTP ${res.status}: ${await res.text()}`);
  const ct = (res.headers.get('content-type') ?? '').toLowerCase();
  if (ct.includes('text/event-stream')) {
    const body = await res.text();
    const data = body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'));
    if (!data) throw new Error(`MCP ${method} SSE response had no data frame: ${body}`);
    return JSON.parse(data.slice(5).trim()) as McpEnvelope;
  }
  return (await res.json()) as McpEnvelope;
}

/** Handshake → render once; return the render's wall-clock ms. */
async function renderOnce(gguiUrl: string, forceCreate: boolean): Promise<number> {
  const hs = await mcpCall(gguiUrl, 'tools/call', {
    name: 'ggui_handshake',
    arguments: {
      intent: INTENT,
      blueprintDraft: { contract: CONTRACT },
      ...(forceCreate ? { forceCreate: true } : {}),
    },
  });
  if (hs.error) throw new Error(`ggui_handshake RPC error: ${hs.error.message}`);
  const handshakeId = (hs.result as HandshakeResult | undefined)?.structuredContent?.handshakeId;
  if (!handshakeId) {
    throw new Error(`ggui_handshake returned no handshakeId: ${JSON.stringify(hs.result)}`);
  }

  const t0 = Date.now();
  const env = await mcpCall(gguiUrl, 'tools/call', {
    name: 'ggui_render',
    arguments: {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract: CONTRACT } },
    },
  });
  if (env.error) throw new Error(`ggui_render RPC error: ${env.error.message}`);
  const render = env.result as RenderResult | undefined;
  if (!render || render.isError) throw new Error(`ggui_render failed: ${JSON.stringify(env.result)}`);
  return Date.now() - t0;
}

test.describe('scaffold-render: blueprint cache hit across sessions (published app)', () => {
  let app: ScaffoldAppHandle | undefined;

  test.beforeAll(() => {
    test.skip(
      !process.env['ANTHROPIC_API_KEY']?.trim(),
      'set ANTHROPIC_API_KEY — the cold turn-1 is a real LLM generation',
    );
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test.fixme(
    'session 1 cold-generates, session 2 reuses the blueprint (latency)',
    async () => {
      test.setTimeout(1_500_000);
      app = await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' });

      const cold = await renderOnce(app.gguiUrl, true);
      expect(
        cold,
        `turn-1 ${cold}ms — too fast for a real LLM call (stub regression?)`,
      ).toBeGreaterThan(1_000);

      // No forceCreate → the matcher runs and should reuse turn-1's blueprint.
      const hit = await renderOnce(app.gguiUrl, false);
      expect(
        hit,
        `turn-2 ${hit}ms — cache hit should be < 10s; LLM fallthrough regression?`,
      ).toBeLessThan(10_000);
    },
  );
});
