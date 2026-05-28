/**
 * Read-or-mint helpers for HMAC secrets that MUST survive a `ggui serve`
 * restart.
 *
 * Background: `createGguiServer` mints two HMAC secrets at boot when the
 * caller doesn't pass them — `wsTokenSecret` (signs the
 * `_meta["ai.ggui/render"].wsToken` envelope so iframes can subscribe
 * to the live-channel WS) and the render-URL signer secret. Both are
 * process-local `randomBytes(32)` by default — fine for a single
 * process lifetime, fatal for "revisit a claude.ai chat history after a
 * restart": the cached wsToken fails HMAC verify against the freshly-
 * minted secret.
 *
 * Persisting the secrets to a 0600-mode file makes those tokens valid
 * across restarts, which is the precondition for any rehydrate path
 * working at all. The file format is intentionally tiny: 64 chars of
 * lowercase hex (32 bytes), no trailing newline, no JSON wrapper. Easy
 * to inspect, easy to rotate (delete the file, restart, fresh secret).
 *
 * Security posture: these secrets are a render-token signing key, NOT
 * a long-lived credential like an OAuth client secret. Losing them
 * means an attacker can mint MCP Apps bootstrap tokens for arbitrary
 * `(renderId, appId)` pairs — same blast radius as before, just
 * surviving restart. Mode 0600 on the file matches `~/.ggui/credentials
 * .json` (BYOK keys) which has the same threat model.
 *
 * Caller composes the path; this module is pure I/O over a given
 * filename so tests can scope to a tmpdir.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/**
 * Read a hex-encoded HMAC secret from `filename`. If the file doesn't
 * exist (ENOENT), mint a fresh 32-byte secret, write it with mode 0600,
 * and return the hex string.
 *
 * Concurrency: the write is atomic — a fresh secret is written to a
 * sibling temp file with `O_CREAT | O_WRONLY` and then `rename(2)`'d
 * into place. POSIX guarantees `rename` is atomic on the same
 * filesystem, so two `ggui serve` processes racing on the same
 * persistent dir can't tear the file at a byte boundary; the loser's
 * rename overwrites the winner's. Both processes then re-read the
 * same surviving value on next boot — last-writer-wins on the secret
 * itself, never partial-write corruption. (Two processes simultaneously
 * minting fresh secrets is already a degenerate case for a per-user
 * persistent dir.)
 *
 * Throws on:
 *   - read errors other than ENOENT (permission denied, EISDIR, etc.)
 *   - write errors (mkdir / writeFile / rename)
 *   - on-disk content that isn't a 64-char hex string (corrupt secret)
 *
 * The throw-on-corrupt branch is deliberate: silently re-minting would
 * invalidate every outstanding token without telling the operator.
 * Better to fail loud so the operator can diagnose (manual edit?) and
 * decide whether to delete and accept the cost.
 */
export function readOrMintHexSecret(filename: string): string {
  let existing: string | null = null;
  try {
    existing = readFileSync(filename, 'utf8').trim();
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (existing !== null) {
    if (!HEX_64.test(existing)) {
      throw new Error(
        `[ggui-cli] persistent secret at ${filename} is corrupt — expected ` +
          `64 lowercase hex chars (32 bytes), got ${existing.length} chars. ` +
          `Delete the file to re-mint a fresh secret (this will invalidate ` +
          `every outstanding token).`,
      );
    }
    return existing;
  }
  const minted = randomBytes(32).toString('hex');
  const parent = dirname(filename);
  mkdirSync(parent, { recursive: true });
  // Atomic write: pid-suffixed temp file in the same dir, then rename
  // into place. Same-filesystem rename is atomic on POSIX, so a racing
  // boot from another process can't observe a half-written secret.
  const tmp = join(parent, `${filename.split('/').pop()}.tmp-${process.pid}`);
  writeFileSync(tmp, minted, { mode: 0o600, encoding: 'utf8' });
  renameSync(tmp, filename);
  return minted;
}

const HEX_64 = /^[0-9a-f]{64}$/;

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object'
    && err !== null
    && 'code' in err
    && (err as { code: string }).code === 'ENOENT'
  );
}
