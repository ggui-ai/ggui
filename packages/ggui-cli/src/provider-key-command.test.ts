/**
 * Unit tests for `provider-key-command.ts`.
 *
 * Tests:
 *   - inferProvider (flag wins; model parse via parseAnyLlmRoute; bedrock→error; missing→error)
 *   - envVarForProvider / readKeyFromEnv (GEMINI→GOOGLE fallback; absent→undefined)
 *   - runProviderKeyCommand (arg parse; key lookup; api call; output)
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SetProviderKeyResponse } from './api-client.js';

// ─── hoisted mocks ───────────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  setAppProviderKey: vi.fn<
    (appId: string, provider: string, plaintextKey: string, label?: string) => Promise<SetProviderKeyResponse>
  >(),
}));

vi.mock('./api-client.js', () => ({
  setAppProviderKey: mocks.setAppProviderKey,
}));

// Import AFTER vi.mock
import {
  inferProvider,
  envVarForProvider,
  readKeyFromEnv,
  runProviderKeyCommand,
} from './provider-key-command.js';

// ─── inferProvider ────────────────────────────────────────────────────────────
describe('inferProvider', () => {
  it('flag wins over model: explicit --provider anthropic → anthropic', () => {
    const result = inferProvider({ generation: { model: 'openai:gpt-5.5' } }, 'anthropic');
    expect(result).toBe('anthropic');
  });

  it('flag wins: explicit --provider openai → openai', () => {
    const result = inferProvider({}, 'openai');
    expect(result).toBe('openai');
  });

  it('flag wins: explicit --provider google → google', () => {
    const result = inferProvider({}, 'google');
    expect(result).toBe('google');
  });

  it('flag wins: explicit --provider openrouter → openrouter', () => {
    const result = inferProvider({}, 'openrouter');
    expect(result).toBe('openrouter');
  });

  it('flag bedrock → error (bedrock is IAM-only)', () => {
    const result = inferProvider({}, 'bedrock');
    expect(result).toMatchObject({ error: expect.stringContaining('bedrock') });
  });

  it('flag with unknown provider → error', () => {
    const result = inferProvider({}, 'notaprovider');
    expect(result).toMatchObject({ error: expect.any(String) });
  });

  it('no flag: derives from canonical provider:model', () => {
    const gguiJson = { generation: { model: 'anthropic:claude-haiku-4-5-20251001' } };
    const result = inferProvider(gguiJson, undefined);
    expect(result).toBe('anthropic');
  });

  it('no flag: derives from LiteLLM gemini/ prefix → google', () => {
    const gguiJson = { generation: { model: 'gemini/gemini-3.5-flash' } };
    const result = inferProvider(gguiJson, undefined);
    expect(result).toBe('google');
  });

  it('no flag: derives from LiteLLM openai/ prefix → openai', () => {
    const gguiJson = { generation: { model: 'openai/gpt-5.5' } };
    const result = inferProvider(gguiJson, undefined);
    expect(result).toBe('openai');
  });

  it('no flag: derives from canonical openrouter:model → openrouter', () => {
    const gguiJson = { generation: { model: 'openrouter:anthropic/claude-haiku-4.5' } };
    const result = inferProvider(gguiJson, undefined);
    expect(result).toBe('openrouter');
  });

  it('no flag: bedrock route → error', () => {
    const gguiJson = { generation: { model: 'bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0' } };
    const result = inferProvider(gguiJson, undefined);
    expect(result).toMatchObject({ error: expect.stringContaining('bedrock') });
  });

  it('no flag: unparseable model string → error with guidance', () => {
    const gguiJson = { generation: { model: 'garbage' } };
    const result = inferProvider(gguiJson, undefined);
    expect(result).toMatchObject({ error: expect.stringContaining('no provider') });
  });

  it('no flag: no generation.model field → error', () => {
    const result = inferProvider({}, undefined);
    expect(result).toMatchObject({ error: expect.stringContaining('no provider') });
  });

  it('no flag: generation.model is not a string → error', () => {
    const result = inferProvider({ generation: { model: 42 } }, undefined);
    expect(result).toMatchObject({ error: expect.stringContaining('no provider') });
  });
});

// ─── envVarForProvider / readKeyFromEnv ───────────────────────────────────────
describe('envVarForProvider', () => {
  it('anthropic → ANTHROPIC_API_KEY', () => {
    expect(envVarForProvider('anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('openai → OPENAI_API_KEY', () => {
    expect(envVarForProvider('openai')).toBe('OPENAI_API_KEY');
  });

  it('google → GOOGLE_API_KEY (primary)', () => {
    expect(envVarForProvider('google')).toBe('GOOGLE_API_KEY');
  });

  it('openrouter → OPENROUTER_API_KEY', () => {
    expect(envVarForProvider('openrouter')).toBe('OPENROUTER_API_KEY');
  });
});

describe('readKeyFromEnv', () => {
  it('returns the anthropic key when set', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-ant-abc123' };
    expect(readKeyFromEnv('anthropic', env)).toBe('sk-ant-abc123');
  });

  it('returns undefined when the anthropic key is absent', () => {
    expect(readKeyFromEnv('anthropic', {})).toBeUndefined();
  });

  it('returns the openai key when set', () => {
    const env = { OPENAI_API_KEY: 'sk-openai-xyz' };
    expect(readKeyFromEnv('openai', env)).toBe('sk-openai-xyz');
  });

  it('google: GOOGLE_API_KEY wins when both are present', () => {
    const env = { GOOGLE_API_KEY: 'google-primary', GEMINI_API_KEY: 'gemini-fallback' };
    expect(readKeyFromEnv('google', env)).toBe('google-primary');
  });

  it('google: falls back to GEMINI_API_KEY when GOOGLE_API_KEY is absent', () => {
    const env = { GEMINI_API_KEY: 'gemini-fallback' };
    expect(readKeyFromEnv('google', env)).toBe('gemini-fallback');
  });

  it('google: returns undefined when both GEMINI and GOOGLE are absent', () => {
    expect(readKeyFromEnv('google', {})).toBeUndefined();
  });

  it('openrouter: returns the key when set', () => {
    const env = { OPENROUTER_API_KEY: 'sk-or-abc' };
    expect(readKeyFromEnv('openrouter', env)).toBe('sk-or-abc');
  });

  it('returns undefined when env var is empty string', () => {
    const env = { ANTHROPIC_API_KEY: '' };
    expect(readKeyFromEnv('anthropic', env)).toBeUndefined();
  });
});

// ─── runProviderKeyCommand ────────────────────────────────────────────────────
describe('runProviderKeyCommand', () => {
  let dir: string;
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggui-providerkey-test-'));
    mocks.setAppProviderKey.mockReset();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('returns 1 and writes to stderr on unknown subcommand', async () => {
    const code = await runProviderKeyCommand(['unknownverb']);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns 1 when --app is missing', async () => {
    const code = await runProviderKeyCommand(['set', '--provider', 'anthropic']);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns 1 when no ggui.json found and no --provider flag', async () => {
    const code = await runProviderKeyCommand(['set', '--app', 'app123']);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });

  it('returns 1 when env var is absent for the resolved provider', async () => {
    writeFileSync(
      join(dir, 'ggui.json'),
      JSON.stringify({ generation: { model: 'anthropic:claude-haiku-4-5-20251001' } }),
      'utf-8',
    );
    vi.stubEnv('ANTHROPIC_API_KEY', '');

    const code = await runProviderKeyCommand(['set', '--app', 'app123'], dir);
    expect(code).toBe(1);
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('ANTHROPIC_API_KEY'))).toBe(true);
  });

  it('calls setAppProviderKey and prints success when all deps are present', async () => {
    writeFileSync(
      join(dir, 'ggui.json'),
      JSON.stringify({ generation: { model: 'anthropic:claude-haiku-4-5-20251001' } }),
      'utf-8',
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-abcdefghijklmnop');
    mocks.setAppProviderKey.mockResolvedValue({
      provider: 'anthropic',
      lastFour: 'nop',
      appId: 'app123',
    });

    const code = await runProviderKeyCommand(['set', '--app', 'app123'], dir);
    expect(code).toBe(0);
    expect(mocks.setAppProviderKey).toHaveBeenCalledOnce();
    const [appId, provider, key] = mocks.setAppProviderKey.mock.calls[0]!;
    expect(appId).toBe('app123');
    expect(provider).toBe('anthropic');
    expect(key).toBe('sk-ant-abcdefghijklmnop');
    // stdout should mention lastFour
    expect(stdoutSpy.mock.calls.some((c) => String(c[0]).includes('nop'))).toBe(true);
  });

  it('uses --provider flag to override model-derived provider', async () => {
    writeFileSync(
      join(dir, 'ggui.json'),
      JSON.stringify({ generation: { model: 'anthropic:claude-haiku-4-5-20251001' } }),
      'utf-8',
    );
    vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test-key');
    mocks.setAppProviderKey.mockResolvedValue({
      provider: 'openai',
      lastFour: 'tkey',
      appId: 'app123',
    });

    const code = await runProviderKeyCommand(['set', '--app', 'app123', '--provider', 'openai'], dir);
    expect(code).toBe(0);
    const [, provider] = mocks.setAppProviderKey.mock.calls[0]!;
    expect(provider).toBe('openai');
  });

  it('returns 1 and prints to stderr on network error', async () => {
    writeFileSync(
      join(dir, 'ggui.json'),
      JSON.stringify({ generation: { model: 'anthropic:claude-haiku-4-5-20251001' } }),
      'utf-8',
    );
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-secret');
    mocks.setAppProviderKey.mockRejectedValue(new Error('network error'));

    const code = await runProviderKeyCommand(['set', '--app', 'app123'], dir);
    expect(code).toBe(1);
    expect(stderrSpy).toHaveBeenCalled();
  });
});
