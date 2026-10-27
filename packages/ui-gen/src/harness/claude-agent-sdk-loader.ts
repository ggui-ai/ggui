/**
 * The one runtime load of `@anthropic-ai/claude-agent-sdk` (ggui#1951).
 *
 * The SDK is an OPTIONAL peer of this package, not a dependency. Its
 * per-platform native binary is about 300 MB, and only the Claude Code
 * login route (`routeOverride.claudeCodeLogin`, `ggui serve
 * --local-cli-login`), the `sdk`-mode Claude adapter and the
 * `./evaluation` loop run it. A plain install therefore does not carry
 * it, and every one of those paths loads it through
 * {@link loadClaudeAgentSdk}: a missing SDK fails with one
 * {@link ClaudeAgentSdkMissingError} that names the install line for
 * each way of installing ggui, and every other failure keeps its own
 * shape.
 *
 * `preloadProviderSdks` (in `./llm-router.ts`) imports the SDK directly
 * on purpose: it reports a missing SDK in its `missing` list and never
 * throws.
 */

/** The package specifier, as it is imported and installed. */
export const CLAUDE_AGENT_SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/**
 * The exact version this package's `peerDependencies` names. The install
 * lines in {@link ClaudeAgentSdkMissingError} use it; a test pins it to
 * `package.json`.
 */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.311';

export type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

/** The SDK is not installed where this package can import it. */
export class ClaudeAgentSdkMissingError extends Error {
  constructor(cause: Error) {
    const pin = `${CLAUDE_AGENT_SDK_SPECIFIER}@${CLAUDE_AGENT_SDK_VERSION}`;
    super(
      `${CLAUDE_AGENT_SDK_SPECIFIER} is not installed. It is an optional peer of @ggui-ai/ui-gen, ` +
        `needed only to generate with the Claude Code login (and by the Agent SDK adapter and evaluation loop). ` +
        `Install it beside ggui:\n` +
        `  npm install ${pin}            (ggui installed in a project)\n` +
        `  npm install -g ${pin}         (ggui installed with -g)\n` +
        `  npx -p @ggui-ai/cli -p ${pin} ggui serve --local-cli-login   (ggui run with npx)`,
      { cause },
    );
    this.name = 'ClaudeAgentSdkMissingError';
  }
}

function isMissingSdk(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const code: unknown = Reflect.get(err, 'code');
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  // A package the SDK itself imports can be missing too; that failure names
  // its own package and is not this one.
  return err.message.includes(`'${CLAUDE_AGENT_SDK_SPECIFIER}'`);
}

function missingOrRethrow(err: unknown): never {
  if (isMissingSdk(err)) throw new ClaudeAgentSdkMissingError(err);
  throw err;
}

/**
 * Import the Claude Agent SDK. A missing SDK rejects with
 * {@link ClaudeAgentSdkMissingError}; any other failure rejects unchanged.
 * `importer` is for tests. Package-internal: its return type names the
 * SDK's types, which a consumer without the SDK cannot resolve.
 */
export async function loadClaudeAgentSdk(
  importer: () => Promise<ClaudeAgentSdk> = () => import('@anthropic-ai/claude-agent-sdk'),
): Promise<ClaudeAgentSdk> {
  try {
    return await importer();
  } catch (err) {
    return missingOrRethrow(err);
  }
}

/**
 * Check that the Claude Agent SDK loads, with the same errors as
 * {@link loadClaudeAgentSdk}, for a host that wants to say so at boot
 * (`ggui serve --local-cli-login`). Its signature names none of the SDK's
 * types, so the package's main entry can export it. `importer` is for tests.
 */
export async function ensureClaudeAgentSdk(
  importer: () => Promise<unknown> = () => import('@anthropic-ai/claude-agent-sdk'),
): Promise<void> {
  try {
    await importer();
  } catch (err) {
    missingOrRethrow(err);
  }
}
