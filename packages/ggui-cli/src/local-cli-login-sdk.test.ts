/**
 * ggui#1951 — `--local-cli-login` runs on the Claude Agent SDK, an
 * optional peer `@ggui-ai/cli` does not install. `ggui serve` says so at
 * boot, with the install lines, instead of at the first generation.
 */
import { ClaudeAgentSdkMissingError } from '@ggui-ai/ui-gen';
import { describe, expect, it } from 'vitest';
import { localCliLoginSdkWarning } from './local-cli-login-sdk.js';

const missing = (): Promise<void> =>
  Promise.reject(
    new ClaudeAgentSdkMissingError(
      Object.assign(new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
    ),
  );

describe('localCliLoginSdkWarning', () => {
  it('no warning when the SDK loads', async () => {
    expect(await localCliLoginSdkWarning()).toBeUndefined();
  });

  it('a missing SDK warns with the install lines', async () => {
    const warning = await localCliLoginSdkWarning(missing);
    expect(warning).toMatch(/^ggui serve: --local-cli-login /);
    expect(warning).toContain('npm install -g @anthropic-ai/claude-agent-sdk@');
    expect(warning).toContain('npx -p @ggui-ai/cli -p @anthropic-ai/claude-agent-sdk@');
  });

  it('a different load failure is not reported as a missing SDK', async () => {
    const boom = new SyntaxError('Unexpected token');
    await expect(localCliLoginSdkWarning(() => Promise.reject(boom))).rejects.toBe(boom);
  });
});
