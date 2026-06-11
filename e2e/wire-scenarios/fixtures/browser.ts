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
 *
 * This fixture is page-plumbing ONLY — it installs no host-side
 * scripts. The R5 retirement (2026-05-26) removed the `/r/<shortCode>`
 * page-shell surface this fixture once stood in as a host for;
 * `ggui_render`'s wire output carries no browser URL. Browser
 * scenarios instead resolve the render's `resourceUri`
 * (`ui://ggui/render/...`) via MCP `resources/read` and mount it
 * behind the MCP-Apps host stand-in (fixtures/mcp-app-host.ts
 * `mountRenderResource`), whose wrapper page plays the host party —
 * answering `ui/initialize` and relaying `tools/call` postMessages to
 * the MCP endpoint.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

export interface BrowserHandle {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  close(): Promise<void>;
}

export async function openBrowser(): Promise<BrowserHandle> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

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
