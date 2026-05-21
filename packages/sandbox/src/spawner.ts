/**
 * Spawner seam. Broken out from the runner so tests can substitute
 * a fake child process without touching the filesystem or launching
 * a real OS process.
 *
 * Kept minimal — only the shape the sandbox actually uses. Real
 * production wiring imports `spawn` from `node:child_process`.
 */
import type { ChildProcess } from 'node:child_process';

export type Spawner = (
  command: string,
  args: readonly string[],
  options: SpawnerOptions,
) => ChildProcess;

export interface SpawnerOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ['pipe', 'pipe', 'pipe'];
  readonly shell: false;
  readonly detached: false;
  readonly windowsHide: true;
}
