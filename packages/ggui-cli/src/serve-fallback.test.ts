/**
 * §10.2a fallback-matrix coverage. Exercises `resolveAgentPlan` with
 * real ggui.json files in a temp directory so the project-config
 * loader + agent-resolution helpers run end-to-end. No mocks; the
 * test surface is exactly what `ggui serve` hits at runtime.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GguiJsonLoadError,
  resolveAgentPlan,
} from './serve-fallback.js';

const MINIMAL_MANIFEST = {
  schema: '1' as const,
  protocol: '1.1',
  app: { slug: 'fallback-test', name: 'Fallback Test' },
};

describe('resolveAgentPlan — §10.2a fallback matrix', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'ggui-serve-fallback-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const writeManifest = (body: unknown): string => {
    const path = join(projectRoot, 'ggui.json');
    writeFileSync(path, JSON.stringify(body, null, 2), 'utf-8');
    return path;
  };

  const writeAgent = (name: string): string => {
    const path = join(projectRoot, name);
    writeFileSync(path, '// stub\n', 'utf-8');
    return path;
  };

  it('case 1: --mcp-only → disabled, silent, supervision absent', () => {
    writeManifest({
      ...MINIMAL_MANIFEST,
      agent: { entry: './agent.ts' },
    });
    writeAgent('agent.ts');

    const plan = resolveAgentPlan({ mcpOnly: true, cwd: projectRoot });
    expect(plan.status).toEqual({ kind: 'disabled', reason: '--mcp-only' });
    expect(plan.warnings).toEqual([]);
    expect(plan.supervision).toBeUndefined();
  });

  it('case 2: no ggui.json → disabled, warn, supervision absent', () => {
    // Use an empty subdir so the ancestor walk can't reach the
    // workspace root's ggui.json if one exists there.
    const nested = join(projectRoot, 'nested');
    mkdirSync(nested);
    // Create sentinel files that `findGguiJson` will stop at so we
    // don't walk up to any real ggui.json on the developer box.
    // Actually `findGguiJson` walks until DEFAULT_FIND_MAX_DEPTH — we
    // rely on tmpdir being inside /tmp which has no ggui.json.
    const plan = resolveAgentPlan({ mcpOnly: false, cwd: nested });
    expect(plan.status).toEqual({
      kind: 'disabled',
      reason: 'no ggui.json',
    });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain('no ggui.json found');
    expect(plan.warnings[0]).toContain('create ggui.json with agent.entry');
    expect(plan.supervision).toBeUndefined();
  });

  it('case 5: ggui.json present, no agent.entry → disabled, warn', () => {
    const manifestPath = writeManifest(MINIMAL_MANIFEST); // no agent block

    const plan = resolveAgentPlan({ mcpOnly: false, cwd: projectRoot });
    expect(plan.status).toEqual({
      kind: 'disabled',
      reason: 'ggui.json has no agent.entry',
    });
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain(manifestPath);
    expect(plan.warnings[0]).toContain('agent.entry is not set');
    expect(plan.supervision).toBeUndefined();
  });

  it('case 6: valid config → running, supervision wired, no warnings', () => {
    const entry = './agent.ts';
    writeManifest({ ...MINIMAL_MANIFEST, agent: { entry } });
    writeAgent('agent.ts');

    const plan = resolveAgentPlan({ mcpOnly: false, cwd: projectRoot });
    expect(plan.status).toEqual({
      kind: 'running',
      entry,
      language: 'ts',
    });
    expect(plan.warnings).toEqual([]);
    expect(plan.supervision).toBeDefined();
    expect(plan.supervision?.startInput.project.slug).toBe('fallback-test');
    expect(plan.supervision?.startInput.project.name).toBe('Fallback Test');
    expect(plan.supervision?.startInput.project.protocol).toBe('1.1');
    expect(plan.supervision?.startInput.projectRoot).toBe(projectRoot);
    expect(plan.supervision?.startInput.entry).toBe(
      join(projectRoot, 'agent.ts'),
    );
  });

  it('case 3: ggui.json malformed (invalid JSON) → throws GguiJsonLoadError', () => {
    writeFileSync(join(projectRoot, 'ggui.json'), '{ not valid', 'utf-8');

    expect(() =>
      resolveAgentPlan({ mcpOnly: false, cwd: projectRoot }),
    ).toThrow(GguiJsonLoadError);
  });

  it('case 3b: ggui.json schema violation → throws GguiJsonLoadError', () => {
    // Valid JSON, wrong schema value.
    writeFileSync(
      join(projectRoot, 'ggui.json'),
      JSON.stringify({ schema: '999', app: {} }),
      'utf-8',
    );

    expect(() =>
      resolveAgentPlan({ mcpOnly: false, cwd: projectRoot }),
    ).toThrow(GguiJsonLoadError);
  });

  it('case 4: agent.entry unsupported extension → throws with field prefix', () => {
    writeManifest({
      ...MINIMAL_MANIFEST,
      agent: { entry: './agent.py' },
    });
    writeAgent('agent.py');

    expect(() =>
      resolveAgentPlan({ mcpOnly: false, cwd: projectRoot }),
    ).toThrow(/ggui\.json agent\.entry:.*unsupported extension/);
  });

  it('case 4b: agent.entry empty string → rejected at schema time', () => {
    writeFileSync(
      join(projectRoot, 'ggui.json'),
      JSON.stringify({
        ...MINIMAL_MANIFEST,
        agent: { entry: '' },
      }),
      'utf-8',
    );

    // Empty entry string fails schema validation → GguiJsonLoadError
    // (not the agent.entry resolve error, because the loader never
    // got past zod).
    expect(() =>
      resolveAgentPlan({ mcpOnly: false, cwd: projectRoot }),
    ).toThrow(GguiJsonLoadError);
  });

  it('onAgentEvent sink is forwarded into the supervision shape when supplied', () => {
    writeManifest({
      ...MINIMAL_MANIFEST,
      agent: { entry: './agent.ts' },
    });
    writeAgent('agent.ts');

    const captured: string[] = [];
    const plan = resolveAgentPlan({
      mcpOnly: false,
      cwd: projectRoot,
      onAgentEvent: (e) => captured.push(e.type),
    });
    expect(plan.supervision?.onEvent).toBeDefined();
    plan.supervision?.onEvent?.({
      type: 'status',
      status: 'ready',
      timestamp: 0,
    });
    expect(captured).toEqual(['status']);
  });

  it('onAgentEvent absent → supervision has no onEvent (silent)', () => {
    writeManifest({
      ...MINIMAL_MANIFEST,
      agent: { entry: './agent.ts' },
    });
    writeAgent('agent.ts');

    const plan = resolveAgentPlan({ mcpOnly: false, cwd: projectRoot });
    expect(plan.supervision?.onEvent).toBeUndefined();
  });

  // ─── manifest + projectRoot surfaced for storage wiring ───────────

  it('surfaces manifest + projectRoot so CLI can resolve storage', () => {
    writeManifest({
      ...MINIMAL_MANIFEST,
      agent: { entry: './agent.ts' },
      storage: {
        renders: { driver: 'sqlite', path: './ggui-sessions.sqlite' },
      },
    });
    writeAgent('agent.ts');

    const plan = resolveAgentPlan({ mcpOnly: false, cwd: projectRoot });
    expect(plan.manifest).not.toBeNull();
    expect(plan.manifest?.storage?.renders).toEqual({
      driver: 'sqlite',
      path: './ggui-sessions.sqlite',
    });
    expect(plan.projectRoot).toBe(projectRoot);
  });

  it('--mcp-only still loads the manifest (storage works without agent)', () => {
    // Operator may run MCP-only with persistent storage; we must
    // surface manifest + projectRoot in that path too.
    writeManifest({
      ...MINIMAL_MANIFEST,
      storage: {
        vectors: { driver: 'sqlite', path: './vectors.sqlite' },
      },
    });

    const plan = resolveAgentPlan({ mcpOnly: true, cwd: projectRoot });
    expect(plan.status).toEqual({ kind: 'disabled', reason: '--mcp-only' });
    expect(plan.manifest?.storage?.vectors).toEqual({
      driver: 'sqlite',
      path: './vectors.sqlite',
    });
    expect(plan.projectRoot).toBe(projectRoot);
  });

  it('--mcp-only with malformed manifest still throws (operator wants to know)', () => {
    writeFileSync(join(projectRoot, 'ggui.json'), '{ not valid', 'utf-8');
    expect(() =>
      resolveAgentPlan({ mcpOnly: true, cwd: projectRoot }),
    ).toThrow(GguiJsonLoadError);
  });

  it('no ggui.json → manifest+projectRoot both null (CLI falls back to in-memory)', () => {
    const nested = join(projectRoot, 'nested-no-manifest');
    mkdirSync(nested);
    const plan = resolveAgentPlan({ mcpOnly: false, cwd: nested });
    expect(plan.manifest).toBeNull();
    expect(plan.projectRoot).toBeNull();
  });

  it('malformed storage block at schema time → GguiJsonLoadError', () => {
    // Unknown driver value — caught by project-config's strict
    // discriminated-union parse, not by resolveStorageFromConfig.
    writeFileSync(
      join(projectRoot, 'ggui.json'),
      JSON.stringify({
        ...MINIMAL_MANIFEST,
        storage: { renders: { driver: 'postgres', url: 'postgres://…' } },
      }),
      'utf-8',
    );
    expect(() =>
      resolveAgentPlan({ mcpOnly: false, cwd: projectRoot }),
    ).toThrow(GguiJsonLoadError);
  });
});
