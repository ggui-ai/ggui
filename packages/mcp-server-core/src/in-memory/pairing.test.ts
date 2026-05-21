import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pairingServiceContract } from '../contract-tests/pairing.js';
import { InMemoryAuthAdapter } from './auth-adapter.js';
import { InMemoryPairingService } from './pairing.js';

pairingServiceContract(
  'InMemoryPairingService',
  () =>
    new InMemoryPairingService({
      serverName: 'my-ggui @ homelab',
    }),
  {
    makeWithClock: async () => {
      let now = 1_700_000_000_000;
      const clock = {
        now: () => now,
        tick: (ms: number) => {
          now += ms;
        },
      };
      return {
        clock,
        service: new InMemoryPairingService({
          serverName: 'test',
          now: clock.now,
        }),
      };
    },
  },
);

describe('InMemoryPairingService — composition with InMemoryAuthAdapter', () => {
  it('issued tokens authenticate via the composed adapter', async () => {
    const adapter = new InMemoryAuthAdapter();
    const pairing = new InMemoryPairingService({
      serverName: 'test',
      onTokenIssued: (token, p) => {
        adapter.registerToken(token, {
          identity: { kind: 'builder' },
          source: 'pairing',
          metadata: { deviceName: p.deviceName, pairingId: p.pairingId },
        });
      },
      onTokenRevoked: (token) => {
        adapter.unregisterToken(token);
      },
    });

    const init = await pairing.initPairing();
    const c = await pairing.completePairing({
      code: init.code,
      deviceName: 'iPhone 15',
    });

    const auth = await adapter.authenticate(c.token);
    expect(auth?.identity.kind).toBe('builder');
    expect(auth?.source).toBe('pairing');
    expect(auth?.metadata?.['deviceName']).toBe('iPhone 15');

    await pairing.revokePairing(c.pairingId);
    await expect(adapter.authenticate(c.token)).resolves.toBeNull();
  });

  it('listPairings exposes the persisted records', async () => {
    const pairing = new InMemoryPairingService({ serverName: 'test' });
    const i1 = await pairing.initPairing();
    await pairing.completePairing({ code: i1.code, deviceName: 'A' });
    const i2 = await pairing.initPairing();
    await pairing.completePairing({ code: i2.code, deviceName: 'B' });
    const list = await pairing.listPairings();
    expect(list.map((p) => p.deviceName)).toEqual(['A', 'B']);
  });

  it('code generator is injectable for deterministic tests', async () => {
    const pairing = new InMemoryPairingService({
      serverName: 'test',
      generateCode: () => '000042',
    });
    const init = await pairing.initPairing();
    expect(init.code).toBe('000042');
  });
});

describe('InMemoryPairingService — default token shape', () => {
  // The OSS in-memory path must mint the SAME token shape as the
  // production `ApiKeyAuthAdapter` (`ggui_user_<12 base64url chars>`).
  // The OAuth consent page placeholder text is `ggui_user_*` — these
  // tests guarantee the implementation matches that placeholder, so
  // tokens copied between paths are interchangeable in form.
  const TOKEN_REGEX = /^ggui_user_[A-Za-z0-9_-]{12}$/;

  it('mints tokens of the form ggui_user_<12 base64url chars>', async () => {
    const pairing = new InMemoryPairingService({ serverName: 'test' });
    const init = await pairing.initPairing();
    const c = await pairing.completePairing({
      code: init.code,
      deviceName: 'A',
    });
    expect(c.token).toMatch(TOKEN_REGEX);
    expect(c.token).toHaveLength(22);
    expect(c.token.startsWith('ggui_user_')).toBe(true);
  });

  it('successive mints produce distinct random tokens', async () => {
    // Each completePairing mints a fresh random token — distinctness
    // proves the suffix is sourced from crypto.randomBytes, not a
    // counter or a fixed seed.
    const pairing = new InMemoryPairingService({ serverName: 'test' });

    const init1 = await pairing.initPairing();
    const c1 = await pairing.completePairing({
      code: init1.code,
      deviceName: 'A',
    });

    const init2 = await pairing.initPairing();
    const c2 = await pairing.completePairing({
      code: init2.code,
      deviceName: 'B',
    });

    expect(c1.token).toMatch(TOKEN_REGEX);
    expect(c2.token).toMatch(TOKEN_REGEX);
    expect(c1.token).not.toBe(c2.token);
  });

  it('token generator is still injectable for deterministic tests', async () => {
    // Override stays available — any caller (e.g. sinks redaction
    // canary in @ggui-ai/mcp-server) that needs a fixed token can
    // still pass `generateToken`.
    const pairing = new InMemoryPairingService({
      serverName: 'test',
      generateToken: () => 'fixed-token-for-test',
    });
    const init = await pairing.initPairing();
    const c = await pairing.completePairing({
      code: init.code,
      deviceName: 'A',
    });
    expect(c.token).toBe('fixed-token-for-test');
  });
});

