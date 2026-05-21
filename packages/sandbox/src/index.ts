/**
 * `@ggui-ai/sandbox` — bounded process-isolation runner for
 * OSS UI-gen workloads.
 *
 * Public surface:
 *
 *   - {@link runSandboxed} — one-shot runner. Spawns a subprocess,
 *     enforces timeout + output caps + env allowlist + cwd
 *     isolation, returns a {@link SandboxResult} with captured
 *     output + terminal outcome.
 *
 *   - {@link SandboxOptions} / {@link SandboxResult} /
 *     {@link SandboxOutcome} — pinned types.
 *
 * For the honest security boundary + what this MVP does NOT enforce,
 * see the JSDoc header on `./types.ts` and the package README.
 */
export { runSandboxed } from './run.js';
export type {
  SandboxOptions,
  SandboxOutcome,
  SandboxResult,
} from './types.js';
export type { Spawner, SpawnerOptions } from './spawner.js';
