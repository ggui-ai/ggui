/**
 * Unit tests for `createThemeWriter` — the CLI's `ThemeWriter` impl
 * that the OSS `mcp-server` calls when an operator hits Save in the
 * `/theme` picker.
 *
 * Coverage:
 *
 *   - Round-trips an existing manifest preserving unknown fields
 *     (`schema` + `protocol` survive a save).
 *   - Writes the new theme value as the canonical object form
 *     (`{ preset, mode }`), NOT the string shorthand.
 *   - `null` clears the field entirely.
 *   - Refuses on missing manifest.
 *   - Refuses on malformed JSON.
 *   - Refuses on a malformed `ThemeConfig` (defense-in-depth — the
 *     server already validates upstream).
 *   - Atomic write — temp file appears in the same directory then is
 *     renamed; original survives a hard fault. We exercise the
 *     simple happy path here; the rename invariant is covered by
 *     reading the result file's content.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createThemeWriter } from './theme-writer.js';

describe('createThemeWriter', () => {
  let dir: string;
  let manifestPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggui-theme-writer-'));
    manifestPath = join(dir, 'ggui.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a preset-form theme into ggui.json preserving other fields', async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema: 'https://ggui.ai/schema/v1',
          protocol: '1.0',
          app: { name: 'demo' },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const writer = createThemeWriter(manifestPath);
    await writer({ preset: 'claudic', mode: 'dark' });

    const next = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(next.theme).toEqual({ preset: 'claudic', mode: 'dark' });
    // Other fields untouched — schema URL, protocol version, app block.
    expect(next.schema).toBe('https://ggui.ai/schema/v1');
    expect(next.protocol).toBe('1.0');
    expect(next.app).toEqual({ name: 'demo' });
  });

  it('replaces an existing theme on subsequent save', async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema: 'https://ggui.ai/schema/v1',
          protocol: '1.0',
          app: { name: 'demo' },
          theme: 'ggui',
        },
        null,
        2,
      ),
      'utf-8',
    );

    const writer = createThemeWriter(manifestPath);
    await writer({ preset: 'claudic', mode: 'light' });

    const next = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(next.theme).toEqual({ preset: 'claudic', mode: 'light' });
  });

  it('clears the theme field when called with null', async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schema: 'https://ggui.ai/schema/v1',
          protocol: '1.0',
          app: { name: 'demo' },
          theme: { preset: 'claudic', mode: 'dark' },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const writer = createThemeWriter(manifestPath);
    await writer(null);

    const next = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect('theme' in next).toBe(false);
  });

  it('writes a trailing newline', async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 'x', protocol: '1.0', app: { name: 'demo' } }, null, 2),
      'utf-8',
    );

    const writer = createThemeWriter(manifestPath);
    await writer('claudic');

    const raw = readFileSync(manifestPath, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('rejects when the manifest does not exist', async () => {
    const writer = createThemeWriter(join(dir, 'absent.json'));
    await expect(writer({ preset: 'claudic' })).rejects.toThrow(
      /failed to read/,
    );
  });

  it('rejects when the manifest is not parseable JSON', async () => {
    writeFileSync(manifestPath, '{ this is not valid', 'utf-8');
    const writer = createThemeWriter(manifestPath);
    await expect(writer({ preset: 'claudic' })).rejects.toThrow(
      /not parseable JSON/,
    );
  });

  it('rejects when the manifest root is not a JSON object', async () => {
    writeFileSync(manifestPath, JSON.stringify(['unexpected', 'array']), 'utf-8');
    const writer = createThemeWriter(manifestPath);
    await expect(writer({ preset: 'claudic' })).rejects.toThrow(
      /not a JSON object/,
    );
  });

  it('rejects an invalid ThemeConfig at the seam (defense-in-depth)', async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 'x', protocol: '1.0', app: { name: 'demo' } }, null, 2),
      'utf-8',
    );

    const writer = createThemeWriter(manifestPath);
    // Empty string is rejected by ThemeConfigSchema (z.string().min(1)).
    await expect(writer('' as unknown as string)).rejects.toThrow(
      /invalid ThemeConfig/,
    );

    // The manifest remains untouched on refusal.
    const raw = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect('theme' in raw).toBe(false);
  });

  it('does not leave a tmp file behind after a successful write', async () => {
    writeFileSync(
      manifestPath,
      JSON.stringify({ schema: 'x', protocol: '1.0', app: { name: 'demo' } }, null, 2),
      'utf-8',
    );

    const writer = createThemeWriter(manifestPath);
    await writer({ preset: 'claudic', mode: 'dark' });

    expect(existsSync(`${manifestPath}.tmp`)).toBe(false);
  });
});
