/**
 * OSS Slice 6.4 payoff: first 2-MCP composition — Tasks + Contacts —
 * reachable through the real `ggui serve` CLI with a TWO-entry
 * `ggui.json#mcpMounts` array.
 *
 * Pairs with:
 *   - `tasks-mount-via-serve.spec.ts` — Slice 6 single-mount proof.
 *   - `notes-mount-via-serve.spec.ts` — Slice 6.2 single-mount proof.
 *   - `contacts-mount-via-serve.spec.ts` — Slice 6.3 single-mount proof.
 *
 * ## What THIS spec proves (and nothing else proves)
 *
 *   1. `ggui.json#mcpMounts` accepts AN ARRAY OF MOUNTS — the CLI
 *      discovers, loads, and aggregates BOTH `tasks-mount.mjs` +
 *      `contacts-mount.mjs` onto a single `/mcp` surface in one `ggui
 *      serve` process. Earlier mount-via-serve specs all declared
 *      exactly one mount entry.
 *   2. `tools/list` carries BOTH tool families (`tasks_*` + `contacts_*`)
 *      alongside `ggui_push` on one session — the precondition for an
 *      agent to decompose a cross-domain intent across both surfaces.
 *   3. **Relational truth holds ACROSS MCPs on seed**: the tasks whose
 *      `assigneeId === 'alice'` (as reported by `tasks_list`) are the
 *      same ids `contacts_get('alice').linkedTaskIds` carries. Either
 *      view recovers the same relationship, NOT a shallow "both tool
 *      families visible" coexistence.
 *   4. **Relational truth survives a cross-MCP mutation**: a new task
 *      created via `tasks_create({assigneeId:'alice'})` + the new id
 *      added to alice via `contacts_link({kind:'task', op:'add'})`
 *      leaves BOTH views agreeing on the new relationship. This is
 *      the mutation path Slice 6.4 unlocks for downstream blueprint
 *      negotiators (person-centric work view, assignee-grouped kanban,
 *      follow-up-for-contact form).
 *
 * ## What this spec is NOT
 *
 *   - Not a generation test. No LLM, no browser navigation. The
 *     sibling `tasks-backed-generation.spec.ts` and `live-generation.
 *     spec.ts` cover LLM-backed renderable componentCode; a bounded
 *     composition equivalent is a separate advisory slice when
 *     practical. This spec's job is the relational-truth claim
 *     independent of LLM nondeterminism.
 *   - Not a per-tool contract test. Both mount .mjs files expose
 *     narrow surfaces (3 tools each) — only enough to exercise the
 *     composition. The 7-tool TS fixtures at
 *     `../fixtures/mcps/{tasks,contacts}/` own full contract
 *     coverage.
 *   - Not a multi-mount collision / error-path test. Slice 6's unit
 *     suite (`packages/mcp-server/src/mcp-mounts.test.ts`) covers tool-
 *     name collisions + empty-outputSchema rejection.
 *
 * ## Clean-room caveat
 *
 * Matches the sibling single-mount specs — uses
 * {@link spawnGguiServeInCwd} so the mount modules' `import 'zod'`
 * resolves via the monorepo's walk-up `node_modules` chain. §4.4 #2
 * (env allowlist) + §4.4 #3 (BYOK carve-out) still hold.
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

const FIXTURE_CWD = resolve(
  __dirname,
  'fixtures/tasks-contacts-mount-via-serve',
);

/** Shape-only facet of TaskItem used by this spec's assertions. */
interface TaskView {
  readonly id: string;
  readonly title: string;
  readonly assigneeId: string | null;
}

/** Shape-only facet of ContactItem used by this spec's assertions. */
interface ContactView {
  readonly id: string;
  readonly displayName: string;
  readonly linkedTaskIds: readonly string[];
}

const SEED_ALICE_EXPECTED_TASK_IDS = ['seed-task-1', 'seed-task-2'];
const SEED_BOB_EXPECTED_TASK_IDS: readonly string[] = [];

const NEW_TASK_TITLE = 'Follow up with Alice on pricing';

