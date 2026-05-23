/**
 * `theme-command` router tests. Covers the surface that ships with
 * the v0.1.0-rc.1 migration guide: `ggui theme validate <path>`.
 *
 * Behaviour pinned:
 *   - bare `ggui theme` / `--help` / unknown subcommand handling
 *   - `validate` success path: stdout carries `Theme valid`, the
 *     resolved `$name`, the color-palette count, and the present
 *     optional blocks; exit 0
 *   - `validate` failure path: per-issue stderr lines with the
 *     dotted Zod path + message; exit 1
 *   - `validate` missing/extra arg → exit 2
 *   - `validate` missing file → exit 1
 *   - `validate` malformed JSON → exit 1
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseThemeDocument,
  type ThemeDocument,
} from '@ggui-ai/project-config';
import { runThemeCommand } from './theme-command.js';

/**
 * Minimum valid theme — mirrors the fixture in
 * `@ggui-ai/project-config`'s own `theme.test.ts`. Kept inline so the
 * CLI test stays hermetic (no fs lookup across packages).
 */
const baseTheme: ThemeDocument = {
  $name: 'cli-test-theme',
  color: {
    primary: {
      '500': { $type: 'color', $value: '#0ea5e9' },
    },
    surface: { $type: 'color', $value: '#ffffff' },
  },
  spacing: {
    '4': { $type: 'dimension', $value: '16px' },
  },
  font: {
    family: {
      sans: { $type: 'fontFamily', $value: ['Inter', 'system-ui'] },
    },
    size: {
      md: { $type: 'dimension', $value: '16px' },
    },
    weight: {
      regular: { $type: 'fontWeight', $value: 400 },
    },
    lineHeight: {
      normal: { $type: 'number', $value: 1.5 },
    },
  },
  shape: {
    radius: {
      md: { $type: 'dimension', $value: '8px' },
    },
    shadow: {
      sm: {
        $type: 'shadow',
        $value: {
          offsetX: '0',
          offsetY: '1px',
          blur: '2px',
          spread: '0',
          color: 'rgba(0,0,0,.05)',
        },
      },
    },
  },
};

async function writeTmpJson(value: unknown): Promise<{
  path: string;
  dir: string;
}> {
  const dir = join(tmpdir(), `ggui-theme-validate-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'theme.json');
  await writeFile(path, JSON.stringify(value, null, 2), 'utf-8');
  return { path, dir };
}

async function writeTmpText(text: string): Promise<{
  path: string;
  dir: string;
}> {
  const dir = join(tmpdir(), `ggui-theme-validate-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'theme.json');
  await writeFile(path, text, 'utf-8');
  return { path, dir };
}

describe('runThemeCommand router', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 2 + prints help when called with no subcommand', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const code = await runThemeCommand([]);
    expect(code).toBe(2);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui theme');
    expect(written).toContain('validate');
  });

  it('returns 0 + prints help on --help', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const code = await runThemeCommand(['--help']);
    expect(code).toBe(0);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('validate');
  });

  it('rejects unknown subcommand with exit 2 + friendly message', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runThemeCommand(['frobnicate']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('unknown subcommand');
    expect(written).toContain('frobnicate');
  });
});

describe('ggui theme validate', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 and prints a success summary for a valid theme file', async () => {
    // Sanity check: the fixture parses against the real schema. Catches
    // drift between the inline fixture above and ThemeDocumentV1.
    expect(() => parseThemeDocument(baseTheme)).not.toThrow();

    const { path, dir } = await writeTmpJson(baseTheme);
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const code = await runThemeCommand(['validate', path]);
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(written).toContain('Theme valid');
      expect(written).toContain('cli-test-theme');
      // 2 entries in `color`: `primary` + `surface`.
      expect(written).toContain('color: 2 palettes/roles');
      expect(written).toContain('optional blocks: none');
      expect(written).toContain(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 and lists the present optional blocks', async () => {
    const themeWithOptional: ThemeDocument = {
      ...baseTheme,
      motion: {
        duration: { fast: { $type: 'duration', $value: '120ms' } },
        transition: {
          standard: {
            $type: 'transition',
            $value: { duration: '120ms', timingFunction: 'ease-in-out' },
          },
        },
      },
      zIndex: {
        modal: { $type: 'number', $value: 1000 },
      },
    };
    const { path, dir } = await writeTmpJson(themeWithOptional);
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      const code = await runThemeCommand(['validate', path]);
      expect(code).toBe(0);
      const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
      expect(written).toContain('optional blocks: motion, zIndex');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 1 with a specific issue line when a required field is missing', async () => {
    // Drop the required `color` group — single-issue failure with a
    // predictable path the test can pin without coupling to the
    // exact Zod issue message wording.
    const { color: _color, ...invalidTheme } = baseTheme;
    const { path, dir } = await writeTmpJson(invalidTheme);
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runThemeCommand(['validate', path]);
      expect(code).toBe(1);
      const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(written).toContain('failed schema validation');
      // Issue path appears in the per-issue line. The path is `color`
      // because the missing-key issue is reported at the parent group.
      expect(written).toMatch(/·\s+color:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 when no path is supplied', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const code = await runThemeCommand(['validate']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('missing <path> argument');
  });

  it('exits 0 + prints help on `validate --help`', async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    const code = await runThemeCommand(['validate', '--help']);
    expect(code).toBe(0);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui theme validate');
  });

  it('exits 1 when the file does not exist', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const missing = join(
      tmpdir(),
      `ggui-theme-validate-missing-${randomUUID()}.json`,
    );
    const code = await runThemeCommand(['validate', missing]);
    expect(code).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('cannot read');
  });

  it('exits 1 when the file is not valid JSON', async () => {
    const { path, dir } = await writeTmpText('{ this is not json');
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const code = await runThemeCommand(['validate', path]);
      expect(code).toBe(1);
      const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
      expect(written).toContain('not valid JSON');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
