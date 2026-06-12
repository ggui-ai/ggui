/**
 * `TunnelProvider` — narrow seam for managed-mode tunnel bootstrap.
 *
 * Design:
 *
 *   - `@ggui-ai/dev-stack` stays local-engine only. No tunnel code
 *     lives inside the dev-stack barrel. The CLI is the layer that
 *     decides whether to wrap a running dev-stack host in a managed
 *     tunnel.
 *   - `TunnelProvider` is intentionally the minimum interface a
 *     provider needs to satisfy. Future providers (Cloudflare
 *     tunnel, Guuey-managed auth-proxy tunnel, Tailscale funnel,
 *     ngrok-style forwarder) plug in behind this seam without
 *     touching dev-stack or the core `runDev` coordination logic.
 *   - The current scaffold ships a **null** provider that always
 *     returns `{ status: 'unavailable' }`. This proves the
 *     architecture end-to-end without shipping a public-tunnel
 *     story before remote authentication is resolved.
 *
 * Non-negotiable invariants:
 *
 *   1. `open()` MUST NOT throw for missing configuration. It returns
 *      `{ status: 'unavailable' }` so the CLI can print a clean
 *      status line and keep local dev running unchanged. Only
 *      genuinely exceptional failures (invariant violations in the
 *      provider itself) are allowed to throw.
 *   2. Providers do not own the decision to expose `/hub*` over the
 *      tunnel. `TunnelContext.authToken` is surfaced so providers
 *      CAN use it for bearer-authenticated upstream calls — but
 *      providers MUST NOT leak it into public tunnel responses.
 *      Remote hub exposure requires a separate auth layer
 *      (see plan doc §"Open: remote auth").
 *   3. `close()` on a ready session MUST be idempotent + safe to
 *      call after the underlying `AbortSignal` has fired.
 */

/**
 * Snapshot of the running local dev stack handed to a tunnel
 * provider. Readonly — the provider inspects and wraps, but cannot
 * reconfigure the local host.
 */
export interface TunnelContext {
  /**
   * Fully-qualified URL of the local dev-stack HTTP host, e.g.
   * `http://127.0.0.1:6780`. Never a wildcard bind or a path —
   * the CLI normalises before handing to the provider.
   */
  readonly localUrl: string;

  /**
   * Bearer token the dev-stack accepts for gated endpoints
   * (`/uis/*`, `/events`, `/runtime/*`). `null` when the server
   * was started without a security policy (tests).
   *
   * Providers MAY use this to make bearer-authenticated upstream
   * calls against the local host (e.g. to probe `/health` or
   * pre-fetch state during bootstrap). Providers MUST NOT pass
   * the bearer through to public tunnel clients — the bearer is
   * a per-run secret, not a user credential.
   */
  readonly authToken: string | null;

  /**
   * Project identity surfaced from `ggui.json`. Providers use
   * this as a stable handle when requesting a remote URL
   * ("open a tunnel for `weather-bot`"). Kept narrow on purpose;
   * richer metadata can be added later without a breaking change.
   */
  readonly project: {
    readonly slug: string;
    readonly name: string;
  };

  /**
   * Port the supervised agent runtime is bound on, when an `--agent`
   * was supplied AND the CLI orchestration asked the dev-stack to
   * wire a specific port (`DevOptions.runtimePort`). `null` when:
   *
   *   - no agent runtime was supplied (`--agent` absent), OR
   *   - the agent runtime was supplied but the CLI did not ask for a
   *     specific port (e.g. the user ran `ggui dev --agent …` without
   *     `--tunnel`).
   *
   * Bridge-style tunnel providers use this to construct a
   * `UrlProxy('http://127.0.0.1:<runtimePort>')` or equivalent for
   * forwarding inbound platform traffic to the local agent. Other
   * providers (forwarders that wrap `localUrl` end-to-end) MAY
   * ignore it.
   */
  readonly runtimePort: number | null;

  /**
   * Lifetime signal. Aborted when the CLI is shutting down the
   * dev stack (Ctrl-C, SIGTERM, server.close()). Providers that
   * maintain long-lived connections MUST wire this signal into
   * their underlying transport so the local server shutdown is
   * not blocked by a dangling tunnel socket.
   */
  readonly signal: AbortSignal;
}

/**
 * Discriminated result of `TunnelProvider.open(ctx)`.
 *
 *   - `ready`       → managed tunnel is up; remoteUrl is printable.
 *   - `unavailable` → provider correctly declined (missing
 *                     configuration, expired auth, offline), and
 *                     the CLI should fall back to local-only.
 *                     `reason` is user-facing; `hint` is an
 *                     optional actionable suggestion.
 */
