import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeRuntimeBundleHash,
  insertRuntimeBundleHash,
  resolveHashedRuntimeBundleUrl,
} from './runtime-bundle-hash.js';

describe('computeRuntimeBundleHash', () => {
  it('is sha256 truncated to 12 hex chars — the immutable-route naming scheme', () => {
    const bytes = Buffer.from('globalThis.__bundle = 1;');
    const expected = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    expect(computeRuntimeBundleHash(bytes)).toBe(expected);
    expect(computeRuntimeBundleHash(bytes)).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('insertRuntimeBundleHash', () => {
  const hash = 'abc123def456';

  it('inserts the hash before the extension on a matching path', () => {
    expect(insertRuntimeBundleHash('/_ggui/iframe-runtime.js', hash, 'iframe-runtime.js')).toBe(
      `/_ggui/iframe-runtime.${hash}.js`,
    );
  });

  it('rewrites a matching absolute URL (CDN fronting this server)', () => {
    expect(
      insertRuntimeBundleHash(
        'https://cdn.example.com/_ggui/iframe-runtime.js',
        hash,
        'iframe-runtime.js',
      ),
    ).toBe(`https://cdn.example.com/_ggui/iframe-runtime.${hash}.js`);
  });

  it('leaves a foreign filename untouched — the foreign host serves only the configured name', () => {
    expect(
      insertRuntimeBundleHash('https://static.example.com/renderer-v7.js', hash, 'iframe-runtime.js'),
    ).toBe('https://static.example.com/renderer-v7.js');
  });

  it('handles a bare filename and an extensionless plain name', () => {
    expect(insertRuntimeBundleHash('iframe-runtime.js', hash, 'iframe-runtime.js')).toBe(
      `iframe-runtime.${hash}.js`,
    );
    expect(insertRuntimeBundleHash('/x/runtime', hash, 'runtime')).toBe(`/x/runtime.${hash}`);
  });
});

describe('resolveHashedRuntimeBundleUrl', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('stamps the content hash of the given bundle file onto the plain URL', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ggui-hash-url-'));
    const bundleFile = path.join(tmpDir, 'iframe-runtime.js');
    const source = 'globalThis.__minted = 1;';
    fs.writeFileSync(bundleFile, source, 'utf8');
    const hash = createHash('sha256').update(source).digest('hex').slice(0, 12);

    expect(
      resolveHashedRuntimeBundleUrl('https://assets.example.com/_ggui/iframe-runtime.js', bundleFile),
    ).toBe(`https://assets.example.com/_ggui/iframe-runtime.${hash}.js`);
  });

  it('falls back to the plain URL when the bundle file is unreadable', () => {
    expect(
      resolveHashedRuntimeBundleUrl(
        'https://assets.example.com/_ggui/iframe-runtime.js',
        '/nonexistent/dist/iframe-runtime.js',
      ),
    ).toBe('https://assets.example.com/_ggui/iframe-runtime.js');
  });
});
