/**
 * `ggui serve` argument parsing, banner rendering, and lifecycle
 * driver.
 *
 * Runs the open self-hosted personal-mode path from `@ggui-ai/mcp-server`
 * + an optional supervised agent. Default (no flags, with a valid
 * `ggui.json` + `agent.entry`) is MCP + agent side by side. Opt-down
 * is `--mcp-only`. Missing-or-incomplete config falls back to
 * MCP-only with a warning; broken config is a `cli.ts`-level error
 * surfaced separately.
 *
 * Deliberately distinct from `ggui dev`:
 *
 *   - `ggui dev`   — local dev loop: registry + hub + runtime supervision
 *                   + preview + (optional) tunnel. Developer-facing.
 *   - `ggui serve` — personal-mode self-hosted runtime: MCP server +
 *                    optional supervised agent. Operator-facing.
 *
 * Keep these separate. The only shared code between them is pure
 * agent-entry resolution (`./agent-resolution.ts`) — no dev-loop
 * concerns leak into serve.
 *
 * This module stays pure / testable — no `node:http` binds, no
 * `createGguiServer()` import, no logger dep. `cli.ts` composes this
 * logic with the real server package, agent adapter, and logger.
 */
import type {
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentRuntimeHandle,
  AgentRuntimeStartInput,
} from '@ggui-ai/agent-runtime';
import type { PairingService } from '@ggui-ai/mcp-server';
import { launchBrowser } from './dev-command.js';

/**
 * Default bind port. Distinct from `ggui dev`'s 6780 so both can run
 * simultaneously without colliding. Not a registered port; chosen for
 * memorability + non-collision with the dev hub.
 */
export const DEFAULT_SERVE_PORT = 6781;

/** Default bind host. Loopback only — matches `ggui dev`. */
export const DEFAULT_SERVE_HOST = '127.0.0.1';