export type TunnelSession = TunnelSessionReady | TunnelSessionUnavailable;

export interface TunnelSessionReady {
  readonly status: 'ready';
  /** Public-facing URL the developer can share. */
  readonly remoteUrl: string;
  /**
   * Shut down the tunnel session. Idempotent — calling twice (or
   * calling after `signal` fired) is a no-op. Resolves when the
   * underlying transport has released its resources.
   */
  close(): Promise<void>;
}

export interface TunnelSessionUnavailable {
  readonly status: 'unavailable';
  /**
   * One-line user-facing reason. Printed in the CLI banner, so
   * keep it short and concrete (e.g. `"not configured"`,
   * `"login expired"`, `"network unreachable"`).
   */
  readonly reason: string;
  /**
   * Optional follow-up action — typically a command the user can
   * run to unblock (`"run \`<your-cli> login\`"`). May be omitted
   * when the reason is self-evident.
   */
  readonly hint?: string;
}

/**
 * A single managed-mode tunnel implementation. Providers are
 * pluggable by construction — a CLI host picks one at boot time
 * (flag, env var, discovery) and hands it to the orchestrator.
 */
export interface TunnelProvider {
  /**
   * Human-readable provider name for banner / logs. Keep short
   * (`"null"`, `"cloudflare"`). Not used for any protocol dispatch
   * — display only.
   */
  readonly name: string;

  /**
   * Attempt to establish a managed tunnel for the running local
   * dev host. Non-throwing by contract — missing configuration is
   * `{ status: 'unavailable', reason, hint }`, not an exception.
   *
   * Providers respecting `ctx.signal` MAY return before the
   * tunnel is fully dialled if the signal fires during bootstrap.
   */
  open(ctx: TunnelContext): Promise<TunnelSession>;
}

/**
 * Reference "null" tunnel provider.
 *
 * Purpose:
 *
 *   - Proves the `TunnelProvider` seam works end-to-end (the CLI
 *     can construct one, wire it into `runDev` orchestration, and
 *     print the expected banner line).
 *   - Never makes a network call, never reads config files, never
 *     spawns a subprocess. Safe to run under any environment
 *     policy (CI, sandboxes, sandboxed CI, locked-down laptops).
 *   - Acts as the default when `ggui dev --tunnel` runs without a
 *     configured provider. The user sees an honest "no provider
 *     configured" line instead of a cryptic network error.
 *
 * An optional `reason` override lets tests pin a specific
 * status string without monkey-patching.
 */
export interface NullTunnelProviderOptions {
  /**
   * Override the default reason string. Useful for tests asserting
   * the banner reads the expected copy, or for hosts that want to
   * customise the "not configured" message without replacing the
   * provider.
   */
  readonly reason?: string;
  /** Optional hint shown alongside the reason. */
  readonly hint?: string;
}

export function createNullTunnelProvider(
  options: NullTunnelProviderOptions = {},
): TunnelProvider {
  const reason = options.reason ?? 'no tunnel provider configured';
  const hint = options.hint;
  return {
    name: 'null',
    async open(_ctx: TunnelContext): Promise<TunnelSession> {
      // Keep the context parameter so the interface is exercised;
      // the null provider ignores every field by design.
      void _ctx;
      const result: TunnelSessionUnavailable = hint
        ? { status: 'unavailable', reason, hint }
        : { status: 'unavailable', reason };
      return result;
    },
  };
}

/**
 * Contract a tunnel-provider plugin module must satisfy for dynamic
 * discovery. Point `GGUI_TUNNEL_PROVIDER` at a module specifier; the
 * module exports either a named `createTunnelProvider` factory or a
 * default export (factory or provider instance) — both shapes are
 * tried in that order. The factory takes no arguments today; if a
 * future revision needs options (project identity, login snapshot)
 * the contract version bumps with it.
 *
 * Kept as a module shape rather than a typed `require` because the
 * target module path is controlled by the user's env, not by the
 * open CLI's dependency graph. The discovery wrapper below validates
 * the shape at runtime and falls back cleanly on any mismatch.
 */
export interface TunnelProviderModule {
  /** Preferred shape. */
  readonly createTunnelProvider?: () => TunnelProvider | Promise<TunnelProvider>;
  /** Alternate shape — default export returning the provider. */
  readonly default?: TunnelProvider | (() => TunnelProvider | Promise<TunnelProvider>);
}

/**
 * Options for the provider-discovery helper. `resolve` is a test
 * seam that stands in for `import()` — production callers pass no
 * options and the helper uses the real dynamic import.
 */
