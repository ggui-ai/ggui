/**
 * `ggui serve` teardown pin (#855).
 *
 * An operator stopping the served process (SIGTERM / Ctrl-C) must get a
 * clean exit: code 0, no signal, and nothing native on stderr. The abort
 * this pins against — `libc++abi: terminating due to uncaught exception
 * of type std::__1::system_error: mutex lock failed: Invalid argument`,
 * exit by SIGABRT — came from `process.exit()` running ONNX Runtime's
 * static teardown under its still-parked worker threads; the fix is a
 * natural drain (`process.exitCode`), which this spec also guards: a
 * child that never drains is SIGKILLed by the harness after 5 s and
 * fails the same assertion.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  type GguiServeHandle,
  attachServeArtifacts,
  spawnGguiServe,
} from './ggui-serve-harness';

const WARM_TIMEOUT_MS = 30_000;
/**
 * Full serve shape: MCP + live channel + a supervised agent
 * (`agent.entry`) + sqlite vectors + `--seed-pool` — the composition
 * the samples-render scenarios run (#866). The fixture is copied into
 * the spawned CWD, so `--seed-pool pool` resolves inside it.
 */
const FULL_SHAPE_FIXTURE = join(__dirname, 'fixtures', 'serve-full-shape');
const NATIVE_ABORT = /libc\+\+abi|mutex lock failed|Abort trap/;
const DRAIN_DEADLINE = /did not drain within/;

async function waitForEmbeddingWarm(
  handle: GguiServeHandle,
): Promise<'warm' | 'degraded'> {
  const startedAt = Date.now();
  for (;;) {
    const stderr = handle.stderr();
    if (/\[ggui:embedding\] warm/.test(stderr)) return 'warm';
    if (/\[ggui:embedding\] semantic search degraded/.test(stderr)) {
      return 'degraded';
    }
    if (Date.now() - startedAt > WARM_TIMEOUT_MS) {
      throw new Error(
        `no [ggui:embedding] warm/degraded line within ${WARM_TIMEOUT_MS}ms — stderr:\n${stderr}`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

test.describe('ggui serve — teardown (#855)', () => {
  test('full shape (agent + sqlite vectors + --seed-pool): SIGTERM after READY exits 0 on a drained loop', async () => {
    test.skip(
      !existsSync(GGUI_CLI_DIST) || !existsSync(DEVTOOL_DIST),
      'needs @ggui-ai/cli + @ggui-ai/console dists — run the builds first',
    );
    const handle = await spawnGguiServe({
      fixtureDir: FULL_SHAPE_FIXTURE,
      mcpOnly: false,
      extraArgs: ['--seed-pool', 'pool'],
    });
    try {
      const warm = await waitForEmbeddingWarm(handle);
      test.skip(
        warm === 'degraded',
        'local embedding model unavailable — the #855 path needs the loaded model',
      );
      expect(handle.stderr()).toMatch(/\[agent\] up pid=/);
      await handle.close();
      const exit = await handle.exit;
      expect(handle.stderr()).not.toMatch(NATIVE_ABORT);
      // The bounded drain is the fallback, never the path: a drained loop
      // exits before the deadline and the diagnostic line is never written.
      expect(handle.stderr()).not.toMatch(DRAIN_DEADLINE);
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      await attachServeArtifacts(handle);
    }
  });

  test('SIGTERM after READY exits 0 with nothing native on stderr', async () => {
    test.skip(
      !existsSync(GGUI_CLI_DIST) || !existsSync(DEVTOOL_DIST),
      'needs @ggui-ai/cli + @ggui-ai/console dists — run the builds first',
    );
    const handle = await spawnGguiServe();
    try {
      // The abort needs the loaded ONNX session — SIGTERM before the model
      // finishes loading exits clean and proves nothing. Wait for the
      // warm beacon; a box without the local model cannot show the path.
      const warm = await waitForEmbeddingWarm(handle);
      test.skip(
        warm === 'degraded',
        'local embedding model unavailable — the #855 path needs the loaded model',
      );
      await handle.close();
      const exit = await handle.exit;
      expect(handle.stderr()).not.toMatch(NATIVE_ABORT);
      expect(handle.stderr()).not.toMatch(DRAIN_DEADLINE);
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      await attachServeArtifacts(handle);
    }
  });
});
