import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/**
 * A fresh directory under the OS temp dir, removed when the calling test
 * finishes, whether it passed or failed. Call it inside a test: vitest throws
 * if `onTestFinished` runs outside one, so a misplaced call is loud rather
 * than a directory left behind on every run.
 */
export function testTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
