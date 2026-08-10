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
import { ARTIFACTS_METADATA_SK, type ArtifactsMetadataRow } from '@ggui-ai/registry-core';
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

  it('rejects path-traversal in authorKey keyIds; traversal-shaped subjects are neutralized by encoding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-fs-reg-traversal2-'));
    try {
      const storage = createFilesystemRegistryStorage({ root });
      // keyId keeps the hard guard (base64url by derivation — '.', '/',
      // '\\' are unrepresentable, so any occurrence is an attack).
      await expect(
        storage.getAuthorKey('alice', '..\\bad'),
      ).rejects.toThrow(/path-traversal/);
      await expect(
        storage.getAuthorKey('alice', '../bad'),
      ).rejects.toThrow(/path-traversal/);
      // Subjects are operator-defined free text — a traversal-shaped
      // subject is LEGAL input, neutralized by encodeRowKey ('/' →
      // %2F) before it becomes a filename component. Round-trip stays
      // inside the author-keys dir.
      await storage.putAuthorKey({
        subject: '../escape',
        keyId: 'k1',
        publicKeyBase64: 'AAAA',
      });
      expect(await storage.getAuthorKey('../escape', 'k1')).toEqual({
        subject: '../escape',
        keyId: 'k1',
        publicKeyBase64: 'AAAA',
      });
      // Nothing escaped the root: the parent of the storage root has
      // gained no files (the row landed under state/author-keys).
      expect(await storage.getAuthorKey('escape', 'k1')).toBe(null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('FilesystemRegistryStorage — mcp tool filters', () => {
  function makeRow(overrides: Partial<ArtifactsMetadataRow>): ArtifactsMetadataRow {
    return {
      artifactId: '@test/foo',
      sk: ARTIFACTS_METADATA_SK,
      kind: 'gadget',
      latestVersion: '0.1.0',
      visibility: 'public',
      publishedAt: '2026-08-10T00:00:00.000Z',
      publishedBy: 'user-1',
      ...overrides,
    };
  }

  it('scanArtifacts honors tool/server filters with the shared semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-fs-reg-mcp-'));
    try {
      const storage = createFilesystemRegistryStorage({ root });
      await storage.putArtifactMetadata(
        makeRow({
          artifactId: '@a/weather-card',
          mcpTools: [{ server: 'weather-server', tool: 'get_weather' }],
          mcpToolsSource: 'declared',
        }),
      );
      await storage.putArtifactMetadata(
        makeRow({
          artifactId: '@b/forecast-panel',
          mcpTools: [{ tool: 'get_weather' }],
          mcpToolsSource: 'derived',
        }),
      );
      await storage.putArtifactMetadata(makeRow({ artifactId: '@c/unbound' }));

      const byTool = await storage.scanArtifacts({ tool: 'get_weather' });
      expect(byTool.rows.map((r) => r.artifactId).sort()).toEqual([
        '@a/weather-card',
        '@b/forecast-panel',
      ]);

      const byServer = await storage.scanArtifacts({ server: 'weather-server' });
      expect(byServer.rows.map((r) => r.artifactId)).toEqual(['@a/weather-card']);

      const byPair = await storage.scanArtifacts({
        tool: 'get_weather',
        server: 'weather-server',
      });
      expect(byPair.rows.map((r) => r.artifactId)).toEqual(['@a/weather-card']);

      const missPair = await storage.scanArtifacts({
        tool: 'get_forecast',
        server: 'weather-server',
      });
      expect(missPair.rows).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
