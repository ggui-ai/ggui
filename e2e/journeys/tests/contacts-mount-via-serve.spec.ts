/**
 * OSS Slice 6.3 payoff: Contacts mount reaches the real `ggui serve`
 * CLI through `ggui.json#mcpMounts` — completes the trio proof that
 * the mount pattern locked in Slice 6 (Tasks) + Slice 6.2 (Notes)
 * generalises to a THIRD domain without a parallel mounting mechanism.
 *
 * Pairs with:
 *   - `tasks-mount-via-serve.spec.ts` — Slice 6 operator-path E2E.
 *   - `notes-mount-via-serve.spec.ts` — Slice 6.2 operator-path E2E.
 *   - `packages/mcp-server/src/mcp-mounts.test.ts` +
 *     `fixtures/mcps/contacts/*.test.ts` — unit + wire coverage.
 *
 * Claims anchored here (and nowhere else):
 *
 *   1. A declared `mcpMounts: ["./contacts-mount.mjs"]` entry resolves
 *      through the REAL CLI binary (not the tests' custom launcher).
 *   2. `tools/list` surfaces `ggui_render` + three `contacts_*` tools.
 *   3. `tools/call contacts_list` reflects seeded state from the mount
 *      factory closure.
 *   4. `tools/call contacts_create` writes; the next `contacts_list`
 *      sees it.
 *   5. `tools/call contacts_link op=add` then `op=remove` round-trips
 *      cleanly through the wire — the Contacts-specific cross-ref op
 *      that differentiates this slice from Tasks (tasks_complete) and
 *      Notes (notes_append).
 *
 * ## Clean-room caveat
 *
 * Matches `tasks-mount-via-serve.spec.ts` +
 * `notes-mount-via-serve.spec.ts` — uses {@link spawnGguiServeInCwd},
 * which pins CWD to this fixture dir inside the monorepo (not a
 * mkdtemp copy) so the mount module's `import 'zod'` resolves via the
 * workspace's `node_modules/` chain. §4.4 #2 (env allowlist) + §4.4
 * #3 (BYOK carve-out) still hold.
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

const FIXTURE_CWD = resolve(__dirname, 'fixtures/contacts-mount-via-serve');

const EXPECTED_DISPLAY_NAMES_SEEDED = ['Alice Chen', 'Bob Patel'];

const NEW_CONTACT_DISPLAY_NAME = 'Slice 6.3 Contact';
const NEW_CONTACT_EMAIL = 'slice63@example.com';

const LINK_TARGET_TASK_ID = 'linked-task-xyz';

test.describe.serial(
  'Slice 6.3 — Contacts ggui.json#mcpMounts resolved by real `ggui serve` CLI',
  () => {
    let handle: GguiServeHandle | null = null;
    let sharedToken: string | null = null;

    test.beforeAll(async () => {
      handle = await spawnGguiServeInCwd({ cwd: FIXTURE_CWD });
      // Pair code is one-use; mint once and share across all
      // assertions in this serial describe.
      const { token } = await mintPairToken(handle, 'contacts-mount-via-serve');
      sharedToken = token;
      expect(token.length).toBeGreaterThan(0);
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('tools/list surfaces ggui_render + contacts_list + contacts_create + contacts_link through strict-auth /mcp', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/list', {});
      expect(listEnv.error).toBeUndefined();
      const tools = (listEnv.result as { tools?: Array<{ name: string }> })
        .tools;
      expect(tools).toBeDefined();
      const names = (tools ?? []).map((t) => t.name);
      expect(names).toContain('ggui_render');
      expect(names).toContain('contacts_list');
      expect(names).toContain('contacts_create');
      expect(
        names,
        'contacts_link missing — proves the Contacts-specific cross-ref op flows through the mount wire too',
      ).toContain('contacts_link');
    });

    test('contacts_list reflects the seed declared inside createGguiMcpMount()', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const callEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'contacts_list',
        arguments: {},
      });
      expect(callEnv.error).toBeUndefined();
      const result = callEnv.result as {
        structuredContent?: {
          items?: Array<{ id: string; displayName: string }>;
        };
        isError?: boolean;
      };
      expect(result.isError).not.toBe(true);
      const items = result.structuredContent?.items ?? [];
      expect(items.length).toBe(EXPECTED_DISPLAY_NAMES_SEEDED.length);
      expect(items.map((i) => i.displayName).sort()).toEqual(
        [...EXPECTED_DISPLAY_NAMES_SEEDED].sort(),
      );
    });

    test('contacts_create mutation round-trips + is visible on subsequent contacts_list', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const createEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'contacts_create',
        arguments: {
          input: {
            displayName: NEW_CONTACT_DISPLAY_NAME,
            email: NEW_CONTACT_EMAIL,
          },
        },
      });
      expect(createEnv.error).toBeUndefined();
      const createResult = createEnv.result as {
        structuredContent?: {
          item?: {
            id: string;
            displayName: string;
            email: string | null;
          };
        };
        isError?: boolean;
      };
      expect(createResult.isError).not.toBe(true);
      expect(createResult.structuredContent?.item?.displayName).toBe(
        NEW_CONTACT_DISPLAY_NAME,
      );
      expect(createResult.structuredContent?.item?.email).toBe(
        NEW_CONTACT_EMAIL,
      );
      const createdId = createResult.structuredContent?.item?.id;
      expect(createdId).toBeTruthy();

      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'contacts_list',
        arguments: {},
      });
      const listResult = listEnv.result as {
        structuredContent?: {
          items?: Array<{ id: string; displayName: string }>;
        };
      };
      const items = listResult.structuredContent?.items ?? [];
      expect(items.length).toBe(EXPECTED_DISPLAY_NAMES_SEEDED.length + 1);
      expect(
        items.some(
          (i) => i.id === createdId && i.displayName === NEW_CONTACT_DISPLAY_NAME,
        ),
      ).toBe(true);
    });

    test('contacts_link add then remove round-trips linkedTaskIds[] (Contacts differentiator from Tasks + Notes)', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      // Re-use the row created in the previous test — serial describe,
      // single CLI process, in-memory mount state.
      const listEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'contacts_list',
        arguments: {},
      });
      const items =
        (listEnv.result as {
          structuredContent?: {
            items?: Array<{
              id: string;
              displayName: string;
              linkedTaskIds: string[];
            }>;
          };
        }).structuredContent?.items ?? [];
      const target = items.find(
        (i) => i.displayName === NEW_CONTACT_DISPLAY_NAME,
      );
      expect(target, 'prior create did not land').toBeDefined();
      expect(target!.linkedTaskIds).toEqual([]);

      // Add.
      const addedEnv = await mcpCallAs(handle.baseUrl, sharedToken, 'tools/call', {
        name: 'contacts_link',
        arguments: {
          id: target!.id,
          link: { kind: 'task', targetId: LINK_TARGET_TASK_ID, op: 'add' },
        },
      });
      expect(addedEnv.error).toBeUndefined();
      const added = addedEnv.result as {
        structuredContent?: {
          item?: { linkedTaskIds: string[] } | null;
        };
        isError?: boolean;
      };
      expect(added.isError).not.toBe(true);
      expect(added.structuredContent?.item?.linkedTaskIds).toEqual([
        LINK_TARGET_TASK_ID,
      ]);

      // Remove.
      const removedEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        {
          name: 'contacts_link',
          arguments: {
            id: target!.id,
            link: { kind: 'task', targetId: LINK_TARGET_TASK_ID, op: 'remove' },
          },
        },
      );
      expect(removedEnv.error).toBeUndefined();
      const removed = removedEnv.result as {
        structuredContent?: {
          item?: { linkedTaskIds: string[] } | null;
        };
        isError?: boolean;
      };
      expect(removed.isError).not.toBe(true);
      expect(removed.structuredContent?.item?.linkedTaskIds).toEqual([]);
    });
  },
);