describe('InMemoryPairingService — persistencePath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pairing-persist-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('survives restart: tokens minted in one process restore in the next', async () => {
    const path = join(dir, 'keys.json');

    // First "process" — mint two pairs.
    const first = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    const init1 = await first.initPairing();
    const c1 = await first.completePairing({ code: init1.code, deviceName: 'device-1' });
    const init2 = await first.initPairing();
    const c2 = await first.completePairing({ code: init2.code, deviceName: 'device-2' });

    // Second "process" — fresh instance reading the same file.
    const adapter = new InMemoryAuthAdapter();
    const second = new InMemoryPairingService({
      serverName: 'test',
      persistencePath: path,
      onTokenIssued: (token, pairing) =>
        adapter.registerToken(token, {
          identity: { kind: 'builder' },
          source: 'pairing',
          metadata: { deviceName: pairing.deviceName, pairingId: pairing.pairingId },
        }),
    });

    const restored = await second.listPairings();
    expect(restored.map((p) => p.deviceName).sort()).toEqual(['device-1', 'device-2']);

    // Replay must have re-registered tokens with the bridged adapter.
    const id1 = await adapter.getIdentity({ headers: { authorization: `Bearer ${c1.token}` } });
    const id2 = await adapter.getIdentity({ headers: { authorization: `Bearer ${c2.token}` } });
    expect(id1).not.toBeNull();
    expect(id2).not.toBeNull();
  });

  it('writes the file with 0600 perms on every mutation', async () => {
    const path = join(dir, 'keys.json');
    const svc = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    const init = await svc.initPairing();
    await svc.completePairing({ code: init.code, deviceName: 'A' });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('idCounter monotonically advances after restore (no id collision)', async () => {
    const path = join(dir, 'keys.json');
    const first = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    const i1 = await first.initPairing();
    const c1 = await first.completePairing({ code: i1.code, deviceName: 'A' });
    expect(c1.pairingId).toBe('pair-1');
    const i2 = await first.initPairing();
    const c2 = await first.completePairing({ code: i2.code, deviceName: 'B' });
    expect(c2.pairingId).toBe('pair-2');

    // Fresh instance — third mint must not collide with existing pair-1/pair-2.
    const second = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    const i3 = await second.initPairing();
    const c3 = await second.completePairing({ code: i3.code, deviceName: 'C' });
    expect(c3.pairingId).toBe('pair-3');
  });

  it('revokePairing is reflected after restart', async () => {
    const path = join(dir, 'keys.json');
    const first = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    const i1 = await first.initPairing();
    const c1 = await first.completePairing({ code: i1.code, deviceName: 'A' });
    await first.revokePairing(c1.pairingId);

    const second = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    const restored = await second.listPairings();
    expect(restored).toEqual([]);
  });

  it('throws on malformed JSON (loud failure beats silent loss)', () => {
    const path = join(dir, 'keys.json');
    writeFileSync(path, 'not valid json');
    expect(
      () => new InMemoryPairingService({ serverName: 'test', persistencePath: path }),
    ).toThrow();
  });

  it('treats missing file as empty (first-boot path)', async () => {
    const path = join(dir, 'subdir-not-yet-created', 'keys.json');
    const svc = new InMemoryPairingService({ serverName: 'test', persistencePath: path });
    expect(await svc.listPairings()).toEqual([]);
    // First mint creates parent dir + writes file.
    const i = await svc.initPairing();
    await svc.completePairing({ code: i.code, deviceName: 'A' });
    expect(JSON.parse(readFileSync(path, 'utf8')).v).toBe(1);
  });
});
