// Pins for scripts/installed-set.mjs — the runner image's identity (every package it ships, read from the tree).
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { dpkgPackages, installedPackages, manifestBytes, manifestOf, packageHash, setHash, systemOf, SCHEMA } from './installed-set.mjs';

const SCRIPT = resolve(import.meta.dirname, 'installed-set.mjs');

function put(root: string, rel: string, body: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}
function pkg(root: string, dir: string, name: string, version: string, files: Record<string, string> = {}): void {
  put(root, `${dir}/package.json`, JSON.stringify({ name, version }));
  for (const [f, body] of Object.entries(files)) put(root, `${dir}/${f}`, body);
}
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'installed-set-'));
  pkg(root, 'node_modules/zod', 'zod', '4.4.3', { 'index.js': 'z1' });
  pkg(root, 'node_modules/@scope/a', '@scope/a', '1.0.0', { 'lib/a.js': 'a1' });
  pkg(root, 'node_modules/@scope/a/node_modules/dep', 'dep', '2.0.0', { 'd.js': 'd1' });
  put(root, 'node_modules/.bin/zod', 'shim');
  put(root, 'node_modules/@scope/.DS_Store', 'finder');
  put(root, 'node_modules/stray-file', 'not a directory');
  mkdirSync(join(root, 'node_modules/not-a-package'), { recursive: true });
  put(root, 'node_modules/not-a-package/readme.txt', 'x');
  return root;
}
const DPKG = [
  'Package: chromium\nStatus: install ok installed\nArchitecture: amd64\nVersion: 154.0.8037.57-1~deb12u1\n',
  'Package: fonts-liberation\nStatus: install ok installed\nArchitecture: all\nVersion: 1:1.07.4-11\n',
  'Package: held-lib\nStatus: hold ok installed\nArchitecture: amd64\nVersion: 3.1\n',
  'Package: removed-thing\nStatus: deinstall ok config-files\nArchitecture: amd64\nVersion: 1.0\n',
  'Package: half-done\nStatus: install ok half-configured\nArchitecture: amd64\nVersion: 0.9\n',
].join('\n');

describe('installed-set: the packages an image ships, read from its tree', () => {
  it('finds top-level, scoped and nested packages — name, version and where each sits — sorted by path; skips dot entries and non-directories', () => {
    const root = tree();
    try {
      const pkgs = installedPackages(root);
      expect(pkgs.map((p) => [p.path, p.name, p.version])).toEqual([
        ['node_modules/@scope/a', '@scope/a', '1.0.0'],
        ['node_modules/@scope/a/node_modules/dep', 'dep', '2.0.0'],
        ['node_modules/zod', 'zod', '4.4.3'],
      ]);
      for (const p of pkgs) expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("a package's hash is its own bytes: it moves with a file, not with its nested packages, and skips symlinks", () => {
    const root = tree();
    try {
      const a = join(root, 'node_modules/@scope/a');
      const before = packageHash(a);
      put(root, 'node_modules/@scope/a/node_modules/dep/d.js', 'd2');
      expect(packageHash(a)).toBe(before);
      symlinkSync(join(a, 'lib/a.js'), join(a, 'link.js'));
      expect(packageHash(a)).toBe(before);
      put(root, 'node_modules/@scope/a/lib/a.js', 'a2');
      expect(packageHash(a)).not.toBe(before);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a top-level symlink (an isolated, not hoisted, layout) stops the read — it would silently shrink the set', () => {
    const root = tree();
    try {
      symlinkSync(join(root, 'node_modules/zod'), join(root, 'node_modules/zod-link'));
      expect(() => installedPackages(root)).toThrow(/node_modules\/zod-link is a symlink — the walk needs the hoisted layout/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a top-level SCOPED symlink stops the read too; a symlink inside a nested node_modules is skipped', () => {
    const root = tree();
    try {
      symlinkSync(join(root, 'node_modules/zod'), join(root, 'node_modules/@scope/a/node_modules/nested-link'));
      mkdirSync(join(root, 'node_modules/@scope/a/node_modules/@x'), { recursive: true });
      symlinkSync(join(root, 'node_modules/zod'), join(root, 'node_modules/@scope/a/node_modules/@x/link'));
      expect(installedPackages(root)).toHaveLength(3);
      symlinkSync(join(root, 'node_modules/@scope/a'), join(root, 'node_modules/@scope/b'));
      expect(() => installedPackages(root)).toThrow(/node_modules\/@scope\/b is a symlink — the walk needs the hoisted layout/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('a malformed package.json stops the read instead of silently dropping the package', () => {
    const root = tree();
    try {
      put(root, 'node_modules/broken/package.json', '{ not json');
      expect(() => installedPackages(root)).toThrow(/unreadable package\.json/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the system block: installed dpkg packages only (held ones included), with their architecture, sorted; Node.js and the OS release', () => {
    expect(dpkgPackages(DPKG)).toEqual([
      { name: 'chromium:amd64', version: '154.0.8037.57-1~deb12u1' },
      { name: 'fonts-liberation', version: '1:1.07.4-11' },
      { name: 'held-lib:amd64', version: '3.1' },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'installed-set-sys-'));
    try {
      put(dir, 'status', DPKG);
      put(dir, 'os-release', 'NAME="Debian GNU/Linux"\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n');
      const sys = systemOf({ dpkgStatus: join(dir, 'status'), osRelease: join(dir, 'os-release') });
      expect(sys.node).toBe(process.version);
      expect(sys.os).toBe('Debian GNU/Linux 12 (bookworm)');
      expect(sys.dpkg).toHaveLength(3);
      expect(systemOf({ dpkgStatus: join(dir, 'absent'), osRelease: join(dir, 'absent') })).toEqual({ node: process.version, os: null, dpkg: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the set hash is the sha256 of the manifest bytes as written, and one package moving moves it', () => {
    const root = tree();
    try {
      const m = manifestOf(root);
      expect(m.schema).toBe(SCHEMA);
      expect(setHash(m)).toBe(createHash('sha256').update(manifestBytes(m)).digest('hex'));
      expect(setHash(manifestOf(root))).toBe(setHash(m));
      pkg(root, 'node_modules/zod', 'zod', '4.4.4', { 'index.js': 'z1' });
      expect(setHash(manifestOf(root))).not.toBe(setHash(m));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the CLI writes the manifest and <out>.sha256 — `sha256sum` of the manifest reproduces it — with the system block', () => {
    const root = tree();
    try {
      put(root, 'sys/status', DPKG);
      put(root, 'sys/os-release', 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n');
      const out = join(root, 'installed-set.json');
      execFileSync('node', [SCRIPT, '--root', root, '--out', out, '--dpkg-status', join(root, 'sys/status'), '--os-release', join(root, 'sys/os-release')], { encoding: 'utf8' });
      const recorded = readFileSync(`${out}.sha256`, 'utf8').trim();
      expect(createHash('sha256').update(readFileSync(out)).digest('hex')).toBe(recorded);
      const written = JSON.parse(readFileSync(out, 'utf8'));
      expect(written.packages).toHaveLength(3);
      expect(written.system.dpkg.map((d: { name: string }) => d.name)).toEqual(['chromium:amd64', 'fonts-liberation', 'held-lib:amd64']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the CLI refuses to write an empty identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'installed-set-empty-'));
    try {
      const r = spawnSync('node', [SCRIPT, '--root', root, '--out', join(root, 'x.json')], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/refusing to write an empty identity/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
