/**
 * A prepared statement that V8 collects must not take the process down.
 *
 * On Node 24.19+, an ObjectWrap build of better-sqlite3 (11.x, or 12.x
 * built from source) aborts with `Assertion failed: (env) != nullptr` in
 * `RemoveEnvironmentCleanupHook`, reached from the Statement destructor
 * during allocation-driven GC (nodejs/node#65446). The stores here create
 * throwaway statements in their constructors (`db.pragma(...)` prepares
 * one per call), so a store that is merely constructed is exposed. The
 * N-API line (13.x) is not.
 *
 * The workload runs in a child process because the failure is an abort,
 * not an exception: it would end the test runner itself. It loads the
 * better-sqlite3 this package resolves, so it reads what is installed.
 * Measured on Node 24.21.0, the same loop aborts 5 runs of 5 on a
 * source-built 12.11.1 and 0 of 5 on 13.0.3. Only a run on Node 24.19+
 * can catch the abort; on any other Node, a pass shows only that the
 * installed major is 13 or later.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const WORKLOAD = `
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
let junk = [];
for (let i = 0; i < 200000; i++) {
  db.prepare('SELECT * FROM t WHERE id = ?').get(i);
  junk.push({ a: i, s: 'y' + i });
  if (junk.length > 1000) junk = [];
}
db.close();
process.stdout.write('survived ' + require('better-sqlite3/package.json').version);
`;

describe('better-sqlite3 statement collection', () => {
  it('200k short-lived statements under allocation pressure leave the process running', () => {
    const run = spawnSync(process.execPath, ['-e', WORKLOAD], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(
      { status: run.status, signal: run.signal, stderr: run.stderr.slice(0, 400) },
      `node ${process.version}`,
    ).toEqual({ status: 0, signal: null, stderr: '' });
    // The N-API line starts at 13: an older major here means the install
    // resolved an ObjectWrap build, whatever this run's Node did with it.
    const major = Number(/^survived (\d+)\./.exec(run.stdout)?.[1]);
    expect(major, run.stdout).toBeGreaterThanOrEqual(13);
  }, 90_000);
});
