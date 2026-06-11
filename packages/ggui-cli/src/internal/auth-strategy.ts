/**
 * Auth strategy for marketplace CLI verbs
 * (`ggui {gadget,blueprint} publish`).
 *
 * Two strategies — explicit `--auth=bearer` for self-hosted and local
 * registries, and the (default) `ggui login` session: the CLI reuses
 * the credential the device flow stored at `~/.ggui/auth.json`,
 * refreshing it when expired. The session acquisition itself lives in
 * `artifact-publish` (`acquireLoginSessionToken`) and is injected here
 * as a callback so this router stays IO-free.
 *
 * @example
 * ```ts
 * import { parseAuthFlags, acquireAuthToken } from './internal/auth-strategy.js';
 *
 * const authFlags = parseAuthFlags(args);
 * const token = await acquireAuthToken({
 *   flags: authFlags,
 *   env: process.env,
 *   acquireSessionToken,
 * });
 * ```
 */

/**
 * Parsed `--auth=<mode>` + `--token <token>` flags.
 *
 * `auth: undefined` means "use the default (the stored `ggui login`
 * session)". The only public flag value is `'bearer'`.
 */
export interface AuthFlags {
  /** Auth mode. Only `'bearer'` is admitted as a public value; absent
   * means "default = the stored `ggui login` session". */
  readonly auth?: 'bearer';
  /** Explicit bearer token. Used only when `auth === 'bearer'`. */
  readonly token?: string;
}

/**
 * Help-text fragment for the auth flags, inlined into each subcommand's
 * help block.
 */
export const AUTH_HELP_FRAGMENT = `Auth:
  --auth=bearer        Use a bearer token (for self-hosted or local
                       registries). Pair with --token <token> or set
                       GGUI_REGISTRY_TOKEN in the environment.
  --token <token>      Bearer token (paired with --auth=bearer).
  (default)            Your \`ggui login\` session — the CLI reads
                       ~/.ggui/auth.json and refreshes the token
                       automatically when it has expired. Run
                       \`ggui login\` first.
`;

/**
 * Pop the auth-related flags out of an argv-like list, returning the
 * parsed flags + the residual args (so subcommand parsers can keep
 * their own flag loops simple). Returns `{ error }` on usage failure.
 *
 * Accepts both `--auth bearer` / `--auth=bearer` forms, and similarly
 * `--token <value>` / `--token=<value>`.
 */
export function parseAuthFlags(
  args: readonly string[],
): { flags: AuthFlags; rest: readonly string[] } | { error: string } {
  let auth: 'bearer' | undefined;
  let token: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;

    if (arg === '--auth' || arg.startsWith('--auth=')) {
      const eq = arg.indexOf('=');
      let value: string;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (typeof next !== 'string' || next.length === 0) {
          return { error: '--auth requires a value' };
        }
        value = next;
        i += 1;
      }
      if (value !== 'bearer') {
        return { error: `--auth must be "bearer" (got "${value}")` };
      }
      auth = value;
      continue;
    }

    if (arg === '--token' || arg.startsWith('--token=')) {
      const eq = arg.indexOf('=');
      let value: string;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (typeof next !== 'string' || next.length === 0) {
          return { error: '--token requires a value' };
        }
        value = next;
        i += 1;
      }
      token = value;
      continue;
    }

    rest.push(arg);
  }

  return {
    flags: {
      ...(auth !== undefined ? { auth } : {}),
      ...(token !== undefined ? { token } : {}),
    },
    rest,
  };
}

/**
 * Login-session callback shape. The caller injects the actual
 * implementation (`acquireLoginSessionToken` in `artifact-publish`,
 * which reads `~/.ggui/auth.json` + refreshes when expired).
 *
 * Returns the bearer token the CLI sends as `Authorization: Bearer <token>`.
 */
export type SessionTokenAcquirer = () => Promise<string>;

/**
 * Acquire the auth token to send to the registry. Routes:
 *
 *   - `flags.auth === 'bearer'` → use `flags.token` || `GGUI_REGISTRY_TOKEN`
 *   - otherwise → call `acquireSessionToken` (the stored `ggui login` session)
 *
 * Throws (with an operator-readable message) when bearer auth is
 * selected but no token is supplied; the message names the env var so
 * the operator can fix it without reading help.
 */
export async function acquireAuthToken(deps: {
  readonly flags: AuthFlags;
  readonly env: NodeJS.ProcessEnv;
  readonly acquireSessionToken: SessionTokenAcquirer;
}): Promise<string> {
  if (deps.flags.auth === 'bearer') {
    const fromFlag = deps.flags.token;
    const fromEnv = deps.env['GGUI_REGISTRY_TOKEN'];
    const token =
      typeof fromFlag === 'string' && fromFlag.length > 0
        ? fromFlag
        : typeof fromEnv === 'string' && fromEnv.length > 0
          ? fromEnv
          : undefined;
    if (token === undefined) {
      throw new Error(
        'bearer auth requires --token <value> or GGUI_REGISTRY_TOKEN',
      );
    }
    return token;
  }
  return deps.acquireSessionToken();
}
