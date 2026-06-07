/**
 * Phase 5 `ggui` OSS — SQLite storage driver boot (advisory → GREEN).
 *
 * Closes §4.3 G11 ("SQLite driver boot — durable render store, WAL
 * artifact"). The blocking tier of Phase 5 exercises the in-memory
 * storage driver exclusively via every other spec in `journeys-ggui-oss`;
 * this one flips the `storage.{renders,vectors,threads}.driver` knob
 * to `'sqlite'` through a fixture `ggui.json` and proves the CLI:
 *
 *   1. Status-reports the sqlite driver on the pre-banner stdout lines
 *      `storage: renders  → sqlite (./ggui-sessions.sqlite)` (plus
 *      vectors/threads siblings). This pins the `describeStorageStatus`
 *      contract from `packages/ggui-cli/src/cli.ts` on the wire.
 *   2. Creates the actual `.sqlite` files on disk after boot — proof
 *      that `@ggui-ai/mcp-server-core/sqlite` dynamically imported
 *      cleanly and the underlying `better-sqlite3` N-API binding
 *      loaded. A misconfigured fixture / missing peer dep would fail
 *      at the CLI's own dynamic-import wrapper
 *      (`resolveStorageFromConfigSafely`) with a remediation hint;
 *      this spec would see READY never arriving.
 *   3. Exercises the write path: mint a pair token, fire a
 *      `ggui_render` story, and confirm the `.sqlite` artifact
 *      mutates (file size grows from the zero-turn baseline). This
 *      proves the SqliteGguiSessionStore is actually persisting events,
 *      not just being instantiated.
 *
 * What this spec deliberately does NOT cover (called out so future
 * sessions don't grow the slice):
 *
 *   - WAL inspection / journal_mode assertion. `better-sqlite3`'s
 *     default mode is fine for the advisory gate; asserting a
 *     specific journal mode would pin an implementation detail that
 *     the reference store could reasonably change.
 *   - Durability across restarts. The §4.3 criterion is "driver
 *     boot". A "restart + replay" proof is a future slice — it
 *     requires tearing down + re-spawning the same CWD, which the
 *     harness can handle but expands scope beyond the advisory row.
 *   - Multi-surface fsync guarantees. Advisory-tier claim.
 *   - Phase 5.5 tarball flow with sqlite. The tarball-smoke spec
 *     covers the memory driver only; a sqlite tarball variant is
 *     follow-on work when/if we ship a first-run sqlite default.
 *
 * Serial under `journeys-ggui-oss`. Own `ggui serve` per test to keep
 * fixture-induced state isolated.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  mcpCallAs,
  mintPairToken,
  spawnGguiServe,
  type GguiServeHandle,
} from './ggui-serve-harness';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath, join } from 'node:path';

/**
 * Sum the byte sizes of a sqlite database file plus any sibling WAL /
 * SHM artifacts. `better-sqlite3` defaults to WAL mode, which parks
 * new writes in `<db>-wal` until a checkpoint promotes them back to
 * the main `<db>` file. Asserting only the main-file size misses the
 * fresh writes; summing across the artifact family is the honest
 * "bytes actually on disk for this store" reading.
 */
function sqliteFamilyBytes(root: string, dbName: string): number {
  const prefix = dbName;
  return readdirSync(root)
    .filter((name) => name === prefix || name.startsWith(`${prefix}-`))
    .reduce((total, name) => total + statSync(join(root, name)).size, 0);
}

const FIXTURE_DIR = resolvePath(__dirname, 'fixtures/sqlite-storage');

/** Same upper bound as sibling specs — sqlite boot adds only the
 *  dynamic-import cost (~100-300ms on warm disk). 60s is 100× headroom. */
const TEST_TIMEOUT_MS = 60_000;

