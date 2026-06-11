/**
 * `ggui keys <list|create|revoke|register>` — manage CLI keys.
 *
 * - `list` / `create` / `revoke` operate on `ggui_user_*` connector
 *   keys (MCP transport bearers). One-time reveal model on `create`.
 * - `register` registers a per-scope Ed25519 PUBLISHER key with the
 *   marketplace registry's `POST /author-keys` endpoint. Distinct
 *   from connector keys: the
 *   publisher key is auto-generated locally by `ggui gadget publish`
 *   / `ggui blueprint publish`; `register` ships its public half to
 *   the registry so future signed publishes validate.
 */
import process from 'node:process';
import { ApiError, createKey, listKeys, revokeKey } from './api-client.js';
import {
  formatLocalKeyTable,
  loadLocalKeys,
  mintLocalKey,
  revokeLocalKey,
  saveLocalKeys,
} from './local-keys.js';
import { AUTH_HELP_FRAGMENT, parseAuthFlags } from './internal/auth-strategy.js';
import { runRegisterAuthorKey } from './internal/register-author-key.js';

export const KEYS_HELP = `ggui keys — manage CLI keys

Usage:
  ggui keys list                          [--keys-file <path>]
  ggui keys create  [--name <label>] [--expires-at <iso8601>] [--keys-file <path>]
  ggui keys revoke  <id>                  [--keys-file <path>]
  ggui keys register --scope <@scope>    [--registry <url>] [--auth=bearer [--token <token>]]

list      Print the caller's keys (id, prefix, name, status, dates).
create    Mint a new connector key. The full secret is printed ONCE — copy it.
revoke    Soft-revoke a connector key by id (the row stays for audit).
register  Register a per-scope Ed25519 PUBLISHER key with the marketplace
          registry so future \`ggui gadget publish\` / \`ggui blueprint publish\`
          signed by the matching private key validate. The keypair is
          auto-generated on first publish under
          ~/.ggui/keys/<scope>/{private,public}.key — this verb ships
          the public half to the registry's POST /author-keys.

register-only ${AUTH_HELP_FRAGMENT}

Pass --keys-file <path> to operate on the LOCAL JSON file instead of
the cloud (api.ggui.ai). The file format is the one written by
\`ggui serve --keys-file\` — the two commands share the same store, so
you can mint a bearer here and have \`ggui serve\` accept it on next
boot. Use this for self-host / personal-mode workflows. --keys-file
applies to list/create/revoke only; \`register\` always talks to the
marketplace registry.
`;

export async function runKeysCommand(args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h') {
    process.stdout.write(KEYS_HELP);
    return sub ? 0 : 2;
  }
  switch (sub) {
    case 'list':
      return runKeysList(rest);
    case 'create':
      return runKeysCreate(rest);
    case 'revoke':
      return runKeysRevoke(rest);
    case 'register':
      return runKeysRegister(rest);
    default:
      process.stderr.write(`ggui keys: unknown subcommand "${sub}"\n\n`);
      process.stderr.write(KEYS_HELP);
      return 2;
  }
}

/**
 * Pull `--keys-file <path>` out of an arg list. Returns the path
 * (when present) and the residual args for downstream parsers.
 * `--keys-file=<path>` long-form is also accepted because operators
 * sometimes type it that way.
 */
function takeKeysFile(args: readonly string[]): {
  keysFile?: string;
  rest: string[];
} {
  const rest: string[] = [];
  let keysFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--keys-file') {
      const value = args[i + 1];
      if (typeof value === 'string' && value.length > 0) {
        keysFile = value;
        i += 1;
        continue;
      }
    } else if (arg.startsWith('--keys-file=')) {
      keysFile = arg.slice('--keys-file='.length);
      continue;
    }
    rest.push(arg);
  }
  return keysFile === undefined ? { rest } : { keysFile, rest };
}

async function runKeysList(args: readonly string[]): Promise<number> {
  const { keysFile, rest } = takeKeysFile(args);
  if (keysFile) {
    if (rest.length > 0) {
      process.stderr.write(`ggui keys list: unexpected extra args ${rest.join(' ')}\n`);
      return 2;
    }
    try {
      const state = loadLocalKeys(keysFile);
      process.stdout.write(formatLocalKeyTable(state));
      return 0;
    } catch (err) {
      process.stderr.write(
        `ggui keys list: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  if (rest.length > 0) {
    process.stderr.write(`ggui keys list: takes no arguments\n`);
    return 2;
  }
  try {
    const { keys } = await listKeys();
    if (keys.length === 0) {
      process.stdout.write(`No keys. Run \`ggui keys create\` to mint one.\n`);
      return 0;
    }
    // Compact aligned table. Columns are sized by content width with a
    // sane minimum so empty rows still render readably.
    const rows = keys.map((k) => [
      k.id,
      `ggui_user_${k.apiKeyPrefix}…`,
      k.name ?? '',
      k.status,
      k.lastUsedAt ?? '—',
    ]);
    const headers = ['ID', 'PREFIX', 'NAME', 'STATUS', 'LAST USED'];
    const widths = headers.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
    );
    const fmt = (cells: string[]): string =>
      cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ');
    process.stdout.write(`${fmt(headers)}\n`);
    for (const row of rows) {
      process.stdout.write(`${fmt(row)}\n`);
    }
    return 0;
  } catch (err) {
    return printApiError('keys list', err);
  }
}

