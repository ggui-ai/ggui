#!/usr/bin/env -S node --import tsx
/**
 * Tasks-mounted `createGguiServer` launcher — child-process entrypoint
 * for `tasks-backed-generation.spec.ts` (Slice 6 product proof).
 *
 * Why a dedicated launcher:
 *
 *   - `@ggui-ai/cli::ggui serve` has no `mcpMounts` config surface
 *     today (by design — adding `ggui.json#mcpMounts` is a dedicated
 *     follow-up slice). The only honest way to boot a Tasks-mounted
 *     server on the **real** `createGguiServer` runtime path is to
 *     call the factory directly with the mount opt passed in.
 *
 *   - Playwright 1.58 loads specs through a CJS TS transform pipeline.
 *     `@ggui-ai/mcp-server` + friends are ESM-only packages; importing
 *     them directly from a `.spec.ts` fails with "No exports main
 *     defined" because the exports map has no `require` condition.
 *     A subprocess launcher sidesteps the resolution mismatch: spawn
 *     `node --import tsx <this file>` and the launcher's ESM imports
 *     all resolve cleanly.
 *
 *   - The same child-process boundary the sibling `spawnGguiServe`
 *     harness uses — READY/PAIR_CODE beacons on stdout, allowlisted
 *     env, fresh-temp CWD — is reproduced here so the `journeys-
 *     ggui-oss` project stays consistent across specs.
 *
 * Accepts **no arguments** — every choice (port = 0, host = 127.0.0.1,
 * provider = Anthropic, model = claude-opus-4-7) is locked. If a
 * future slice needs a matrix, parameterize here. `ANTHROPIC_API_KEY`
 * comes from the inherited env (forwarded via the harness's BYOK
 * carve-out) — the launcher emits `MISSING_KEY\n` on stderr and exits
 * non-zero if absent so the spec's `beforeAll` gate sees an explicit
 * failure instead of a silent `codeReady: false` later.
 *
 * Output contract:
 *
 *   stdout:
 *     `READY <baseUrl>\n`   once the HTTP server is accepting traffic.
 *     `PAIR_CODE <code>\n`  once the initial pair code is minted.
 *
 *   stderr:
 *     `MISSING_KEY\n`       before exit(1) when ANTHROPIC_API_KEY is absent.
 *
 * Shutdown: SIGTERM triggers an ordered close (pairing service first,
 * then HTTP). The harness's 5s escalation-to-SIGKILL window is the
 * hard upper bound.
 */
import { createServer as createNetServer } from 'node:net';
import { createGguiServer, InMemoryAuthAdapter, InMemoryShortCodeIndex, type GenerationDeps, type LlmSelection, type McpServerMount, type ProviderKeyRef } from '@ggui-ai/mcp-server';
import { InMemoryBlueprintProvider } from '@ggui-ai/mcp-server-core/in-memory';
import { createDeterministicPreviewEmitter } from '@ggui-ai/preview-a2ui/emitters';
import { createUiGenerator, withBrowserCompile } from '@ggui-ai/ui-gen';
import { selectAdapter } from '@ggui-ai/ui-gen/providers';

/**
 * Pre-pick a free TCP port before `createGguiServer` so we can compose
 * an absolute `renderer.url` at factory time (Task #382 — srcdoc
 * iframes have `about:srcdoc` as origin; relative `/_ggui/renderer.js`
 * fails to resolve, so the renderer bundle never loads and the viewer
 * never reaches "connected"). Mirrors the CLI's pre-resolve pattern
 * (see `packages/ggui-cli/src/mcp-backend.ts::pickFreePort`).
 */
function pickFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (typeof addr === 'object' && addr !== null) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error(`pickFreePort: unexpected address ${String(addr)}`));
      }
    });
  });
}
import { createTasksSharedHandlers } from './fixtures/mcps/tasks/handlers.js';
import { TASKS_SEED } from './fixtures/mcps/tasks/seed.js';
import { TasksStore } from './fixtures/mcps/tasks/store.js';

