import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getPersistentDir } from './paths.js';

describe('getPersistentDir', () => {
  const originalOverride = process.env['GGUI_PERSISTENT_DIR'];

  beforeEach(() => {
    delete process.env['GGUI_PERSISTENT_DIR'];
  });

  afterEach(() => {
    if (originalOverride !== undefined) {
      process.env['GGUI_PERSISTENT_DIR'] = originalOverride;
    } else {
      delete process.env['GGUI_PERSISTENT_DIR'];
    }
  });

  it('returns <projectRoot>/.ggui/persistent when projectRoot is provided', () => {
    // Per-project isolation: two different projects on the same machine
    // get independent persistent bundles. Critical for hosts that run
    // multiple `ggui serve` instances (e.g. test fixtures, monorepo
    // demos).
    expect(getPersistentDir('/some/project')).toBe(
      '/some/project/.ggui/persistent',
    );
  });

  it('falls back to ~/.ggui/persistent when no projectRoot is provided', () => {
    // Bare `ggui serve` (no ggui.json discovered) still gets persistence
    // — per-user, same convention as `~/.ggui/credentials.json`.
    expect(getPersistentDir()).toBe(join(homedir(), '.ggui', 'persistent'));
    expect(getPersistentDir(null)).toBe(join(homedir(), '.ggui', 'persistent'));
    expect(getPersistentDir('')).toBe(join(homedir(), '.ggui', 'persistent'));
  });

  it('honors GGUI_PERSISTENT_DIR env override over both branches', () => {
    process.env['GGUI_PERSISTENT_DIR'] = '/tmp/override';
    expect(getPersistentDir('/some/project')).toBe('/tmp/override');
    expect(getPersistentDir()).toBe('/tmp/override');
  });

  it('ignores empty-string env override (no-config edge case)', () => {
    process.env['GGUI_PERSISTENT_DIR'] = '';
    expect(getPersistentDir('/some/project')).toBe(
      '/some/project/.ggui/persistent',
    );
  });
});