export interface ParsedServeFlags {
  /** Port to bind. Defaults to {@link DEFAULT_SERVE_PORT}. `0` = OS-assigned. */
  port: number;
  /** Host to bind. Defaults to {@link DEFAULT_SERVE_HOST}. */
  host: string;
  /**
   * When true, boot MCP server only — skip agent supervision even
   * if `ggui.json` has `agent.entry`. Operator opt-down per the
   * §10.2a lock.
   */
  mcpOnly: boolean;
  /**
   * When true, switch the in-memory auth adapter to `devAllowAll: true`
   * — every non-empty bearer (including the no-bearer probe MCP custom
   * connectors send) authenticates as builder. Strictly a local-dev /
   * tunnel-smoke escape hatch; production uses pairing or a custom
   * `AuthAdapter`.
   *
   * NEVER expose a `--dev-allow-all` server to the open internet
   * outside an ephemeral tunnel — the banner prints an unmissable
   * warning when this flag is set.
   */
  devAllowAll: boolean;
  /**
   * Override the public base URL used to compose `mcpApps.wsUrl`
   * and `runtime.url`. Without this, the URLs derive from
   * `--host:--port`, which only resolves from the same machine.
   * Set to a tunnel URL (`https://<random>.trycloudflare.com`) when
   * testing against a remote MCP host so the iframe-runtime + live
   * channel resolve from the host's perspective.
   *
   * Trailing slash is stripped on parse. Must include scheme
   * (`http://` or `https://`); the `wsUrl` is derived by replacing the
   * scheme with `ws`/`wss`.
   */
  publicBaseUrl?: string;
  /**
   * When true, auto-spawn a cloudflared quick-tunnel pointed at the
   * local listen port and treat the assigned URL as
   * {@link publicBaseUrl}. Mutually exclusive with `--public-base-url`
   * (operator gets EITHER explicit URL OR auto-tunnel).
   *
   * `--public + --dev-allow-all` combination is rejected at parse
   * time unless `--i-know-its-public` is also set — exposing
   * any-bearer auth to the open internet via cloudflared takes a
   * deliberate flag.
   */
  publicAutoTunnel?: boolean;
  /** Acknowledgement flag — see {@link publicAutoTunnel}. */
  iKnowItsPublic?: boolean;
  /**
   * Mount the OAuth 2.1 + PKCE + Dynamic Client Registration routes
   * required by MCP custom-connector hosts (claude.ai, ChatGPT) whose
   * "Add connector" form has no field for a pre-shared bearer token.
   *
   * Flow when on:
   *   1. Host hits `/mcp` without auth → 401 + WWW-Authenticate
   *      pointing at `/.well-known/oauth-protected-resource`.
   *   2. Host fetches discovery → finds `/oauth/authorize` +
   *      `/oauth/token` + `/oauth/register`.
   *   3. Host registers a client via DCR (no pre-shared secrets) +
   *      redirects user-agent to `/oauth/authorize`.
   *   4. Server renders a paste-key page; operator pastes the
   *      paired bearer (from the landing page or `POST /pair`).
   *   5. Server validates against the active `AuthAdapter`, mints
   *      an authorization code, redirects back with `?code=...`.
   *   6. Host exchanges code → access_token (= the paired bearer).
   *   7. Subsequent `/mcp` calls authenticate normally.
   *
   * Without `--oauth`, OAuth-discovery clients bail with "couldn't
   * reach MCP server" because the .well-known endpoints 404. Pure-
   * bearer clients (Claude Desktop with bearer in config, console,
   * etc.) keep working without it.
   */
  oauth: boolean;
  /**
   * When true, run a public-facing demo: every non-empty bearer
   * authenticates as builder (same auth shape as {@link devAllowAll})
   * but with three differences:
   *
   *   1. Banner copy is "PUBLIC DEMO" with a "operator pays for the
   *      LLM" cost note, instead of the "DEV ALLOW-ALL" warning.
   *   2. A per-remote-IP `FixedWindowRateLimiter` is bound to the
   *      `ggui_render` handler so a single visitor can't burn the
   *      operator's budget. Default: 30 render calls per 10 minutes per IP.
   *   3. The pair-code beacon is suppressed (same as devAllowAll —
   *      pair codes are meaningless under any-bearer-auth).
   *
   * Mutually exclusive with {@link devAllowAll}: both relax /mcp auth
   * the same way, but they describe different operator intents and
   * surface different banner copy. Using both at once is rejected at
   * parse time so the banner stays truthful.
   *
   * Use case: a developer hosting a small ggui demo for an audience
   * (Show HN, blog post, classroom) where unauthenticated end-users
   * should be able to interact, paid for by the operator's single
   * shared LLM key in `~/.ggui/credentials.json`.
   */
  publicDemo: boolean;
  /**
   * Multi-tenant posture. Switches the `/ggui/console/llm-keys` gate
   * from admin-token to auth-adapter — each authenticated end-user
   * manages their OWN provider keys (scope = `userId` for `kind:'user'`
   * identities, `appId` for `kind:'app'`). `kind:'builder'` identities
   * are rejected at the gate.
   *
   * Strict-auth shape — every bearer must clear the `AuthAdapter`.
   * Mutually exclusive with {@link devAllowAll} and {@link publicDemo};
   * those modes collapse every identity to `kind:'builder'` which the
   * multi-tenant gate rejects, so the combination would produce a
   * server that's wired multi-tenant but can't authenticate anyone.
   *
   * Use case: a single `ggui serve` instance fronting many users (a
   * shared dev box, a small team server) where each user pastes their
   * own LLM key via /settings using their paired bearer.
   */
  multiTenant: boolean;
  /**
   * Server-level MCP instructions preset (the string injected into
   * the LLM's system prompt above the tool catalog). Operator-tunable
   * advisory level for tool-use posture:
   *
   *   - `default`    — gentle "ggui first when UI fits, prose otherwise"
   *   - `aggressive` — render anything with structure (no-preset default)
   *   - `always`     — every response renders via ggui_render
   *   - `minimal`    — server identity only, no behavioral nudge
   *   - `off`        — omit the field entirely
   *
   * Surface = `--mcp-instructions <preset>` or
   * `GGUI_MCP_INSTRUCTIONS=<preset>` env var (CLI flag wins).
   * Custom strings can only be passed via programmatic embed
   * (`createGguiServer({mcpInstructions: '...'})`).
   */
  mcpInstructions?: 'default' | 'aggressive' | 'always' | 'minimal' | 'off';
  /**
   * Skip auto-opening the operator's browser at the base URL after
   * boot. Without this flag, `ggui serve` opens the local HTTP URL
   * after the banner — server-side redirect routes first-run
   * operators (no LLM creds) to the admin onboarding flow. Auto-open
   * is also skipped for `--mcp-only` (no UI surface) and non-TTY
   * sessions (CI, supervised, piped output).
   *
   * Surface = `--no-open` flag.
   */
  noOpen?: boolean;
  /**
   * Path to a JSON file backing the pairing service. When set, paired
   * bearers survive a server restart — claude.ai stays connected
   * across `ggui serve` runs.
   *
   * Stored in plaintext at the path with `0600` perms; assume the
   * file lives on operator-controlled disk (e.g. `~/.ggui/keys.json`).
   *
   * Surface = `--keys-file <path>`.
   */
  keysFile?: string;
  /**
   * Disable the cross-restart persistence bundle. Without this flag,
   * `ggui serve` reads or mints the HMAC secrets (and, in later
   * slices, RenderStore + ShortCodeIndex + VectorStore + paired
   * bearers) under `getPersistentDir(projectRoot)` so a server
   * restart doesn't invalidate cached `_meta["ai.ggui/render"].wsToken`
   * envelopes — claude.ai chat-history revisits keep working.
   *
   * With `--ephemeral`, every restart mints fresh HMAC secrets (the
   * legacy behavior). Use for tests / CI loops that don't want files
   * written under `~/.ggui/` or the project root, and for incident-
   * response nuclear-revoke scenarios.
   *
   * Surface = `--ephemeral`.
   */
  ephemeral?: boolean;
  /**
   * Operator-pinned admin bearer for the console `/keys` gate. Absent
   * = the server mints a fresh `ggui_admin_*` per boot. Pin a value
   * here when the operator wants the bearer to survive restarts (e.g.
   * the same value lives in a password manager + an MCP-host config).
   *
   * Surface = `--admin-token <token>`.
   */
  adminToken?: string;
  /**
   * Paths to read-only shared blueprint pool directories. Each entry
   * was supplied via a `--seed-pool <dir>` flag (repeatable). At boot,
   * each path is loaded as a `FileSystemBlueprintSource` and passed to
   * `buildSeedPool` so its blueprints are available for exact-contract
   * reuse behind the operator's own discovered set.
   *
   * Defaults to `[]` (no shared pools). Shared pools are checked
   * AFTER the operator's own blueprints — local declarations always win.
   *
   * Surface = `--seed-pool <dir>` (repeatable).
   */
  seedPools: string[];
  /** Populated when parsing failed; caller renders + bails with exit code 1. */
  error?: string;
}

/**
 * Parse the raw `ggui serve` argv tail. Returns a discriminated
 * shape — `error` field is non-undefined on malformed input.
 *
 * Flag surface per the §10.2a lock:
 *   - `--port <n>` / `--host <addr>`: bind target.
 *   - `--mcp-only`: opt-down to MCP-only.
 *   - `--all`: REJECTED with a pointer to the real default. See doc lock.
 *   - `--help` / `-h`: help sentinel.
 */
