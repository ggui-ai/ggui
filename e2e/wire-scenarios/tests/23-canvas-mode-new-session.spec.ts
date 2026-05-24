/**
 * Scenario 23 — canvas-mode `ggui_new_session` mints the session-scoped
 * iframe resource.
 *
 * When the operator's `ggui.json#app.defaultMcpAppsMode === 'canvas'`,
 * a fresh `ggui_new_session` call MUST return:
 *
 *   - `result._meta.ui.resourceUri === 'ui://ggui/session/<sessionId>'`
 *     (the resource URI the spec-compliant MCP host fetches to mount
 *     ONE session-scoped iframe instead of waiting for the first
 *     `ggui_push` to mint a per-push iframe)
 *
 * And the resource itself MUST be served via `resources/read` and
 * carry a canvas-mode bootstrap meta (`canvasMode: true` + the
 * live-mode trio `wsUrl/token/expiresAt`) so the iframe runtime takes
 * the CanvasShell mount path. The shell wrapper uses
 * `data-ggui-shell="self-contained"` (vs `"loading"` for the
 * fallback path).
 *
 * Note: the agent-facing `structuredContent` does NOT carry
 * `_mcpAppsMode` — that field is internal-only (used by `resultMeta`
 * to decide whether to stamp the resourceUri) and stripped by the
 * MCP output-schema validator before the response leaves the server.
 * The canvas-vs-inline split is a host-presentation concern; the
 * agent only needs to know which tools to call.
 *
 * No LLM cold-gen — pure wire shape. Runs without `ANTHROPIC_API_KEY`.
 */
import { describe, expect, test } from 'vitest';
import { callTool, readResource, unwrapStructured } from '../fixtures/mcp-client.js';

const CANVAS_PORT = Number.parseInt(process.env.GGUI_CANVAS_PORT ?? '6786', 10);
const MCP_URL = `http://localhost:${CANVAS_PORT}/mcp`;

interface NewSessionResult {
  readonly sessionId: string;
}

interface MetaUiBlock {
  readonly ui?: {
    readonly resourceUri?: string;
  };
}

describe('Scenario 23 — canvas-mode new_session mints session-scoped resourceUri', () => {
  test('result carries _meta.ui.resourceUri = ui://ggui/session/<sessionId>', async () => {
    const resp = await callTool(MCP_URL, 'ggui_new_session', {});
    if (resp.error !== undefined) {
      throw new Error(`ggui_new_session failed: ${resp.error.message}`);
    }
    const sc = unwrapStructured<NewSessionResult>(resp);
    expect(sc.sessionId).toMatch(/^[a-z0-9-]+$/);

    const meta = resp.result?._meta as MetaUiBlock | undefined;
    expect(meta).toBeDefined();
    expect(meta?.ui?.resourceUri).toBe(`ui://ggui/session/${sc.sessionId}`);
  });

  test('the minted resource is served via resources/read and carries canvasMode:true in the bootstrap', async () => {
    const sc = unwrapStructured<NewSessionResult>(
      await callTool(MCP_URL, 'ggui_new_session', {}),
    );
    const resourceUri = `ui://ggui/session/${sc.sessionId}`;

    const resourceResp = await readResource(MCP_URL, resourceUri);
    if (resourceResp.error !== undefined) {
      throw new Error(
        `resources/read ${resourceUri} failed: ${resourceResp.error.message}`,
      );
    }
    const contents = resourceResp.result?.contents;
    expect(contents).toBeDefined();
    expect(contents?.length ?? 0).toBeGreaterThan(0);
    const body = contents?.[0];
    expect(body?.uri).toBe(resourceUri);
    expect(body?.mimeType).toMatch(/^text\/html/);
    const html = body?.text ?? '';
    // Canvas-mode wrapper marker. When the canvas branch fires, the
    // resource template emits `data-ggui-shell="self-contained"`;
    // when it falls back to the legacy single-item path the marker
    // reads `data-ggui-shell="loading"`. Pinning the canvas marker
    // catches the integration-gap regression directly.
    expect(html).toMatch(/data-ggui-shell="self-contained"/);
    // Bootstrap embeds the canvasMode flag + live-mode trio. Asserting
    // the literal substring keeps the test transport-agnostic
    // (escaped or unescaped both pass).
    expect(html).toMatch(/"canvasMode"\s*:\s*true/);
    expect(html).toMatch(/"wsUrl"\s*:\s*"ws:\/\//);
  });
});