test.describe.serial(
  'Slice 6.4 — Tasks + Contacts composed on the real `ggui serve` CLI',
  () => {
    let handle: GguiServeHandle | null = null;
    let sharedToken: string | null = null;

    test.beforeAll(async () => {
      handle = await spawnGguiServeInCwd({ cwd: FIXTURE_CWD });
      const { token } = await mintPairToken(
        handle,
        'tasks-contacts-compose-via-serve',
      );
      sharedToken = token;
      expect(token.length).toBeGreaterThan(0);
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('tools/list surfaces ggui_push + tasks_* + contacts_* on one session from a two-entry mcpMounts array', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      const listEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/list',
        {},
      );
      expect(listEnv.error).toBeUndefined();
      const tools = (listEnv.result as { tools?: Array<{ name: string }> })
        .tools;
      expect(tools).toBeDefined();
      const names = (tools ?? []).map((t) => t.name);

      expect(names).toContain('ggui_push');
      // Tasks mount (3 tools).
      expect(names).toContain('tasks_list');
      expect(names).toContain('tasks_get');
      expect(names).toContain('tasks_create');
      // Contacts mount (3 tools).
      expect(names).toContain('contacts_list');
      expect(names).toContain('contacts_get');
      expect(
        names,
        'contacts_link missing — the cross-ref mutation tool is the load-bearing op for the composition mutation claim.',
      ).toContain('contacts_link');

      // Sanity lower bound — ggui-native (4: blueprint reads + ggui_push)
      // + tasks (3) + contacts (3) = 10.
      expect(names.length).toBeGreaterThanOrEqual(10);
    });

    test('seeded relational truth: tasks with assigneeId=alice match contacts_get(alice).linkedTaskIds', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      // Read Alice from the contacts mount.
      const contactEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        { name: 'contacts_get', arguments: { id: 'alice' } },
      );
      expect(contactEnv.error).toBeUndefined();
      const contactResult = contactEnv.result as {
        structuredContent?: { item?: ContactView | null };
        isError?: boolean;
      };
      expect(contactResult.isError).not.toBe(true);
      const alice = contactResult.structuredContent?.item;
      expect(alice, 'contacts_get(alice) returned null — seed missing').toBeTruthy();

      // Read the full task list from the tasks mount + filter to tasks
      // assigned to alice.
      const taskEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        { name: 'tasks_list', arguments: {} },
      );
      expect(taskEnv.error).toBeUndefined();
      const taskResult = taskEnv.result as {
        structuredContent?: { items?: TaskView[] };
        isError?: boolean;
      };
      expect(taskResult.isError).not.toBe(true);
      const tasks = taskResult.structuredContent?.items ?? [];
      const aliceTaskIdsFromTasks = tasks
        .filter((t) => t.assigneeId === 'alice')
        .map((t) => t.id)
        .sort();

      // Cross-MCP agreement — the two views return the same set of
      // ids. If the stores diverge on seed, this flips first.
      expect(aliceTaskIdsFromTasks).toEqual(
        [...SEED_ALICE_EXPECTED_TASK_IDS].sort(),
      );
      expect([...(alice!.linkedTaskIds ?? [])].sort()).toEqual(
        [...SEED_ALICE_EXPECTED_TASK_IDS].sort(),
      );

      // Sanity: bob's reverse-ref is empty AND no task carries his
      // assigneeId. An accidental "every contact gets every task"
      // default would flip this.
      const bobContactEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        { name: 'contacts_get', arguments: { id: 'bob' } },
      );
      const bobResult = bobContactEnv.result as {
        structuredContent?: { item?: ContactView | null };
      };
      const bob = bobResult.structuredContent?.item;
      expect(bob?.linkedTaskIds ?? []).toEqual(SEED_BOB_EXPECTED_TASK_IDS);
      expect(tasks.filter((t) => t.assigneeId === 'bob').map((t) => t.id)).toEqual(
        [],
      );
    });

    test('cross-MCP mutation: new tasks_create + contacts_link(add) leaves both mounts agreeing on the new relationship', async () => {
      if (!handle || !sharedToken) throw new Error('handle not ready');

      // Create a new task on the tasks mount with assigneeId=alice.
      // The tasks side of the relationship is now: "new task exists
      // AND its assigneeId references alice".
      const createEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        {
          name: 'tasks_create',
          arguments: {
            input: { title: NEW_TASK_TITLE, assigneeId: 'alice' },
          },
        },
      );
      expect(createEnv.error).toBeUndefined();
      const createResult = createEnv.result as {
        structuredContent?: { item?: TaskView };
        isError?: boolean;
      };
      expect(createResult.isError).not.toBe(true);
      const newTask = createResult.structuredContent?.item;
      expect(newTask?.title).toBe(NEW_TASK_TITLE);
      expect(newTask?.assigneeId).toBe('alice');
      const newTaskId = newTask!.id;

      // Contacts side not yet updated — the contacts mount doesn't
      // auto-sync off tasks writes (strategy §18: id-reference-by-
      // convention, no cross-MCP coupling at the store layer). Verify
      // the gap before we mutate the other side.
      const preLinkEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        { name: 'contacts_get', arguments: { id: 'alice' } },
      );
      const preLinkResult = preLinkEnv.result as {
        structuredContent?: { item?: ContactView | null };
      };
      expect(
        preLinkResult.structuredContent?.item?.linkedTaskIds ?? [],
        'contacts mount accidentally auto-synced off tasks_create — cross-MCP coupling should require an explicit contacts_link call.',
      ).not.toContain(newTaskId);

      // Explicit cross-ref write via the contacts mount.
      const linkEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        {
          name: 'contacts_link',
          arguments: {
            id: 'alice',
            link: { kind: 'task', targetId: newTaskId, op: 'add' },
          },
        },
      );
      expect(linkEnv.error).toBeUndefined();
      const linkResult = linkEnv.result as {
        structuredContent?: { item?: ContactView | null };
        isError?: boolean;
      };
      expect(linkResult.isError).not.toBe(true);
      expect(
        linkResult.structuredContent?.item?.linkedTaskIds ?? [],
      ).toContain(newTaskId);

      // Post-mutation: both views must agree on the NEW relationship.
      // Tasks side — assigneeId === 'alice' for the new row.
      const postTaskEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        { name: 'tasks_list', arguments: {} },
      );
      const postTasks =
        (postTaskEnv.result as {
          structuredContent?: { items?: TaskView[] };
        }).structuredContent?.items ?? [];
      const aliceIdsAfter = postTasks
        .filter((t) => t.assigneeId === 'alice')
        .map((t) => t.id)
        .sort();

      // Contacts side — the cross-ref now includes the new task id.
      const postContactEnv = await mcpCallAs(
        handle.baseUrl,
        sharedToken,
        'tools/call',
        { name: 'contacts_get', arguments: { id: 'alice' } },
      );
      const aliceAfter = (
        postContactEnv.result as {
          structuredContent?: { item?: ContactView | null };
        }
      ).structuredContent?.item;

      const expectedAfter = [...SEED_ALICE_EXPECTED_TASK_IDS, newTaskId].sort();
      expect(aliceIdsAfter).toEqual(expectedAfter);
      expect([...(aliceAfter!.linkedTaskIds ?? [])].sort()).toEqual(
        expectedAfter,
      );
    });
  },
);