export function parseServeFlags(args: readonly string[]): ParsedServeFlags {
  const out: ParsedServeFlags = {
    port: DEFAULT_SERVE_PORT,
    host: DEFAULT_SERVE_HOST,
    mcpOnly: false,
    devAllowAll: false,
    publicDemo: false,
    multiTenant: false,
    oauth: false,
    seedPools: [],
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port') {
      const v = args[++i];
      if (v === undefined) {
        return { ...out, error: '--port requires a value' };
      }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 65535) {
        return {
          ...out,
          error: `--port must be an integer in [0, 65535], got "${v}"`,
        };
      }
      out.port = n;
      continue;
    }
    if (arg === '--host') {
      const v = args[++i];
      if (v === undefined || v === '') {
        return { ...out, error: '--host requires a value' };
      }
      out.host = v;
      continue;
    }
    if (arg === '--mcp-only') {
      out.mcpOnly = true;
      continue;
    }
    if (arg === '--dev-allow-all') {
      out.devAllowAll = true;
      continue;
    }
    if (arg === '--public-demo') {
      out.publicDemo = true;
      continue;
    }
    if (arg === '--multi-tenant') {
      out.multiTenant = true;
      continue;
    }
    if (arg === '--oauth') {
      out.oauth = true;
      continue;
    }
    if (arg === '--public-base-url') {
      const v = args[++i];
      if (v === undefined || v === '') {
        return { ...out, error: '--public-base-url requires a value' };
      }
      if (!/^https?:\/\//.test(v)) {
        return {
          ...out,
          error: `--public-base-url must start with http:// or https://, got "${v}"`,
        };
      }
      // Strip trailing slash so callers don't have to think about
      // `${baseUrl}/s/` vs `${baseUrl}//s/` — both are common typos.
      out.publicBaseUrl = v.replace(/\/+$/, '');
      continue;
    }
    if (arg === '--public') {
      out.publicAutoTunnel = true;
      continue;
    }
    if (arg === '--i-know-its-public') {
      out.iKnowItsPublic = true;
      continue;
    }
    if (arg === '--no-open') {
      out.noOpen = true;
      continue;
    }
    if (arg === '--mcp-instructions') {
      const v = args[++i];
      if (v === undefined || v === '') {
        return { ...out, error: '--mcp-instructions requires a value' };
      }
      if (
        v !== 'default' &&
        v !== 'aggressive' &&
        v !== 'always' &&
        v !== 'minimal' &&
        v !== 'off'
      ) {
        return {
          ...out,
          error: `--mcp-instructions must be one of [default, aggressive, always, minimal, off], got "${v}"`,
        };
      }
      out.mcpInstructions = v;
      continue;
    }
    if (arg === '--keys-file') {
      const v = args[++i];
      if (v === undefined || v === '') {
        return { ...out, error: '--keys-file requires a value' };
      }
      out.keysFile = v;
      continue;
    }
    if (arg === '--admin-token') {
      const v = args[++i];
      if (v === undefined || v === '') {
        return { ...out, error: '--admin-token requires a value' };
      }
      out.adminToken = v;
      continue;
    }
    if (arg === '--ephemeral') {
      out.ephemeral = true;
      continue;
    }
    if (arg === '--seed-pool') {
      const value = args[++i];
      if (value === undefined) return { ...out, error: '--seed-pool requires a path' };
      out.seedPools.push(value);
      continue;
    }
    if (arg === '--all') {
      // §10.2a lock: --all is NOT a first-class flag. The default
      // already runs everything. Reject with a pointer so users
      // learn the real mental model in one interaction.
      return {
        ...out,
        error:
          '--all is not a flag. The default already runs everything (MCP + agent). ' +
          'Use --mcp-only to run just the MCP server.',
      };
    }
    if (arg === '--help' || arg === '-h') {
      return { ...out, error: '__help__' };
    }
    return { ...out, error: `unknown option "${arg ?? ''}"` };
  }
  if (out.devAllowAll && out.publicDemo) {
    return {
      ...out,
      error:
        '--dev-allow-all and --public-demo are mutually exclusive. ' +
        '--dev-allow-all is for local-only development (no rate limit, ' +
        '"DEV ALLOW-ALL" warning); --public-demo is for an operator-paid ' +
        'public demo (rate-limited, "PUBLIC DEMO" copy). Pick one.',
    };
  }
  if (out.multiTenant && (out.devAllowAll || out.publicDemo)) {
    return {
      ...out,
      error:
        '--multi-tenant is incompatible with --dev-allow-all and --public-demo. ' +
        'Multi-tenant requires real per-user identities (kind:"user" / kind:"app"); ' +
        'the any-bearer modes collapse every caller to kind:"builder" which the ' +
        'multi-tenant gate rejects. Drop the other flag and pair with real bearers.',
    };
  }
  if (out.publicAutoTunnel && out.publicBaseUrl !== undefined) {
    return {
      ...out,
      error:
        '--public and --public-base-url are mutually exclusive. ' +
        '--public auto-spawns a cloudflared quick-tunnel and sets the URL; ' +
        '--public-base-url pins an explicit URL. Pick one.',
    };
  }
  if (out.publicAutoTunnel && out.devAllowAll && !out.iKnowItsPublic) {
    return {
      ...out,
      error:
        '--public + --dev-allow-all exposes any-bearer auth to the open ' +
        'internet via cloudflared. Add --i-know-its-public to acknowledge ' +
        'this, or pair real bearers and drop --dev-allow-all.',
    };
  }
  return out;
}

/**
 * Resolved agent-component status for the banner + lifecycle. The
 * CLI layer computes this from (flags, ggui.json state, resolution
 * result) before calling {@link runServe}.
 */
export type AgentStatus =
  | {
      readonly kind: 'running';
      /** Display-friendly entry path (relative to cwd is fine). */
      readonly entry: string;
      /** `js` → plain node; `ts` → node --import=tsx. */
      readonly language: 'js' | 'ts';
    }
  | {
      readonly kind: 'disabled';
      readonly reason: AgentDisabledReason;
    };

export type AgentDisabledReason =
  | '--mcp-only'
  | 'no ggui.json'
  | 'ggui.json has no agent.entry';

/**
 * Shape the banner a `ggui serve` run prints AFTER the server is
 * listening. Pure so tests can pin the exact copy.
 *
 * Honest about scope — the CLI now wires strict auth (any bearer that
 * isn't pair-minted is rejected) and pre-mints an initial pair code
 * via the `pairCode` field so the operator's first-run flow has a
 * concrete starting point. The blueprint-read handler family is still
 * what ships today; `pairCode` is optional for backward-compat with
 * embedding hosts that opt out of pairing.
 */
