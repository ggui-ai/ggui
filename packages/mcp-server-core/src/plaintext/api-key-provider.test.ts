/**
 * Plaintext api-key-provider tests.
 *
 * Two layers:
 *   1. Shared contract suite — parity with the in-memory reference.
 *   2. File-backed specifics — persistence across instances, chmod
 *      0o600, no secret on disk, malformed-document rejection,
 *      empty-file handling.
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { apiKeyProviderContract } from '../contract-tests/api-key-provider.js';
import { PlaintextFileApiKeyProvider } from './api-key-provider.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'ggui-api-key-provider-test-'));
let pathCounter = 0;
function tempPath(): string {
  pathCounter += 1;
  return join(tmpRoot, `keys-${pathCounter}.json`);
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── contract suite ───────────────────────────────────────────────────

apiKeyProviderContract(
  'PlaintextFileApiKeyProvider',
  () => new PlaintextFileApiKeyProvider({ filename: tempPath() }),
);

// ── file-backed specifics ────────────────────────────────────────────

describe('PlaintextFileApiKeyProvider — file specifics', () => {
  it('persists records across provider instances on the same file', async () => {
    const path = tempPath();
    const a = new PlaintextFileApiKeyProvider({ filename: path });
    const minted = await a.mint({ appId: 'app-a', label: 'laptop' });

    // Fresh instance sees the record and verifies the same secret.
    const b = new PlaintextFileApiKeyProvider({ filename: path });
    const list = await b.list('app-a');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(minted.record.id);
    const verified = await b.verify(minted.secret);
    expect(verified?.id).toBe(minted.record.id);
  });

  it('never writes the plaintext secret to disk', async () => {
    const path = tempPath();
    const provider = new PlaintextFileApiKeyProvider({ filename: path });
    const { secret } = await provider.mint({ appId: 'app-a' });
    const raw = readFileSync(path, 'utf8');
    // Neither the full secret nor the random tail should appear.
    expect(raw).not.toContain(secret);
    const tail = secret.slice('ggui_sk_'.length);
    expect(raw).not.toContain(tail);
    // A hash (64 hex chars) MUST be present.
    expect(raw).toMatch(/"secretHash":\s*"[a-f0-9]{64}"/);
  });

  it('chmods the file to 0o600 on every write', async () => {
    if (process.platform === 'win32') return;
    const path = tempPath();
    const provider = new PlaintextFileApiKeyProvider({ filename: path });
    await provider.mint({ appId: 'app-a' });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    chmodSync(path, 0o644);
    await provider.mint({ appId: 'app-a' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('revoke persists to disk', async () => {
    const path = tempPath();
    const a = new PlaintextFileApiKeyProvider({ filename: path });
    const minted = await a.mint({ appId: 'app-a' });
    await a.revoke(minted.record.id);

    const b = new PlaintextFileApiKeyProvider({ filename: path });
    await expect(b.verify(minted.secret)).resolves.toBeNull();
    await expect(b.list('app-a')).resolves.toEqual([]);
  });

  it('treats an empty file as empty state', async () => {
    const path = tempPath();
    writeFileSync(path, '', 'utf8');
    const provider = new PlaintextFileApiKeyProvider({ filename: path });
    await expect(provider.list('app-a')).resolves.toEqual([]);
    const minted = await provider.mint({ appId: 'app-a' });
    await expect(provider.verify(minted.secret)).resolves.not.toBeNull();
  });

  it('throws on a malformed document rather than silently resetting', async () => {
    const path = tempPath();
    writeFileSync(path, '{"version": 99, "keys": []}', 'utf8');
    const provider = new PlaintextFileApiKeyProvider({ filename: path });
    await expect(provider.list('app-a')).rejects.toThrow(
      /not a valid v1 document/,
    );
  });

  it('creates parent directories on first write', async () => {
    const path = join(tmpRoot, 'nested', 'dir', 'api-keys.json');
    const provider = new PlaintextFileApiKeyProvider({ filename: path });
    const minted = await provider.mint({ appId: 'app-a' });
    const reread = new PlaintextFileApiKeyProvider({ filename: path });
    await expect(reread.verify(minted.secret)).resolves.not.toBeNull();
  });
});