interface CreateFlags {
  readonly name?: string;
  readonly expiresAt?: string;
  readonly help: boolean;
  readonly error?: string;
}

function parseCreateFlags(args: readonly string[]): CreateFlags {
  let name: string | undefined;
  let expiresAt: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--name') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { help, error: '--name requires a value' };
      }
      name = value;
      i += 1;
      continue;
    }
    if (arg === '--expires-at') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { help, error: '--expires-at requires an ISO 8601 value' };
      }
      expiresAt = value;
      i += 1;
      continue;
    }
    return { help, error: `unknown flag: ${arg}` };
  }
  return { name, expiresAt, help };
}

async function runKeysCreate(args: readonly string[]): Promise<number> {
  const { keysFile, rest: afterKeysFile } = takeKeysFile(args);
  if (keysFile) {
    const flags = parseCreateFlags(afterKeysFile);
    if (flags.help) {
      process.stdout.write(KEYS_HELP);
      return 0;
    }
    if (flags.error) {
      process.stderr.write(`ggui keys create: ${flags.error}\n`);
      return 2;
    }
    if (flags.expiresAt) {
      process.stderr.write(
        `ggui keys create: --expires-at is not supported with --keys-file (local store has no TTL).\n`,
      );
      return 2;
    }
    try {
      const state = loadLocalKeys(keysFile);
      const row = mintLocalKey(state, {
        deviceName: flags.name ?? `cli-${new Date().toISOString().slice(0, 10)}`,
      });
      saveLocalKeys(keysFile, state);
      process.stdout.write(`\n`);
      process.stdout.write(`API key:    ${row.token}\n`);
      process.stdout.write(`ID:         ${row.pairingId}\n`);
      process.stdout.write(`Name:       ${row.deviceName}\n`);
      process.stdout.write(`Created:    ${new Date(row.createdAt).toISOString()}\n`);
      process.stdout.write(`File:       ${keysFile}\n`);
      process.stdout.write(`\n`);
      process.stdout.write(
        `IMPORTANT: copy the API key now — it will NEVER be shown again.\n`,
      );
      process.stdout.write(
        `Use it as the bearer token for any client that hits this server's /mcp.\n`,
      );
      return 0;
    } catch (err) {
      process.stderr.write(
        `ggui keys create: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  const flags = parseCreateFlags(afterKeysFile);
  if (flags.help) {
    process.stdout.write(KEYS_HELP);
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`ggui keys create: ${flags.error}\n`);
    return 2;
  }
  try {
    const result = await createKey({
      name: flags.name,
      expiresAt: flags.expiresAt,
    });
    process.stdout.write(`\n`);
    process.stdout.write(`API key:    ${result.apiKey}\n`);
    process.stdout.write(`ID:         ${result.id}\n`);
    process.stdout.write(`Prefix:     ${result.prefix}\n`);
    process.stdout.write(`Created:    ${result.createdAt}\n`);
    process.stdout.write(`\n`);
    process.stdout.write(
      `IMPORTANT: copy the API key now — it will NEVER be shown again.\n`,
    );
    process.stdout.write(
      `Use it as the bearer token for the ggui-protocol-user MCP server.\n`,
    );
    return 0;
  } catch (err) {
    return printApiError('keys create', err);
  }
}

async function runKeysRevoke(args: readonly string[]): Promise<number> {
  const { keysFile, rest } = takeKeysFile(args);
  if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
    process.stdout.write(KEYS_HELP);
    return rest.length === 0 ? 2 : 0;
  }
  if (rest.length !== 1) {
    process.stderr.write(`ggui keys revoke: takes exactly one <id> argument\n`);
    return 2;
  }
  const id = rest[0]!;
  if (keysFile) {
    try {
      const state = loadLocalKeys(keysFile);
      const removed = revokeLocalKey(state, id);
      if (!removed) {
        process.stderr.write(`ggui keys revoke: no key with id "${id}" in ${keysFile}\n`);
        return 1;
      }
      saveLocalKeys(keysFile, state);
      process.stdout.write(`Revoked ${id} from ${keysFile}.\n`);
      return 0;
    } catch (err) {
      process.stderr.write(
        `ggui keys revoke: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }
  try {
    await revokeKey(id);
    process.stdout.write(`Revoked key ${id}.\n`);
    return 0;
  } catch (err) {
    return printApiError('keys revoke', err);
  }
}

function printApiError(label: string, err: unknown): number {
  if (err instanceof ApiError) {
    process.stderr.write(`ggui ${label}: ${err.code}: ${err.message}\n`);
  } else if (err instanceof Error) {
    process.stderr.write(`ggui ${label}: ${err.message}\n`);
  } else {
    process.stderr.write(`ggui ${label}: unknown error\n`);
  }
  return 1;
}

/* ─── register ─────────────────────────────────────────────────────── */

export interface RegisterFlags {
  readonly scope?: string;
  readonly registry?: string;
  readonly help: boolean;
  readonly error?: string;
}

export function parseRegisterFlags(args: readonly string[]): RegisterFlags {
  let scope: string | undefined;
  let registry: string | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--scope') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { help, error: '--scope requires a value (e.g. `@my-scope`)' };
      }
      scope = value;
      i += 1;
      continue;
    }
    if (arg && arg.startsWith('--scope=')) {
      scope = arg.slice('--scope='.length);
      continue;
    }
    if (arg === '--registry') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return { help, error: '--registry requires a URL' };
      }
      registry = value;
      i += 1;
      continue;
    }
    if (arg && arg.startsWith('--registry=')) {
      registry = arg.slice('--registry='.length);
      continue;
    }
    return { help, error: `unknown flag: ${arg}` };
  }
  return {
    help,
    ...(scope !== undefined ? { scope } : {}),
    ...(registry !== undefined ? { registry } : {}),
  };
}