export interface ServeBannerInputs {
  /** The actual bound port. May differ from requested when `--port 0`. */
  readonly port: number;
  /** The actual bound host. */
  readonly host: string;
  /** Number of registered MCP tools. */
  readonly toolCount: number;
  /** Server name echoed in `info`. */
  readonly serverName: string;
  /** Server version echoed in `info`. */
  readonly serverVersion: string;
  /** Agent component status at banner time. */
  readonly agent: AgentStatus;
  /**
   * Pre-minted initial pairing code, when the backend has pairing
   * wired. `undefined` when pairing is disabled (future embedding
   * hosts). Always present for `ggui serve` runs today.
   */
  readonly pairCode?: string;
  /**
   * Unix-millis expiry of {@link pairCode}. Present iff `pairCode`
   * is present.
   */
  readonly pairCodeExpiresAt?: number;
  /**
   * When true, the auth section becomes a "DEV ALLOW-ALL" warning
   * instead of the strict-auth blurb. Set by `--dev-allow-all`.
   */
  readonly devAllowAll?: boolean;
  /**
   * When true, the auth section becomes a "PUBLIC DEMO" warning with
   * a cost-attribution + rate-limit note instead of the strict-auth
   * blurb. Set by `--public-demo`. Mutually exclusive with
   * `devAllowAll` at parse time; the banner asserts the same shape.
   */
  readonly publicDemo?: boolean;
  /**
   * When true, the auth section adds a "MULTI-TENANT" line below the
   * strict-auth blurb explaining that each user manages their own LLM
   * keys via /settings under their paired bearer. Set by
   * `--multi-tenant`. Mutually exclusive with `devAllowAll` and
   * `publicDemo` at parse time.
   */
  readonly multiTenant?: boolean;
  /**
   * Public base URL displayed under the local URLs when set via
   * `--public-base-url`. Reminds the operator which URL their tunnel
   * is forwarding to without grepping the agent-emitted shortCode
   * URLs.
   */
  readonly publicBaseUrl?: string;
  /**
   * When true, the auth section advertises OAuth discovery so the
   * operator can see at a glance that custom-connector hosts will
   * be able to complete the auth dance. Absent → no extra line.
   */
  readonly oauth?: boolean;
  /**
   * Admin token printed prominently in the banner so operators can
   * paste it into the console `/admin-login` page. Absent → no line
   * (e.g. an embedded host with no console wired).
   */
  readonly adminToken?: string;
  /**
   * When true, the banner adds an action line pointing the operator at
   * the console `/settings` page so they can paste an LLM key without
   * touching env vars or restarting. Set when `describeGenerationBinding`
   * returned null (no env var + no credentials-file entry).
   */
  readonly noLlmKey?: boolean;
  /**
   * Embedding model id surfaced for the local RAG layer. When set,
   * the banner shows a `rag` line so operators see which model is
   * wired (and that bge-small downloads lazily on first render). Absent
   * when no embedding is wired (e.g. tests, programmatic embeds that
   * fall back to MockEmbeddingProvider).
   */
  readonly embeddingModel?: string;
}

export function describeServeBanner(input: ServeBannerInputs): string[] {
  const httpUrl = `http://${input.host}:${input.port}`;
  const lines: string[] = [
    '',
    `  ${input.serverName} v${input.serverVersion} — community edition · open self-hosted personal-mode`,
    '',
    // Operator-facing URL goes first — it's the "open a browser here"
    // signal that closes the first-run story. Landing page lives at `/`
    // by default when `ggui serve` is the entry point (see
    // `cli.ts::buildMcpServerBackend`).
    `  open      →  ${httpUrl}/`,
    `  mcp       →  ${httpUrl}/mcp`,
    `  health    →  ${httpUrl}/ggui/health`,
    `  tools     →  ${input.toolCount} registered`,
    `  agent     →  ${describeAgentStatus(input.agent)}`,
    ...(input.embeddingModel
      ? [`  rag       →  ${input.embeddingModel} (cached at ~/.ggui/models/)`]
      : []),
  ];
  if (input.publicBaseUrl) {
    lines.push(`  public    →  ${input.publicBaseUrl}/`);
  }
  if (input.pairCode && !input.devAllowAll && !input.publicDemo) {
    // Pair code is meaningless under any-bearer-auth modes (every
    // bearer already authenticates); skip it to keep the banner
    // truthful. Visual + machine-readable pairing affordance. The
    // machine-readable `PAIR_CODE <code>` line is emitted separately
    // by `runServe` before the banner; this line is operator-facing.
    lines.push(`  pair code →  ${input.pairCode}   (valid ~10m)`);
  }
  if (input.adminToken) {
    // Admin token gates the console `/keys` plane (list / mint /
    // revoke). Operator pastes it into the `/admin-login` page on
    // first visit. Printed in the same column as the pair-code so
    // both bearers are obvious in the boot banner.
    lines.push(
      `  admin token →  ${input.adminToken}   (console /keys gate — paste at /admin-login)`,
    );
  }
  if (input.noLlmKey) {
    // First-run nudge — without an LLM key, ggui_render falls back to
    // the Connect-Claude card and the iframe never bootstraps. Surface
    // the /settings URL alongside admin-token so the operator can paste
    // a key without restarting (the file store is hot-read on every
    // generation; setting through /settings takes effect immediately).
    const settingsUrl = input.publicBaseUrl
      ? `${input.publicBaseUrl}/settings`
      : `${httpUrl}/settings`;
    lines.push(
      `  ⚠ no LLM key configured. paste one at ${settingsUrl}`,
      `        (admin-gated — use the admin token above) or export`,
      `        ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY /`,
      `        OPENROUTER_API_KEY before re-running.`,
    );
  }
  lines.push('');
  if (input.devAllowAll) {
    // Loud warning — `--dev-allow-all` accepts any bearer (including
    // the no-bearer probe MCP custom connectors send) as builder.
    // Operators should never expose this surface to the open internet
    // outside an ephemeral tunnel for connector smoke testing.
    lines.push(
      `  ⚠ DEV ALLOW-ALL: every bearer authenticates as builder.`,
      `        For local dev / tunnel smoke ONLY. Never expose to the open`,
      `        internet. Drop --dev-allow-all to switch back to strict auth.`,
    );
  } else if (input.publicDemo) {
    // Distinct from --dev-allow-all: public-demo is a deliberate
    // operator posture, not an escape hatch. Surfaces (a) cost
    // attribution (the operator's BYOK funds every visitor's
    // generations) and (b) the rate-limit ceiling so the operator
    // remembers what protection is in place if the demo blows up.
    lines.push(
      `  ⚠ PUBLIC DEMO: every bearer authenticates as builder.`,
      `        End-user generations bill the operator's LLM key in`,
      `        ~/.ggui/credentials.json. Per-IP rate limit on ggui_render`,
      `        bounds abuse. Drop --public-demo for strict auth.`,
    );
  } else {
    lines.push(
      `  auth: strict — only pair-minted bearer tokens authenticate /mcp.`,
      `        Pair via the code above (landing page or \`POST /pair\`).`,
      `        Override the adapter via GguiServer({ auth }) in code for`,
      `        custom deployments (OIDC, Cognito, etc.).`,
    );
    if (input.multiTenant) {
      lines.push(
        ``,
        `  multi-tenant: each authenticated user manages their OWN LLM`,
        `        keys at /settings — the gate uses the request's bearer`,
        `        (Authorization: Bearer their-paired-token), NOT the`,
        `        admin token. Per-user scope is auto-derived from the`,
        `        identity (userId / appId).`,
        `        Note: ggui_render generation still resolves BYOK at the`,
        `        operator scope (env + credentials-file 'global'). Per-`,
        `        user generation-time BYOK is a follow-up — for now,`,
        `        multi-tenant lets each user MANAGE their key plane`,
        `        without granting them the operator's admin token.`,
      );
    }
    if (input.oauth) {
      lines.push(
        ``,
        `  oauth: enabled — MCP custom-connector hosts (claude.ai etc.)`,
        `         can discover via /.well-known/oauth-* and complete the`,
        `         auth dance against /oauth/{authorize,token,register}.`,
        `         Paste the paired bearer on the consent page.`,
      );
    }
  }
  lines.push('', `  Ctrl-C to stop.`, '');
  return lines;
}

