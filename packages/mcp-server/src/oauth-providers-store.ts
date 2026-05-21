/**
 * OAuth provider config storage.
 *
 * Two-layer storage with env-first override:
 *
 *   - File: `~/.ggui/oauth-providers.json` (mode `0o600`, atomic
 *     writes via tmp+rename). Operator pastes client_id/secret in
 *     `/admin/oauth-providers`; values land here.
 *   - Env: `GGUI_OAUTH_<PROVIDERID_UPPERCASE>_CLIENT_ID` +
 *     `GGUI_OAUTH_<PROVIDERID_UPPERCASE>_CLIENT_SECRET`. When both
 *     are set, the env value wins silently — file value stays on
 *     disk untouched. Production deploys use env; the API surfaces
 *     env-overridden slots as read-only.
 */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OAuthProviderConfigRecord } from './oauth-login-types.js';
import type { Logger } from './logger.js';

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]*$/;
const ENV_KEY_RE = /^GGUI_OAUTH_([A-Z0-9_]+)_CLIENT_ID$/;
const FILE_VERSION = '1';

export interface OAuthProvidersStoreOptions {
  /** Override file path. Defaults to `~/.ggui/oauth-providers.json`. */
  readonly filePath?: string;
  /** Test seam: process.env replacement. Defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>;
  readonly logger: Logger;
}

export interface PutInput {
  readonly providerId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly enabled?: boolean;
}

export interface OAuthProvidersStore {
  /** Read all records merged: env-overrides win over file values. */
  list(): Promise<ReadonlyArray<OAuthProviderConfigRecord>>;
  /** Look up one provider by id. Returns null if absent / disabled. */
  get(providerId: string): Promise<OAuthProviderConfigRecord | null>;
  /**
   * Persist or update a file-backed record. Throws on attempt to
   * write a record whose providerId is currently env-overridden.
   */
  put(input: PutInput): Promise<OAuthProviderConfigRecord>;
  /** Toggle enabled. Throws on env-overridden record. */
  setEnabled(providerId: string, enabled: boolean): Promise<void>;
  /** Delete a file-backed record. No-op on env-overridden record. */
  remove(providerId: string): Promise<void>;
}

interface FileRecord {
  providerId: string;
  clientId: string;
  clientSecret: string;
  enabled: boolean;
}

interface FileShape {
  version: string;
  providers: FileRecord[];
}

function defaultFilePath(): string {
  return path.join(os.homedir(), '.ggui', 'oauth-providers.json');
}

/**
 * Convert an env-key segment to a providerId. The env key uses `_` as
 * the separator (`MY_PROVIDER`), but the providerId convention is
 * kebab-case, so lowercase and convert `_` → `-`.
 */
function envSegmentToProviderId(segment: string): string {
  return segment.toLowerCase().replace(/_/g, '-');
}

function validateProviderId(providerId: string): void {
  if (!PROVIDER_ID_RE.test(providerId)) {
    throw new Error(
      `oauth_provider_invalid_id: '${providerId}' must match /^[a-z][a-z0-9-]*$/`,
    );
  }
}

function envOverrideError(providerId: string): Error {
  return new Error(
    `oauth_provider_env_overridden: ${providerId} has env credentials; remove env vars to edit.`,
  );
}

/**
 * Scan the env for `GGUI_OAUTH_<X>_CLIENT_ID` + `_CLIENT_SECRET`
 * pairs. Only emit a record when BOTH halves are set (a half-set
 * pair is operator misconfiguration; we don't silently fall back to
 * the file value). Returns map keyed by providerId.
 */
function scanEnvOverrides(
  env: Record<string, string | undefined>,
): Map<string, OAuthProviderConfigRecord> {
  const overrides = new Map<string, OAuthProviderConfigRecord>();
  for (const key of Object.keys(env)) {
    const match = ENV_KEY_RE.exec(key);
    if (!match) continue;
    const segment = match[1];
    if (!segment) continue;
    const providerId = envSegmentToProviderId(segment);
    if (!PROVIDER_ID_RE.test(providerId)) continue;
    const clientId = env[`GGUI_OAUTH_${segment}_CLIENT_ID`];
    const clientSecret = env[`GGUI_OAUTH_${segment}_CLIENT_SECRET`];
    if (!clientId || !clientSecret) continue;
    overrides.set(providerId, {
      providerId,
      clientId,
      clientSecret,
      source: 'env',
      enabled: true,
    });
  }
  return overrides;
}

async function readFileShape(
  filePath: string,
  logger: Logger,
): Promise<FileShape> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') {
      return { version: FILE_VERSION, providers: [] };
    }
    logger.warn('oauth_providers_file_read_error', {
      filePath,
      error: String(err),
    });
    return { version: FILE_VERSION, providers: [] };
  }
  // File-mode lax check (best-effort; non-POSIX FS may not honor 0600).
  try {
    const stat = await fs.stat(filePath);
    // Only the lower 9 bits encode rwx for owner/group/other.
    const mode = stat.mode & 0o777;
    if (mode > 0o600) {
      logger.warn('oauth_providers_file_lax_mode', {
        filePath,
        mode: mode.toString(8),
      });
    }
  } catch {
    // Stat failure isn't load-bearing; we already have the file
    // content. Move on.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn('oauth_providers_file_corrupt', {
      filePath,
      error: String(err),
    });
    return { version: FILE_VERSION, providers: [] };
  }
  if (!parsed || typeof parsed !== 'object') {
    logger.warn('oauth_providers_file_corrupt', {
      filePath,
      reason: 'root_not_object',
    });
    return { version: FILE_VERSION, providers: [] };
  }
  const obj = parsed as { version?: unknown; providers?: unknown };
  if (!Array.isArray(obj.providers)) {
    logger.warn('oauth_providers_file_corrupt', {
      filePath,
      reason: 'providers_not_array',
    });
    return { version: FILE_VERSION, providers: [] };
  }
  const providers: FileRecord[] = [];
  for (const row of obj.providers) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (
      typeof r['providerId'] !== 'string' ||
      typeof r['clientId'] !== 'string' ||
      typeof r['clientSecret'] !== 'string'
    ) {
      continue;
    }
    if (!PROVIDER_ID_RE.test(r['providerId'])) continue;
    providers.push({
      providerId: r['providerId'],
      clientId: r['clientId'],
      clientSecret: r['clientSecret'],
      enabled: typeof r['enabled'] === 'boolean' ? r['enabled'] : true,
    });
  }
  return { version: FILE_VERSION, providers };
}

