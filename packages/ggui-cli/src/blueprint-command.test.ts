/**
 * `blueprint-command` router tests. Thin checks that the router
 * dispatches to the right subcommand surface. The shared internals
 * (`internal/artifact-*`) carry the bulk of behavior coverage; this
 * file asserts the router correctly:
 *   - prints help on bare `ggui blueprint` / `--help`
 *   - rejects unknown subcommands with a friendly diagnostic
 *   - dispatches `create` to `runBlueprintCreate` (scaffolds a real
 *     blueprint in a tmpdir)
 *   - dispatches `search --hook ...` to the kind-locked parser, which
 *     refuses the gadget-only flag
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GGUI_BLUEPRINT_JSON_FILENAME } from '@ggui-ai/artifact-manifest';
import { runBlueprintCommand } from './blueprint-command.js';

describe('runBlueprintCommand', () => {
  it('returns 2 + prints help when called with no subcommand', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand([]);
    expect(code).toBe(2);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui blueprint');
    expect(written).toContain('create');
    expect(written).toContain('publish');
    expect(written).toContain('install');
    expect(written).toContain('search');
    stdoutSpy.mockRestore();
  });

  it('returns 0 + prints help on --help', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand(['--help']);
    expect(code).toBe(0);
    stdoutSpy.mockRestore();
  });

  it('rejects unknown subcommand with exit 2 + friendly message', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand(['frobnicate']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('unknown subcommand');
    expect(written).toContain('frobnicate');
    vi.restoreAllMocks();
  });

  it('dispatches `create` to the blueprint scaffolder', async () => {
    const workDir = join(tmpdir(), `ggui-blueprint-cmd-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
    const origCwd = process.cwd();
    process.chdir(workDir);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const code = await runBlueprintCommand(['create', '@my-org/login-form']);
      expect(code).toBe(0);
      const manifestPath = join(workDir, 'login-form', GGUI_BLUEPRINT_JSON_FILENAME);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8'));
      expect(manifest.kind).toBe('blueprint');
      expect(manifest.scope).toBe('@my-org');
      expect(manifest.name).toBe('login-form');
    } finally {
      stdoutSpy.mockRestore();
      process.chdir(origCwd);
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it('dispatches `search --hook` and rejects (hook is gadget-only)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand(['search', '--hook', 'useMap']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('--hook is a gadget-only filter');
    vi.restoreAllMocks();
  });

  it('dispatches `search --kind=gadget` and rejects (conflicts with verb)', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand(['search', '--kind=gadget']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('conflicts with');
    vi.restoreAllMocks();
  });

  // Slice 5 follow-up (2026-05-18, L5): explicit coverage for the
  // `uninstall` subcommand router. `runArtifactUninstall` itself is
  // well-tested directly; this case pins the router dispatches to it
  // (catches regressions where the switch falls through to "unknown
  // subcommand" or the help text drops the verb).
  it('dispatches `uninstall` to the artifact-uninstall runtime', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Running with no positional arg → uninstall verb sees the
    // parser error path, which is the router's "I reached the right
    // verb" signal.
    const code = await runBlueprintCommand(['uninstall']);
    expect(code).toBe(2);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui blueprint uninstall');
    expect(written).toContain('missing positional argument');
    vi.restoreAllMocks();
  });

  it('dispatches `uninstall --help` to the verb-specific help', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand(['uninstall', '--help']);
    expect(code).toBe(0);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('ggui blueprint uninstall');
    expect(written).toContain('remove a marketplace-installed');
    stdoutSpy.mockRestore();
  });

  it('lists uninstall in the top-level help text', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await runBlueprintCommand(['--help']);
    expect(code).toBe(0);
    const written = stdoutSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('uninstall');
    stdoutSpy.mockRestore();
  });
});
