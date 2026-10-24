/**
 * ggui#1951 — `@anthropic-ai/claude-agent-sdk` is an optional peer of
 * this package. Every runtime load goes through `loadClaudeAgentSdk`,
 * so a missing SDK fails with one named error that says how to install
 * it, and every other failure keeps its own shape.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_AGENT_SDK_SPECIFIER,
  CLAUDE_AGENT_SDK_VERSION,
  ClaudeAgentSdkMissingError,
  ensureClaudeAgentSdk,
  loadClaudeAgentSdk,
} from './claude-agent-sdk-loader.js';

function notFound(code: string, specifier: string): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}' imported from /x/y.js`), { code });
}

describe('loadClaudeAgentSdk', () => {
  it('returns the module when the SDK is installed', async () => {
    const sdk = await loadClaudeAgentSdk();
    expect(typeof sdk.query).toBe('function');
  });

  for (const code of ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']) {
    it(`a missing SDK (${code}) becomes ClaudeAgentSdkMissingError naming all three install lines`, async () => {
      const err: unknown = await loadClaudeAgentSdk(() =>
        Promise.reject(notFound(code, CLAUDE_AGENT_SDK_SPECIFIER)),
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClaudeAgentSdkMissingError);
      const message = (err as Error).message;
      const pin = `${CLAUDE_AGENT_SDK_SPECIFIER}@${CLAUDE_AGENT_SDK_VERSION}`;
      expect(message).toContain(`npm install ${pin}`);
      expect(message).toContain(`npm install -g ${pin}`);
      expect(message).toContain(`npx -p @ggui-ai/cli -p ${pin}`);
      expect((err as Error).cause).toBeInstanceOf(Error);
    });
  }

  it('a missing package the SDK itself imports is not reported as a missing SDK', async () => {
    const inner = notFound('ERR_MODULE_NOT_FOUND', 'some-transitive-dep');
    const err: unknown = await loadClaudeAgentSdk(() => Promise.reject(inner)).catch((e: unknown) => e);
    expect(err).toBe(inner);
  });

  it('any other load failure is rethrown unchanged', async () => {
    const boom = new SyntaxError('Unexpected token');
    const err: unknown = await loadClaudeAgentSdk(() => Promise.reject(boom)).catch((e: unknown) => e);
    expect(err).toBe(boom);
  });

  it('ensureClaudeAgentSdk resolves when the SDK loads, and names a missing one the same way', async () => {
    await expect(ensureClaudeAgentSdk()).resolves.toBeUndefined();
    const err: unknown = await ensureClaudeAgentSdk(() =>
      Promise.reject(notFound('ERR_MODULE_NOT_FOUND', CLAUDE_AGENT_SDK_SPECIFIER)),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeAgentSdkMissingError);
    const boom = new SyntaxError('Unexpected token');
    await expect(ensureClaudeAgentSdk(() => Promise.reject(boom))).rejects.toBe(boom);
  });

  it("names the exact version package.json declares as the optional peer", () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.peerDependencies?.[CLAUDE_AGENT_SDK_SPECIFIER]).toBe(CLAUDE_AGENT_SDK_VERSION);
    expect(pkg.peerDependenciesMeta?.[CLAUDE_AGENT_SDK_SPECIFIER]?.optional).toBe(true);
    expect(pkg.dependencies?.[CLAUDE_AGENT_SDK_SPECIFIER]).toBeUndefined();
  });
});
