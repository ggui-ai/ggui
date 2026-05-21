/**
 * Local benchmark vitest config — narrows test discovery to the
 * canonical `src/` tree. Without this, Vitest's default glob picks up
 * stale worktree copies under `.claude/worktrees/*` and the post-
 * deploy snapshot under `deploy/`, both of which carry their own
 * `node_modules` resolving to pre-rebuild dist files. Those test
 * files SHOULD NOT be run in this package's suite.
 *
 * `*.e2e.test.ts` files are excluded from the default run — they make
 * real LLM API calls (Anthropic / OpenAI / Gemini), take 5+ minutes
 * per provider, and cost real money. Invoke them via the dedicated
 * `bench` scripts (Tier 3) or with an explicit
 * `vitest run src/multi-sdk/multi-sdk.e2e.test.ts` invocation.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      'deploy/**',
      'src/**/*.e2e.test.ts',
    ],
  },
});
