import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'vitest/config';

// Load `.env.local` BEFORE workers fork so module-level
// `HAS_KEY = !!process.env.ANTHROPIC_API_KEY` evaluates correctly in
// each test file. Inheritance handles the rest.
//
// `.env.local` lives at the OSS-subtree root — `oss/` in the monorepo,
// the repo root in the OSS-standalone checkout — gitignored, so every
// dev keeps their own. `scenarios/` sits exactly two levels below that
// root in BOTH layouts (`oss/e2e/scenarios` / `e2e/scenarios`), so the
// path is a single context-independent `../../`. Kept in lockstep with
// the twin load in `fixtures/global-setup.ts`.
//
// A missing file is fine: dotenv no-ops, honest specs skip when their
// gating env var is absent, and CI injects keys via GitHub Actions
// secrets (no file on disk). dotenv won't override an already-set
// `process.env` var, so a CI-injected value always wins.
loadEnv({ path: resolve(import.meta.dirname, '..', '..', '.env.local') });

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
