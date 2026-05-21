import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from './schema.js';
import {
  findGguiJson,
  GguiJsonLoadError,
  loadGguiJson,
  safeLoadGguiJson,
  saveGguiJson,
} from './node.js';

const MINIMAL_V1: GguiJsonV1 = {
  schema: '1',
  protocol: '1.1',
  app: { slug: 'weather-bot', name: 'Weather Bot' },
  blueprints: { include: [] },
  primitives: {
    packages: ['@ggui-ai/design/primitives'],
    local: [],
  },
  mcpMounts: [],
};

describe('ggui.json loader — filesystem round-trip', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ggui-json-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('save → load round-trips a valid document', () => {
    const path = join(workDir, 'ggui.json');
    saveGguiJson(path, MINIMAL_V1);
    const loaded = loadGguiJson(path);
    expect(loaded).toEqual(MINIMAL_V1);
  });

  it('save writes a trailing newline + 2-space indent', () => {
    const path = join(workDir, 'ggui.json');
    saveGguiJson(path, MINIMAL_V1);
    const raw = readFileSync(path, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('  "schema": "1"');
  });

  it('save rejects an invalid document before writing', () => {
    const path = join(workDir, 'ggui.json');
    const bad = { ...MINIMAL_V1, schema: '2' as unknown as '1' };
    expect(() => saveGguiJson(path, bad)).toThrow();
  });

  it('load throws GguiJsonLoadError for a missing file', () => {
    const path = join(workDir, 'does-not-exist.json');
    try {
      loadGguiJson(path);
      expect.unreachable('load should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GguiJsonLoadError);
      expect((err as GguiJsonLoadError).path).toBe(path);
    }
  });

  it('load throws GguiJsonLoadError for malformed JSON', () => {
    const path = join(workDir, 'ggui.json');
    writeFileSync(path, '{not json', 'utf-8');
    try {
      loadGguiJson(path);
      expect.unreachable('load should have thrown on bad JSON');
    } catch (err) {
      expect(err).toBeInstanceOf(GguiJsonLoadError);
      expect((err as GguiJsonLoadError).message).toMatch(/not valid JSON/);
      expect((err as GguiJsonLoadError).cause).toBeInstanceOf(Error);
    }
  });

  it('load throws GguiJsonLoadError for schema violations, preserving ZodError cause', () => {
    const path = join(workDir, 'ggui.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...MINIMAL_V1,
        app: { slug: 'Invalid Slug', name: 'X' },
      }),
      'utf-8',
    );
    try {
      loadGguiJson(path);
      expect.unreachable('load should have thrown on bad slug');
    } catch (err) {
      expect(err).toBeInstanceOf(GguiJsonLoadError);
      expect((err as GguiJsonLoadError).message).toMatch(
        /failed schema validation/,
      );
      const cause = (err as GguiJsonLoadError).cause as
        | { issues?: unknown }
        | undefined;
      expect(cause).toBeDefined();
      expect(Array.isArray(cause?.issues)).toBe(true);
    }
  });

  it('safeLoad returns a discriminated result on success', () => {
    const path = join(workDir, 'ggui.json');
    saveGguiJson(path, MINIMAL_V1);
    const result = safeLoadGguiJson(path);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.app.slug).toBe('weather-bot');
    }
  });

  it('safeLoad returns a discriminated result on failure', () => {
    const path = join(workDir, 'missing.json');
    const result = safeLoadGguiJson(path);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeInstanceOf(GguiJsonLoadError);
      expect(result.error.path).toBe(path);
    }
  });
});

describe('ggui.json loader — findGguiJson upward walk', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'ggui-json-find-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('finds ggui.json in the start directory', () => {
    const path = join(workDir, 'ggui.json');
    saveGguiJson(path, MINIMAL_V1);
    const found = findGguiJson(workDir);
    expect(found).toBe(path);
  });

  it('finds ggui.json in a parent directory', () => {
    const nested = join(workDir, 'a', 'b', 'c');
    mkdirSync(nested, { recursive: true });
    const rootPath = join(workDir, 'ggui.json');
    saveGguiJson(rootPath, MINIMAL_V1);
    const found = findGguiJson(nested);
    expect(found).toBe(rootPath);
  });

  it('returns null when no ggui.json exists above startDir', () => {
    const found = findGguiJson(workDir, 2);
    expect(found).toBeNull();
  });

  it('honours maxDepth = 0 by searching only the start directory', () => {
    const nested = join(workDir, 'a');
    mkdirSync(nested, { recursive: true });
    saveGguiJson(join(workDir, 'ggui.json'), MINIMAL_V1);
    const found = findGguiJson(nested, 0);
    expect(found).toBeNull();
  });
});
