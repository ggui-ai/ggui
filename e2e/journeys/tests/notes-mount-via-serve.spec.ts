/**
 * OSS Slice 6.2 payoff: Notes mount reaches the real `ggui serve` CLI
 * through `ggui.json#mcpMounts` — proves the mount pattern locked in
 * Slice 6 (Tasks) generalises to a second domain without a parallel
 * mounting mechanism.
 *
 * Pairs with:
 *   - `tasks-mount-via-serve.spec.ts` — Slice 6 operator-path E2E.
 *   - `packages/mcp-server/src/mcp-mounts.test.ts` + integration
 *     tests under `fixtures/mcps/notes/` — unit + wire coverage.
 *
 * Claims anchored here (and nowhere else):
 *
 *   1. A declared `mcpMounts: ["./notes-mount.mjs"]` entry resolves
 *      through the REAL CLI binary (not the tests' custom launcher).
 *   2. `tools/list` surfaces `ggui_push` + three `notes_*` tools.
 *   3. `tools/call notes_list` reflects seeded state from the mount
 *      factory closure.
 *   4. `tools/call notes_create` writes; the next `notes_list` sees it.
 *   5. `tools/call notes_append` preserves the prior body with the
 *      paragraph-break semantic — the Notes-specific behaviour that
 *      differentiates this slice from Tasks.
 *
 * ## Clean-room caveat
 *
 * Matches `tasks-mount-via-serve.spec.ts` — uses
 * {@link spawnGguiServeInCwd}, which pins CWD to this fixture dir
 * inside the monorepo (not a mkdtemp copy) so the mount module's
 * `import 'zod'` resolves via the workspace's `node_modules/` chain.
 * §4.4 #2 (env allowlist) + §4.4 #3 (BYOK carve-out) still hold.
 *
 * ## Lane classification
 *
 *   **Lane 1** (OSS-core E2E) — blocking, no LLM, <10s.
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

const FIXTURE_CWD = resolve(__dirname, 'fixtures/notes-mount-via-serve');

const EXPECTED_TITLES_SEEDED = ['Slice 6.2 plan', 'Pricing research'];

const NEW_NOTE_TITLE = 'Ship Slice 6.2 Notes mount proof';
const NEW_NOTE_BODY = 'Drafted spec; verification pending.';
const APPEND_MARKDOWN = 'Verification green. Ready to commit.';

test.describe.serial(
  'Slice 6.2 — Notes ggui.json#mcpMounts resolved by real `ggui serve` CLI',
  () => {
    let handle: GguiServeHandle | null = null;
    let sharedToken: string | null = null;

    test.beforeAll(async () => {
      handle = await spawnGguiServeInCwd({ cwd: FIXTURE_CWD });
      // Pair code is one-use; mint once and share across all
      // assertions in this serial describe.
      const { token } = await mintPairToken(handle, 'notes-mount-via-serve');
      sharedToken = token;
      expect(token.length).toBeGreaterThan(0);
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('tools/list surfaces ggui_push + notes_list + notes_create + notes_append through strict-auth /mcp', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/list', {});
      expect(listEnv.error).toBeUndefined();
      const tools = (listEnv.result as { tools?: Array<{ name: string }> })
        .tools;
      expect(tools).toBeDefined();
      const names = (tools ?? []).map((t) => t.name);
      expect(names).toContain('ggui_push');
      expect(names).toContain('notes_list');
      expect(names).toContain('notes_create');
      expect(
        names,
        'notes_append missing — proves the Notes-specific append op flows through the mount wire too',
      ).toContain('notes_append');
    });

    test('notes_list reflects the seed declared inside createGguiMcpMount()', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const callEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'notes_list',
        arguments: {},
      });
      expect(callEnv.error).toBeUndefined();
      const result = callEnv.result as {
        structuredContent?: { items?: Array<{ id: string; title: string }> };
        isError?: boolean;
      };
      expect(result.isError).not.toBe(true);
      const items = result.structuredContent?.items ?? [];
      expect(items.length).toBe(EXPECTED_TITLES_SEEDED.length);
      expect(items.map((i) => i.title).sort()).toEqual(
        [...EXPECTED_TITLES_SEEDED].sort(),
      );
    });

    test('notes_create mutation round-trips + is visible on subsequent notes_list', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const createEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'notes_create',
        arguments: { input: { title: NEW_NOTE_TITLE, body: NEW_NOTE_BODY } },
      });
      expect(createEnv.error).toBeUndefined();
      const createResult = createEnv.result as {
        structuredContent?: { item?: { id: string; title: string; body: string } };
        isError?: boolean;
      };
      expect(createResult.isError).not.toBe(true);
      expect(createResult.structuredContent?.item?.title).toBe(NEW_NOTE_TITLE);
      expect(createResult.structuredContent?.item?.body).toBe(NEW_NOTE_BODY);
      const createdId = createResult.structuredContent?.item?.id;
      expect(createdId).toBeTruthy();

      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'notes_list',
        arguments: {},
      });
      const listResult = listEnv.result as {
        structuredContent?: { items?: Array<{ id: string; title: string }> };
      };
      const items = listResult.structuredContent?.items ?? [];
      expect(items.length).toBe(EXPECTED_TITLES_SEEDED.length + 1);
      expect(
        items.some((i) => i.id === createdId && i.title === NEW_NOTE_TITLE),
      ).toBe(true);
    });

    test('notes_append preserves prior body with a blank-line paragraph separator (Notes differentiator from Tasks)', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      // The prior test's new row is still in the store (serial describe,
      // single CLI process, in-memory mount state).
      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'notes_list',
        arguments: {},
      });
      const items =
        (listEnv.result as {
          structuredContent?: { items?: Array<{ id: string; title: string }> };
        }).structuredContent?.items ?? [];
      const newRow = items.find((i) => i.title === NEW_NOTE_TITLE);
      expect(newRow, 'prior create did not land').toBeDefined();

      const appendEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'notes_append',
        arguments: { id: newRow!.id, markdown: APPEND_MARKDOWN },
      });
      expect(appendEnv.error).toBeUndefined();
      const appended = appendEnv.result as {
        structuredContent?: { item?: { body: string } | null };
        isError?: boolean;
      };
      expect(appended.isError).not.toBe(true);
      expect(appended.structuredContent?.item?.body).toBe(
        `${NEW_NOTE_BODY}\n\n${APPEND_MARKDOWN}`,
      );
    });
  },
);
