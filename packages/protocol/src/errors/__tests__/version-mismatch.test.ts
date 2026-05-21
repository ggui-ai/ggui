/**
 * Typed-error surface for protocol-version handshake.
 *
 * Proves the Phase 1 Item 6 acceptance criterion that
 * `UPGRADE_REQUIRED` is reachable via a typed error class, not just
 * via raw string compares against `ErrorPayload.code` /
 * `err.message`.
 */
import { describe, it, expect } from 'vitest';
import {
  UPGRADE_REQUIRED,
  UpgradeRequiredError,
  CLIENT_SUPPORTED_VERSIONS,
} from '../../index.js';

describe('UpgradeRequiredError', () => {
  it('pins .name for typed dispatch + .code to the canonical wire literal', () => {
    const err = new UpgradeRequiredError({
      observedVersion: 'draft-2027-99-99',
      acceptedVersions: CLIENT_SUPPORTED_VERSIONS,
      observedBy: 'client',
    });
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UpgradeRequiredError');
    expect(err.code).toBe(UPGRADE_REQUIRED);
    expect(err.code).toBe('UPGRADE_REQUIRED');
  });

  it('carries the observed + accepted versions so operators can diagnose', () => {
    const err = new UpgradeRequiredError({
      observedVersion: 'v-old',
      acceptedVersions: ['v-new', 'v-newer'],
      observedBy: 'server',
    });
    expect(err.observedVersion).toBe('v-old');
    expect(err.acceptedVersions).toEqual(['v-new', 'v-newer']);
    expect(err.observedBy).toBe('server');
  });

  it('renders an array-shaped observedVersion (server observes client set)', () => {
    const err = new UpgradeRequiredError({
      observedVersion: ['v1', 'v2'],
      acceptedVersions: ['v3'],
      observedBy: 'server',
    });
    expect(err.message).toContain('v1, v2');
    expect(err.message).toContain('v3');
  });

  it('handles absent observedVersion (defensive: when the peer did not declare)', () => {
    const err = new UpgradeRequiredError({
      acceptedVersions: ['v-accepted'],
      observedBy: 'client',
    });
    expect(err.observedVersion).toBeUndefined();
    expect(err.message).toContain('unknown');
    expect(err.message).toContain('v-accepted');
  });

  it('names directional framing correctly — server observes client, client observes server', () => {
    const serverObserves = new UpgradeRequiredError({
      observedVersion: 'old',
      acceptedVersions: ['new'],
      observedBy: 'server',
    });
    expect(serverObserves.message).toMatch(/client speaks/);

    const clientObserves = new UpgradeRequiredError({
      observedVersion: 'old',
      acceptedVersions: ['new'],
      observedBy: 'client',
    });
    expect(clientObserves.message).toMatch(/server speaks/);
  });
});
