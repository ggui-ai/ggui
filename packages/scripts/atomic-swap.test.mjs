// Pins for ggui#694 (per-process staging dirs) on top of the #681 completeness gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SWAP = fileURLToPath(new URL('./atomic-swap.mjs', import.meta.url));
function pkgDir() {
  const d = mkdtempSync(join(tmpdir(), 'atomic-swap-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', main: 'dist/index.js', exports: { '.': './dist/index.js', './types': './dist/index.d.ts' } }));
  return d;
}
function stage(d, name, complete = true) {
  mkdirSync(join(d, name), { recursive: true });
  writeFileSync(join(d, name, 'index.js'), `export const built = ${JSON.stringify(name)};\n`);
  if (complete) writeFileSync(join(d, name, 'index.d.ts'), 'export declare const built: string;\n');
}
const run = (d, staging) => spawnSync(process.execPath, [SWAP, staging, 'dist'], { cwd: d, encoding: 'utf8' });
const deadPid = 2147483000; // no such process on any sane box

test('happy path: per-pid staging swaps in and leaves no staging residue', () => {
  const d = pkgDir(); const s = `dist.staging-${process.pid}`; stage(d, s);
  const r = run(d, s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(d, 'dist/index.js')));
  assert.ok(!existsSync(join(d, s)));
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('dist.staging-')), []);
  rmSync(d, { recursive: true, force: true });
});

test('a stale staging dir from a DEAD pid is swept; a LIVE sibling\'s is kept', () => {
  const d = pkgDir(); const s = `dist.staging-${process.pid}`; stage(d, s);
  stage(d, `dist.staging-${deadPid}`);           // crashed prior build
  const liveSibling = `dist.staging-${process.ppid}`; stage(d, liveSibling); // a concurrent build mid-flight
  const r = run(d, s);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!existsSync(join(d, `dist.staging-${deadPid}`)), 'dead-pid staging swept');
  assert.ok(existsSync(join(d, liveSibling)), 'live sibling staging untouched');
  rmSync(d, { recursive: true, force: true });
});

test('completeness gate still refuses an incomplete staging (exit 1, live untouched)', () => {
  const d = pkgDir(); stage(d, 'dist.staging-1', true); assert.equal(run(d, 'dist.staging-1').status, 0);
  const s = `dist.staging-${process.pid}`; stage(d, s, false);
  const r = run(d, s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to publish/);
  assert.ok(existsSync(join(d, 'dist/index.d.ts')), 'previous complete live dist intact');
  rmSync(d, { recursive: true, force: true });
});

test('two concurrent swaps of the same package (staging = the live shell\'s $$, as in production): both exit 0, live is complete, no residue', async () => {
  const d = pkgDir(); stage(d, 'template');
  // Each runner is what pnpm runs for a build script: `sh -c '... dist.staging-$$ ... atomic-swap.mjs dist.staging-$$ dist'`.
  // The sibling's staging dir carries a LIVE pid while it runs, so the dead-pid sweep must leave it alone.
  const cmd = `cp -R template "dist.staging-$$" && node ${JSON.stringify(SWAP)} "dist.staging-$$" dist`;
  const go = () => new Promise((res) => { const c = spawn('sh', ['-c', cmd], { cwd: d }); let err = ''; c.stderr.on('data', (x) => (err += x)); c.on('exit', (code) => res({ code, err })); });
  const [ra, rb] = await Promise.all([go(), go()]);
  assert.equal(ra.code, 0, ra.err); assert.equal(rb.code, 0, rb.err);
  assert.ok(existsSync(join(d, 'dist/index.js')) && existsSync(join(d, 'dist/index.d.ts')));
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith('dist.staging-') || n.startsWith('dist.trash')), []);
  rmSync(d, { recursive: true, force: true });
});

test('a fixed (legacy) staging dir name still works unchanged', () => {
  const d = pkgDir(); stage(d, 'dist.staging');
  const r = run(d, 'dist.staging'); assert.equal(r.status, 0, r.stderr); assert.ok(existsSync(join(d, 'dist/index.js')));
  rmSync(d, { recursive: true, force: true });
});
