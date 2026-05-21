/**
 * `FilesystemBundleStorage` contract test. Runs the full
 * {@link bundleStorageContract} suite from `@ggui-ai/registry-core`
 * against a fresh tmpdir per case + adds impl-specific tests:
 *
 *   - Path-traversal rejection on every {scope, name, version} field.
 *   - URL composition matches the served-path layout.
 */
import { mkdtempSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bundleStorageContract } from '@ggui-ai/registry-core/testing';
import { createFilesystemBundleStorage } from './filesystem-bundle-storage.js';

const allocatedRoots: string[] = [];

bundleStorageContract(() => {
  const root = mkdtempSync(join(tmpdir(), 'ggui-bundle-server-test-'));
  allocatedRoots.push(root);
  return createFilesystemBundleStorage({
    root,
    bundleHost: 'https://test.invalid',
  });
});

afterAll(async () => {
  await Promise.all(
    allocatedRoots.map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('FilesystemBundleStorage — impl-specific', () => {
  it('composes URLs against the configured bundleHost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-bundle-url-'));
    try {
      const s = createFilesystemBundleStorage({
        root,
        bundleHost: 'http://localhost:9001',
      });
      expect(s.bundleUrl('@a', 'b', '0.1.0')).toBe(
        'http://localhost:9001/bundles/@a/b/0.1.0/bundle.js',
      );
      expect(s.signatureUrl('@a', 'b', '0.1.0')).toBe(
        'http://localhost:9001/bundles/@a/b/0.1.0/bundle.js.sig',
      );
      expect(s.manifestUrl('@a', 'b', '0.1.0')).toBe(
        'http://localhost:9001/bundles/@a/b/0.1.0/manifest.json',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('strips a trailing slash from bundleHost', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-bundle-trailing-'));
    try {
      const s = createFilesystemBundleStorage({
        root,
        bundleHost: 'http://localhost:9001/',
      });
      expect(s.bundleUrl('@a', 'b', '0.1.0')).toBe(
        'http://localhost:9001/bundles/@a/b/0.1.0/bundle.js',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal in scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-bundle-trav1-'));
    try {
      const s = createFilesystemBundleStorage({ root, bundleHost: 'http://t' });
      await expect(s.getBundle('../bad', 'name', '0.1.0')).rejects.toThrow(
        /path-traversal/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal in name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-bundle-trav2-'));
    try {
      const s = createFilesystemBundleStorage({ root, bundleHost: 'http://t' });
      await expect(s.getBundle('@a', '../bad', '0.1.0')).rejects.toThrow(
        /path-traversal/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects path-traversal in version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ggui-bundle-trav3-'));
    try {
      const s = createFilesystemBundleStorage({ root, bundleHost: 'http://t' });
      await expect(s.getBundle('@a', 'b', '../bad')).rejects.toThrow(
        /path-traversal/,
      );
      expect(() => s.bundleUrl('@a', 'b', '..\\bad')).toThrow(/path-traversal/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
