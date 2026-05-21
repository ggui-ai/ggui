/**
 * Per-registry JWT cache for `ggui gadget publish`.
 *
 * Layout: `~/.ggui/auth/<registry-hostname>/token.json`. One file per
 * registry hostname so an operator who publishes to a dev sandbox
 * AND production doesn't paper over one session with the other. The
 * hostname is the directory name (no path component leaks into disk
 * names) — full URL is captured inside the document.
 *
 * Document version is `1`. Bumped on breaking-change shape edits;
 * loaders that see `version > 1` refuse rather than mis-parse.
 *
 * **Distinct from `~/.ggui/auth.json`.** That file holds the
 * `api.ggui.ai` device-flow session for hosted-key management. The
 * registry tokens here are a SEPARATE auth surface (different IdP,
 * different audience), so they live in a parallel namespace.
 */
import { URL } from 'node:url';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigDir } from '../paths.js';

/** v1 on-disk shape. */
export interface RegistryTokenDocument {
  readonly version: 1;
  /** Full registry origin (e.g. `https://dev.registry.sandbox.ggui.ai`). */
  readonly registry: string;
  /** Cognito IdToken — sent as `Authorization: Bearer <idToken>`. */
  readonly idToken: string;
  /** Cognito AccessToken — surfaced separately for handlers that need it. */
  readonly accessToken: string;
  /** Cognito RefreshToken — used to mint fresh id/access tokens. */
  readonly refreshToken: string;
  /** Unix epoch SECONDS — past this, the id token is rejected by the registry. */
  readonly expiresAt: number;
  /** Username the tokens belong to (informational; for `--whoami` reuse). */
  readonly username: string;
  /** ISO 8601 timestamp this document was written. */
  readonly writtenAt: string;
}

/**
 * Compute the on-disk path for a registry's token cache. Pure (no
 * IO) so callers can derive the path before existence checks.
 */
export function getRegistryTokenPath(registryUrl: string): string {
  const host = safeHostname(registryUrl);
  return join(getConfigDir(), 'auth', host, 'token.json');
}

/**
 * Load a cached token document. Returns null when missing OR
 * malformed — callers treat both as "need to log in".
 */
export function loadRegistryToken(
  registryUrl: string,
): RegistryTokenDocument | null {
  const path = getRegistryTokenPath(registryUrl);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRegistryTokenDocument(decoded)) return null;
  return decoded;
}

/**
 * Atomically write the document with mode `0o600`. write-temp +
 * rename pattern so a crash mid-write doesn't strand a partial doc.
 */
export function saveRegistryToken(doc: RegistryTokenDocument): void {
  const target = getRegistryTokenPath(doc.registry);
  const dir = dirname(target);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort on Windows
    }
  }
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
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
 * Decide whether a cached document is still usable for the next
 * request. Subtracts a 60-second safety margin so we don't race a
 * boundary expiry that the registry would refuse.
 */
export function isTokenFresh(
  doc: RegistryTokenDocument,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return doc.expiresAt - nowSeconds > 60;
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

function isRegistryTokenDocument(x: unknown): x is RegistryTokenDocument {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    r['version'] === 1 &&
    typeof r['registry'] === 'string' &&
    typeof r['idToken'] === 'string' &&
    typeof r['accessToken'] === 'string' &&
    typeof r['refreshToken'] === 'string' &&
    typeof r['expiresAt'] === 'number' &&
    typeof r['username'] === 'string' &&
    typeof r['writtenAt'] === 'string'
  );
}

/**
 * Extract a filesystem-safe hostname from a registry URL. Replaces
 * non-alphanumeric chars with `-` so the result is always a valid
 * directory name on every supported OS.
 */
function safeHostname(registryUrl: string): string {
  let host: string;
  try {
    host = new URL(registryUrl).hostname;
  } catch {
    // Caller validated earlier; if we got here with a bogus URL the
    // cleanest thing is to refuse the path entirely.
    throw new Error(`auth-cache: invalid registry URL: ${registryUrl}`);
  }
  return host.replace(/[^a-z0-9.-]/gi, '-');
}
