/**
 * `ggui keys register`.
 *
 * Register a per-scope Ed25519 public key with the marketplace
 * registry's `POST /author-keys` endpoint. Replaces the operator-owned
 * `aws dynamodb put-item` workflow that previously required raw IAM
 * credentials + registry table knowledge.
 *
 * The publisher's identity is derived server-side from the verified
 * bearer credential; the body carries only `publicKeyBase64`. `keyId`
 * is derived from the public-key bytes on the server, so re-running
 * with the same key is idempotent (200 OK).
 *
 * Auth + registry-URL resolution match the publish flow (the stored
 * `ggui login` session by default, `--auth=bearer --token <token>` /
 * `GGUI_REGISTRY_TOKEN` for self-hosted registries; `GGUI_REGISTRY`
 * env / `ggui.json#registry` URL chain works the same way operators
 * are used to).
 */
import { readFileSync } from 'node:fs';
import { REGISTER_AUTHOR_KEY_ERROR_CODES } from '@ggui-ai/registry-core';
import {
  acquireLoginSessionToken,
  type AuthFailed,
} from './artifact-publish.js';
import { resolveRegistryUrl } from './artifact-search.js';
import { acquireAuthToken, type AuthFlags } from './auth-strategy.js';
import { getPublicKeyPath, hasKeypair } from './key-store.js';

/**
 * Outcome discriminator. The `ok: false` `code` union surfaces specific
 * HTTP failure modes so callers (notably a future `--json` flag) can
 * branch on the registry's closed error set without parsing the human-
 * readable message:
 *
 *   - `unauthorized`     ← HTTP 401 (missing/invalid bearer credential).
 *   - `invalid_request`  ← HTTP 400 (malformed body or wrong key length).
 *   - `key_conflict`     ← HTTP 409 (collision against an existing row).
 *   - `http-error`       ← any other non-2xx (5xx or unexpected status).
 *
 * The body's `error` field on a structured error response is read first
 * (it carries the registry's authoritative {@link RegisterAuthorKeyErrorCode});
 * status-code mapping is the fallback when the body omits it. The
 * human-readable `message` always flows through from the body when
 * present.
 */
export type RegisterKeyOutcome =
  | {
      readonly ok: true;
      readonly status: 200 | 201;
      readonly registryUrl: string;
      readonly subject: string;
      readonly keyId: string;
    }
  | {
      readonly ok: false;
      readonly code:
        | 'no-registry'
        | 'invalid-registry'
        | 'no-keypair'
        | 'auth_failed'
        | 'auth_config_missing'
        | 'network-error'
        | 'unauthorized'
        | 'invalid_request'
        | 'key_conflict'
        | 'http-error'
        | 'bad-response';
      readonly message: string;
    };

export interface RunRegisterKeyFlags {
  readonly scope: string;
  readonly registry?: string;
  /** Auth strategy + bearer token. `undefined` → the stored `ggui
   *  login` session; `{ auth: 'bearer', token? }` → explicit bearer
   *  (self-hosted registries), token from the flag or
   *  `GGUI_REGISTRY_TOKEN`. Mirrors the publish flow's `AuthFlags`. */
  readonly auth?: AuthFlags;
}

export interface RunRegisterKeyDeps {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly fetch: typeof fetch;
  readonly now: () => number;
}

/**
 * Sentinel that carries the structured {@link AuthFailed} payload
 * through `acquireAuthToken`'s throwing session callback — the
 * register flow's never-throws contract maps it back to an outcome.
 * Mirrors `SessionAuthError` in `artifact-publish.ts`.
 */
class SessionOutcomeError extends Error {
  constructor(readonly payload: AuthFailed) {
    super(payload.error.message);
  }
}

/**
 * Run the register flow end-to-end. Never throws — every error path
 * returns a structured outcome.
 */