async function writeFileShape(
  filePath: string,
  shape: FileShape,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp`;
  // Open with mode 0o600 so even if the rename + chmod race, the
  // tmp file is never world-readable.
  const handle = await fs.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(shape, null, 2), 'utf8');
    // fsync via FileHandle.sync — durable before rename, so a crash
    // mid-write can't leave the operator with a half-written file
    // promoted into place.
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
  // Belt-and-suspenders: re-chmod after rename in case the target
  // pre-existed at a different mode (rename preserves source mode
  // on Linux but spelling it out keeps the contract obvious).
  try {
    await fs.chmod(filePath, 0o600);
  } catch {
    // chmod failure on non-POSIX FS isn't fatal — we already wrote
    // with 0o600 on the tmp file and rename preserves it.
  }
}

export function createOAuthProvidersStore(
  opts: OAuthProvidersStoreOptions,
): OAuthProvidersStore {
  const filePath = opts.filePath ?? defaultFilePath();
  const env = opts.env ?? process.env;
  const logger = opts.logger;

  async function listInternal(): Promise<{
    overrides: Map<string, OAuthProviderConfigRecord>;
    file: FileShape;
  }> {
    const [overrides, file] = await Promise.all([
      Promise.resolve(scanEnvOverrides(env)),
      readFileShape(filePath, logger),
    ]);
    return { overrides, file };
  }

  async function list(): Promise<ReadonlyArray<OAuthProviderConfigRecord>> {
    const { overrides, file } = await listInternal();
    const merged: OAuthProviderConfigRecord[] = [];
    for (const rec of overrides.values()) {
      merged.push(rec);
    }
    for (const rec of file.providers) {
      if (overrides.has(rec.providerId)) continue;
      merged.push({
        providerId: rec.providerId,
        clientId: rec.clientId,
        clientSecret: rec.clientSecret,
        source: 'file',
        enabled: rec.enabled,
      });
    }
    merged.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));
    return merged;
  }

  async function get(
    providerId: string,
  ): Promise<OAuthProviderConfigRecord | null> {
    const all = await list();
    const found = all.find((r) => r.providerId === providerId && r.enabled);
    return found ?? null;
  }

  async function put(input: PutInput): Promise<OAuthProviderConfigRecord> {
    validateProviderId(input.providerId);
    if (input.clientId.length === 0) {
      throw new Error('oauth_provider_invalid_client_id: clientId must be non-empty');
    }
    if (input.clientSecret.length === 0) {
      throw new Error('oauth_provider_invalid_client_secret: clientSecret must be non-empty');
    }
    const overrides = scanEnvOverrides(env);
    if (overrides.has(input.providerId)) {
      throw envOverrideError(input.providerId);
    }
    const file = await readFileShape(filePath, logger);
    const enabled = input.enabled ?? true;
    const next: FileRecord = {
      providerId: input.providerId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      enabled,
    };
    const idx = file.providers.findIndex(
      (r) => r.providerId === input.providerId,
    );
    if (idx >= 0) {
      file.providers[idx] = next;
    } else {
      file.providers.push(next);
    }
    await writeFileShape(filePath, file);
    return {
      providerId: next.providerId,
      clientId: next.clientId,
      clientSecret: next.clientSecret,
      source: 'file',
      enabled: next.enabled,
    };
  }

  async function setEnabled(
    providerId: string,
    enabled: boolean,
  ): Promise<void> {
    validateProviderId(providerId);
    const overrides = scanEnvOverrides(env);
    if (overrides.has(providerId)) {
      throw envOverrideError(providerId);
    }
    const file = await readFileShape(filePath, logger);
    const idx = file.providers.findIndex((r) => r.providerId === providerId);
    if (idx < 0) {
      throw new Error(
        `oauth_provider_not_found: ${providerId} is not stored in the file.`,
      );
    }
    const existing = file.providers[idx];
    if (!existing) {
      throw new Error(`oauth_provider_not_found: ${providerId} is not stored in the file.`);
    }
    file.providers[idx] = {
      providerId: existing.providerId,
      clientId: existing.clientId,
      clientSecret: existing.clientSecret,
      enabled,
    };
    await writeFileShape(filePath, file);
  }

  async function remove(providerId: string): Promise<void> {
    validateProviderId(providerId);
    const overrides = scanEnvOverrides(env);
    if (overrides.has(providerId)) {
      // Spec: no-op on env-overridden record (file value stays
      // untouched; env continues to win).
      return;
    }
    const file = await readFileShape(filePath, logger);
    const idx = file.providers.findIndex((r) => r.providerId === providerId);
    if (idx < 0) return;
    file.providers.splice(idx, 1);
    await writeFileShape(filePath, file);
  }

  return { list, get, put, setEnabled, remove };
}
