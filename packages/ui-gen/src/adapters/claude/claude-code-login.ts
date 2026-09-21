/**
 * ggui#1185 — generation through the machine's own Claude Code login.
 *
 * The Claude SDK adapter spawns the Claude Code binary. Given no provider
 * key, that binary authenticates with whatever `claude` is logged in as on
 * the machine — the operator's own plan. This module holds the three
 * things that make such a run honest and reproducible:
 *
 *   1. {@link CLAUDE_CODE_LOGIN_CREDENTIAL} — the sentinel a `ProviderKeyRef`
 *      carries in place of a key, the same shape `bedrock-iam` already uses
 *      for "authenticate with ambient credentials, not a key I hold".
 *   2. {@link stripProviderKeyEnv} — no provider key may reach the spawned
 *      process: the binary prefers an env key over its login, so a stale
 *      `ANTHROPIC_API_KEY` would silently take the run off the login path.
 *   3. {@link claudeCodeLoginQueryOptions} — the SDK options that keep the
 *      run bounded: no built-in tool (`tools: []`), no `~/.claude` settings,
 *      hooks or MCP servers leaking in (`settingSources: []`). Not
 *      `--bare`, either: on the SDK's bundled binary `-p` reads the login
 *      store as it always has, so no flag is needed — and the flag it
 *      would be (`--no-bare`) is one that binary rejects; see the note on
 *      the function below.
 *
 * Opt-in, off by default; the default stays a provider key. The copy that
 * names what this does lives with the CLI flag that enables it.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Sentinel credential: "no key — use the machine's Claude Code login". */
export const CLAUDE_CODE_LOGIN_CREDENTIAL = "claude-code-login" as const;

/**
 * Every env name the spawned binary would read as a credential or an
 * endpoint override ahead of its login. Stripped whole, never rewritten.
 */
export const PROVIDER_KEY_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

/** A copy of `env` without any provider key or endpoint override. */
export function stripProviderKeyEnv(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const out: Record<string, string> = {};
  const drop: ReadonlySet<string> = new Set(PROVIDER_KEY_ENV_NAMES);
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !drop.has(k)) out[k] = v;
  }
  return out;
}

/**
 * The SDK `query()` options a login-path run is pinned to — typed as the
 * SDK's own `Options` members, so a change in the SDK's shape is a compile
 * error here and never a silently ignored key.
 *
 * NOT pinned: `--no-bare`. The SDK spawns its BUNDLED binary (2.1.229 for
 * SDK 0.3.229), which has no bare mode and rejects the flag outright
 * (`error: unknown option '--no-bare'`, measured 2026-09-21 on the first
 * live turn of the login client); the machine's own `claude` (2.1.274)
 * accepts it, which is where the earlier probe measured it. On the
 * bundled binary `-p` reads the login store as it always has. If a later
 * SDK bundles a binary where bare becomes the `-p` default, the flag
 * comes back here — with the SDK version bump, measured again.
 */
export type ClaudeCodeLoginQueryOptions = Required<Pick<Options, "tools" | "settingSources">>;

export function claudeCodeLoginQueryOptions(): ClaudeCodeLoginQueryOptions {
  return { tools: [], settingSources: [] };
}