/**
 * Banner cell for the `agent` line. Pure — tests pin the copy.
 */
export function describeAgentStatus(status: AgentStatus): string {
  if (status.kind === 'running') {
    const runner = status.language === 'ts' ? 'node --import=tsx' : 'node';
    return `${status.entry} (${runner}) — running`;
  }
  switch (status.reason) {
    case '--mcp-only':
      return `disabled (--mcp-only)`;
    case 'no ggui.json':
      return `disabled (no ggui.json)`;
    case 'ggui.json has no agent.entry':
      return `disabled (ggui.json has no agent.entry)`;
  }
}

/**
 * Minimal shape the CLI runner needs back from `@ggui-ai/mcp-server`.
 * The real factory returns more (the Express app, plus lifecycle
 * plumbing); we narrow here so tests can substitute without
 * conjuring an `Express` instance or pulling node:http types into
 * the pure module.
 */
export interface ServeBackend {
  /** Bind and accept connections. Resolves to the bound port. */
  listen(port: number, host: string): Promise<number>;
  /** Close all connections. Idempotent. */
  close(): Promise<void>;
  /** Number of MCP tools registered on this server. */
  readonly toolCount: number;
  /** Server name echoed in `info`. */
  readonly serverName: string;
  /** Server version echoed in `info`. */
  readonly serverVersion: string;
  /**
   * Count of primitive catalogs the backend composed from
   * `ggui.json#primitives.{packages,local}`. Surfaced narrow (count
   * only, not the catalog shape) so the test narrowing stays tight
   * — integration tests that need the full shape compose
   * `createGguiServer` directly.
   */
  readonly primitiveCatalogCount: number;
  /**
   * Which theme source backs `server.theme` — `'default'` when the
   * CLI passed nothing (server fell back to the shipped
   * `@ggui-ai/design` lightTheme), `'file'` when the operator's
   * `ggui.json#theme = { file: ... }` resolved cleanly, `'preset'`
   * when the operator selected one of the registered DTCG presets
   * (`ggui.json#theme = "claudic"` shorthand or
   * `{ preset: 'claudic', mode: 'dark', overrides: {...} }`). Tests
   * use this to prove the thread-through without reaching into the
   * `GguiServer` shape.
   */
  readonly themeSource: 'default' | 'file' | 'preset';
  /**
   * Composed pairing service, or `null` when the backend was built
   * without pairing. `ggui serve`'s default bundle always wires
   * pairing on; this field is nullable to keep the `ServeBackend`
   * contract truthful for future embedding hosts that opt out.
   *
   * `runServe` uses this to pre-mint an initial pair code after bind
   * (so a fresh operator's first-run flow doesn't need a pre-existing
   * bearer to trigger `/admin/pair/init`). Tests substitute `null` to
   * exercise the "no pre-mint" branch.
   */
  readonly pairingService: PairingService | null;
  /**
   * Admin bearer that gates the console `/keys` plane (mint / list /
   * revoke + admin-login). Either the operator-supplied value (via
   * `--admin-token`) or a fresh `ggui_admin_*` minted on boot when
   * that flag is absent. `null` when the backend has no console wired
   * — the CLI bundle always does, so this is non-null in practice.
   *
   * Surfaced narrow on the `ServeBackend` contract so `runServe` can
   * banner-print it next to PAIR_CODE without reaching into the
   * `GguiServer` shape.
   */
  readonly adminToken: string | null;
  /**
   * Embedding model id for the local RAG layer. Set when the backend
   * wired `createLocalEmbeddingProvider` (CLI default — bge-small-en-
   * v1.5). Absent when the backend fell back to `MockEmbeddingProvider`
   * (programmatic embeds / test paths). Used by `describeServeBanner`
   * to surface the RAG model in the boot banner so operators see
   * what's wired.
   */
  readonly embeddingModel?: string;
}