export async function runRegisterAuthorKey(
  flags: RunRegisterKeyFlags,
  deps: RunRegisterKeyDeps,
): Promise<RegisterKeyOutcome> {
  // 1. Registry URL — same resolver as publish/search.
  const resolved = resolveRegistryUrl({
    ...(flags.registry !== undefined ? { flag: flags.registry } : {}),
    cwd: deps.cwd,
    env: {
      GGUI_REGISTRY:
        typeof deps.env['GGUI_REGISTRY'] === 'string' ? deps.env['GGUI_REGISTRY'] : undefined,
    },
  });
  if ('error' in resolved) {
    const isNoRegistry = resolved.error.startsWith('no registry');
    return {
      ok: false,
      code: isNoRegistry ? 'no-registry' : 'invalid-registry',
      message: resolved.error,
    };
  }

  // 2. Read the local public key. Same per-scope keystore the publish
  // flow auto-generates on first publish — operators run `ggui keys
  // register` AFTER `ggui blueprint publish` / `ggui gadget publish`
  // generates the keypair locally + the registry rejects with
  // `unknown_key`.
  if (!hasKeypair(flags.scope)) {
    return {
      ok: false,
      code: 'no-keypair',
      message:
        `no keypair found for scope ${flags.scope}. Run \`ggui blueprint publish\` or ` +
        `\`ggui gadget publish\` under this scope first — the publish flow generates the ` +
        `keypair on first run.`,
    };
  }
  const pubPath = getPublicKeyPath(flags.scope);
  let publicKeyBytes: Buffer;
  try {
    publicKeyBytes = readFileSync(pubPath);
  } catch (err) {
    return {
      ok: false,
      code: 'no-keypair',
      message: `failed to read public key at ${pubPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (publicKeyBytes.length !== 32) {
    return {
      ok: false,
      code: 'no-keypair',
      message: `public key at ${pubPath} is not a 32-byte Ed25519 key (got ${publicKeyBytes.length} bytes)`,
    };
  }
  const publicKeyBase64 = publicKeyBytes.toString('base64');

  // 3. Credential — same two-path strategy as publish:
  //    --auth=bearer → token from the flag or GGUI_REGISTRY_TOKEN
  //    default       → the stored `ggui login` session.
  let accessToken: string;
  try {
    accessToken = await acquireAuthToken({
      flags: flags.auth ?? {},
      env: deps.env,
      acquireSessionToken: async () => {
        const auth = await acquireLoginSessionToken({
          now: deps.now,
          fetchImpl: deps.fetch,
        });
        if (!auth.ok) throw new SessionOutcomeError(auth);
        return auth.accessToken;
      },
    });
  } catch (err) {
    if (err instanceof SessionOutcomeError) {
      return {
        ok: false,
        code: err.payload.error.code,
        message: err.payload.error.message,
      };
    }
    // Bearer selected but no token supplied — `acquireAuthToken`
    // throws with an operator-readable message naming the env var.
    return {
      ok: false,
      code: 'auth_config_missing',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 4. POST /author-keys
  const url = `${resolved.url}/author-keys`;
  let res: Response;
  try {
    res = await deps.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ publicKeyBase64 }),
    });
  } catch (err) {
    return {
      ok: false,
      code: 'network-error',
      message: `failed to reach registry at ${resolved.url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      code: 'bad-response',
      message: `registry responded with HTTP ${res.status} but body was not valid JSON`,
    };
  }

  if (res.status === 200 || res.status === 201) {
    if (body === null || typeof body !== 'object') {
      return {
        ok: false,
        code: 'bad-response',
        message: `registry returned ${res.status} with malformed body`,
      };
    }
    const okBody = body as {
      subject?: unknown;
      keyId?: unknown;
    };
    if (typeof okBody.subject !== 'string' || typeof okBody.keyId !== 'string') {
      return {
        ok: false,
        code: 'bad-response',
        message: `registry returned ${res.status} with missing subject/keyId fields`,
      };
    }
    return {
      ok: true,
      status: res.status,
      registryUrl: resolved.url,
      subject: okBody.subject,
      keyId: okBody.keyId,
    };
  }

  // Defend against `null` / non-object JSON (e.g. `body === null` or
  // `body === "string-literal"`) — accessing `.error`/`.message` on
  // those would throw. Treat them like the "no structured body" case.
  const errBody: { error?: unknown; message?: unknown } =
    body !== null && typeof body === 'object'
      ? (body as { error?: unknown; message?: unknown })
      : {};
  const errMsg =
    typeof errBody.message === 'string'
      ? errBody.message
      : `registry returned HTTP ${res.status}`;

  // Prefer the body's `error` discriminator (closed enum from registry-
  // core's `REGISTER_AUTHOR_KEY_ERROR_CODES`) over status-code mapping —
  // the body is authoritative when present + well-formed. Status-code
  // mapping is the fallback when the body omits `error`.
  const bodyError = mapBodyErrorToCode(errBody.error);
  if (bodyError !== undefined) {
    return { ok: false, code: bodyError, message: errMsg };
  }

  return {
    ok: false,
    code: mapStatusToCode(res.status),
    message: errMsg,
  };
}

/**
 * Map the registry's structured `error` discriminator to the CLI's
 * outcome `code`. Returns `undefined` when the body doesn't carry a
 * recognised code so the caller can fall back to status-code mapping.
 * The `server_error` value from the registry deliberately maps to the
 * CLI's generic `http-error` bucket — the CLI doesn't distinguish 500-
 * shaped responses from other non-2xx statuses.
 */
function mapBodyErrorToCode(
  raw: unknown,
): 'unauthorized' | 'invalid_request' | 'key_conflict' | 'http-error' | undefined {
  if (typeof raw !== 'string') return undefined;
  // Defend against a future registry-core enum addition leaking through
  // — only map values the CLI knows about.
  if (!(REGISTER_AUTHOR_KEY_ERROR_CODES as readonly string[]).includes(raw)) {
    return undefined;
  }
  switch (raw) {
    case 'unauthorized':
      return 'unauthorized';
    case 'invalid_request':
      return 'invalid_request';
    case 'key_conflict':
      return 'key_conflict';
    case 'server_error':
      return 'http-error';
    default:
      return undefined;
  }
}

/**
 * Map an HTTP status to the CLI outcome `code` when the body didn't
 * carry a structured `error` discriminator. Everything outside the
 * three explicit buckets collapses to `http-error`.
 */
function mapStatusToCode(
  status: number,
): 'unauthorized' | 'invalid_request' | 'key_conflict' | 'http-error' {
  if (status === 401) return 'unauthorized';
  if (status === 400) return 'invalid_request';
  if (status === 409) return 'key_conflict';
  return 'http-error';
}