async function main(): Promise<void> {
  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key || key.length === 0) {
    process.stderr.write('MISSING_KEY\n');
    process.exit(1);
    return;
  }

  // Seed from the canonical fixture — the spec's claim #1 matches
  // against this shape, and the launcher cannot diverge from the
  // fixture without the contract test flagging the drift.
  const store = new TasksStore();
  store.seed(TASKS_SEED);

  // Inline generator composition — mirrors `@ggui-ai/cli::
  // probeGenerationBinding` (the CLI is bin-only so its probe helper
  // isn't a published export). Provider pinned to Anthropic so the
  // spec's assertions never straddle providers.
  const adapter = selectAdapter('anthropic');
  if (!adapter) {
    process.stderr.write('NO_ANTHROPIC_ADAPTER\n');
    process.exit(1);
    return;
  }
  const uiGenerator = withBrowserCompile(createUiGenerator({ adapter }));
  const selection: LlmSelection = {
    provider: 'anthropic',
    model: 'claude-opus-4-7',
  };
  const providerKey: ProviderKeyRef = { provider: 'anthropic', key };
  const generation: GenerationDeps = {
    uiGenerator,
    resolveLlm: () => ({ selection, providerKey }),
    blueprints: new InMemoryBlueprintProvider(),
  };

  const tasksMount: McpServerMount = {
    name: 'tasks',
    handlers: createTasksSharedHandlers({ store }),
  };

  // Pre-pick a concrete port so we can compose an absolute
  // `renderer.url` BEFORE `createGguiServer` (Task #382 — srcdoc
  // iframes can't resolve relative paths; the renderer bundle URL on
  // `_meta.ggui.bootstrap.rendererUrl` must be absolute for the
  // devtool `/s/<shortCode>` SessionViewer iframe (srcdoc'd) to load the
  // renderer inside its srcdoc-mounted iframe).
  const port = await pickFreePort('127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;

  const server = createGguiServer({
    auth: new InMemoryAuthAdapter({ devAllowAll: false }),
    sessionChannel: true,
    pairing: true,
    shortCodeIndex: new InMemoryShortCodeIndex(),
    // Console mount owns the `/s/<shortCode>` SPA route the spec
    // navigates to. Without this, browser navigation returns
    // "Cannot GET /s/<shortCode>" and the test never finds the
    // connected status indicator. Mirrors the CLI's `ggui serve`
    // default (see packages/ggui-cli/src/mcp-backend.ts).
    // Renamed from `devtool` → `console` in Slice 5c.
    console: { sessionCookie: true },
    mcpApps: {
      renderBaseUrl: `${baseUrl}/s/`,
      wsUrl: `ws://127.0.0.1:${port}/ws`,
    },
    // Task #382 — absolute rendererUrl so srcdoc iframes can boot.
    renderer: { url: `${baseUrl}/_ggui/renderer.js` },
    provisionalPreview: {
      enabled: true,
      emitter: createDeterministicPreviewEmitter(),
    },
    generation,
    mcpMounts: [tasksMount],
  });

  const httpServer = await server.listen(port, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    process.stderr.write('LISTEN_NO_ADDRESS\n');
    process.exit(1);
    return;
  }

  if (!server.pairingService) {
    process.stderr.write('NO_PAIRING_SERVICE\n');
    process.exit(1);
    return;
  }
  const initial = await server.pairingService.initPairing();

  // Beacon contract — match the CLI's `runServe` exactly so the
  // harness's existing beacon parser works without per-launcher
  // branching. READY first, PAIR_CODE second.
  process.stdout.write(`READY ${baseUrl}\n`);
  process.stdout.write(`PAIR_CODE ${initial.code}\n`);

  const shutdown = async (): Promise<void> => {
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `LAUNCHER_FAILED ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