/**
 * Factory that constructs the backend. Injectable so tests can
 * provide a deterministic fake without booting a real HTTP server.
 * Production wiring in `cli.ts` passes a factory that composes
 * `@ggui-ai/mcp-server`'s `createGguiServer` + the package's `info`.
 */
export type ServeBackendFactory = () => ServeBackend;

/**
 * Supervised-agent plumbing. Only populated when `runServe` has been
 * asked to run the agent (i.e. `status.kind === 'running'`). `cli.ts`
 * assembles this from `./agent-resolution.ts` + the loaded `ggui.json`.
 */
export interface ServeAgentSupervision {
  readonly adapter: AgentRuntimeAdapter;
  readonly startInput: AgentRuntimeStartInput;
  /**
   * Event sink — called for every `AgentRuntimeEvent` emitted by the
   * adapter between start and stop. Production wires a logger;
   * tests use a collector. Optional: omitting it silently discards
   * the event stream (still valid for tests that only care about
   * lifecycle, not logs).
   */
  readonly onEvent?: (event: AgentRuntimeEvent) => void;
}

/**
 * Shape of the "await until shutdown" signal. Production uses an
 * in-process SIGINT/SIGTERM listener; tests pass a manual AbortSignal
 * to trigger a graceful close without raising real signals.
 */
export interface ServeShutdownSignal {
  readonly aborted: boolean;
  addEventListener(
    event: 'abort',
    handler: () => void,
    opts?: { once?: boolean },
  ): void;
}

export interface RunServeOptions {
  /**
   * Parsed flags. The `error` field must already be handled upstream.
   * `seedPools` is omitted too — it's parse output the CLI consumes to
   * build the shared `BlueprintPool[]` (fed straight into the backend
   * factory), NOT a `runServe` lifecycle input.
   */
  readonly flags: Readonly<Omit<ParsedServeFlags, 'error' | 'seedPools'>>;
  /** Build the backend. Called once, after flag parsing. */
  readonly backendFactory: ServeBackendFactory;
  /**
   * Agent supervision plumbing. Populated iff `agentStatus.kind ===
   * 'running'`. When undefined, `runServe` skips supervision entirely.
   */
  readonly agent?: ServeAgentSupervision;
  /** Pre-resolved banner status — `cli.ts` picks this per the fallback matrix. */
  readonly agentStatus: AgentStatus;
  /**
   * When true, the boot banner emits a "/settings to set your LLM key"
   * action line so first-run operators know how to recover from
   * `ggui_render` falling back to the Connect-Claude card. Set by
   * `cli.ts` when the generation probe returned null (no env + no
   * credentials-file).
   */
  readonly noLlmKey?: boolean;
  /** Where to write the banner. */
  readonly stdout: { write(chunk: string): void };
  /**
   * Signal that resolves the serve loop. Production composes this
   * from SIGINT + SIGTERM; tests abort it manually.
   */
  readonly shutdownSignal: ServeShutdownSignal;
}

/**
 * Boot the backend, start the agent (if any), print the banner, then
 * block until the shutdown signal fires. On signal, stops both
 * components gracefully and resolves.
 *
 * Agent-crash policy (§10.2a lock): a crash AFTER boot surfaces as
 * an `onEvent({type:'status', status:'crashed'})` delivery — the
 * serve loop keeps MCP running and waits for shutdown. No auto-
 * restart in v1. Operators compose restart policies via their own
 * supervisor.
 *
 * MCP failure surfaces as a thrown error from `backendFactory()` /
 * `backend.listen()` and propagates to `cli.ts` (exit 1).
 *
 * Pure enough to unit-test: the HTTP binding, signal wiring, and
 * banner render are all either injected or pinned by
 * {@link describeServeBanner} / {@link describeAgentStatus}.
 */
