/**
 * Plaintext provider-key-store tests.
 *
 * Two layers:
 *   1. Shared contract suite — parity with the in-memory reference.
 *   2. File-backed specifics — persistence across instances, chmod
 *      0o600, rejection of malformed documents, graceful empty-file
 *      handling.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { providerKeyStoreContract } from '../contract-tests/provider-key-store.js';
import { PlaintextFileProviderKeyStore } from './provider-key-store.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-provider-key-store-test-'));
let pathCounter = 0;
function tempPath(): string {
  pathCounter += 1;
  return join(tmpRoot, `keys-${pathCounter}.json`);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── contract suite (each test gets a fresh file) ─────────────────────

providerKeyStoreContract(
  'PlaintextFileProviderKeyStore',
  () => new PlaintextFileProviderKeyStore({ filename: tempPath() }),
);

// ── file-backed specifics ────────────────────────────────────────────

describe('PlaintextFileProviderKeyStore — file specifics', () => {
  it('persists keys across store instances on the same file', async () => {
    const path = tempPath();
    const a = new PlaintextFileProviderKeyStore({ filename: path });
    await a.set('app-a', 'anthropic', 'key-A');
    await a.set('app-b', 'openai', 'key-B');

    const b = new PlaintextFileProviderKeyStore({ filename: path });
    const keyA = await b.get('app-a', 'anthropic');
    const keyB = await b.get('app-b', 'openai');
    expect(keyA?.key).toBe('key-A');
    expect(keyB?.key).toBe('key-B');
  });

  it('chmods the file to 0o600 on every write', async () => {
    // POSIX-only check — Windows / some Node / FS combos may not
    // honor chmod. The adapter swallows chmod errors, so we only
    // assert when the platform supports mode bits.
    if (process.platform === 'win32') return;
    const path = tempPath();
    const store = new PlaintextFileProviderKeyStore({ filename: path });
    await store.set('app-a', 'anthropic', 'key');
    // File should be r/w for owner only.
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    // If the file's permissions widen between writes, the next
    // write must re-clamp them.
    chmodSync(path, 0o644);
    await store.set('app-a', 'openai', 'key');
    const modeAfter = statSync(path).mode & 0o777;
    expect(modeAfter).toBe(0o600);
  });

  it('writes a human-readable JSON document (auditable)', async () => {
    const path = tempPath();
    const store = new PlaintextFileProviderKeyStore({ filename: path });
    await store.set('app-a', 'anthropic', 'key-A');
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as {
      version: number;
      apps: Record<string, Record<string, string>>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.apps['app-a']?.['anthropic']).toBe('key-A');
    // Pretty-printed so `cat` is useful.
    expect(raw).toContain('\n');
  });

  it('treats an empty file as empty state (operators use `: > file` to reset)', async () => {
    const path = tempPath();
    writeFileSync(path, '', 'utf8');
    const store = new PlaintextFileProviderKeyStore({ filename: path });
    await expect(store.listProviders('app-a')).resolves.toEqual([]);
    // Subsequent writes work normally.
    await store.set('app-a', 'anthropic', 'key');
    expect((await store.get('app-a', 'anthropic'))?.key).toBe('key');
  });

  it('throws on a malformed document rather than silently resetting', async () => {
    const path = tempPath();
    writeFileSync(path, '{"version": 2, "apps": {}}', 'utf8');
    const store = new PlaintextFileProviderKeyStore({ filename: path });
    await expect(store.get('app-a', 'anthropic')).rejects.toThrow(
      /not a valid v1 document/,
    );
  });

  it('creates parent directories on first write', async () => {
    const path = join(tmpRoot, 'nested', 'dir', 'keys.json');
    const store = new PlaintextFileProviderKeyStore({ filename: path });
    await store.set('app-a', 'anthropic', 'key');
    // File exists + round-trips.
    const reread = new PlaintextFileProviderKeyStore({ filename: path });
    expect((await reread.get('app-a', 'anthropic'))?.key).toBe('key');
  });
});
