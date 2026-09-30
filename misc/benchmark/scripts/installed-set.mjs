#!/usr/bin/env node
/* eslint-disable no-console -- build step: the written manifest and its hash are the output */
/**
 * installed-set.mjs — the runner image's IDENTITY: what it actually ships, read from the built tree.
 *
 * The image's third-party parts are fetched when it is built — npm packages resolve to the newest versions their
 * declared ranges and the workspace's overrides allow (the deploy does not read the lockfile), and the Node.js base
 * image and the apt packages (Chromium, fonts) come from their current releases — so a commit does not pin their exact
 * versions. This records them:
 *   - `packages`: one entry per package under `<root>/node_modules`, nested `node_modules` included — its path, name,
 *     version and the sha256 of its files (see `packageHash`; a nested `node_modules` is its own entries);
 *   - `system`: the Node.js version, the OS release, and every installed dpkg package with its version.
 * The set's hash is the sha256 of the manifest file's exact bytes, so `sha256sum installed-set.json` reproduces it.
 *
 * The walk relies on the deploy's HOISTED layout (real package directories). A top-level package that is a symlink —
 * `node_modules/<name>` or `node_modules/@scope/<name>`, as an isolated layout makes them — would silently shrink the
 * set, so it stops the build instead.
 *
 * Run it in the image's FINAL stage, after every strip and every apt install, so it reads the tree that runs:
 *   node scripts/installed-set.mjs --root /app --out /app/installed-set.json
 * writes the manifest and `<out>.sha256`, and prints the hash. `--dpkg-status` / `--os-release` override the system
 * files' paths (for tests).
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHEMA = "ggui.bench.installed-set.v2";

/**
 * sha256 over a package directory's regular files: for each, its relative path, NUL, its bytes, NUL — in walk order
 * (every directory's entries sorted by name, depth first). Symlinks and nested node_modules are not followed.
 */
export function packageHash(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (e === "node_modules") continue;
        walk(p);
      } else if (st.isFile()) files.push(p);
    }
  };
  walk(dir);
  const h = createHash("sha256");
  for (const f of files) {
    h.update(`${relative(dir, f)}\0`);
    h.update(readFileSync(f));
    h.update("\0");
  }
  return h.digest("hex");
}

const isDir = (p) => lstatSync(p).isDirectory();

/** Every installed package under `<root>/node_modules`, nested included, sorted by path. */
export function installedPackages(root) {
  const out = [];
  const record = (d) => {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    } catch (err) {
      if (err.code === "ENOENT") return false;
      throw new Error(`installed-set: unreadable package.json in ${d}: ${err.message}`);
    }
    out.push({ path: relative(root, d), name: pkg.name ?? null, version: pkg.version ?? null, sha256: packageHash(d) });
    return true;
  };
  const refuseLink = (p) => {
    throw new Error(
      `installed-set: ${relative(root, p)} is a symlink — the walk needs the hoisted layout (real package directories); an isolated layout would silently shrink the set`
    );
  };
  const scan = (nm, top) => {
    let entries;
    try {
      entries = readdirSync(nm).sort();
    } catch (err) {
      if (err.code === "ENOENT" || err.code === "ENOTDIR") return;
      throw err;
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const p = join(nm, e);
      if (lstatSync(p).isSymbolicLink()) {
        if (top) refuseLink(p);
        continue;
      }
      if (!isDir(p)) continue;
      const dirs = [];
      if (e.startsWith("@")) {
        for (const s of readdirSync(p).sort()) {
          if (s.startsWith(".")) continue;
          const d = join(p, s);
          if (lstatSync(d).isSymbolicLink()) {
            if (top) refuseLink(d);
            continue;
          }
          if (isDir(d)) dirs.push(d);
        }
      } else dirs.push(p);
      for (const d of dirs) {
        if (record(d)) scan(join(d, "node_modules"), false);
      }
    }
  };
  scan(join(root, "node_modules"), true);
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * dpkg's installed packages, `{ name, version }`, sorted by name. Status is `<want> <flag> <status>`: a package counts
 * when its status word is `installed`, whatever is wanted of it (`install ok installed`, `hold ok installed`).
 */
export function dpkgPackages(statusText) {
  const pkgs = [];
  for (const stanza of statusText.split(/\n\s*\n/)) {
    const field = (k) => new RegExp(`^${k}: (.*)$`, "m").exec(stanza)?.[1]?.trim();
    const name = field("Package");
    if (name && field("Status")?.split(/\s+/)[2] === "installed") {
      const arch = field("Architecture");
      pkgs.push({ name: arch && arch !== "all" ? `${name}:${arch}` : name, version: field("Version") ?? null });
    }
  }
  pkgs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pkgs;
}

/** The runtime beneath the packages: Node.js, the OS release, and the dpkg set (absent files read as null). */
export function systemOf({ dpkgStatus = "/var/lib/dpkg/status", osRelease = "/etc/os-release" } = {}) {
  const read = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  };
  const os = read(osRelease);
  const dpkg = read(dpkgStatus);
  return {
    node: process.version,
    os: os === null ? null : (/^PRETTY_NAME="?([^"\n]*)"?$/m.exec(os)?.[1] ?? null),
    dpkg: dpkg === null ? null : dpkgPackages(dpkg),
  };
}

export function manifestOf(root, systemPaths) {
  return { schema: SCHEMA, system: systemOf(systemPaths), packages: installedPackages(root) };
}

/** The manifest's bytes as written, one canonical line; the set hash is the sha256 of exactly these bytes. */
export const manifestBytes = (manifest) => `${JSON.stringify(manifest)}\n`;
export const setHash = (manifest) => createHash("sha256").update(manifestBytes(manifest)).digest("hex");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const at = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = at("--root");
  const out = at("--out");
  if (!root || !out) {
    console.error("usage: installed-set.mjs --root <dir> --out <manifest.json> [--dpkg-status <path>] [--os-release <path>]");
    process.exit(2);
  }
  const systemPaths = {
    ...(at("--dpkg-status") ? { dpkgStatus: at("--dpkg-status") } : {}),
    ...(at("--os-release") ? { osRelease: at("--os-release") } : {}),
  };
  const manifest = manifestOf(root, systemPaths);
  if (manifest.packages.length === 0) {
    console.error(`installed-set: no packages under ${root}/node_modules — refusing to write an empty identity`);
    process.exit(1);
  }
  const hash = setHash(manifest);
  writeFileSync(out, manifestBytes(manifest));
  writeFileSync(`${out}.sha256`, `${hash}\n`);
  const dpkg = manifest.system.dpkg === null ? "no dpkg" : `${manifest.system.dpkg.length} dpkg packages`;
  console.log(`installed-set: ${manifest.packages.length} npm packages, ${dpkg}, node ${manifest.system.node}, sha256 ${hash}`);
}
