/**
 * Contract test factory for {@link PairingService} implementations.
 *
 * Normative semantics covered:
 *   - `initPairing()` returns a code + expiry + serverName.
 *   - `activeInit()` returns null before any mint, echoes the latest
 *     mint, and returns null for expired codes (read-only: must not
 *     consume the pending state).
 *   - `completePairing()` with a valid code consumes it (one-shot),
 *     mints a token, and returns a `PairingCompletion`.
 *   - A second `completePairing()` with the same code fails.
 *   - `completePairing()` with a stale (expired) code fails.
 *   - `completePairing()` with no pending code fails.
 *   - `listPairings()` shows completed pairings; revoked ones are gone.
 *   - `revokePairing()` is idempotent (revoking an unknown id is fine).
 *
 * Pass a `clock` factory for deterministic TTL tests. Omitting it
 * skips the expiry test rather than failing it.
 */
import { describe, expect, it } from 'vitest';
import type { PairingService } from '../pairing.js';

export interface PairingContractClock {
  now(): number;
  tick(ms: number): void;
}

export interface PairingContractOptions {
  /**
   * Factory producing `(clock, service)` pairs so the expiry test can
   * deterministically advance time past the pairing-code TTL.
   */
  makeWithClock?: () => Promise<{
    clock: PairingContractClock;
    service: PairingService;
  }>;
}

export function pairingServiceContract(
  label: string,
  makeService: () => Promise<PairingService> | PairingService,
  opts: PairingContractOptions = {},
): void {
  describe(`PairingService contract — ${label}`, () => {
    it('initPairing returns a code + expiry + serverName', async () => {
      const p = await makeService();
      const init = await p.initPairing();
      expect(init.code).toBeTruthy();
      expect(init.code.length).toBeGreaterThanOrEqual(4);
      expect(typeof init.codeExpiresAt).toBe('number');
      expect(init.codeExpiresAt).toBeGreaterThan(0);
      expect(init.serverName).toBeTruthy();
    });

    it('activeInit returns null before any mint', async () => {
      const p = await makeService();
      await expect(p.activeInit()).resolves.toBeNull();
    });

    it('activeInit echoes the latest mint without consuming it', async () => {
      const p = await makeService();
      const init = await p.initPairing();
      const active = await p.activeInit();
      expect(active).not.toBeNull();
      expect(active!.code).toBe(init.code);
      expect(active!.codeExpiresAt).toBe(init.codeExpiresAt);
      // Read-only: calling again must NOT consume the pending code —
      // completePairing with the same code must still succeed.
      const again = await p.activeInit();
      expect(again).not.toBeNull();
      await expect(
        p.completePairing({ code: init.code, deviceName: 'post-active' }),
      ).resolves.toMatchObject({ deviceName: 'post-active' });
    });

    it('activeInit reflects the most recent mint (overwrite semantics)', async () => {
      const p = await makeService();
      await p.initPairing();
      const second = await p.initPairing();
      const active = await p.activeInit();
      expect(active).not.toBeNull();
      expect(active!.code).toBe(second.code);
    });

    it('completePairing with a valid code mints a token and persists the pairing', async () => {
      const p = await makeService();
      const init = await p.initPairing();
      const completion = await p.completePairing({
        code: init.code,
        deviceName: 'iPhone 15',
      });
      expect(completion.pairingId).toBeTruthy();
      expect(completion.token).toBeTruthy();
      expect(completion.deviceName).toBe('iPhone 15');
      expect(completion.serverName).toBe(init.serverName);

      const list = await p.listPairings();
      expect(list).toHaveLength(1);
      expect(list[0]?.pairingId).toBe(completion.pairingId);
      expect(list[0]?.deviceName).toBe('iPhone 15');
    });

    it('completePairing is one-shot: reusing the same code fails', async () => {
      const p = await makeService();
      const init = await p.initPairing();
      await p.completePairing({ code: init.code, deviceName: 'A' });
      await expect(
        p.completePairing({ code: init.code, deviceName: 'B' }),
      ).rejects.toThrow();
    });

    it('completePairing with a wrong code fails', async () => {
      const p = await makeService();
      await p.initPairing();
      await expect(
        p.completePairing({ code: 'wrong-code', deviceName: 'A' }),
      ).rejects.toThrow();
    });

    it('completePairing with no pending code fails', async () => {
      const p = await makeService();
      await expect(
        p.completePairing({ code: '123456', deviceName: 'A' }),
      ).rejects.toThrow();
    });

    it('revokePairing removes the pairing from the list', async () => {
      const p = await makeService();
      const init = await p.initPairing();
      const c = await p.completePairing({
        code: init.code,
        deviceName: 'A',
      });
      await p.revokePairing(c.pairingId);
      const list = await p.listPairings();
      expect(list).toHaveLength(0);
    });

    it('revokePairing is idempotent', async () => {
      const p = await makeService();
      await expect(p.revokePairing('unknown-id')).resolves.toBeUndefined();
      const init = await p.initPairing();
      const c = await p.completePairing({
        code: init.code,
        deviceName: 'A',
      });
      await p.revokePairing(c.pairingId);
      await expect(p.revokePairing(c.pairingId)).resolves.toBeUndefined();
    });

    if (opts.makeWithClock) {
      const makeWithClock = opts.makeWithClock;

      it('completePairing fails when the code has expired', async () => {
        const { clock, service } = await makeWithClock();
        const init = await service.initPairing();
        clock.tick(init.codeExpiresAt - clock.now() + 1);
        await expect(
          service.completePairing({ code: init.code, deviceName: 'A' }),
        ).rejects.toThrow();
      });

      it('activeInit returns null once the pending code expires', async () => {
        const { clock, service } = await makeWithClock();
        await service.initPairing();
        expect(await service.activeInit()).not.toBeNull();
        // Advance past the TTL.
        const init = await service.activeInit();
        clock.tick(init!.codeExpiresAt - clock.now() + 1);
        expect(await service.activeInit()).toBeNull();
      });
    }
  });
}
