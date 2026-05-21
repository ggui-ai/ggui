/**
 * OAuth providers store tests — Slice C agent C
 * (`docs/plans/2026-05-01-end-user-auth-slices.md`).
 *
 * Each test gets its own tmpdir so file writes from one test don't
 * leak into another. Env overrides are passed via the `env` option
 * so we don't mutate `process.env` (and so each test sees a clean
 * env scope).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createOAuthProvidersStore,
  type OAuthProvidersStore,
} from './oauth-providers-store.js';
import type { Logger } from './logger.js';

interface CapturedLog {
  level: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  fields?: Record<string, unknown>;
}

function makeLogger(captured: CapturedLog[] = []): Logger & {
  captured: CapturedLog[];
} {
  const push = (
    level: CapturedLog['level'],
    event: string,
    fields?: Record<string, unknown>,
  ): void => {
    captured.push({ level, event, ...(fields !== undefined ? { fields } : {}) });
  };
  const logger = {
    captured,
    info: (event: string, fields?: Record<string, unknown>) => push('info', event, fields),
    warn: (event: string, fields?: Record<string, unknown>) => push('warn', event, fields),
    error: (event: string, fields?: Record<string, unknown>) => push('error', event, fields),
    debug: (event: string, fields?: Record<string, unknown>) => push('debug', event, fields),
    child: () => logger,
  };
  return logger;
}

interface Harness {
  store: OAuthProvidersStore;
  filePath: string;
  tmpDir: string;
  env: Record<string, string | undefined>;
  logger: ReturnType<typeof makeLogger>;
}

async function makeHarness(opts?: {
  env?: Record<string, string | undefined>;
  fileName?: string;
}): Promise<Harness> {
  const tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'ggui-oauth-providers-test-'),
  );
  const filePath = path.join(tmpDir, opts?.fileName ?? 'oauth-providers.json');
  const env = opts?.env ?? {};
  const logger = makeLogger();
  const store = createOAuthProvidersStore({ filePath, env, logger });
  return { store, filePath, tmpDir, env, logger };
}

const harnesses: Harness[] = [];

beforeEach(() => {
  harnesses.length = 0;
});

afterEach(async () => {
  for (const h of harnesses) {
    try {
      await fs.rm(h.tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best-effort.
    }
  }
});

async function track(h: Harness): Promise<Harness> {
  harnesses.push(h);
  return h;
}

describe('createOAuthProvidersStore — list', () => {
  it('returns empty array when file does not exist', async () => {
    const h = await track(await makeHarness());
    const result = await h.store.list();
    expect(result).toEqual([]);
  });

  it('returns file-backed records with source=file', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'g-id',
      clientSecret: 'g-secret',
    });
    await h.store.put({
      providerId: 'github',
      clientId: 'gh-id',
      clientSecret: 'gh-secret',
    });
    const result = await h.store.list();
    expect(result.length).toBe(2);
    // Sorted by providerId.
    expect(result[0]?.providerId).toBe('github');
    expect(result[0]?.source).toBe('file');
    expect(result[0]?.enabled).toBe(true);
    expect(result[1]?.providerId).toBe('google');
    expect(result[1]?.source).toBe('file');
  });

  it('env override wins over file value with source=env', async () => {
    // Pre-seed the file with a file-source row, then build a store
    // with env set so we can observe env-wins behavior on list.
    const h1 = await track(await makeHarness());
    await h1.store.put({
      providerId: 'google',
      clientId: 'file-g-id',
      clientSecret: 'file-g-secret',
    });
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-g-id',
      GGUI_OAUTH_GOOGLE_CLIENT_SECRET: 'env-g-secret',
    };
    const logger = makeLogger();
    const store2 = createOAuthProvidersStore({
      filePath: h1.filePath,
      env,
      logger,
    });
    const list = await store2.list();
    expect(list.length).toBe(1);
    expect(list[0]?.source).toBe('env');
    expect(list[0]?.clientId).toBe('env-g-id');
    expect(list[0]?.clientSecret).toBe('env-g-secret');
  });

  it('env override prevents put on the same providerId', async () => {
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-g-id',
      GGUI_OAUTH_GOOGLE_CLIENT_SECRET: 'env-g-secret',
    };
    const h = await track(await makeHarness({ env }));
    await expect(
      h.store.put({
        providerId: 'google',
        clientId: 'file-g-id',
        clientSecret: 'file-g-secret',
      }),
    ).rejects.toThrow(/oauth_provider_env_overridden/);
  });

  it('env override emits source=env, enabled=true regardless of file value', async () => {
    // First write a file value WITHOUT env set.
    const h1 = await track(await makeHarness());
    await h1.store.put({
      providerId: 'google',
      clientId: 'file-g-id',
      clientSecret: 'file-g-secret',
      enabled: false,
    });
    // Now construct a fresh store pointed at the same file but with
    // env set for the same providerId.
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-g-id',
      GGUI_OAUTH_GOOGLE_CLIENT_SECRET: 'env-g-secret',
    };
    const logger = makeLogger();
    const h2: Harness = {
      filePath: h1.filePath,
      tmpDir: h1.tmpDir,
      env,
      logger,
      store: createOAuthProvidersStore({
        filePath: h1.filePath,
        env,
        logger,
      }),
    };
    const list = await h2.store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.providerId).toBe('google');
    expect(list[0]?.source).toBe('env');
    expect(list[0]?.enabled).toBe(true);
    expect(list[0]?.clientId).toBe('env-g-id');
    expect(list[0]?.clientSecret).toBe('env-g-secret');
    // File value still on disk untouched — read raw.
    const raw = JSON.parse(await fs.readFile(h1.filePath, 'utf8')) as {
      providers: Array<{ providerId: string; clientId: string; enabled: boolean }>;
    };
    expect(raw.providers[0]?.clientId).toBe('file-g-id');
    expect(raw.providers[0]?.enabled).toBe(false);
  });

  it('env half-set (only CLIENT_ID, no CLIENT_SECRET) does NOT override', async () => {
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-id',
      // missing GGUI_OAUTH_GOOGLE_CLIENT_SECRET
    };
    const h = await track(await makeHarness({ env }));
    await h.store.put({
      providerId: 'google',
      clientId: 'file-g-id',
      clientSecret: 'file-g-secret',
    });
    const list = await h.store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.source).toBe('file');
    expect(list[0]?.clientId).toBe('file-g-id');
  });

  it('kebab-case providerId maps to underscored env key', async () => {
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_MY_PROVIDER_CLIENT_ID: 'env-id',
      GGUI_OAUTH_MY_PROVIDER_CLIENT_SECRET: 'env-secret',
    };
    const h = await track(await makeHarness({ env }));
    const list = await h.store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.providerId).toBe('my-provider');
    expect(list[0]?.source).toBe('env');
  });
});

describe('createOAuthProvidersStore — get', () => {
  it('returns the file-backed record when present + enabled', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
    });
    const r = await h.store.get('google');
    expect(r).not.toBeNull();
    expect(r?.providerId).toBe('google');
    expect(r?.source).toBe('file');
  });

  it('returns null for absent providerId', async () => {
    const h = await track(await makeHarness());
    expect(await h.store.get('does-not-exist')).toBeNull();
  });

  it('returns null when record is enabled=false', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
      enabled: false,
    });
    expect(await h.store.get('google')).toBeNull();
  });

  it('returns env-overridden record', async () => {
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GITHUB_CLIENT_ID: 'env-id',
      GGUI_OAUTH_GITHUB_CLIENT_SECRET: 'env-secret',
    };
    const h = await track(await makeHarness({ env }));
    const r = await h.store.get('github');
    expect(r).not.toBeNull();
    expect(r?.source).toBe('env');
    expect(r?.clientId).toBe('env-id');
  });
});

describe('createOAuthProvidersStore — put', () => {
  it('writes the file at mode 0o600', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
    });
    const stat = await fs.stat(h.filePath);
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('creates the parent directory if missing', async () => {
    const tmpRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'ggui-oauth-providers-pdir-'),
    );
    const filePath = path.join(tmpRoot, 'nested', 'deeper', 'oauth.json');
    const logger = makeLogger();
    const store = createOAuthProvidersStore({ filePath, env: {}, logger });
    harnesses.push({
      store,
      filePath,
      tmpDir: tmpRoot,
      env: {},
      logger,
    });
    await store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
    });
    const exists = await fs
      .stat(filePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('rejects with oauth_provider_env_overridden when env is set', async () => {
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-id',
      GGUI_OAUTH_GOOGLE_CLIENT_SECRET: 'env-secret',
    };
    const h = await track(await makeHarness({ env }));
    await expect(
      h.store.put({
        providerId: 'google',
        clientId: 'file-id',
        clientSecret: 'file-secret',
      }),
    ).rejects.toThrow(/oauth_provider_env_overridden/);
  });

  it('rejects on invalid providerId — UPPERCASE', async () => {
    const h = await track(await makeHarness());
    await expect(
      h.store.put({
        providerId: 'Google',
        clientId: 'id',
        clientSecret: 'secret',
      }),
    ).rejects.toThrow(/oauth_provider_invalid_id/);
  });

  it('rejects on invalid providerId — with space', async () => {
    const h = await track(await makeHarness());
    await expect(
      h.store.put({
        providerId: 'with space',
        clientId: 'id',
        clientSecret: 'secret',
      }),
    ).rejects.toThrow(/oauth_provider_invalid_id/);
  });

  it('rejects on invalid providerId — with slash', async () => {
    const h = await track(await makeHarness());
    await expect(
      h.store.put({
        providerId: 'with/slash',
        clientId: 'id',
        clientSecret: 'secret',
      }),
    ).rejects.toThrow(/oauth_provider_invalid_id/);
  });

  it('rejects on empty clientId', async () => {
    const h = await track(await makeHarness());
    await expect(
      h.store.put({
        providerId: 'google',
        clientId: '',
        clientSecret: 'secret',
      }),
    ).rejects.toThrow(/oauth_provider_invalid_client_id/);
  });

  it('rejects on empty clientSecret', async () => {
    const h = await track(await makeHarness());
    await expect(
      h.store.put({
        providerId: 'google',
        clientId: 'id',
        clientSecret: '',
      }),
    ).rejects.toThrow(/oauth_provider_invalid_client_secret/);
  });

  it('round-trip: put then list returns the same shape', async () => {
    const h = await track(await makeHarness());
    const written = await h.store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
    });
    expect(written.source).toBe('file');
    expect(written.enabled).toBe(true);
    const list = await h.store.list();
    expect(list[0]).toEqual(written);
  });

  it('overwrites an existing record on second put', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'id-1',
      clientSecret: 'secret-1',
    });
    await h.store.put({
      providerId: 'google',
      clientId: 'id-2',
      clientSecret: 'secret-2',
    });
    const list = await h.store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.clientId).toBe('id-2');
  });
});

describe('createOAuthProvidersStore — setEnabled', () => {
  it('flips a record from enabled=true to enabled=false; get returns null after', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
    });
    await h.store.setEnabled('google', false);
    expect(await h.store.get('google')).toBeNull();
    const list = await h.store.list();
    expect(list[0]?.enabled).toBe(false);
  });

  it('rejects with oauth_provider_env_overridden when env is set', async () => {
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-id',
      GGUI_OAUTH_GOOGLE_CLIENT_SECRET: 'env-secret',
    };
    const h = await track(await makeHarness({ env }));
    await expect(h.store.setEnabled('google', false)).rejects.toThrow(
      /oauth_provider_env_overridden/,
    );
  });

  it('throws oauth_provider_not_found when record is absent', async () => {
    const h = await track(await makeHarness());
    await expect(h.store.setEnabled('google', false)).rejects.toThrow(
      /oauth_provider_not_found/,
    );
  });
});

describe('createOAuthProvidersStore — remove', () => {
  it('deletes a file-backed record', async () => {
    const h = await track(await makeHarness());
    await h.store.put({
      providerId: 'google',
      clientId: 'id',
      clientSecret: 'secret',
    });
    await h.store.remove('google');
    expect(await h.store.list()).toEqual([]);
  });

  it('no-op on env-overridden record (file value untouched)', async () => {
    // Write file first WITHOUT env.
    const h1 = await track(await makeHarness());
    await h1.store.put({
      providerId: 'google',
      clientId: 'file-id',
      clientSecret: 'file-secret',
    });
    // Now construct a fresh store with env set, attempt remove.
    const env: Record<string, string | undefined> = {
      GGUI_OAUTH_GOOGLE_CLIENT_ID: 'env-id',
      GGUI_OAUTH_GOOGLE_CLIENT_SECRET: 'env-secret',
    };
    const logger = makeLogger();
    const store2 = createOAuthProvidersStore({
      filePath: h1.filePath,
      env,
      logger,
    });
    await store2.remove('google');
    // File still has the old record.
    const raw = JSON.parse(await fs.readFile(h1.filePath, 'utf8')) as {
      providers: Array<{ providerId: string; clientId: string }>;
    };
    expect(raw.providers.length).toBe(1);
    expect(raw.providers[0]?.clientId).toBe('file-id');
  });

  it('no-op on absent providerId', async () => {
    const h = await track(await makeHarness());
    await h.store.remove('not-there'); // does not throw
    expect(await h.store.list()).toEqual([]);
  });
});

describe('createOAuthProvidersStore — corrupt file handling', () => {
  it('returns empty list + warns on JSON parse error', async () => {
    const h = await track(await makeHarness());
    await fs.mkdir(path.dirname(h.filePath), { recursive: true });
    await fs.writeFile(h.filePath, '{ not valid json', { mode: 0o600 });
    const list = await h.store.list();
    expect(list).toEqual([]);
    const corruptLog = h.logger.captured.find(
      (l) => l.event === 'oauth_providers_file_corrupt',
    );
    expect(corruptLog).toBeDefined();
    expect(corruptLog?.level).toBe('warn');
  });

  it('returns empty list when file is valid JSON but providers is not an array', async () => {
    const h = await track(await makeHarness());
    await fs.mkdir(path.dirname(h.filePath), { recursive: true });
    await fs.writeFile(
      h.filePath,
      JSON.stringify({ version: '1', providers: 'not-an-array' }),
      { mode: 0o600 },
    );
    const list = await h.store.list();
    expect(list).toEqual([]);
  });

  it('warns + still reads when file mode is too permissive', async () => {
    const h = await track(await makeHarness());
    await fs.mkdir(path.dirname(h.filePath), { recursive: true });
    await fs.writeFile(
      h.filePath,
      JSON.stringify({
        version: '1',
        providers: [
          {
            providerId: 'google',
            clientId: 'id',
            clientSecret: 'secret',
            enabled: true,
          },
        ],
      }),
      { mode: 0o644 },
    );
    const list = await h.store.list();
    expect(list.length).toBe(1);
    const laxLog = h.logger.captured.find(
      (l) => l.event === 'oauth_providers_file_lax_mode',
    );
    expect(laxLog).toBeDefined();
  });
});
