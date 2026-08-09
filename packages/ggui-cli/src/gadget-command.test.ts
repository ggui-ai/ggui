/**
 * `gadget-command` router tests. Thin checks that the router
 * dispatches to the right subcommand surface — the shared internals
 * (`internal/artifact-*`) carry the bulk of behavior coverage. Mirrors
 * `blueprint-command.test.ts`. This file asserts the router correctly:
 *   - prints help on bare `ggui gadget` / `--help`
 *   - rejects unknown subcommands with a friendly diagnostic
 *   - dispatches `create` to `runGadgetCreate` (scaffolds a real
 *     gadget in a tmpdir)
 *   - dispatches `search --kind=blueprint` to the kind-locked parser,
 *     which rejects the conflicting verb/flag pair
 *   - forwards EVERY parsed publish flag to the publish core —
 *     `--identity-token` regressed here once (parsed, then dropped on
 *     the router floor), so the forwarding is pinned via a module mock.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GGUI_GADGET_JSON_FILENAME } from '@ggui-ai/artifact-manifest';
import { runGadgetCommand } from './gadget-command.js';
import { runArtifactPublish } from './internal/artifact-publish.js';

// Mock ONLY the publish core so the forwarding test can observe the
// exact options object the router hands over. Flag parsing + help
// rendering stay real (spread from the actual module).
vi.mock('./internal/artifact-publish.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./internal/artifact-publish.js')>();
  return {
    ...actual,
    runArtifactPublish: vi.fn(async () => ({
      ok: true as const,
      exitCode: 0 as const,
      success: {
        artifactId: '@my-org/map-gadget',
        version: '0.1.0',
        manifestUrl: '(mock)',
        installCommand:
          'ggui gadget install @my-org/map-gadget@0.1.0 --registry=https://r.example',
        registryUrl: 'https://r.example',
        dryRun: true,
      },
    })),
  };
});

describe('runGadgetCommand', () => {
  it('returns 2 + prints help when called with no subcommand', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runGadgetCommand([]);
    expect(code).toBe(2);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui gadget');
    expect(written).toContain('create');
    expect(written).toContain('publish');
    expect(written).toContain('install');
    expect(written).toContain('search');
    stdoutSpy.mockRestore();
  });

  it('returns 0 + prints help on --help', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runGadgetCommand(['--help']);
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });

  it('rejects unknown subcommand with exit 2 + friendly message', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runGadgetCommand(['frobnicate']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('unknown subcommand');
    expect(written).toContain('frobnicate');
    vi.restoreAllMocks();
  });

  it('dispatches `create` to the gadget scaffolder', async () => {
    const workDir = join(tmpdir(), `ggui-gadget-cmd-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(workDir);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runGadgetCommand(['create', '@my-org/weather-card']);
      expect(code).toBe(0);
      const manifestPath = join(workDir, 'weather-card', GGUI_GADGET_JSON_FILENAME);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      expect(manifest.kind).toBe('gadget');
      expect(manifest.scope).toBe('@my-org');
      expect(manifest.name).toBe('weather-card');
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(origCwd);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('dispatches `search --kind=blueprint` and rejects (conflicts with verb)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runGadgetCommand(['search', '--kind=blueprint']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('conflicts with');
    vi.restoreAllMocks();
  });

  it('dispatches `uninstall` to the artifact-uninstall runtime', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Running with no positional arg → uninstall verb sees the
    // parser error path, which is the router's "I reached the right
    // verb" signal.
    const code = await runGadgetCommand(['uninstall']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui gadget uninstall');
    expect(written).toContain('missing positional argument');
    vi.restoreAllMocks();
  });

  it('dispatches `uninstall --help` to the verb-specific help', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runGadgetCommand(['uninstall', '--help']);
    expect(code).toBe(0);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui gadget uninstall');
    expect(written).toContain('remove a marketplace-installed');
    expect(written).toContain('ggui.json#app.gadgets');
    stdoutSpy.mockRestore();
  });

  it('lists uninstall in the top-level help text', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runGadgetCommand(['--help']);
    expect(code).toBe(0);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('uninstall');
    stdoutSpy.mockRestore();
  });

  it('forwards --identity-token to the publish core', async () => {
    vi.mocked(runArtifactPublish).mockClear();
    const code = await runGadgetCommand([
      'publish',
      '--dry-run',
      '--identity-token',
      'header.payload.sig',
    ]);
    expect(code).toBe(0);
    expect(runArtifactPublish).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(runArtifactPublish).mock.calls[0]![0];
    expect(opts.kind).toBe('gadget');
    expect(opts.dryRun).toBe(true);
    expect(opts.identityToken).toBe('header.payload.sig');
  });
});
