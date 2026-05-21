import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlaintextFileProviderKeyStore } from '@ggui-ai/mcp-server-core/plaintext';
import type { LlmProvider, ProviderKeyStore } from '@ggui-ai/mcp-server-core';
import {
  createByokResolver,
  PROVIDER_ENV_NAMES,
  BYOK_GLOBAL_APP_SCOPE,
} from './byok-resolver';
import { getConfigDir, getCredentialsFile, getEmbeddingCacheDir } from './paths';

describe('paths.ts — OSS config dir resolution', () => {
  let savedConfig: string | undefined;
  let savedEmbedding: string | undefined;
  beforeEach(() => {
    savedConfig = process.env['GGUI_CONFIG_DIR'];
    savedEmbedding = process.env['GGUI_EMBEDDING_CACHE_DIR'];
    delete process.env['GGUI_CONFIG_DIR'];
    delete process.env['GGUI_EMBEDDING_CACHE_DIR'];
  });
  afterEach(() => {
    if (savedConfig !== undefined) process.env['GGUI_CONFIG_DIR'] = savedConfig;
    else delete process.env['GGUI_CONFIG_DIR'];
    if (savedEmbedding !== undefined)
      process.env['GGUI_EMBEDDING_CACHE_DIR'] = savedEmbedding;
    else delete process.env['GGUI_EMBEDDING_CACHE_DIR'];
  });

  it('defaults config dir to ~/.ggui', () => {
    const dir = getConfigDir();
    expect(dir.endsWith('/.ggui')).toBe(true);
  });

  it('honors GGUI_CONFIG_DIR override', () => {
    process.env['GGUI_CONFIG_DIR'] = '/tmp/custom-ggui-cfg';
    expect(getConfigDir()).toBe('/tmp/custom-ggui-cfg');
  });

  it('credentials file lives at <configDir>/credentials.json', () => {
    process.env['GGUI_CONFIG_DIR'] = '/tmp/byok-test';
    expect(getCredentialsFile()).toBe('/tmp/byok-test/credentials.json');
  });

  it('embedding cache dir defaults to <configDir>/models', () => {
    process.env['GGUI_CONFIG_DIR'] = '/tmp/byok-test';
    expect(getEmbeddingCacheDir()).toBe('/tmp/byok-test/models');
  });

  it('GGUI_EMBEDDING_CACHE_DIR overrides the embedding cache dir independently of GGUI_CONFIG_DIR', () => {
    process.env['GGUI_CONFIG_DIR'] = '/tmp/byok-test';
    process.env['GGUI_EMBEDDING_CACHE_DIR'] = '/mnt/shared-models';
    expect(getEmbeddingCacheDir()).toBe('/mnt/shared-models');
    // GGUI_CONFIG_DIR still drives credentials.json
    expect(getCredentialsFile()).toBe('/tmp/byok-test/credentials.json');
  });

  it('empty-string overrides are ignored (treated as unset)', () => {
    process.env['GGUI_CONFIG_DIR'] = '';
    expect(getConfigDir().endsWith('/.ggui')).toBe(true);
  });
});

