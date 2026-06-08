/**
 * `ggui provider-key set` — push a provider API key to a cloud ggui app.
 *
 * Resolves the target provider either from:
 *   - `--provider <name>` flag (explicit, validated against BYOK set)
 *   - `ggui.json#generation.model` (via `parseAnyLlmRoute` from @ggui-ai/protocol)
 *
 * Then reads the key from the appropriate environment variable and
 * POSTs it to `POST /v1/apps/{appId}/provider-keys`.
 */
/* eslint-disable no-console */
import process from 'node:process';
import { parseAnyLlmRoute, type LlmProvider } from '@ggui-ai/protocol';
import { z } from 'zod';
import { setAppProviderKey } from './api-client.js';
import { findGguiJson, readGguiJson } from './internal/ggui-json.js';

// ─────────────────────────────────────────────────────────────────────────────
// BYOK provider set — bedrock is excluded (IAM-only, no plaintext key to push)
// ─────────────────────────────────────────────────────────────────────────────

/** Providers that accept a user-supplied plaintext API key. */
export const BYOK_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter'] as const;

/** Provider name subset that supports BYOK. */
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

function isByokProvider(s: string): s is ByokProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(s);
}

// ─────────────────────────────────────────────────────────────────────────────
// inferProvider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve which LLM provider to push a key for.
 *
 * Priority:
 *   1. `flagProvider` (explicit `--provider` flag) — validated against BYOK set.
 *      Bedrock → descriptive error. Unknown provider → error.
 *   2. `ggui.json#generation.model` — parsed via `parseAnyLlmRoute` from
 *      `@ggui-ai/protocol`. Bedrock → error. Unparseable / absent → error.
 *
 * **Does NOT hand-roll a provider parser.** All model-string parsing goes
 * through `parseAnyLlmRoute` (covers both canonical `provider:model` and
 * LiteLLM `provider/model` forms).
 */
export function inferProvider(
  gguiJson: unknown,
  flagProvider: string | undefined,
): ByokProvider | { error: string } {
  if (flagProvider !== undefined) {
    if (flagProvider === 'bedrock') {
      return { error: 'bedrock is platform/IAM-only — no BYOK key to push' };
    }
    if (!isByokProvider(flagProvider)) {
      return {
        error: `"${flagProvider}" is not a supported BYOK provider — must be one of: ${BYOK_PROVIDERS.join(', ')}`,
      };
    }
    return flagProvider;
  }

  // No flag — derive from ggui.json#generation.model via parseAnyLlmRoute.
  const schema = z.object({
    generation: z
      .object({
        model: z.string().optional(),
      })
      .optional(),
  });

  const parsed = schema.safeParse(gguiJson);
  const modelString = parsed.success ? parsed.data.generation?.model : undefined;

  if (!modelString) {
    return { error: 'no provider — pass --provider or set generation.model in ggui.json' };
  }

  const route = parseAnyLlmRoute(modelString);
  if (!route) {
    return { error: 'no provider — pass --provider or set generation.model in ggui.json' };
  }

  const provider: LlmProvider = route.provider;

  if (provider === 'bedrock') {
    return { error: 'bedrock is platform/IAM-only — no BYOK key to push' };
  }

  if (!isByokProvider(provider)) {
    // Defensive: covers any future LlmProvider added before BYOK_PROVIDERS is updated.
    return { error: `"${provider}" is not a supported BYOK provider — pass --provider explicitly` };
  }

  return provider;
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-var helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the primary env-var name for a BYOK provider.
 * For google the primary is `GEMINI_API_KEY` (with `GOOGLE_API_KEY` as
 * fallback checked in `readKeyFromEnv`).
 */
export function envVarForProvider(provider: ByokProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'google':
      return 'GEMINI_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
  }
}

/**
 * Read the API key for a BYOK provider from the given env.
 *
 * - `anthropic`   → `ANTHROPIC_API_KEY`
 * - `openai`      → `OPENAI_API_KEY`
 * - `google`      → `GEMINI_API_KEY` (primary), then `GOOGLE_API_KEY` (fallback)
 * - `openrouter`  → `OPENROUTER_API_KEY`
 *
 * Returns `undefined` when no non-empty value is found.
 */
