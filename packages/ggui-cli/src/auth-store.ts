/**
 * `~/.ggui/auth.json` reader / writer for the OSS `ggui` CLI.
 *
 * The file is written by `ggui login` after a successful device-flow
 * exchange against `api.ggui.ai` (S2 endpoints). All authenticated
 * subcommands (`whoami`, `keys *`) read it via {@link loadAuthSession}.
 *
 * On-disk shape is `AuthSessionDocument` v1 — a small JSON document
 * with the access + refresh bearers, their expiry timestamps, the
 * userId the tokens are bound to, and the API endpoint used at login
 * time. Mode `0o600` is enforced on every write — the tokens are
 * bearer secrets equivalent to a short-lived password.
 *
 * This file is distinct from `~/.ggui/credentials.json` (BYOK
 * provider keys, see `paths.ts`). The two coexist; one stores
 * provider-API keys for local generation, the other stores ggui.ai
 * session bearers for hosted-key management.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { getAuthFile, getConfigDir } from './paths.js';

/**
 * Default endpoint URL — `api.ggui.ai` once Route53 + ACM land (S6).
 * Until then the operator overrides via `GGUI_API_URL` env to point
 * at the deployed exec-api URL surfaced in `amplify_outputs.json`.
 */
const DEFAULT_API_URL = 'https://api.ggui.ai';

/**
 * v1 on-disk document. Bumped on breaking changes; loaders that
 * encounter `version > 1` should refuse to read and prompt the user
 * to upgrade the CLI.
 */
export interface AuthSessionDocument {
  readonly version: 1;
  /** API endpoint these tokens are bound to (origin only, no path). */
  readonly endpoint: string;
  /** Cognito sub of the authenticated user. */
  readonly userId: string;
  /** Stable session id grouping access + refresh on the server. */
  readonly sessionId: string;
  /** `cli_at_*` bearer. Send as `Authorization: Bearer <accessToken>`. */
  readonly accessToken: string;
  /** Unix epoch SECONDS — used to decide when to proactively refresh. */
  readonly accessExpiresAt: number;
  /** `cli_rt_*` bearer. Used by /v1/auth/refresh. */
  readonly refreshToken: string;
  /** Unix epoch SECONDS — past this, the user must `ggui login` again. */
  readonly refreshExpiresAt: number;
  /** Free-form label the CLI provided at login (e.g. host name). */
  readonly clientName: string;
  /** ISO 8601 timestamp of when this document was written. */
  readonly writtenAt: string;
}

/** Resolution of the API endpoint, with explicit precedence. */
export interface ResolvedEndpoint {
  readonly url: string;
  readonly source: 'env' | 'auth.json' | 'default';
}

/**
 * Resolve which endpoint a command should use.
 *
 * Precedence:
 *   1. `GGUI_API_URL` env var — operator override (dev / sandbox testing).
 *   2. `~/.ggui/auth.json#endpoint` — captured at last `ggui login`.
 *   3. `https://api.ggui.ai` — production default.
 *
 * Used by `ggui login` (where there's no auth.json yet) and by every
 * authenticated command (where auth.json holds the canonical value).
 */
export function resolveEndpoint(): ResolvedEndpoint {
  const envOverride = process.env['GGUI_API_URL'];
  if (envOverride && envOverride.length > 0) {
    return { url: stripTrailingSlash(envOverride), source: 'env' };
  }
  const session = tryLoadAuthSession();
  if (session) {
    return { url: stripTrailingSlash(session.endpoint), source: 'auth.json' };
  }
  return { url: DEFAULT_API_URL, source: 'default' };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Load the auth.json document. Returns null if missing OR malformed
 * (unknown version, missing fields, parse error). Callers print
 * "ggui login" prompt on null rather than crash.
 */
export function tryLoadAuthSession(): AuthSessionDocument | null {
  const path = getAuthFile();
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isAuthSessionDocument(parsed)) return null;
  return parsed;
}

/**
 * Stricter loader — throws with a friendly message for the
 * authenticated-command path. CLI surfaces the message + exit 1.
 */
export function loadAuthSession(): AuthSessionDocument {
  const session = tryLoadAuthSession();
  if (!session) {
    throw new Error(
      'No active ggui session. Run `ggui login` first.',
    );
  }
  return session;
}

function isAuthSessionDocument(x: unknown): x is AuthSessionDocument {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    r['version'] === 1 &&
    typeof r['endpoint'] === 'string' &&
    typeof r['userId'] === 'string' &&
    typeof r['sessionId'] === 'string' &&
    typeof r['accessToken'] === 'string' &&
    typeof r['accessExpiresAt'] === 'number' &&
    typeof r['refreshToken'] === 'string' &&
    typeof r['refreshExpiresAt'] === 'number' &&
    typeof r['clientName'] === 'string' &&
    typeof r['writtenAt'] === 'string'
  );
}

/**
 * Atomically write the document with mode `0o600`. Uses the
 * write-temp + rename pattern so a crash mid-write doesn't leave a
 * partial document.
 */
export function saveAuthSession(doc: AuthSessionDocument): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    chmodSync(dir, 0o700);
  }
  const target = getAuthFile();
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  // Write JSON pretty-printed for human-readable inspection.
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  // chmod the tmp file in case the writeFileSync mode arg was ignored
  // by the platform (Windows tolerates 0o600 silently as 0o666).
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Delete the auth.json file. No-op if missing. Used by `ggui logout`.
 */
export function deleteAuthSession(): { deleted: boolean } {
  const path = getAuthFile();
  if (!existsSync(path)) return { deleted: false };
  unlinkSync(path);
  return { deleted: true };
}
