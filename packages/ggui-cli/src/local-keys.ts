/**
 * Local-file key management for self-host operators — mirrors the
 * `--keys-file` JSON written by `InMemoryPairingService.persistencePath`.
 *
 * `ggui keys <list|create|revoke>` defaults to the cloud-backed
 * `api.ggui.ai` path. Pass `--keys-file <path>` to switch each
 * subcommand to operate on the LOCAL JSON file instead — useful for
 * production-grade self-hosting where operators want to mint /
 * inspect / revoke bearers without depending on api.ggui.ai.
 *
 * Schema is identical to what `InMemoryPairingService` writes (v=1)
 * so `ggui keys` and `ggui serve --keys-file` operate on the same
 * file with no migration step.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

interface LocalKeyRow {
  pairingId: string;
  deviceName: string;
  createdAt: number;
  lastUsedAt?: number;
  lastRemoteAddress?: string;
  token: string;
}

interface LocalKeysState {
  v: 1;
  pairings: LocalKeyRow[];
  idCounter: number;
}

/**
 * Read + parse the keys file, or return empty state when the file is
 * missing / empty (first-boot path). Throws on malformed JSON or
 * unsupported schema — loud failure beats silent overwrite.
 */
export function loadLocalKeys(path: string): LocalKeysState {
  if (!existsSync(path)) {
    return { v: 1, pairings: [], idCounter: 0 };
  }
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) {
    return { v: 1, pairings: [], idCounter: 0 };
  }
  const parsed = JSON.parse(raw) as LocalKeysState;
  if (parsed.v !== 1) {
    throw new Error(
      `ggui keys: unsupported schema v=${String(parsed.v)} at ${path} (expected v=1)`,
    );
  }
  return parsed;
}

/**
 * Atomic write — temp file + rename, `0600` perms, parent dir created
 * with `0700` if missing. Mirrors `InMemoryPairingService.persistToDisk`
 * so the two writers can't disagree on file shape.
 */
export function saveLocalKeys(path: string, state: LocalKeysState): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(state, null, 2));
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* swallow — original error is the real one */
    }
    throw err;
  }
}

/**
 * Mint a new `ggui_user_*` token and append it to `state`. Returns
 * the appended row (caller surfaces the plaintext token to the
 * operator — one-time reveal, exactly like cloud-side `keys create`).
 */
export function mintLocalKey(
  state: LocalKeysState,
  opts: { readonly deviceName: string; readonly now?: () => number },
): LocalKeyRow {
  const now = (opts.now ?? Date.now)();
  const pairingId = `pair-${++state.idCounter}`;
  const token = `ggui_user_${randomBytes(9).toString('base64url')}`;
  const row: LocalKeyRow = {
    pairingId,
    deviceName: opts.deviceName,
    createdAt: now,
    token,
  };
  state.pairings.push(row);
  return row;
}

/**
 * Remove the row with `pairingId`. Idempotent — revoking a missing
 * id is not an error. Returns `true` when a row was removed.
 */
export function revokeLocalKey(state: LocalKeysState, pairingId: string): boolean {
  const before = state.pairings.length;
  state.pairings = state.pairings.filter((p) => p.pairingId !== pairingId);
  return state.pairings.length < before;
}

/**
 * Render a fixed-width table to stdout. Columns chosen to match the
 * cloud-side `keys list` shape so operators recognize the layout
 * regardless of which mode they're in.
 */
export function formatLocalKeyTable(state: LocalKeysState): string {
  if (state.pairings.length === 0) {
    return 'No local keys. Run `ggui keys create --keys-file <path> --name <label>` to mint one.\n';
  }
  const headers = ['ID', 'PREFIX', 'NAME', 'CREATED', 'LAST USED'];
  const rows = state.pairings.map((p) => [
    p.pairingId,
    `${p.token.slice(0, 14)}…`,
    p.deviceName,
    new Date(p.createdAt).toISOString(),
    p.lastUsedAt ? new Date(p.lastUsedAt).toISOString() : '—',
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
  return [fmt(headers), ...rows.map(fmt)].join('\n') + '\n';
}
