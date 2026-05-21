/**
 * Tiny browser fixture — wraps `playwright-core`'s chromium.launch so
 * each scenario can request a fresh page without re-importing the
 * library and managing browser/context teardown.
 *
 * Why playwright-core (the gadget) and not `@playwright/test` (the
 * runner): our workspace runs with `node-linker=hoisted` (required
 * for AWS Amplify Hosting monorepo SSR), which breaks `@playwright/
 * test`'s singleton-module invariant. Using the gadget directly
 * from vitest tests avoids the runner's hoist-vs-pnpm collision
 * AND matches `@ggui-ai/ui-visual-tester`'s existing pattern.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export interface BrowserHandle {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  close(): Promise<void>;
}

const MCP_URL =
  process.env.GGUI_MCP_URL ??
  `http://localhost:${process.env.GGUI_PORT ?? 6781}/mcp`;

export interface OpenBrowserOptions {
  /**
   * When true (default), install a tiny relay script that forwards
   * `tools/call` postMessages from the rendered iframe to the MCP
   * server's `/mcp` endpoint and posts the JSON-RPC response back
   * to `event.source`.
   *
   * The page shell at `<server>/r/<code>` is just a thin loader for
   * the iframe-runtime — it doesn't ship a host MCP client. In real
   * deployments the host (claude.ai, sample agent, etc.) is the
   * relay party. For test scenarios that hit `/r/<code>` directly,
   * this fixture stands in for that host so submit_action actually
   * reaches the server.
   */
  readonly relayToolCallsToMcp?: boolean;
}

export async function openBrowser(
  opts: OpenBrowserOptions = {},
): Promise<BrowserHandle> {
  const relay = opts.relayToolCallsToMcp !== false;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  if (relay) {
    // Pass null — the in-page script derives the MCP URL from the
    // current location's origin. Hardcoding a URL trips CORS when
    // ggui-default issues 127.0.0.1 renderer URLs but the fixture
    // was configured against `localhost`.
    await page.addInitScript(() => {
      // Stand in for the host (MCP Apps relay party). Listens for
      // postMessages from any child iframe that carry a JSON-RPC
      // `tools/call`, forwards to the MCP server over HTTP, and
      // posts the response back to event.source so the iframe's
      // postRpcToParent listener resolves.
      window.addEventListener('message', async (ev) => {
        const data = ev.data as
          | {
              jsonrpc?: unknown;
              id?: unknown;
              method?: unknown;
              params?: unknown;
            }
          | null;
        if (
          data === null ||
          typeof data !== 'object' ||
          data.jsonrpc !== '2.0' ||
          data.method !== 'tools/call'
        ) {
          return;
        }
        const id = data.id as number;
        const params = data.params as
          | { name?: string; arguments?: Record<string, unknown> }
          | undefined;
        // Derive the MCP URL from the page's origin so we stay
        // same-origin regardless of whether the renderer URL uses
        // localhost or 127.0.0.1.
        const mcpUrl = `${window.location.origin}/mcp`;
        try {
          const resp = await fetch(mcpUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: Math.floor(Math.random() * 1e9),
              method: 'tools/call',
              params: {
                name: params?.name ?? '',
                arguments: params?.arguments ?? {},
              },
            }),
          });
          const text = await resp.text();
          let jsonRpc: unknown;
          const trimmed = text.trim();
          if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
            const dataLine = trimmed
              .split('\n')
              .find((l) => l.startsWith('data:'));
            jsonRpc = dataLine
              ? JSON.parse(dataLine.slice('data:'.length).trim())
              : { error: { message: 'SSE parse failed' } };
          } else {
            jsonRpc = JSON.parse(trimmed);
          }
          const r = jsonRpc as {
            result?: unknown;
            error?: { code: number; message: string };
          };
          const reply = {
            jsonrpc: '2.0',
            id,
            ...(r.error !== undefined
              ? { error: r.error }
              : { result: r.result }),
          };
          (ev.source as Window | null)?.postMessage(reply, '*');
        } catch (err) {
          (ev.source as Window | null)?.postMessage(
            {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : String(err),
              },
            },
            '*',
          );
        }
      });
    }, MCP_URL);
  }

  return {
    browser,
    context,
    page,
    async close() {
      await context.close();
      await browser.close();
    },
  };
}