export interface DiscoverTunnelProviderOptions {
  /**
   * Module specifier to attempt. Default: `process.env.GGUI_TUNNEL_PROVIDER`.
   * When unset / empty, no discovery is attempted and the caller
   * falls back to the null provider with reason "no provider
   * configured".
   */
  readonly moduleSpecifier?: string | null;
  /**
   * Test seam — receives the module specifier and returns the
   * imported module (or throws to simulate a failed import).
   * Production callers leave this undefined; the helper then uses
   * the real dynamic `import()`.
   */
  readonly resolve?: (specifier: string) => Promise<unknown>;
}

/**
 * Discriminated result of `discoverTunnelProvider`.
 *
 *   - `found` → the module path resolved AND its factory produced a
 *               provider. The CLI uses `provider` directly.
 *   - `none`  → no module specifier set; expected for OSS users who
 *               haven't installed a private provider. Caller falls
 *               back to the null provider with a specific reason.
 *   - `error` → a specifier was configured but loading / instantiating
 *               failed. Caller falls back to the null provider with
 *               the failure reason surfaced so the user can act
 *               (fix path, reinstall, etc.).
 */
export type TunnelProviderDiscovery =
  | { readonly kind: 'found'; readonly provider: TunnelProvider; readonly moduleSpecifier: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'error'; readonly moduleSpecifier: string; readonly reason: string };

/**
 * Attempt to load a `TunnelProvider` from an external module whose
 * path is given by `process.env.GGUI_TUNNEL_PROVIDER` (or the
 * `moduleSpecifier` override).
 *
 * Discovery mechanics:
 *
 *   1. If no specifier is configured → `{ kind: 'none' }`. The
 *      caller prints "no tunnel provider configured" and uses the
 *      null provider.
 *   2. Dynamic-import the specifier. On any thrown error →
 *      `{ kind: 'error', reason }` — caller prints the reason.
 *   3. Read `module.createTunnelProvider` first, then `module.default`.
 *      Both may be factory functions or (for `default` only) an
 *      already-built provider object. Anything else → `error`.
 *   4. Invoke the factory (if callable). If it throws → `error`.
 *   5. Validate the returned value has `.name: string` + `.open`
 *      callable. If not → `error`.
 *   6. Success → `{ kind: 'found', provider, moduleSpecifier }`.
 *
 * Never throws. The null-provider fallback is the single recovery
 * path across every failure mode.
 */
export async function discoverTunnelProvider(
  options: DiscoverTunnelProviderOptions = {},
): Promise<TunnelProviderDiscovery> {
  const specifier =
    options.moduleSpecifier !== undefined
      ? options.moduleSpecifier
      : process.env.GGUI_TUNNEL_PROVIDER ?? null;

  if (!specifier || specifier.length === 0) {
    return { kind: 'none' };
  }

  const resolve = options.resolve ?? ((s: string) => import(s));

  let mod: unknown;
  try {
    mod = await resolve(specifier);
  } catch (err) {
    return {
      kind: 'error',
      moduleSpecifier: specifier,
      reason: `failed to import "${specifier}": ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (mod === null || typeof mod !== 'object') {
    return {
      kind: 'error',
      moduleSpecifier: specifier,
      reason: `module "${specifier}" did not export an object`,
    };
  }

  const typed = mod as TunnelProviderModule;
  const factory =
    typed.createTunnelProvider ??
    (typeof typed.default === 'function' ? typed.default : null);
  const preBuilt =
    typed.createTunnelProvider === undefined && typeof typed.default === 'object' && typed.default !== null
      ? typed.default
      : null;

  let provider: TunnelProvider;
  try {
    if (preBuilt) {
      provider = preBuilt;
    } else if (factory) {
      const maybeProvider = await factory();
      provider = maybeProvider;
    } else {
      return {
        kind: 'error',
        moduleSpecifier: specifier,
        reason: `module "${specifier}" exports neither \`createTunnelProvider\` nor a default export`,
      };
    }
  } catch (err) {
    return {
      kind: 'error',
      moduleSpecifier: specifier,
      reason: `provider factory in "${specifier}" threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (
    !provider ||
    typeof provider !== 'object' ||
    typeof (provider as TunnelProvider).name !== 'string' ||
    typeof (provider as TunnelProvider).open !== 'function'
  ) {
    return {
      kind: 'error',
      moduleSpecifier: specifier,
      reason: `module "${specifier}" returned a value that is not a TunnelProvider`,
    };
  }

  return { kind: 'found', provider, moduleSpecifier: specifier };
}
