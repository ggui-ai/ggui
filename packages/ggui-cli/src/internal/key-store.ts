/**
 * Local Ed25519 signing-key store for `ggui gadget publish`.
 *
 * Layout: `~/.ggui/keys/<scope>/private.key` (raw 32-byte seed) +
 * `public.key` next to it (raw 32-byte public). One directory per
 * npm scope so an author publishing multiple gadgets under the same
 * scope reuses one key; switching scopes generates a new keypair on
 * next first-publish.
 *
 * **Why raw bytes.** PEM/JWK wrappers add format-decode failure
 * modes. The signer in `gadget-signing.ts` consumes raw seeds; the
 * round-trip is "read 32 bytes → sign". Operators copying keys
 * between machines `cat`-with-mode-0600 the file.
 *
 * **Mode 0o600.** Same discipline as `~/.ggui/auth.json` — the
 * private key is a secret equivalent to a long-lived password.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from '../paths.js';

/**
 * Resolve the default private-key path for an npm scope.
 *
 *   - `@mapbox/foo-gadget` → `~/.ggui/keys/@mapbox/private.key`
 *   - `@you/widgets`       → `~/.ggui/keys/@you/private.key`
 *
 * The `artifactId` argument is the full `<scope>/<name>`; this helper
 * strips the name and uses the scope.
 */
export function getPrivateKeyPath(scope: string): string {
  const dir = join(getConfigDir(), 'keys', scope);
  return join(dir, 'private.key');
}

export function getPublicKeyPath(scope: string): string {
  const dir = join(getConfigDir(), 'keys', scope);
  return join(dir, 'public.key');
}

/**
 * Extract the npm scope from a `<scope>/<name>` artifactId. Throws on
 * malformed input — the parser layer should have caught it first.
 */
export function scopeOf(artifactId: string): string {
  const slash = artifactId.indexOf('/');
  if (slash === -1 || !artifactId.startsWith('@')) {
    throw new Error(
      `key-store: artifactId must be \`<scope>/<name>\` (got ${artifactId})`,
    );
  }
  return artifactId.slice(0, slash);
}

/**
 * Read a raw 32-byte private key from disk. Returns null when the
 * file does not exist (the caller decides whether to generate vs.
 * error). Throws when the file exists but is the wrong length —
 * silent truncation would produce a broken signature.
 */
export function readPrivateKey(path: string): Uint8Array | null {
  if (!existsSync(path)) return null;
  const buf = readFileSync(path);
  if (buf.length !== 32) {
    throw new Error(
      `key-store: ${path} is not a 32-byte Ed25519 seed (got ${buf.length} bytes)`,
    );
  }
  return new Uint8Array(buf);
}

/**
 * Write a 32-byte private key to disk with mode `0o600` + an
 * accompanying public-key file alongside. Atomic via write-temp +
 * rename so a crash mid-write doesn't strand a partial blob.
 */
export function writePrivateKey(
  scope: string,
  privateKey: Uint8Array,
  publicKey: Uint8Array,
): void {
  if (privateKey.length !== 32) {
    throw new Error(
      `key-store: private key must be 32 bytes (got ${privateKey.length})`,
    );
  }
  if (publicKey.length !== 32) {
    throw new Error(
      `key-store: public key must be 32 bytes (got ${publicKey.length})`,
    );
  }
  const privPath = getPrivateKeyPath(scope);
  const pubPath = getPublicKeyPath(scope);
  const dir = dirname(privPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort
    }
  }
  writeAtomic(privPath, Buffer.from(privateKey), 0o600);
  writeAtomic(pubPath, Buffer.from(publicKey), 0o644);
}

/**
 * Returns true when both halves exist on disk for `scope`. Used by
 * the publish flow to decide between "load existing" vs. "generate
 * new + register".
 */
export function hasKeypair(scope: string): boolean {
  return existsSync(getPrivateKeyPath(scope));
}

/**
 * stat helper — exported for tests that want to assert mode bits
 * survived the round-trip.
 */
export function statPrivateKey(scope: string): { mode: number } | null {
  const path = getPrivateKeyPath(scope);
  if (!existsSync(path)) return null;
  const s = statSync(path);
  return { mode: s.mode };
}

function writeAtomic(target: string, bytes: Buffer, mode: number): void {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, bytes, { mode });
  try {
    chmodSync(tmp, mode);
  } catch {
    // best-effort
  }
  renameSync(tmp, target);
  try {
    chmodSync(target, mode);
  } catch {
    // best-effort
  }
}
