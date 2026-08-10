/**
 * Dist-artifact ESM-interop smoke (integration scope: compiles the
 * package + spawns a plain `node` subprocess).
 *
 * The `./testing` subpath ships to npm and is consumed under native
 * Node ESM — NOT under vitest's module interop, which silently
 * papers over CJS/ESM default-export divergence. A default-import of
 * the CJS `@tufjs/repo-mock` binds the whole `exports` object under
 * real Node ESM (its transpiled `exports.default` is NOT unwrapped),
 * so `mocktuf(...)` throws `TypeError: mocktuf is not a function` in
 * the shipped artifact while every vitest-run test stays green.
 *
 * This test exercises the artifact the way a consumer does: compile
 * the package with the real `tsc` build config into a throwaway
 * outDir, `import()` the built `testing/index.js` from a plain
 * `node --input-type=module` child, and boot + tear down a stack.
 */
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cjsRequire = createRequire(import.meta.url);

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Inside the package so the compiled output resolves its deps through
// the normal node_modules walk-up; cleaned in afterAll either way.
const SMOKE_OUT_DIR = join(PACKAGE_ROOT, '.tmp-dist-smoke');

describe('dist ESM interop — the shipped ./testing artifact runs under plain node', () => {
  afterAll(async () => {
    await rm(SMOKE_OUT_DIR, { recursive: true, force: true });
  });

  it('compiled testing/index.js boots a mock stack under native Node ESM', async () => {
    const tscBin = cjsRequire.resolve('typescript/bin/tsc');

    // Real build config, throwaway outDir; declarations skipped for
    // speed (the interop question lives in the emitted JS).
    await execFileAsync(
      process.execPath,
      [
        tscBin,
        '-p',
        join(PACKAGE_ROOT, 'tsconfig.build.json'),
        '--outDir',
        SMOKE_OUT_DIR,
        '--declaration',
        'false',
        '--declarationMap',
        'false',
      ],
      { cwd: PACKAGE_ROOT, timeout: 60_000 },
    );

    const builtTestingUrl = pathToFileURL(
      join(SMOKE_OUT_DIR, 'testing', 'index.js'),
    ).href;
    const script = [
      `const { startSigstoreMockStack } = await import(${JSON.stringify(builtTestingUrl)});`,
      `const stack = await startSigstoreMockStack();`,
      `stack.teardown();`,
      `console.log('DIST_SMOKE_OK');`,
    ].join('\n');

    const child = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', script],
      { cwd: PACKAGE_ROOT, timeout: 60_000 },
    );
    expect(child.stdout).toContain('DIST_SMOKE_OK');
  }, 90_000);
});
