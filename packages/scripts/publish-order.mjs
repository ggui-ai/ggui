// The release wave's publish order, checked against the dependency graph.
//
// `.github/workflows/release.yml` publishes the wave one package at a time,
// in the order of its hand-kept `ORDER` array, and the visibility wait
// (`npm-visibility.mjs`) holds each package until the packages it depends on
// are installable. Both rest on one definition of "depends on", kept here:
//
//   an internal dependency is an `@ggui-ai/*` name in `dependencies` or
//   `peerDependencies`.
//
// `optionalDependencies` and `bundleDependencies` are not read, so an
// `@ggui-ai/*` entry in either is refused: it would be a dependency the wait
// never waits for.
//
//   node publish-order.mjs check <packages-root> <dir>...
//     exits 1 and prints each problem when the listed directories are not a
//     dependency-first order of every publishable package under the root.
//   node publish-order.mjs by-depth <packages-root> <dir>...
//     prints the listed directories sorted by dependency depth (byDepth).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCOPE = "@ggui-ai/";
const READ_FIELDS = ["dependencies", "peerDependencies"];
const REFUSED_FIELDS = ["optionalDependencies", "bundleDependencies", "bundledDependencies"];

/** `@ggui-ai/*` names a package depends on: dependencies, then peerDependencies, deduplicated. */
export function internalDeps(packageJson) {
  const names = [];
  for (const field of READ_FIELDS) {
    for (const name of Object.keys(packageJson[field] ?? {})) {
      if (name.startsWith(SCOPE) && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function refusedEntries(packageJson) {
  const entries = [];
  for (const field of REFUSED_FIELDS) {
    const value = packageJson[field];
    if (!value) continue;
    const names = Array.isArray(value) ? value : Object.keys(value);
    for (const name of names) if (name.startsWith(SCOPE)) entries.push([field, name]);
  }
  return entries;
}

/**
 * Every publishable package under `packagesRoot`, by directory:
 * `{ dir, name, version, deps, excludedFields }`. Private packages and directories
 * without a package.json are skipped.
 */
export function readPublishSet(packagesRoot) {
  const set = new Map();
  for (const dir of readdirSync(packagesRoot).sort()) {
    const path = join(packagesRoot, dir, "package.json");
    if (!existsSync(path)) continue;
    const packageJson = JSON.parse(readFileSync(path, "utf8"));
    if (packageJson.private) continue;
    set.set(dir, {
      dir,
      name: packageJson.name,
      version: packageJson.version,
      deps: internalDeps(packageJson),
      excludedFields: refusedEntries(packageJson),
    });
  }
  return set;
}

/** Each way `order` fails to be a dependency-first order of `set`; empty when it is one. */
export function checkPublishOrder(order, set) {
  const problems = [];
  const position = new Map();
  for (const [dir, pkg] of set) position.set(pkg.name, order.indexOf(dir));

  order.forEach((dir, index) => {
    const pkg = set.get(dir);
    if (!pkg) {
      problems.push(`${dir} is in the publish order but is not a publishable package`);
      return;
    }
    for (const dep of pkg.deps) {
      const at = position.get(dep) ?? -1;
      if (at === -1) {
        problems.push(`${dir} depends on ${dep}, which is not in the publish order`);
      } else if (at > index) {
        problems.push(
          `${dir} (position ${index + 1}) depends on ${dep}, which is published later (position ${at + 1})`
        );
      }
    }
  });
  for (const dir of set.keys()) {
    if (!order.includes(dir))
      problems.push(`${dir} is a publishable package but is not in the publish order`);
  }
  for (const pkg of set.values()) {
    for (const [field, name] of pkg.excludedFields) {
      problems.push(
        `${pkg.dir} lists ${name} in ${field}; an internal dependency belongs in dependencies or peerDependencies`
      );
    }
  }
  return problems;
}

/**
 * `order` sorted by dependency depth (a package with no internal dependency
 * is depth 0; any other is one more than its deepest dependency), keeping the
 * given order inside a depth. The publish step waits before a package until
 * its dependencies have settled, so publishing a whole depth before the next
 * means each wait covers as many packages as it can, and the wave waits
 * fewer times than in the hand order alone.
 */
export function byDepth(order, set) {
  const byName = new Map([...set.values()].map((pkg) => [pkg.name, pkg]));
  const memo = new Map();
  const depth = (name) => {
    if (!memo.has(name)) {
      const deps = byName.get(name)?.deps ?? [];
      memo.set(name, deps.length === 0 ? 0 : 1 + Math.max(...deps.map(depth)));
    }
    return memo.get(name);
  };
  return order
    .map((dir, index) => ({ dir, index, depth: depth(set.get(dir)?.name) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.dir);
}

/** The entries of the `ORDER=( … )` array in the release workflow's text. */
export function releaseOrder(workflowText) {
  const match = /ORDER=\(\n([\s\S]*?)\n\s*\)/.exec(workflowText);
  if (!match) throw new Error("release workflow: no ORDER=( array found");
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** One line of normal output on stdout. */
const say = (line) => process.stdout.write(`${line}\n`);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, packagesRoot, ...order] = process.argv.slice(2);
  if (!["check", "by-depth"].includes(command) || !packagesRoot || order.length === 0) {
    console.error("usage: publish-order.mjs check|by-depth <packages-root> <dir>...");
    process.exit(2);
  }
  const set = readPublishSet(packagesRoot);
  if (command === "by-depth") {
    say(byDepth(order, set).join(" "));
  } else {
    const problems = checkPublishOrder(order, set);
    for (const problem of problems) say(`::error::${problem}`);
    if (problems.length > 0) process.exit(1);
    say(`Publish order checked: ${order.length} packages, dependencies first.`);
  }
}
