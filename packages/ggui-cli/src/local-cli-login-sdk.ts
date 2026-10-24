/**
 * `--local-cli-login` generates through the Claude Agent SDK, which
 * `@ggui-ai/ui-gen` declares as an optional peer (ggui#1951): its
 * native binary is about 300 MB, so a plain `@ggui-ai/cli` install
 * does not carry it. `ggui serve` checks at boot and warns with the
 * install lines, instead of letting the first generation on the login
 * route be the one that finds out.
 *
 * A warning, not a refusal: the login route only runs when no Anthropic
 * key resolves, so a server with a key never needs the SDK.
 */
import { ClaudeAgentSdkMissingError, ensureClaudeAgentSdk } from '@ggui-ai/ui-gen';

/**
 * The boot warning for a missing SDK, or `undefined` when it loads.
 * Any other load failure rejects unchanged. `check` is for tests.
 */
export async function localCliLoginSdkWarning(
  check: typeof ensureClaudeAgentSdk = ensureClaudeAgentSdk,
): Promise<string | undefined> {
  try {
    await check();
    return undefined;
  } catch (err) {
    if (!(err instanceof ClaudeAgentSdkMissingError)) throw err;
    return `ggui serve: --local-cli-login generates through the Claude Agent SDK. ${err.message}\n`;
  }
}