test.describe.serial('Phase 5 — SQLite storage driver boot', () => {
  let handle: GguiServeHandle;

  test.beforeAll(async () => {
    if (!existsSync(GGUI_CLI_DIST)) {
      test.skip(
        true,
        `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
      );
      return;
    }
    if (!existsSync(DEVTOOL_DIST)) {
      test.skip(
        true,
        `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
      );
      return;
    }
    handle = await spawnGguiServe({ fixtureDir: FIXTURE_DIR });
  });

  test.afterAll(async () => {
    if (handle) await handle.close();
  });

  test.afterEach(async () => {
    if (handle) await attachServeArtifacts(handle);
  });

  test('CLI status lines + sqlite files materialise on disk', async () => {
    test.setTimeout(TEST_TIMEOUT_MS);

    // 1. Status lines — pin the external contract from
    //    `describeStorageStatus` in `packages/ggui-cli/src/cli.ts`.
    //    These are operator-facing lines (the only signal the CLI
    //    surfaces that the sqlite driver actually mounted), so
    //    asserting them here locks the wire format for future
    //    ggui.json manifests.
    const stdout = handle.stdout();
    expect(
      stdout,
      'CLI did not announce the sqlite renders store',
    ).toMatch(/storage: renders\s+→ sqlite \(\.\/ggui-sessions\.sqlite\)/);
    expect(
      stdout,
      'CLI did not announce the sqlite vectors store',
    ).toMatch(/storage: vectors\s+→ sqlite \(\.\/ggui-vectors\.sqlite\)/);
    expect(
      stdout,
      'CLI did not announce the sqlite threads store',
    ).toMatch(
      /storage: threads\s+→ sqlite \(\.\/ggui-threads\.sqlite\) — durable/,
    );

    // 2. Files on disk — proof `@ggui-ai/mcp-server-core/sqlite`
    //    dynamically imported and `better-sqlite3` loaded. The paths
    //    are relative to the ggui.json directory (the tempCwd) —
    //    same contract `resolveStorageFromConfig` consumes.
    const rendersDb = join(handle.tempCwd, 'ggui-sessions.sqlite');
    const vectorsDb = join(handle.tempCwd, 'ggui-vectors.sqlite');
    const threadsDb = join(handle.tempCwd, 'ggui-threads.sqlite');
    expect(
      existsSync(rendersDb),
      `renders sqlite file missing at ${rendersDb}`,
    ).toBe(true);
    expect(
      existsSync(vectorsDb),
      `vectors sqlite file missing at ${vectorsDb}`,
    ).toBe(true);
    expect(
      existsSync(threadsDb),
      `threads sqlite file missing at ${threadsDb}`,
    ).toBe(true);

    // 3. Write-path proof — mint a pair token, fire a `ggui_render`
    //    against the sqlite-backed render store, then assert the
    //    renders db artifact family (main + `-wal` + `-shm`) grew
    //    past the boot baseline. The particular byte count isn't
    //    load-bearing (depends on better-sqlite3 page size + journal
    //    mode); ">0 after mutation" is the honest signal that writes
    //    actually hit disk, not that the store no-op'd silently.
    //    Summing across the family captures WAL-mode writes that
    //    land in `<db>-wal` before checkpointing — see the
    //    `sqliteFamilyBytes` helper.
    const baselineBytes = sqliteFamilyBytes(
      handle.tempCwd,
      'ggui-sessions.sqlite',
    );
    const { token } = await mintPairToken(handle, 'sqlite-storage-spec');
    expect(token.length).toBeGreaterThan(0);

    // Post-Phase-B render is handshake-first: handshake → render
    // ({handshakeId, props, override?}). The prior `ggui_new_session` mint is
    // gone — every render IS the addressable scope.
    const hsEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
      name: 'ggui_handshake',
      arguments: {
        intent: 'sqlite driver boot smoke',
        blueprintDraft: { contract: {} },
      },
    });
    expect(hsEnv.error).toBeUndefined();
    const handshakeId = (
      hsEnv.result as { structuredContent: { handshakeId: string } }
    ).structuredContent.handshakeId;
    expect(handshakeId).toBeTruthy();

    const renderEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
      name: 'ggui_render',
      arguments: { handshakeId, props: {}, override: { contract: {} } },
    });
    expect(renderEnv.error).toBeUndefined();
    // Post-Phase-B structuredContent surface: {sessionId, url, action,
    // nextStep?}. The presence of `sessionId` is the proof the render
    // committed.
    const renderOutput = renderEnv.result as {
      structuredContent?: { sessionId?: string; url?: string };
      isError?: boolean;
    };
    expect(renderOutput.structuredContent?.sessionId).toBeTruthy();

    const postWriteBytes = sqliteFamilyBytes(
      handle.tempCwd,
      'ggui-sessions.sqlite',
    );
    expect(
      postWriteBytes,
      `sessions sqlite family did not grow after ggui_render — baseline=${baselineBytes}B, post=${postWriteBytes}B. ` +
        `The SqliteGguiSessionStore may be silently falling through to in-memory. ` +
        `(Sum spans ggui-sessions.sqlite + ggui-sessions.sqlite-wal + ggui-sessions.sqlite-shm.)`,
    ).toBeGreaterThan(baselineBytes);
  });
});
