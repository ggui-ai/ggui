/**
 * Scenario 28 — the read-plane door (ggui#537).
 *
 * A server running the read-plane-only posture (`--withhold-result-meta`
 * / `GGUI_WITHHOLD_RESULT_META=1`) publishes only the view's IDENTITY on
 * a `ggui_render` result — the `ui://ggui/render/…` locator on
 * `structuredContent.resourceUri` and on the spec pointer
 * `_meta.ui.resourceUri` — and no bootstrap material. A spec-canonical
 * MCP-Apps host mounts the DECLARATION-level static shell (the
 * `_meta.ui.resourceUri` announced on `tools/list`) and forwards the
 * result via `ui/notifications/tool-result`. Before #537 that shell had
 * exactly one tier for the material — the inline slice — and sat at
 * "Waiting for tool result…" forever (prod, 2026-08-16→17, every
 * claude.ai view). Now it takes the read-plane door: it asks the HOST to
 * `resources/read` the locator, recovers the envelope the per-render
 * self-contained shell inlines, and mounts from it.
 *
 * Wire half (deterministic, no browser): the render result carries NO
 * `ai.ggui/render` slice and DOES carry the pointer.
 * Browser half: the static shell + the identity-only result → the paint
 * arrives, and the host observed exactly one proxied `resources/read`
 * for the locator (the door, not a fallback).
 *
 * Runs in the keyless sweep against the `ggui-default-withhold` service
 * (global-setup, port 6789). Priming = `/control` register (scenario-18
 * recipe): unique in SHAPE — description is stripped from `blueprintKey`.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import { callTool, listTools, readResource, unwrapStructured } from '../fixtures/mcp-client.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  startMcpAppHost,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';

const PORT = Number.parseInt(process.env.GGUI_WITHHOLD_PORT ?? '6789', 10);
const MCP_URL = `http://localhost:${PORT}/mcp`;
const CONTROL_URL = `http://localhost:${PORT}/control`;

/** Unique in SHAPE (three props, own names) — see scenario 27's note. */
const DOOR_CONTRACT = {
  propsSpec: {
    description: 'read-plane door scenario 28 — a receipt line',
    properties: {
      merchant: { schema: { type: 'string' }, required: true, description: 'who was paid' },
      amountCents: { schema: { type: 'integer' }, required: true, description: 'minor units' },
      note: { schema: { type: 'string' }, required: false, description: 'optional memo' },
    },
  },
} as const;

const DOOR_COMPONENT_CODE = [
  'import { jsx } from "react/jsx-runtime";',
  'import { Card, Text } from "@ggui-ai/design/primitives";',
  'export default function ReadDoorCard() {',
  '  return jsx(Card, { children: jsx(Text, { children: "read-door-ok" }) });',
  '}',
  '',
].join('\n');

interface ToolEntry {
  name: string;
  _meta?: { ui?: { resourceUri?: string } };
}

describe('Scenario 28 — read-plane door: static shell + identity-only tool result paints via resources/read', () => {
  let host: McpAppHostHandle | null = null;
  let browser: BrowserHandle | null = null;

  afterEach(async () => {
    await browser?.close();
    browser = null;
    await host?.close();
    host = null;
  });

  test(
    'the result carries identity only, and the shell resolves it through the host',
    async () => {
      const expectedCodeHash = createHash('sha256').update(DOOR_COMPONENT_CODE).digest('hex');

      // ── 1. Zero-LLM priming via /control ─────────────────────────
      const ops = unwrapStructured<{ codeHash: string }>(
        await callTool(CONTROL_URL, 'ggui_ops_register_blueprint', {
          contract: DOOR_CONTRACT,
          componentCode: DOOR_COMPONENT_CODE,
          confirm: true,
        }),
      );
      expect(ops.codeHash).toBe(expectedCodeHash);

      // ── 2. The declaration-level static shell (what a spec host mounts)
      const toolsResp = await listTools(MCP_URL);
      const tools = toolsResp.result as { tools?: ToolEntry[] } | undefined;
      const renderTool = tools?.tools?.find((t) => t.name === 'ggui_render');
      expect(renderTool, 'ggui_render is declared').toBeDefined();
      const declaredUri = renderTool!._meta?.ui?.resourceUri;
      expect(declaredUri, 'ggui_render declares _meta.ui.resourceUri').toMatch(/^ui:\/\/ggui\/render/);
      const staticShell = await readResource(MCP_URL, declaredUri!);
      const staticShellHtml = staticShell.result?.contents?.[0]?.text;
      expect(typeof staticShellHtml).toBe('string');
      // It is the STATIC (thin) shell: no assembled envelope line of its
      // own — the marker text appears only inside the shell's own door
      // code, never as `<script>globalThis.__GGUI_META__ = {…}`.
      expect(staticShellHtml).toContain('data-ggui-shell="thin"');
      expect(staticShellHtml).not.toContain('<script>globalThis.__GGUI_META__ = {');

      // ── 3. handshake (cache) → render.accept ────────────────────
      const handshake = unwrapStructured<{ handshakeId: string; suggestion: { origin: string } }>(
        await callTool(MCP_URL, 'ggui_handshake', {
          intent: 'a receipt line for a coffee — paraphrased vs the priming',
          blueprintDraft: { contract: DOOR_CONTRACT },
        }),
      );
      expect(handshake.suggestion.origin).toBe('cache');

      const renderResp = await callTool(MCP_URL, 'ggui_render', {
        handshakeId: handshake.handshakeId,
        props: { merchant: 'Blue Bottle', amountCents: 450 },
      });
      const render = unwrapStructured<{ sessionId: string; resourceUri: string }>(renderResp);
      expect(render.resourceUri).toMatch(/^ui:\/\/ggui\/render\//);

      // ── 4. Wire half: identity only, on BOTH slots; no material ──
      const result = renderResp.result as {
        _meta?: Record<string, unknown>;
        structuredContent?: Record<string, unknown>;
        content?: unknown[];
      };
      expect(result._meta, 'the pointer is published').toBeDefined();
      expect(result._meta!['ai.ggui/render'], 'the bootstrap material is withheld').toBeUndefined();
      expect((result._meta!['ui'] as { resourceUri?: string } | undefined)?.resourceUri).toBe(render.resourceUri);

      // ── 5. Browser half: static shell + forwarded result → the door ─
      host = await startMcpAppHost({
        mcpUrl: MCP_URL,
        resourceHtml: staticShellHtml as string,
        toolResult: result as Record<string, unknown>,
      });
      browser = await openBrowser();
      const proxiedReads: string[] = [];
      browser.page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/mcp')) {
          const body = req.postData() ?? '';
          if (body.includes('"resources/read"')) proxiedReads.push(body);
        }
      });

      await browser.page.goto(host.url, { waitUntil: 'domcontentloaded' });
      const frame = browser.page.frameLocator(MCP_APP_IFRAME_SELECTOR);
      await frame.getByText('read-door-ok').waitFor({ timeout: 30_000 });

      // ── 6. The paint came THROUGH THE DOOR — one host-proxied read of the locator
      expect(
        proxiedReads.length,
        `expected exactly one host-proxied resources/read (the door); saw ${proxiedReads.length}`,
      ).toBe(1);
      expect(proxiedReads[0]).toContain(render.resourceUri);
    },
    120_000,
  );
});
