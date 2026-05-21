/**
 * `FilesystemRegistryStorage` contract test. Runs the full
 * {@link registryStorageContract} suite from `@ggui-ai/registry-core`
 * against a fresh tmpdir per case + adds impl-specific tests:
 *
 *   - Path-traversal rejection at the row-key boundary.
 *   - State persists across factory calls against the same root.
 */
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { registryStorageContract } from '@ggui-ai/registry-core/testing';
import { createFilesystemRegistryStorage } from './filesystem-registry-storage.js';

// ─── Contract suite ──────────────────────────────────────────────────────
// We allocate a new tmpdir each time the factory runs so the contract
// tests get isolated state. Cleanup happens at suite teardown. The
// contract factory is synchronous, so we use `mkdtempSync`.

const allocatedRoots: string[] = [];

registryStorageContract(() => {
  const root = mkdtempSync(join(tmpdir(), 'ggui-registry-server-test-'));
  allocatedRoots.push(root);
  return createFilesystemRegistryStorage({ root });
});

afterAll(async () => {
  await Promise.all(
    allocatedRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

// ─── Impl-specific tests ─────────────────────────────────────────────────

describe('FilesystemRegistryStorage — impl-specific', () => {
  it('persists state across factory rebinds against the same root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-fs-reg-persist-'));
    try {
      const a = createFilesystemRegistryStorage({ root });
      await a.putArtifactMetadata({
        artifactId: '@a/b',
        sk: 'metadata#',
        kind: 'gadget',
        latestVersion: '0.1.0',
        visibility: 'public',
        publishedAt: '2026-05-17T00:00:00.000Z',
        publishedBy: 'u1',
      });
      const b = createFilesystemRegistryStorage({ root });
      const row = await b.getArtifactMetadata('@a/b');
      expect(row?.latestVersion).toBe('0.1.0');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal in version field on putArtifactVersionIfAbsent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-fs-reg-traversal-'));
    try {
      const storage = createFilesystemRegistryStorage({ root });
      await expect(
        storage.putArtifactVersionIfAbsent({
          artifactId: '@a/b',
          version: '../escape',
          manifest: {} as never,
          kind: 'gadget',
          visibility: 'public',
          publishedAt: '2026-05-17T00:00:00.000Z',
          publishedBy: 'u1',
        }),
      ).rejects.toThrow(/path-traversal/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal in authorKey fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-fs-reg-traversal2-'));
    try {
      const storage = createFilesystemRegistryStorage({ root });
      await expect(
        storage.getAuthorKey('../bad', 'k1'),
      ).rejects.toThrow(/path-traversal/);
      await expect(
        storage.getAuthorKey('alice', '..\\bad'),
      ).rejects.toThrow(/path-traversal/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
