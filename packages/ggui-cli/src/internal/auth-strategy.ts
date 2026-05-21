/**
 * Vendor-neutral auth strategy for marketplace CLI verbs
 * (`ggui {gadget,blueprint} publish`).
 *
 * Two strategies — explicit `--auth=bearer` for self-hosted and local
 * registries, and the (default) hosted-auth flow for the cloud
 * registry. The default flow is implemented behind a vendor-neutral
 * function name (`acquireHostedAuthJwt`) so this surface never names
 * any specific identity provider; the underlying implementation in
 * `artifact-publish` calls the cloud's hosted auth provider.
 *
 * The public surface (this file, its consumers, and the CLI help
 * text) stays vendor-neutral.
 *
 * @example
 * ```ts
 * import { parseAuthFlags, acquireAuthToken } from './internal/auth-strategy.js';
 *
 * const authFlags = parseAuthFlags(args);
 * const jwt = await acquireAuthToken({
 *   flags: authFlags,
 *   env: process.env,
 *   registryUrl,
 *   acquireHostedAuthJwt,
 * });
 * ```
 */

/**
 * Parsed `--auth=<mode>` + `--token <token>` flags. Vendor-neutral.
 *
 * `auth: undefined` means "use the default (hosted auth via the
 * registry)". The only public flag value is `'bearer'`.
 */
export interface AuthFlags {
  /** Auth mode. Only `'bearer'` is admitted as a public value; absent
   * means "default = hosted auth via the configured registry". */
  readonly auth?: 'bearer';
  /** Explicit bearer token. Used only when `auth === 'bearer'`. */
  readonly token?: string;
}

/**
 * Help-text fragment for the auth flags, inlined into each subcommand's
 * help block. Vendor-neutral copy — never name the identity provider.
 */
export const AUTH_HELP_FRAGMENT = `Auth:
  --auth=bearer        Use a bearer token (for self-hosted or local
                       registries). Pair with --token <token> or set
                       GGUI_REGISTRY_TOKEN in the environment.
  --token <token>      Bearer token (paired with --auth=bearer).
  (default)            Hosted auth via the configured registry —
                       no flag needed; the CLI prompts for credentials
                       on first publish and caches the resulting
                       session at ~/.ggui/auth/<registry-host>/token.json.
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
 * Hosted-auth callback shape. Vendor-neutral by design — the caller
 * injects the actual implementation (which today calls the cloud
 * registry's hosted auth vendor).
 *
 * Returns the bearer JWT the CLI sends as `Authorization: Bearer <jwt>`.
 */
export type HostedAuthAcquirer = (deps: {
  readonly registryUrl: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}) => Promise<string>;

/**
 * Acquire the auth token to send to the registry. Routes:
 *
 *   - `flags.auth === 'bearer'` → use `flags.token` || `GGUI_REGISTRY_TOKEN`
 *   - otherwise → call `acquireHostedAuthJwt`
 *
 * Throws (with an operator-readable message) when bearer auth is
 * selected but no token is supplied; the message names the env var so
 * the operator can fix it without reading help.
 */
export async function acquireAuthToken(deps: {
  readonly flags: AuthFlags;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly registryUrl: string;
  readonly acquireHostedAuthJwt: HostedAuthAcquirer;
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
  return deps.acquireHostedAuthJwt({
    registryUrl: deps.registryUrl,
    env: deps.env,
    cwd: deps.cwd,
  });
}
