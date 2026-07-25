#!/usr/bin/env node
/**
 * Sync the pinned silverprotocol cassette corpus into
 * `oss/.silverprotocol-corpus/` (gitignored).
 *
 * Distribution contract (negotiated, silverprotocol/workspace#1): the
 * corpus is public + immutable-by-commit in silverprotocol/typescript-sdk;
 * consumers pin by commit SHA and fetch the paths they need. This script
 * is that pin's executor: it reads `silverprotocol-fixtures.lock.json`,
 * fetches each file at the locked commit from raw.githubusercontent.com,
 * and verifies its sha256. Any mismatch is a hard error — a changed
 * upstream blob at the same SHA is impossible, so a mismatch means the
 * lock was hand-edited or the download was corrupted.
 *
 * Idempotent: files already present with the right hash are skipped.
 *
 * `--relock <commit>`: refresh path — re-fetches every locked file at the
 * given commit and rewrites the lock's hashes. The diff is the reviewable
 * refresh PR the plan requires.
 *
 * No dependencies, no auth (public repo), Node 18+ (global fetch).
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OSS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(OSS_ROOT, 'silverprotocol-fixtures.lock.json');
const CORPUS_DIR = join(OSS_ROOT, '.silverprotocol-corpus');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function fetchBlob(repo, commit, basePath, path) {
  const url = `https://raw.githubusercontent.com/${repo}/${commit}/${basePath}/${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const relockAt = process.argv.includes('--relock')
    ? process.argv[process.argv.indexOf('--relock') + 1]
    : null;
  const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
  const commit = relockAt ?? lock.commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`lock commit must be a full 40-char SHA, got: ${commit}`);
  }

  let fetched = 0;
  let skipped = 0;
  for (const entry of lock.files) {
    const dest = join(CORPUS_DIR, entry.path);
    if (!relockAt && existsSync(dest)) {
      const existing = await readFile(dest);
      if (sha256(existing) === entry.sha256) {
        skipped++;
        continue;
      }
    }
    const blob = await fetchBlob(lock.repo, commit, lock.basePath, entry.path);
    const hash = sha256(blob);
    if (relockAt) {
      entry.sha256 = hash;
    } else if (hash !== entry.sha256) {
      throw new Error(
        `sha256 mismatch for ${entry.path}: lock=${entry.sha256} fetched=${hash} — ` +
          'lock hand-edited or download corrupted; never assert against unverified cassettes',
      );
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, blob);
    fetched++;
  }

  if (relockAt) {
    lock.commit = commit;
    await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`[corpus] relocked at ${commit} — review + commit the lock diff`);
  }
  console.log(
    `[corpus] ${lock.repo}@${commit.slice(0, 12)} — ${fetched} fetched, ${skipped} up-to-date → ${CORPUS_DIR}`,
  );
}

main().catch((err) => {
  console.error(`[corpus] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
