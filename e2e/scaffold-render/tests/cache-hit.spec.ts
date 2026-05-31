/**
 * Sub-tier B — cache-hit scenario. Talks DIRECTLY to the scaffolded app's ggui
 * MCP server (no browser) and proves cross-session blueprint reuse via the
 * RENDER OUTPUT: turn-1 is a real cold generation (forceCreate); turn-2 (the
 * render matcher allowed to run) reuses turn-1's blueprint. The primary
 * observable is the structured `cache` marker on `ggui_render` —
 * `cache.hit === true` with `cache.llmCallsAvoided >= 1` — plus blueprint
 * identity equality: both turns carry the same `contractHash` (same data flow ⟺
 * same hash). Latency stays as a SECONDARY soft signal (turn-2 still fast).
 *
 * Phase 1 keeps turn-2 on the existing `decision:{kind:'override'}` flow:
 * render's own matcher (still present in Phase 1) makes turn-2 cache-hit on the
 * identical contract. Phase 2 flips this to `accept` in the wave that deletes
 * the render-side matcher.
 *
 * Auth: the scaffolded ggui runs `ggui serve --mcp-only --dev-allow-all`, which
 * accepts ANY non-empty bearer as `builder` — no pairing/handshake-token needed.
 *
 * LIVE regression gate: cross-session blueprint reuse is wired on this base. If
 * a change breaks reuse, turn-2 falls back to a cold gen — `cache.hit` goes
 * false (and latency climbs), failing this spec.
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
/**
 * Reuse-outcome marker on `ggui_render`'s `renderCacheMarkerSchema`. Mirrored
 * locally (rather than imported from `@ggui-ai/protocol`) to keep this Verdaccio
 * sub-tier-B harness dependency-free — same transport-boundary stance as the
 * `Record<string, unknown>` envelope above. Only the read fields are modeled.
 */
interface RenderCacheMarker {
  hit: boolean;
  similarity?: number;
  cachedBlueprintId?: string;
  llmCallsAvoided: number;
  kind?: 'full-template' | 'cold';
}
/**
 * ggui_render CallToolResult (the bits we check). `contractHash` + `cache` are
 * the Phase-1 reuse-visibility fields surfaced on `renderOutputSchema`; `action`
 * rides along for completeness.
 */
interface RenderResult {
  isError?: boolean;
  renderId?: string;
  action?: string;
  contractHash?: string;
  cache?: RenderCacheMarker;
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

/** ggui_render CallToolResult envelope — the structured fields ride on `structuredContent`. */
interface RenderCallResult {
  isError?: boolean;
  structuredContent?: RenderResult;
}

/** The parsed render output plus the render's wall-clock ms (secondary signal). */
interface RenderOnceResult extends RenderResult {
  ms: number;
}

/** Handshake → render once; return the parsed render output + wall-clock ms. */
async function renderOnce(gguiUrl: string, forceCreate: boolean): Promise<RenderOnceResult> {
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
  const ms = Date.now() - t0;
  if (env.error) throw new Error(`ggui_render RPC error: ${env.error.message}`);
  const call = env.result as RenderCallResult | undefined;
  if (!call || call.isError) throw new Error(`ggui_render failed: ${JSON.stringify(env.result)}`);
  const render = call.structuredContent;
  if (!render) {
    throw new Error(`ggui_render returned no structuredContent: ${JSON.stringify(env.result)}`);
  }
  return { ...render, ms };
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

  test(
    'session 1 cold-generates, session 2 reuses the blueprint (cache.hit + identity)',
    async () => {
      test.setTimeout(1_500_000);
      app = await spawnScaffoldedApp({ sdk: 'claude-agent-sdk' });

      const render1 = await renderOnce(app.gguiUrl, true);
      // No forceCreate → the render matcher runs and should reuse turn-1's blueprint.
      const render2 = await renderOnce(app.gguiUrl, false);
      // eslint-disable-next-line no-console -- reuse + latency signal in the CI log.
      console.log(
        `[cache-hit] turn-1 cold=${render1.ms}ms hit=${render1.cache?.hit} | ` +
          `turn-2=${render2.ms}ms hit=${render2.cache?.hit} avoided=${render2.cache?.llmCallsAvoided}`,
      );

      // PRIMARY observable: turn-2 served a stored component without generating.
      expect(render2.cache?.hit, 'turn-2 should be a cache hit').toBe(true);
      expect(
        render2.cache?.llmCallsAvoided ?? 0,
        'turn-2 cache hit should report at least one generation call avoided',
      ).toBeGreaterThanOrEqual(1);
      // Identity proof: same data flow ⟺ same contractHash across both turns.
      expect(render1.contractHash, 'turn-1 should carry a contractHash').toBeTruthy();
      expect(
        render2.contractHash,
        'turn-2 contractHash should equal turn-1 (same contract → same hash)',
      ).toBe(render1.contractHash);

      // SECONDARY signal: turn-2 stays fast (no LLM fallthrough). Soft so a slow
      // CI box doesn't mask the primary cache.hit failure mode above.
      expect
        .soft(render2.ms, `turn-2 ${render2.ms}ms — cache hit should be < 10s`)
        .toBeLessThan(10_000);
    },
  );
});
