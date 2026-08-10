/**
 * `canReadPrivateArtifact` — the single ownership rule for private-row
 * reads. Both read-path ops (read, list-versions) and any
 * transport-level private-fetch route MUST authorize through this one
 * predicate so the rule can never fork.
 */
import { describe, expect, it, vi } from 'vitest';
import { canReadPrivateArtifact } from './private-read-authz.js';
import type { ScopeOwnerRow } from '../types.js';

function ownerRow(overrides: Partial<ScopeOwnerRow> = {}): ScopeOwnerRow {
  return {
    scope: '@test',
    ownerSubject: 'owner-9',
    claimedAt: '2026-08-01T00:00:00.000Z',
    verification: 'unverified',
    ...overrides,
  };
}

describe('canReadPrivateArtifact', () => {
  it('denies anonymous callers without consulting the scope owner', async () => {
    const getScopeOwner = vi.fn(async () => ownerRow());
    const allowed = await canReadPrivateArtifact(
      undefined,
      { publishedBy: 'user-1' },
      getScopeOwner,
    );
    expect(allowed).toBe(false);
    expect(getScopeOwner).not.toHaveBeenCalled();
  });

  it('allows the publisher without consulting the scope owner (zero-extra-reads fast path)', async () => {
    const getScopeOwner = vi.fn(async () => ownerRow());
    const allowed = await canReadPrivateArtifact(
      { subject: 'user-1' },
      { publishedBy: 'user-1' },
      getScopeOwner,
    );
    expect(allowed).toBe(true);
    expect(getScopeOwner).not.toHaveBeenCalled();
  });

  it('allows the scope owner when the caller is not the publisher', async () => {
    const getScopeOwner = vi.fn(async () => ownerRow({ ownerSubject: 'owner-9' }));
    const allowed = await canReadPrivateArtifact(
      { subject: 'owner-9' },
      { publishedBy: 'user-1' },
      getScopeOwner,
    );
    expect(allowed).toBe(true);
    expect(getScopeOwner).toHaveBeenCalledTimes(1);
  });

  it('denies a caller who is neither publisher nor scope owner', async () => {
    const getScopeOwner = vi.fn(async () => ownerRow({ ownerSubject: 'owner-9' }));
    const allowed = await canReadPrivateArtifact(
      { subject: 'stranger-2' },
      { publishedBy: 'user-1' },
      getScopeOwner,
    );
    expect(allowed).toBe(false);
  });

  it('denies a non-publisher when the scope is unclaimed (null owner row)', async () => {
    const getScopeOwner = vi.fn(async () => null);
    const allowed = await canReadPrivateArtifact(
      { subject: 'stranger-2' },
      { publishedBy: 'user-1' },
      getScopeOwner,
    );
    expect(allowed).toBe(false);
  });
});

describe('artifactScope', () => {
  it('extracts the scope segment from an artifactId', async () => {
    const { artifactScope } = await import('./private-read-authz.js');
    expect(artifactScope('@test/foo')).toBe('@test');
  });
});

describe('createScopeOwnerResolver', () => {
  it('memoizes — many invocations cost one storage lookup', async () => {
    const { createScopeOwnerResolver } = await import('./private-read-authz.js');
    const getScopeOwner = vi.fn(async () => ownerRow());
    const resolve = createScopeOwnerResolver({ getScopeOwner }, '@test/foo');
    await resolve();
    await resolve();
    const owner = await resolve();
    expect(owner?.ownerSubject).toBe('owner-9');
    expect(getScopeOwner).toHaveBeenCalledTimes(1);
    expect(getScopeOwner).toHaveBeenCalledWith('@test');
  });

  it('fails closed — a storage fault resolves to null (deny) instead of rejecting', async () => {
    const { createScopeOwnerResolver } = await import('./private-read-authz.js');
    const getScopeOwner = vi.fn(async (): Promise<ScopeOwnerRow | null> => {
      throw new Error('simulated storage outage');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const resolve = createScopeOwnerResolver({ getScopeOwner }, '@test/foo');
      await expect(resolve()).resolves.toBeNull();
      // The fault is an operator signal, not a wire signal.
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
