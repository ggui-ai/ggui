/**
 * Centralized path helpers for the open `@ggui-ai/cli` (`ggui`).
 *
 * The OSS dirstub lives at `~/.ggui/`. All CLI-managed state
 * (credentials, embedding cache, code cache, persistent bundle) is
 * rooted under this single directory.
 *
 * Override the dir via `GGUI_CONFIG_DIR` env so tests + clean-room
 * harnesses can scope the store to a temp dir without touching the
 * operator's HOME. The override is read on every call (no module-level
 * cache) so process-level env mutations between calls take effect —
 * matters for vitest suites that mutate `process.env` per test.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

const DIRNAME = '.ggui';

/**
 * Return the OSS CLI config directory.
 *
 * Resolution order:
 *   1. `GGUI_CONFIG_DIR` env (if set + non-empty) — tests + clean-room.
 *   2. `~/.ggui` (`os.homedir() + DIRNAME`) — operator default.
 */
export function getConfigDir(): string {
  const override = process.env['GGUI_CONFIG_DIR'];
  if (override && override.length > 0) return override;
  return join(homedir(), DIRNAME);
}

/**
 * Path to the BYOK credentials file. Written + read by the
 * `PlaintextFileProviderKeyStore` from `@ggui-ai/mcp-server-core/plaintext`
 * at the global app-scope (single-user personal-mode default).
 *
 * On-disk shape is `PlaintextFileProviderKeyStore`'s v1 document. Mode
 * 0o600 is enforced by the store on every write.
 */
export function getCredentialsFile(): string {
  return join(getConfigDir(), 'credentials.json');
}

/**
 * Path to the CLI auth-session file. Written by `ggui login` after a
 * successful device-flow exchange against `api.ggui.ai`; read by every
 * authenticated command (`whoami`, `keys *`).
 *
 * On-disk shape is `AuthSessionDocument` from `./lib/auth-store.ts`.
 * Mode 0o600 is enforced by the store on every write — the access +
 * refresh tokens are bearer secrets equivalent to a short-lived
 * password.
 */
export function getAuthFile(): string {
  return join(getConfigDir(), 'auth.json');
}

/**
 * Path to the local-embedding model cache. Resolution order matches
 * the OSS full-generation port plan (§2.B + §7.2):
 *
 *   1. `GGUI_EMBEDDING_CACHE_DIR` env — operator override (CI, custom
 *      mounts, shared NFS).
 *   2. `~/.ggui/models` — first-run default. Owned by ggui to avoid
 *      polluting the operator's `~/.cache/huggingface` cache.
 *
 * Returned even when the directory does not exist on disk — the
 * embedding bootstrap creates it on first warmup.
 */
export function getEmbeddingCacheDir(): string {
  const override = process.env['GGUI_EMBEDDING_CACHE_DIR'];
  if (override && override.length > 0) return override;
  return join(getConfigDir(), 'models');
}

/**
 * Path to the content-addressable componentCode cache. Used by
 * `FileSystemCodeStore` when wired as the OSS dev default.
 *
 * Resolution order:
 *   1. `GGUI_CODE_CACHE_DIR` env — operator override.
 *   2. `~/.ggui/code-cache` — first-run default.
 *
 * The store creates the directory lazily on first put; the path is
 * safe to return even when nothing has been written yet. Operators
 * who want to reset the cache can `rm -rf` this directory at any
 * time — every entry is content-addressable + immutable, so a
 * re-fetch repopulates from upstream code on next render.
 */
export function getCodeCacheDir(): string {
  const override = process.env['GGUI_CODE_CACHE_DIR'];
  if (override && override.length > 0) return override;
  return join(getConfigDir(), 'code-cache');
}

/**
 * Directory backing the `--persistent` bundle (renders.sqlite,
 * short-codes.sqlite, bootstrap-secret.hex, render-signer-secret.hex,
 * keys.json …). Survives `ggui serve` restarts so claude.ai chat-history
 * revisits can rehydrate the iframe instead of seeing four cascading
 * failures (HMAC + shortCode + render + pairing).
 *
 * Resolution order:
 *   1. `GGUI_PERSISTENT_DIR` env — operator override (tests, clean-room,
 *      shared mount).
 *   2. `<projectRoot>/.ggui/persistent` — when the CLI resolved a
 *      ggui.json. Per-project isolation; different projects get
 *      separate renders even on the same machine.
 *   3. `~/.ggui/persistent` — fallback when there's no manifest
 *      (`ggui serve` from a bare directory).
 *
 * Returned even when the directory doesn't exist on disk — the
 * persistence wiring creates parents on first write.
 */
export function getPersistentDir(projectRoot?: string | null): string {
  const override = process.env['GGUI_PERSISTENT_DIR'];
  if (override && override.length > 0) return override;
  if (projectRoot && projectRoot.length > 0) {
    return join(projectRoot, DIRNAME, 'persistent');
  }
  return join(getConfigDir(), 'persistent');
}