export async function runServe(opts: RunServeOptions): Promise<number> {
  const backend = opts.backendFactory();
  const boundPort = await backend.listen(opts.flags.port, opts.flags.host);

  // Start the agent AFTER the MCP server is listening. Rationale:
  // most agents call MCP as soon as they boot; binding first means
  // the agent's first connect always succeeds. If the agent's
  // start() throws, we've still bound MCP and can surface the agent
  // error cleanly without leaving an orphan HTTP server.
  let agentHandle: AgentRuntimeHandle | null = null;
  let unsubscribeAgent: (() => void) | null = null;
  if (opts.agent) {
    const supervision = opts.agent;
    try {
      agentHandle = await supervision.adapter.start(supervision.startInput);
      if (supervision.onEvent) {
        unsubscribeAgent = agentHandle.subscribe(supervision.onEvent);
      }
    } catch (err) {
      // Start-time failure is a permanent config error per the
      // AgentRuntimeAdapter contract. Clean up the bound server so
      // we don't leak a socket.
      await backend.close();
      throw err;
    }
  }

  // Pre-mint an initial pairing code so a fresh operator's first-run
  // flow has a concrete starting point. Without this, `/admin/pair/
  // init` is gated by a builder bearer the operator doesn't have yet
  // under strict auth — a chicken-and-egg that only devAllowAll hid.
  // `activeInit()` on the landing page + the `PAIR_CODE` boot beacon
  // below both read from the resulting pending code. Absent pairing
  // (future embedding host opts out) → skip the mint + beacon + the
  // banner line, leaving the operator on whatever bearer path their
  // custom adapter provides.
  //
  // Skipped under `--dev-allow-all` — every bearer authenticates as
  // builder there, so a pair code would be cargo-cult dressing on a
  // permissive auth surface and harnesses parsing `PAIR_CODE` would
  // get a value that's not actually load-bearing.
  let initialPair: Awaited<
    ReturnType<PairingService['initPairing']>
  > | undefined;
  if (backend.pairingService && !opts.flags.devAllowAll && !opts.flags.publicDemo) {
    initialPair = await backend.pairingService.initPairing();
  }

  // Machine-readable ready beacon. Stable single-line format for
  // test harnesses + supervisors; goes out BEFORE the pretty banner
  // so consumers can gate on it without grepping multi-line output.
  // Format: `READY <baseUrl>\n`.
  opts.stdout.write(`READY http://${opts.flags.host}:${boundPort}\n`);
  if (initialPair) {
    // Paired beacon for harnesses — same stable-line contract as READY.
    // Format: `PAIR_CODE <code>\n`. Expiry is implicit via the ~10m
    // TTL the `InMemoryPairingService` ships with; harnesses that
    // need it can read `GET /ggui/console/info#pairing.pending`.
    opts.stdout.write(`PAIR_CODE ${initialPair.code}\n`);
  }
  if (backend.adminToken) {
    // Machine-readable admin-token beacon — same stable-line contract
    // as READY + PAIR_CODE. Harnesses pre-populate the console admin
    // cookie by reading this off stdout.
    opts.stdout.write(`ADMIN_TOKEN ${backend.adminToken}\n`);
  }

  const bannerLines = describeServeBanner({
    port: boundPort,
    host: opts.flags.host,
    toolCount: backend.toolCount,
    serverName: backend.serverName,
    serverVersion: backend.serverVersion,
    agent: opts.agentStatus,
    devAllowAll: opts.flags.devAllowAll,
    publicDemo: opts.flags.publicDemo,
    multiTenant: opts.flags.multiTenant,
    oauth: opts.flags.oauth,
    ...(opts.flags.publicBaseUrl !== undefined
      ? { publicBaseUrl: opts.flags.publicBaseUrl }
      : {}),
    ...(initialPair
      ? {
          pairCode: initialPair.code,
          pairCodeExpiresAt: initialPair.codeExpiresAt,
        }
      : {}),
    ...(backend.adminToken ? { adminToken: backend.adminToken } : {}),
    ...(opts.noLlmKey ? { noLlmKey: true } : {}),
    ...(backend.embeddingModel ? { embeddingModel: backend.embeddingModel } : {}),
  });
  opts.stdout.write(`${bannerLines.join('\n')}\n`);

  // Auto-open the operator's browser at the local URL. The server's
  // `landingRedirect` then routes first-run operators (no LLM creds)
  // to the admin onboarding flow at `/admin-login?next=/admin/llm-keys`,
  // so the URL bar lands on the right page without the CLI needing
  // to know which target to pick. Skipped for: `--no-open`, non-TTY
  // (CI / supervised / piped), `--mcp-only` (no UI surface to open).
  // Errors are swallowed — the banner already shows the URL so the
  // operator can copy/paste if launchBrowser fails (xdg-open missing,
  // etc.).
  const shouldAutoOpenServe =
    !opts.flags.noOpen
    && !opts.flags.mcpOnly
    && opts.stdout === process.stdout
    && process.stdout.isTTY === true;
  if (shouldAutoOpenServe) {
    const localUrl = `http://${opts.flags.host}:${boundPort}`;
    const result = launchBrowser(localUrl);
    opts.stdout.write(
      result.ok
        ? `\n  opening browser → ${localUrl}\n`
        : `\n  (couldn't auto-open browser: ${result.error})\n`,
    );
  }

  const stopAll = async (): Promise<void> => {
    // Stop the agent BEFORE the server so the agent doesn't try
    // one last call into an already-torn-down MCP surface. Swallow
    // stop errors — the log has already delivered the crash signal
    // if there was one, and the server close is the priority.
    if (unsubscribeAgent) unsubscribeAgent();
    unsubscribeAgent = null;
    if (agentHandle) {
      try {
        await agentHandle.stop();
      } catch {
        /* best-effort */
      }
      agentHandle = null;
    }
    await backend.close();
  };

  if (opts.shutdownSignal.aborted) {
    await stopAll();
    return 0;
  }
  await new Promise<void>((resolve) => {
    opts.shutdownSignal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true },
    );
  });
  await stopAll();
  return 0;
}

