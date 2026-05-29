/**
 * Playwright `globalSetup` — runs once, before any worker starts.
 *
 * Builds the `@ggui-samples/app-ggui-basic-web` Vite SPA into `dist/`
 * so every parallel worker's `vite preview` spawn (one per Playwright
 * worker — see `agent-loop-harness.ts`) serves the SAME built output.
 *
 * Why this exists: the prior harness ran `pnpm start` (= `vite build &&
 * vite preview`) inside each worker, so parallel workers raced on the
 * shared `dist/` write — first worker's preview would intermittently
 * serve a half-written index.html from a sibling worker's mid-flight
 * build. Splitting build (here, once) from preview (per-worker, in
 * the harness) eliminates the race.
 *
 * Skipped when the agent-loop journey isn't in scope: if NONE of the
 * three BYOK keys are set, the matrix would skip all describes anyway
 * and the build would be wasted work. Specs that don't need the web
 * preview (every spec except agent-loop) tolerate a missing build
 * because they don't spawn the preview server.
 *
 * Run cost: ~3-5s on a warm cache, ~10-15s cold. Single fixed cost
 * regardless of worker count.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { OUTERMOST_ROOT } from './workspace-paths';

const AGENT_LOOP_BYOK_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
] as const;

export default async function globalSetup(): Promise<void> {
  // No BYOK key → the agent-loop matrix will skip every describe.
  // Avoid the build cost in that case (every other spec uses
  // `--port 0` ggui-serve harnesses with no web preview dependency).
  const hasAnyKey = AGENT_LOOP_BYOK_KEYS.some(
    (k) => (process.env[k] ?? '').trim().length > 0,
  );
  if (!hasAnyKey) {
    console.log(
      '[global-setup] no agent-loop BYOK key set — skipping Vite build ' +
        '(agent-loop matrix will skip all describes anyway).',
    );
    return;
  }

  // Sanity check — the workspace root must exist before we can call
  // pnpm. Same shape as the runtime check inside the harness, just
  // earlier (config-eval-adjacent) so a misconfigured environment
  // surfaces before any worker spawn.
  if (!existsSync(resolve(OUTERMOST_ROOT, 'pnpm-workspace.yaml'))) {
    throw new Error(
      `[global-setup] expected pnpm-workspace.yaml at ${OUTERMOST_ROOT}`,
    );
  }

  console.log('[global-setup] building @ggui-samples/app-ggui-basic-web…');
  const t0 = Date.now();
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@ggui-samples/app-ggui-basic-web',
      '--silent',
      'build',
    ],
    {
      cwd: OUTERMOST_ROOT,
      stdio: 'inherit',
      env: process.env,
    },
  );
  const ms = Date.now() - t0;
  if (result.status !== 0) {
    throw new Error(
      `[global-setup] Vite build failed (status=${result.status}). ` +
        `Per-worker \`vite preview\` will not serve a usable bundle.`,
    );
  }
  console.log(`[global-setup] Vite build OK (${ms}ms).`);
}
