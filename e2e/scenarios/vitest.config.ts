import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Load .env.local from the repo root BEFORE workers fork so
// module-level `HAS_KEY = !!process.env.ANTHROPIC_API_KEY` evaluates
// correctly in each test file. Inheritance handles the rest.
//
// Hand-rolled to keep the package dep-free (no dotenv).
//
// The repo-root depth is layout-dependent — `scenarios/` sits at
// `oss/e2e/scenarios/` in the monorepo (root is 3 up) and at
// `e2e/scenarios/` in the OSS-standalone checkout (root is 2 up). Both
// candidates are tried, monorepo-first. Kept in lockstep with the twin
// loader in `fixtures/global-setup.ts` — the two MUST resolve the same
// file or `HAS_KEY` disagrees between config-eval and globalSetup.
function loadDotenvLocal(): void {
  const here = resolve(import.meta.dirname);
  const candidates = [
    resolve(here, '..', '..', '..', '.env.local'),
    resolve(here, '..', '..', '.env.local'),
  ];
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (key.length > 0 && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
      return;
    } catch {
      /* try next */
    }
  }
}
loadDotenvLocal();

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 30_000,
    pool: 'forks', // Each scenario file gets its own process — services hold global state.
    poolOptions: { forks: { singleFork: true } },
    globalSetup: ['./fixtures/global-setup.ts'],
    reporters: ['default'],
  },
});