async function runKeysRegister(args: readonly string[]): Promise<number> {
  // Peel the shared `--auth=bearer` / `--token` flags first (same
  // router the publish verbs use), then parse the register-specific
  // flags from the residue.
  const authParsed = parseAuthFlags(args);
  if ('error' in authParsed) {
    process.stderr.write(`ggui keys register: ${authParsed.error}\n`);
    return 2;
  }
  const flags = parseRegisterFlags(authParsed.rest);
  if (flags.help) {
    process.stdout.write(KEYS_HELP);
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`ggui keys register: ${flags.error}\n`);
    return 2;
  }
  if (!flags.scope) {
    process.stderr.write(
      'ggui keys register: --scope is required (e.g. `--scope @my-scope`)\n',
    );
    return 2;
  }
  if (!flags.scope.startsWith('@')) {
    process.stderr.write(
      `ggui keys register: --scope must start with \`@\` (got "${flags.scope}")\n`,
    );
    return 2;
  }

  const authFlags = authParsed.flags;
  const outcome = await runRegisterAuthorKey(
    {
      scope: flags.scope,
      ...(flags.registry !== undefined ? { registry: flags.registry } : {}),
      ...(authFlags.auth !== undefined || authFlags.token !== undefined
        ? { auth: authFlags }
        : {}),
    },
    {
      cwd: process.cwd(),
      env: process.env,
      fetch,
      // Unix-epoch SECONDS — the login-session expiry fields
      // (`accessExpiresAt` / `refreshExpiresAt` in auth-store.ts) are
      // in seconds. `Date.now()` returns milliseconds; passing it raw
      // would make every freshness check fail and force a refresh (or
      // a spurious "session expired") on every run.
      now: () => Math.floor(Date.now() / 1000),
    },
  );

  if (outcome.ok) {
    const verb = outcome.status === 201 ? 'Registered' : 'Already registered';
    process.stdout.write(
      `${verb} publisher key for ${flags.scope}.\n` +
        `  registry: ${outcome.registryUrl}\n` +
        `  subject:  ${outcome.subject}\n` +
        `  keyId:    ${outcome.keyId}\n`,
    );
    return 0;
  }
  process.stderr.write(`ggui keys register: ${outcome.code}: ${outcome.message}\n`);
  // Exit-code policy: `key_conflict` is a distinct, scriptable state
  // (the registry already holds a different publicKey for this
  // subject+keyId — vanishingly rare hash collision OR a stale row).
  // Scripts that wrap `ggui keys register` should be able to detect
  // it without parsing the message. Exit 2 is reserved for usage
  // errors (handled above before this point), exit 1 covers
  // everything else.
  if (outcome.code === 'key_conflict') return 3;
  return 1;
}