export function readKeyFromEnv(
  provider: ByokProvider,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const candidates: string[] =
    provider === 'google'
      ? ['GEMINI_API_KEY', 'GOOGLE_API_KEY']
      : [envVarForProvider(provider)];

  for (const name of candidates) {
    const val = env[name];
    if (val && val.length > 0) return val;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command runner
// ─────────────────────────────────────────────────────────────────────────────

export const PROVIDER_KEY_HELP = `ggui provider-key — manage cloud provider API keys for a ggui app

Usage:
  ggui provider-key set --app <appId> [--provider <name>]

Subcommands:
  set   Push a provider API key from the appropriate env var to the cloud app.
        The provider is derived from ggui.json#generation.model unless
        --provider is given explicitly.

        Supported providers: anthropic, openai, google, openrouter.
        (bedrock is IAM-only — no plaintext key to push.)

        Reads the key from env:
          ANTHROPIC_API_KEY  (anthropic)
          OPENAI_API_KEY     (openai)
          GEMINI_API_KEY     (google, primary); GOOGLE_API_KEY (fallback)
          OPENROUTER_API_KEY (openrouter)

Options:
  --app <appId>       Target app ID (required).
  --provider <name>   Override provider (default: derived from ggui.json).
  --help, -h          Show this help.
`;

/**
 * Entry point for `ggui provider-key <subcommand> [options]`.
 *
 * @param args - argv slice after `provider-key` (e.g. `['set', '--app', 'app123']`)
 * @param startDir - optional cwd override (primarily for tests)
 * @returns exit code (0 = success, 1 = error)
 */
export async function runProviderKeyCommand(
  args: readonly string[],
  startDir: string = process.cwd(),
): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    process.stdout.write(PROVIDER_KEY_HELP);
    return 0;
  }

  const [subcommand, ...rest] = args;

  if (subcommand !== 'set') {
    process.stderr.write(
      `ggui provider-key: unknown subcommand "${subcommand as string}"\n` +
        `  Run \`ggui provider-key --help\` for usage.\n`,
    );
    return 1;
  }

  // ── Parse flags ─────────────────────────────────────────────────────────
  let appId: string | undefined;
  let flagProvider: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--app' && i + 1 < rest.length) {
      appId = rest[++i];
    } else if (arg === '--provider' && i + 1 < rest.length) {
      flagProvider = rest[++i];
    }
  }

  if (!appId) {
    process.stderr.write('ggui provider-key set: --app <appId> is required.\n');
    return 1;
  }

  // ── Load ggui.json ───────────────────────────────────────────────────────
  const gguiJsonPath = findGguiJson(startDir);
  let gguiJson: unknown = {};
  if (gguiJsonPath) {
    const readResult = readGguiJson(gguiJsonPath);
    if ('value' in readResult) {
      gguiJson = readResult.value;
    }
  }

  // ── Resolve provider ─────────────────────────────────────────────────────
  const providerResult = inferProvider(gguiJson, flagProvider);
  if (typeof providerResult === 'object' && 'error' in providerResult) {
    process.stderr.write(`ggui provider-key set: ${providerResult.error}\n`);
    return 1;
  }
  const provider: ByokProvider = providerResult;

  // ── Read key from env ────────────────────────────────────────────────────
  const key = readKeyFromEnv(provider);
  if (!key) {
    const primaryVar = envVarForProvider(provider);
    const hint =
      provider === 'google'
        ? `${primaryVar} (or GOOGLE_API_KEY)`
        : primaryVar;
    process.stderr.write(
      `ggui provider-key set: no key found for provider "${provider}" — set ${hint} and retry.\n`,
    );
    return 1;
  }

  // ── Push to cloud ────────────────────────────────────────────────────────
  try {
    const result = await setAppProviderKey(appId, provider, key);
    process.stdout.write(
      `  provider key set (••••${result.lastFour}) for ${provider}\n`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(
      `ggui provider-key set: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