export const SERVE_HELP = `ggui serve — run the open self-hosted personal-mode app

Boots the @ggui-ai/mcp-server binding with persistent defaults AND
(by default) supervises your agent alongside it. The current MCP
handler surface is the blueprint-read family (search / list_featured
/ render); more tools come online as @ggui-ai/mcp-server-handlers
grows.

First-run bundle (all on by default):
  - Landing page at /          — operator opens a browser and sees
                                  server identity + pair-code card.
  - Render viewer at /r/<code>  — same-origin viewer for renders
                                  minted by ggui_render; same-origin
                                  HTTP-only cookie authenticates the
                                  live-channel /ws upgrade.
  - POST /pair + POST /admin/pair/init — pairing endpoint for MCP
                                  hosts and third-party clients.
  - Live-channel /ws            — live render plane for MCP Apps
                                  iframes and the console.

Embedding hosts that want a different shape (no landing page, no
pairing, programmatic control) should compose createGguiServer()
directly in code rather than invoking \`ggui serve\`.

Usage:
  ggui serve [options]

Options:
  --port <n>             Bind port (default: ${DEFAULT_SERVE_PORT}, 0 = OS-assigned).
  --host <addr>          Bind host (default: ${DEFAULT_SERVE_HOST}).
  --mcp-only             Run just the MCP server; do not supervise an agent.
  --dev-allow-all        Accept any non-empty bearer (incl. no bearer) as
                         builder. Local-dev / tunnel smoke ONLY — never
                         expose to the open internet.
  --public-demo          Public-facing demo posture: same any-bearer auth
                         as --dev-allow-all, plus per-IP rate limit on
                         ggui_render (30 generations / 10 min) and a
                         "PUBLIC DEMO — operator pays" banner. Mutually
                         exclusive with --dev-allow-all.
  --multi-tenant         Multi-tenant posture: switches the /settings LLM-
                         keys gate from admin-token to auth-adapter so
                         each authenticated end-user manages their OWN
                         key plane (scope = userId/appId). kind:'builder'
                         identities are rejected at the gate. Strict-auth
                         only; mutually exclusive with --dev-allow-all
                         and --public-demo. (Generation-time BYOK still
                         resolves at the operator 'global' scope — a
                         follow-up will thread per-user BYOK through
                         ggui_render.)
  --public-base-url <u>  Override the public base URL used to compose
                         iframe-runtime + shortCode URLs. Set this to a
                         tunnel URL (https://<random>.trycloudflare.com)
                         when testing against a remote MCP host so URLs
                         resolve from the host's perspective. Without
                         this, URLs derive from --host:--port and only
                         work from the same machine.
  --oauth                Mount OAuth 2.1 + PKCE + Dynamic Client
                         Registration routes (.well-known/oauth-* +
                         /oauth/{authorize,token,register}). Required
                         for MCP custom-connector hosts (claude.ai,
                         ChatGPT) whose Add Connector form has no field
                         for a pre-shared bearer; OAuth lets them do
                         a discovery → DCR → consent dance ending in
                         the same paired bearer the strict-auth flow
                         already mints. Pure-bearer clients (Claude
                         Desktop with bearer in config) work without it.
  --admin-token <t>      Pin the admin bearer that gates the console
                         /keys plane (list / mint / revoke pairings +
                         /admin-login route). Without this, the server
                         mints a fresh ggui_admin_* token per boot and
                         prints it on the banner. Pin a stable value
                         when you want the bearer to survive restarts
                         (e.g. paste once into a password manager).
  --ephemeral            Disable cross-restart persistence. Without
                         this flag, the HMAC secrets that sign MCP
                         Apps bootstrap tokens and signed render URLs
                         are read or minted under .ggui/persistent/
                         (project-local if a ggui.json was resolved,
                         else ~/.ggui/persistent/) so cached tokens
                         survive a server restart. Pass this flag to
                         keep restarts ephemeral (tests / CI / nuclear-
                         revoke). Override the dir via GGUI_PERSISTENT_DIR.
  --seed-pool <dir>      Load a read-only shared blueprint pool from a
                         directory artifact (repeatable). Blueprints in it
                         are reused by exact contract match, after your own.
  --help, -h             Show this help.

Agent runtime:
  The default boots your agent alongside MCP. The agent's entry file
  comes from ggui.json:

    { "agent": { "entry": "./agent.ts" } }

  Supported extensions: .js / .mjs / .cjs (node), .ts / .tsx / .mts
  (node --import=tsx). No ggui.json, or no agent.entry, falls back
  to MCP-only with a warning. Malformed ggui.json or a bad entry
  is a hard error.

  Agent crashes after startup are logged; the MCP server keeps
  running. No auto-restart — compose that with your own supervisor.

Persistent storage (default-on; opt-out via --ephemeral):
  By default \`ggui serve\` writes a small bundle under .ggui/persistent/
  (project-local if a ggui.json was resolved, else ~/.ggui/persistent/)
  so cached MCP Apps tokens, signed render URLs, shortCodes, renders,
  vectors, and paired bearers survive a restart — claude.ai chat-history
  revisits keep working.

  Bundle layout:

    .ggui/persistent/
      ├── ws-token-secret.hex       (HMAC, 0600)
      ├── render-signer-secret.hex  (HMAC, 0600)
      ├── short-codes.sqlite        (signed render-URL resolution)
      ├── renders.sqlite            (RenderStore — renders + event history)
      ├── vectors.sqlite            (RAG corpus)
      └── keys.json                 (paired bearers)

  Override the dir with \`GGUI_PERSISTENT_DIR\`. Pass \`--ephemeral\` to
  skip the bundle entirely (tests, CI loops, nuclear-revoke).

  Explicit ggui.json#storage declarations always win — declare
  \`{ "renders": { "driver": "memory" } }\` to opt renders back to
  in-memory while keeping other surfaces persistent. Custom sqlite
  paths via ggui.json#storage are honored verbatim:

    {
      "storage": {
        "renders": { "driver": "sqlite", "path": "./ggui-renders.sqlite" },
        "vectors": { "driver": "sqlite", "path": "./ggui-vectors.sqlite" },
        "threads": { "driver": "sqlite", "path": "./ggui-threads.sqlite" }
      }
    }

  Threads: the persistent-chat route family (/threads) is opt-in.
  Absent \`storage.threads\` leaves the routes unmounted — pairs
  with Portal's self-hosted origins only when declared. Driver
  semantics:
    - \`driver: "sqlite"\` — durable. Threads survive restart.
      /ggui/health reports \`threads.durability: "durable"\`;
      Portal hides its non-durable caveat.
    - \`driver: "memory"\` — routes mount but data is lost on
      restart. /ggui/health reports \`threads.durability:
      "ephemeral"\`; Portal shows its caveat.

  Paths resolve relative to the ggui.json directory. The sqlite
  driver needs \`better-sqlite3\` installed in your project.

Recommended setups:

  Local-only smoke (no tunnel, no remote MCP host):
    ggui serve

  claude.ai custom connector (over a public tunnel):
    1. Tunnel: cloudflared tunnel --url http://localhost:6781
    2. ggui serve --oauth \\
                  --public-base-url https://<tunnel>.trycloudflare.com
    3. Note PAIR_CODE from boot. Visit the landing page (the public URL
       above), complete pairing, save the bearer.
    4. claude.ai → Settings → Connectors → Add custom connector.
       URL: https://<tunnel>.trycloudflare.com/mcp
       Client ID / Secret: leave empty (server uses Dynamic Client
       Registration; no pre-shared secret needed).
    5. Click Connect → claude.ai redirects you to a paste-key page.
       Paste the bearer from step 3. Done.

  Quick local-dev WITHOUT auth (NEVER over a public tunnel):
    ggui serve --dev-allow-all

Current limits:
  - Strict-auth only: /mcp rejects any bearer that isn't pair-minted.
    The CLI pre-mints one pairing code on boot (printed as
    \`PAIR_CODE <code>\` and shown in the banner + on the landing
    page). Complete \`POST /pair {code, deviceName}\` to receive a
    bearer you can use with MCP. Embed @ggui-ai/mcp-server in your
    own entrypoint to inject a different AuthAdapter (OIDC, Cognito,
    etc.) for production.
  - Single-tenant: every request scopes to one \`builder\` app id.
`;