describe('PROVIDER_ENV_NAMES — locked env-var mapping', () => {
  it('maps anthropic → ANTHROPIC_API_KEY (single name)', () => {
    expect(PROVIDER_ENV_NAMES.anthropic).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('maps openai → OPENAI_API_KEY', () => {
    expect(PROVIDER_ENV_NAMES.openai).toEqual(['OPENAI_API_KEY']);
  });

  it('maps openrouter → OPENROUTER_API_KEY', () => {
    expect(PROVIDER_ENV_NAMES.openrouter).toEqual(['OPENROUTER_API_KEY']);
  });

  it('maps google → [GOOGLE_API_KEY, GEMINI_API_KEY] (alias supported, GOOGLE first)', () => {
    expect(PROVIDER_ENV_NAMES.google).toEqual([
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
    ]);
  });

  it('does NOT include bedrock (handled by AWS SDK credential chain)', () => {
    expect(
      (PROVIDER_ENV_NAMES as Record<string, unknown>)['bedrock'],
    ).toBeUndefined();
  });
});

describe('createByokResolver — env-only path', () => {
  it('resolves anthropic from env with source="env" + envName', async () => {
    const resolver = createByokResolver({
      env: { ANTHROPIC_API_KEY: 'sk-ant-from-env' },
      fileStore: null,
    });
    const result = await resolver.resolve('anthropic');
    expect(result).toEqual({
      key: 'sk-ant-from-env',
      source: 'env',
      provider: 'anthropic',
      envName: 'ANTHROPIC_API_KEY',
    });
  });

  it('resolves openai from env', async () => {
    const resolver = createByokResolver({
      env: { OPENAI_API_KEY: 'sk-oa' },
      fileStore: null,
    });
    expect(await resolver.resolve('openai')).toEqual({
      key: 'sk-oa',
      source: 'env',
      provider: 'openai',
      envName: 'OPENAI_API_KEY',
    });
  });

  it('resolves openrouter from env', async () => {
    const resolver = createByokResolver({
      env: { OPENROUTER_API_KEY: 'sk-or' },
      fileStore: null,
    });
    expect(await resolver.resolve('openrouter')).toEqual({
      key: 'sk-or',
      source: 'env',
      provider: 'openrouter',
      envName: 'OPENROUTER_API_KEY',
    });
  });

  it('resolves google from GOOGLE_API_KEY (primary)', async () => {
    const resolver = createByokResolver({
      env: { GOOGLE_API_KEY: 'goog-1' },
      fileStore: null,
    });
    expect(await resolver.resolve('google')).toMatchObject({
      key: 'goog-1',
      source: 'env',
      envName: 'GOOGLE_API_KEY',
    });
  });

  it('resolves google from GEMINI_API_KEY (alias) when GOOGLE_API_KEY is absent', async () => {
    const resolver = createByokResolver({
      env: { GEMINI_API_KEY: 'gem-1' },
      fileStore: null,
    });
    expect(await resolver.resolve('google')).toMatchObject({
      key: 'gem-1',
      source: 'env',
      envName: 'GEMINI_API_KEY',
    });
  });

  it('GOOGLE_API_KEY beats GEMINI_API_KEY when both are set (locked precedence)', async () => {
    const resolver = createByokResolver({
      env: { GOOGLE_API_KEY: 'goog', GEMINI_API_KEY: 'gem' },
      fileStore: null,
    });
    const result = await resolver.resolve('google');
    expect(result?.key).toBe('goog');
    expect(result?.envName).toBe('GOOGLE_API_KEY');
  });

  it('treats empty-string env values as absent (covers shells that export = "" )', async () => {
    const resolver = createByokResolver({
      env: { ANTHROPIC_API_KEY: '' },
      fileStore: null,
    });
    expect(await resolver.resolve('anthropic')).toBeNull();
  });

  it('returns null for bedrock (delegated to AWS SDK chain — never env-resolvable here)', async () => {
    const resolver = createByokResolver({
      env: { AWS_ACCESS_KEY_ID: 'irrelevant', AWS_SECRET_ACCESS_KEY: 'also' },
      fileStore: null,
    });
    expect(await resolver.resolve('bedrock')).toBeNull();
  });
});

describe('createByokResolver — credentials-file fallback', () => {
  let tmpDir: string;
  let credFile: string;
  let store: ProviderKeyStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ggui-byok-test-'));
    credFile = join(tmpDir, 'credentials.json');
    store = new PlaintextFileProviderKeyStore({ filename: credFile });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('falls back to credentials file when env is empty', async () => {
    await store.set(BYOK_GLOBAL_APP_SCOPE, 'anthropic', 'sk-ant-from-file');
    const resolver = createByokResolver({ env: {}, fileStore: store });
    expect(await resolver.resolve('anthropic')).toEqual({
      key: 'sk-ant-from-file',
      source: 'credentials-file',
      provider: 'anthropic',
    });
  });

  it('env wins over credentials file (env precedence is locked)', async () => {
    await store.set(BYOK_GLOBAL_APP_SCOPE, 'openai', 'sk-from-file');
    const resolver = createByokResolver({
      env: { OPENAI_API_KEY: 'sk-from-env' },
      fileStore: store,
    });
    const result = await resolver.resolve('openai');
    expect(result?.key).toBe('sk-from-env');
    expect(result?.source).toBe('env');
  });

  it('returns null when neither env nor file has the provider', async () => {
    const resolver = createByokResolver({ env: {}, fileStore: store });
    expect(await resolver.resolve('openrouter')).toBeNull();
  });

  it('credentials file lookups are scoped to the BYOK_GLOBAL_APP_SCOPE app id', async () => {
    // Write under a DIFFERENT app id; the resolver must NOT pick it
    // up — global-scope is the locked key for OSS personal-mode.
    await store.set('some-other-app', 'google', 'wrong-key');
    const resolver = createByokResolver({ env: {}, fileStore: store });
    expect(await resolver.resolve('google')).toBeNull();
  });

  it('null fileStore disables the file leg entirely', async () => {
    await store.set(BYOK_GLOBAL_APP_SCOPE, 'anthropic', 'sk-from-file');
    const resolver = createByokResolver({ env: {}, fileStore: null });
    // Even though `store` has the key, the resolver was told to skip
    // the file leg. Tests + clean-room harnesses use this to prove
    // env-only behavior.
    expect(await resolver.resolve('anthropic')).toBeNull();
  });

  it('all four providers + the file leg in one resolver instance', async () => {
    const providers: ReadonlyArray<LlmProvider> = [
      'anthropic',
      'openai',
      'google',
      'openrouter',
    ];
    for (const p of providers) {
      await store.set(BYOK_GLOBAL_APP_SCOPE, p, `key-for-${p}`);
    }
    const resolver = createByokResolver({ env: {}, fileStore: store });
    for (const p of providers) {
      const result = await resolver.resolve(p);
      expect(result, `${p} should resolve from file`).toMatchObject({
        provider: p,
        source: 'credentials-file',
        key: `key-for-${p}`,
      });
    }
  });
});

describe('createByokResolver — credentials-file mode + writeability', () => {
  let tmpDir: string;
  let credFile: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ggui-byok-mode-'));
    credFile = join(tmpDir, 'nested', 'credentials.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PlaintextFileProviderKeyStore writes mode 0o600 + creates parent dirs', async () => {
    const store = new PlaintextFileProviderKeyStore({ filename: credFile });
    await store.set(BYOK_GLOBAL_APP_SCOPE, 'anthropic', 'sk-test');
    expect(existsSync(credFile)).toBe(true);
    const mode = statSync(credFile).mode & 0o777;
    expect(mode).toBe(0o600);
    // File is round-trippable JSON — operator audit story.
    const parsed = JSON.parse(readFileSync(credFile, 'utf8')) as {
      apps: Record<string, Record<string, string>>;
    };
    expect(parsed.apps[BYOK_GLOBAL_APP_SCOPE]?.['anthropic']).toBe('sk-test');
  });

  it('default (no fileStore option) constructs a PlaintextFileProviderKeyStore at GGUI_CONFIG_DIR/credentials.json', async () => {
    process.env['GGUI_CONFIG_DIR'] = tmpDir;
    try {
      // Pre-seed via the store the resolver will construct internally
      // — write the file at the resolved path so the default-store
      // construction picks it up.
      mkdirSync(tmpDir, { recursive: true });
      writeFileSync(
        join(tmpDir, 'credentials.json'),
        JSON.stringify({
          version: 1,
          apps: { [BYOK_GLOBAL_APP_SCOPE]: { openai: 'sk-default-store' } },
        }),
        { mode: 0o600 },
      );
      const resolver = createByokResolver({ env: {} });
      const result = await resolver.resolve('openai');
      expect(result?.key).toBe('sk-default-store');
      expect(result?.source).toBe('credentials-file');
    } finally {
      delete process.env['GGUI_CONFIG_DIR'];
    }
  });
});
