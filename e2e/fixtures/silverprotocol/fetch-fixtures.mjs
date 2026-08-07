#!/usr/bin/env node
/**
 * fetch-fixtures — pinned-SHA consumption of the silverprotocol corpus
 * (#426 Spec A; negotiated Phase-4 terms). Downloads the mirror tarball
 * at the locked commit, extracts ONLY the locked legs into .cache/,
 * and verifies the content checksum. Idempotent: a valid cache is a
 * no-network no-op. NEVER fetches a branch/tag — the SHA is the pin.
 *
 *   node fetch-fixtures.mjs               fetch if needed + verify
 *   node fetch-fixtures.mjs --verify-only no network; nonzero if cache absent/corrupt
 *   node fetch-fixtures.mjs --update-lock refetch + rewrite sha256 (refresh ritual only)
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = join(HERE, "fixtures.lock.json");
const CACHE = join(HERE, ".cache");

const log = (m) => process.stderr.write(`[fetch-fixtures] ${m}\n`);
const fail = (m) => {
  log(`FAIL: ${m}`);
  process.exit(1);
};

const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
const legPaths = lock.legs.flatMap((l) =>
  lock.files.map((f) => `${l.scenario}/${l.framework}.${f}.json`)
);

function cacheChecksum() {
  const h = createHash("sha256");
  for (const rel of [...legPaths].sort()) {
    const p = join(CACHE, rel);
    if (!existsSync(p)) return null;
    h.update(rel).update("\0").update(readFileSync(p));
  }
  return h.digest("hex");
}

function verify({ allowMissingLockSum = false } = {}) {
  const sum = cacheChecksum();
  if (sum === null) return false;
  if (lock.sha256 === "FILL_ON_FIRST_FETCH") return allowMissingLockSum;
  if (sum !== lock.sha256)
    fail(
      `cache checksum mismatch: ${sum} != lock ${lock.sha256} — refetch or fix the lock via the refresh ritual`
    );
  return true;
}

const args = process.argv.slice(2);
if (args.includes("--verify-only")) {
  if (!verify()) fail("cache absent or incomplete (run without --verify-only, with network)");
  log("cache valid");
  process.exit(0);
}

if (!args.includes("--update-lock") && verify()) {
  log("cache valid — no fetch needed");
  process.exit(0);
}

log(`fetching ${lock.repo}@${lock.commit.slice(0, 9)} …`);
const tarball = join(HERE, `.tarball-${lock.commit.slice(0, 9)}.tar.gz`);
execFileSync(
  "curl",
  ["-fsSL", "-o", tarball, `https://codeload.github.com/${lock.repo}/tar.gz/${lock.commit}`],
  { stdio: ["ignore", "inherit", "inherit"] }
);
rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });
// Tarball root dir is `<repo-name>-<full-sha>/`.
const prefix = `typescript-sdk-${lock.commit}/${lock.corpusPath}/`;
const stripCount = prefix.split("/").filter(Boolean).length;
for (const rel of legPaths) {
  execFileSync(
    "tar",
    ["-xzf", tarball, "-C", CACHE, "--strip-components", String(stripCount), `${prefix}${rel}`],
    { stdio: ["ignore", "inherit", "inherit"] }
  );
}
rmSync(tarball, { force: true });

const missing = legPaths.filter((rel) => !existsSync(join(CACHE, rel)));
if (missing.length)
  fail(`legs missing after extract (check lock legs vs the pinned tree): ${missing.join(", ")}`);

const sum = cacheChecksum();
if (args.includes("--update-lock")) {
  writeFileSync(LOCK_PATH, `${JSON.stringify({ ...lock, sha256: sum }, null, 2)}\n`);
  log(`lock sha256 updated: ${sum}`);
} else if (!verify()) {
  fail("fetched cache does not match lock sha256");
}
log(`fetched ${legPaths.length} files, checksum ${sum.slice(0, 12)}…`);
