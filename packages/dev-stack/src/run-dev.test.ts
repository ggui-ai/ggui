/**
 * Smoke tests for the `runDev` orchestration entry point.
 *
 * Exercises the bootstrap path — find + load `ggui.json`,
 * discover UIs, surface manifest issues. HTTP serving is off
 * (`serve: false`) so the tests stay fast.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GguiDevError, runDev } from './run-dev.js';

describe('runDev (orchestration)', () => {
  let tmp: string;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-cli-dev-'));
    lines.length = 0;
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('throws GguiDevError when ggui.json cannot be found', async () => {
    await expect(runDev({ cwd: tmp, log, serve: false })).rejects.toThrow(GguiDevError);
  });

  it('loads a minimal ggui.json and reports the resolved identity', async () => {
    writeFileSync(
      join(tmp, 'ggui.json'),
      JSON.stringify({
        schema: '1',
        protocol: '1.1',
        app: { slug: 'weather-bot', name: 'Weather Bot' },
      }),
    );

    const result = await runDev({ cwd: tmp, log, serve: false });

    expect(result.manifest.app.slug).toBe('weather-bot');
    expect(result.manifest.protocol).toBe('1.1');
    expect(result.manifest.blueprints.include).toEqual([]);
    expect(result.manifestPath).toBe(join(tmp, 'ggui.json'));
    expect(result.discovery.uis).toEqual([]);

    const joined = lines.join('\n');
    expect(joined).toContain('Weather Bot');
    expect(joined).toContain('weather-bot');
    expect(joined).toContain('(default tokens)');
    expect(joined).toContain('(none discovered)');
  });

  it('surfaces declared blueprint globs in the summary', async () => {
    writeFileSync(
      join(tmp, 'ggui.json'),
      JSON.stringify({
        schema: '1',
        protocol: '1.1',
        app: { slug: 'app', name: 'App' },
        blueprints: { include: ['ui/**/ggui.ui.json'] },
      }),
    );

    const result = await runDev({ cwd: tmp, log, serve: false });

    expect(result.manifest.blueprints.include).toEqual(['ui/**/ggui.ui.json']);

    const joined = lines.join('\n');
    expect(joined).toContain('ui/**/ggui.ui.json');
  });

  it('discovers ggui.ui.json files under the declared globs and prints them', async () => {
    writeFileSync(
      join(tmp, 'ggui.json'),
      JSON.stringify({
        schema: '1',
        protocol: '1.1',
        app: { slug: 'app', name: 'App' },
        blueprints: { include: ['ui/**/ggui.ui.json'] },
      }),
    );
    mkdirSync(join(tmp, 'ui/weather-card'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui/weather-card/ggui.ui.json'),
      JSON.stringify({
        id: 'weather-card',
        name: 'Weather Card',
        contract: { intent: 'forecast' },
      }),
    );

    const result = await runDev({ cwd: tmp, log, serve: false });

    expect(result.discovery.uis.map((u) => u.id)).toEqual(['weather-card']);
    expect(result.discovery.issues).toEqual([]);

    const joined = lines.join('\n');
    expect(joined).toContain('1 discovered');
    expect(joined).toContain('- weather-card  (Weather Card)');
  });

  it('surfaces manifest issues without failing the whole boot', async () => {
    writeFileSync(
      join(tmp, 'ggui.json'),
      JSON.stringify({
        schema: '1',
        protocol: '1.1',
        app: { slug: 'app', name: 'App' },
        blueprints: { include: ['ui/**/ggui.ui.json'] },
      }),
    );
    mkdirSync(join(tmp, 'ui/bad'), { recursive: true });
    writeFileSync(join(tmp, 'ui/bad/ggui.ui.json'), '{ not valid');
    mkdirSync(join(tmp, 'ui/good'), { recursive: true });
    writeFileSync(
      join(tmp, 'ui/good/ggui.ui.json'),
      JSON.stringify({ id: 'good', name: 'Good', contract: { intent: 'ok' } }),
    );

    const result = await runDev({ cwd: tmp, log, serve: false });

    expect(result.discovery.uis.map((u) => u.id)).toEqual(['good']);
    expect(result.discovery.issues).toHaveLength(1);

    const joined = lines.join('\n');
    expect(joined).toContain('issues: 1');
    expect(joined).toContain('ui/bad/ggui.ui.json');
  });

  it('propagates GguiJsonLoadError when the file is malformed JSON', async () => {
    writeFileSync(join(tmp, 'ggui.json'), '{ not valid json');
    await expect(runDev({ cwd: tmp, log, serve: false })).rejects.toThrow(/not valid JSON/);
  });

  it('propagates validation errors when required fields are missing', async () => {
    writeFileSync(join(tmp, 'ggui.json'), JSON.stringify({ schema: '1' }));
    await expect(runDev({ cwd: tmp, log, serve: false })).rejects.toThrow(/schema validation/);
  });
});
