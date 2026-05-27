/**
 * OSS Slice 6: operator-facing mount path — proven through the REAL
 * `ggui serve` CLI binary + real `ggui.json#mcpMounts` config.
 *
 * Pairs with:
 *   - `packages/project-config/src/mcp-mount-discovery.test.ts` — the
 *     resolver's own unit tests.
 *   - `packages/ggui-cli/src/mcp-backend.test.ts` — the in-process
 *     "mount wires into tools/list" integration.
 *
 * What THIS spec proves (and nothing else proves):
 *
 *   1. An operator declaring `mcpMounts: ["./mount.mjs"]` in
 *      `ggui.json` gets their mount loaded by the real CLI binary at
 *      boot — no custom launcher, no in-process compose.
 *   2. The mount's handlers surface through `/mcp tools/list`
 *      alongside ggui-native tools (`ggui_render`), under strict-auth.
 *   3. `tools/call` dispatches to the mount's handler — `tasks_list`
 *      reflects the seed declared inside the mount's factory, and a
 *      subsequent `tasks_create` persists + is visible on the next
 *      read.
 *
 * ## What this spec is NOT
 *
 *   - Not a generation test: no LLM, no browser, no `ggui_render` call.
 *     That diagonal is covered by `tasks-backed-generation.spec.ts`
 *     (via the custom launcher) and `live-generation.spec.ts`.
 *   - Not a full-surface contract test: the mount exposes only 2
 *     tools (`tasks_list` + `tasks_create`) — enough to prove the
 *     operator seam works. The TS Tasks fixture's 7-tool surface +
 *     48-test contract suite stay the source of truth for full
 *     coverage.
 *
 * ## Clean-room caveat
 *
 * Unlike `npx-bootstrap.spec.ts` + `manifest-capabilities.spec.ts`,
 * this spec spawns `ggui serve` with CWD pinned to a real fixture
 * dir inside the monorepo (via {@link spawnGguiServeInCwd}) — not a
 * `mkdtempSync` copy. Reason: the mount module's `import 'zod'` etc.
 * relies on Node's resolver finding `node_modules/` above the CWD,
 * and the monorepo's chain is the only one available. §4.4 #2 (env
 * allowlist) + §4.4 #3 (BYOK carve-out) still hold — the clean-room
 * relaxation is intentionally narrow. See harness JSDoc for the
 * trade-off.
 *
 * ## Lane classification
 *
 *   **Lane 1** (OSS-core E2E) — blocking, no LLM, should run <10s.
 *   Per the 4-lane taxonomy: this slice proves functional wiring
 *   (`ggui serve` + config + /mcp), not LLM-backed behaviour.
 */
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import {
  attachServeArtifacts,
  mcpCallAs,
  mintPairToken,
  spawnGguiServeInCwd,
  type GguiServeHandle,
} from './ggui-serve-harness';

/**
 * Absolute path to the fixture dir. `spawnGguiServeInCwd` spawns the
 * real CLI with this as CWD so the mount module at
 * `./tasks-mount.mjs` (relative to `ggui.json` in the same dir)
 * resolves through Node's default walker.
 */
const FIXTURE_CWD = resolve(__dirname, 'fixtures/tasks-mount-via-serve');

const EXPECTED_TITLES_SEEDED = [
  'Ship Slice 6 mount-via-serve',
  'Verify operator-facing mount path',
];

const NEW_TASK_TITLE = 'Route mcpMounts through ggui serve';

test.describe.serial(
  'Slice 6 — ggui.json#mcpMounts resolved by real `ggui serve` CLI',
  () => {
    let handle: GguiServeHandle | null = null;
    let sharedToken: string | null = null;

    test.beforeAll(async () => {
      handle = await spawnGguiServeInCwd({ cwd: FIXTURE_CWD });
      // Pair code is one-use; mint a single bearer and reuse it
      // across all assertions in this serial describe. Fresh-code-
      // per-test would require the admin/pair/init seam, which is
      // orthogonal to what this spec proves.
      const { token } = await mintPairToken(handle, 'mcp-mount-via-serve');
      sharedToken = token;
      expect(token.length).toBeGreaterThan(0);
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('tools/list surfaces ggui_render + tasks_list + tasks_create through strict-auth /mcp', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready — beforeAll failed');

      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/list', {});
      expect(listEnv.error).toBeUndefined();
      const tools = (listEnv.result as {
        tools?: Array<{ name: string }>;
      }).tools;
      expect(tools, 'tools/list returned no tools array').toBeDefined();
      const names = (tools ?? []).map((t) => t.name);
      // ggui-native:
      expect(
        names,
        'ggui_render missing — without it the console viewer is orphaned',
      ).toContain('ggui_render');
      // mounted:
      expect(
        names,
        'tasks_list missing — the mount module was loaded but tools/list did not surface its handlers',
      ).toContain('tasks_list');
      expect(
        names,
        'tasks_create missing — mount aggregation dropped a handler',
      ).toContain('tasks_create');
    });

    test('tasks_list reflects the seed declared inside createGguiMcpMount()', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const callEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'tasks_list',
        arguments: {},
      });
      expect(callEnv.error).toBeUndefined();
      const result = callEnv.result as {
        structuredContent?: { items?: Array<{ id: string; title: string }> };
        isError?: boolean;
      };
      expect(result.isError).not.toBe(true);
      const items = result.structuredContent?.items ?? [];
      expect(
        items.length,
        `tasks_list returned ${items.length} items — the mount factory seeded 2; CLI may have loaded the wrong module.`,
      ).toBe(EXPECTED_TITLES_SEEDED.length);
      const titles = items.map((i) => i.title).sort();
      expect(titles).toEqual([...EXPECTED_TITLES_SEEDED].sort());
    });

    test('tasks_create mutation round-trips + is visible on subsequent tasks_list', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      // Mutate through the mounted handler.
      const createEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'tasks_create',
        arguments: { input: { title: NEW_TASK_TITLE } },
      });
      expect(createEnv.error).toBeUndefined();
      const createResult = createEnv.result as {
        structuredContent?: {
          item?: { id: string; title: string; status: string };
        };
        isError?: boolean;
      };
      expect(createResult.isError).not.toBe(true);
      expect(createResult.structuredContent?.item?.title).toBe(NEW_TASK_TITLE);
      expect(createResult.structuredContent?.item?.status).toBe('todo');
      const createdId = createResult.structuredContent?.item?.id;
      expect(createdId).toBeTruthy();

      // Read through the mounted handler — mutation durable across
      // dispatch (the mount owns its state for the life of the CLI
      // process, which is what we want).
      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'tasks_list',
        arguments: {},
      });
      const listResult = listEnv.result as {
        structuredContent?: { items?: Array<{ id: string; title: string }> };
      };
      const items = listResult.structuredContent?.items ?? [];
      expect(
        items.length,
        `tasks_list after tasks_create returned ${items.length} items — expected seed + 1 = 3.`,
      ).toBe(EXPECTED_TITLES_SEEDED.length + 1);
      expect(
        items.some((i) => i.id === createdId && i.title === NEW_TASK_TITLE),
        `post-create tasks_list did not contain the new item {${createdId!}, "${NEW_TASK_TITLE}"} — the mutation did not land in the store.`,
      ).toBe(true);
    });
  },
);
