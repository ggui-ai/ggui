/**
 * CLI unit tests — the exit-code mapping. Pure unit-level: no
 * subprocess, no server.
 *
 * The zero-executed guard is load-bearing for CI adopters: a run
 * where every fixture skipped (e.g. hostless CLI against the current
 * all-setup catalog) historically exited 0 and read as a green
 * conformance gate while grading nothing. Exit 2 makes that state
 * loud and distinct from a fixture failure (exit 1).
 */
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { exitCodeForResult, loadCatalogInputs, main, parseArgs, USAGE } from './cli.js';
import { runRefusalEnvelopeConformance } from './refusal-envelope-conformance/index.js';
import { runConformance } from './run-conformance.js';
import { runTransportRefusalConformance } from './transport-refusal-conformance/index.js';
import type { ConformanceFailure, ConformanceResult } from './run-conformance.js';

function result(overrides: Partial<ConformanceResult>): ConformanceResult {
  return { passed: [], failed: [], skipped: [], totalMs: 1, ...overrides };
}

const FAILURE: ConformanceFailure = {
  name: 'action-ack-sequence',
  criterion: 'criterion',
  expected: {},
  received: {},
  message: 'mismatch',
};

describe('exitCodeForResult', () => {
  it('returns 0 when at least one fixture passed and none failed', () => {
    expect(
      exitCodeForResult(
        result({
          passed: ['bootstrap-success'],
          skipped: [{ name: 'props-update-roundtrip', reason: 'Path-B' }],
        }),
      ),
    ).toBe(0);
  });

  it('returns 1 when any fixture failed', () => {
    expect(
      exitCodeForResult(result({ passed: ['bootstrap-success'], failed: [FAILURE] })),
    ).toBe(1);
  });

  it('returns 2 when zero fixtures executed (all skipped) — never reads as success', () => {
    expect(
      exitCodeForResult(
        result({
          skipped: [
            { name: 'bootstrap-success', reason: 'no host provided' },
            { name: 'version-mismatch', reason: 'no host provided' },
          ],
        }),
      ),
    ).toBe(2);
  });

  it('returns 2 on a fully empty result (zero fixtures selected)', () => {
    expect(exitCodeForResult(result({}))).toBe(2);
  });

  it('failure outranks the zero-executed guard (exit 1 wins over exit 2)', () => {
    expect(exitCodeForResult(result({ failed: [FAILURE] }))).toBe(1);
  });
});

describe('the CLI can grade the pure-function catalogs when handed their inputs (ggui#803 leg 3)', () => {
  const sample = (name: string): string =>
    fileURLToPath(new URL(`./cli-samples/${name}`, import.meta.url));

  it('parses --registry, --projector and --transport-projector', () => {
    const parsed = parseArgs([
      '--url',
      'http://localhost:3000',
      '--auth',
      'bearer:t',
      '--registry',
      './registry.json',
      '--projector',
      './project.mjs',
      '--transport-projector',
      './endpoint.mjs',
    ]);
    expect(parsed.registry).toBe('./registry.json');
    expect(parsed.projector).toBe('./project.mjs');
    expect(parsed.transportProjector).toBe('./endpoint.mjs');
  });

  it('--help names the three flags beside the catalogs they grade', () => {
    expect(USAGE).toContain('--registry <file.json>');
    expect(USAGE).toContain('--projector <module>');
    expect(USAGE).toContain('--transport-projector <module>');
  });

  it('loads a JSON registry and imports projector modules into the run config', async () => {
    const inputs = await loadCatalogInputs({
      registry: sample('registry.json'),
      projector: sample('project.mjs'),
      transportProjector: sample('endpoint.mjs'),
    });
    expect(Object.keys(inputs.refusalRegistry ?? {})).toEqual(['hard_cap_exceeded']);
    const refusal = {
      code: 'app_deprovisioned',
      message: 'm',
      fix: 'f',
      retry: 'never',
      handshake: 'intact',
    };
    expect(inputs.refusalProjector?.(refusal)).toMatchObject({
      isError: true,
      hasMeta: false,
      structuredContent: { outcome: 'refused', refusal },
    });
    expect(inputs.transportRefusalProjector?.(refusal)).toMatchObject({
      httpStatus: 403,
      error: { code: -32003 },
    });
    expect(inputs.transportRefusalProjector?.({ ...refusal, code: 'insufficient_credit' })).toBeNull();
  });

  it('a flag left out leaves its catalog input absent — the runner skips it by name', async () => {
    const inputs = await loadCatalogInputs({ registry: sample('registry.json') });
    expect(inputs.refusalProjector).toBeUndefined();
    expect(inputs.transportRefusalProjector).toBeUndefined();
  });

  it('a catalog left ungraded is SKIPPED with the CLI flag named, not only the runner key', async () => {
    const result = await runConformance({
      serverUrl: 'ws://127.0.0.1:9/ws',
      auth: { kind: 'bearer', token: 'x' },
      only: ['refusal-envelope/refuse-never', 'transport-refusal/refuse-render-only-code'],
      observationTimeoutMs: 10,
    });
    const reasons = result.skipped.map((s) => s.reason);
    expect(reasons.some((r) => r.includes('--projector <module>'))).toBe(true);
    expect(reasons.some((r) => r.includes('--transport-projector <module>'))).toBe(true);
  });

  it('refuses a registry file that is not an object of rows, loudly', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ggui-cli-'));
    const bad = join(dir, 'registry.json');
    await writeFile(bad, JSON.stringify([1, 2, 3]));
    await expect(loadCatalogInputs({ registry: bad })).rejects.toThrow(/--registry .*object of rows/);
  });

  it('a registry row missing a field is refused naming the row', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'ggui-cli-'));
    const bad = join(dir, 'registry.json');
    await writeFile(
      bad,
      JSON.stringify({ x: { code: 'x', surfaces: ['render-gate'], retry: 'never', description: 'd' } }),
    );
    await expect(loadCatalogInputs({ registry: bad })).rejects.toThrow(/row 'x'/);
  });

  it('a registry file that does not exist fails naming --registry and the path', async () => {
    await expect(loadCatalogInputs({ registry: '/nonexistent/ggui-registry.json' })).rejects.toThrow(
      /--registry \/nonexistent\/ggui-registry\.json/,
    );
  });

  it('a projector module that cannot be imported fails naming the flag and the path', async () => {
    await expect(loadCatalogInputs({ projector: '/nonexistent/project.mjs' })).rejects.toThrow(
      /--projector \/nonexistent\/project\.mjs/,
    );
  });

  it('refuses a projector module whose export is not a function, naming the flag', async () => {
    await expect(loadCatalogInputs({ projector: sample('bad-export.mjs') })).rejects.toThrow(
      /--projector .*must export/,
    );
    await expect(loadCatalogInputs({ transportProjector: sample('bad-export.mjs') })).rejects.toThrow(
      /--transport-projector/,
    );
  });

  it('refuses a projector return that is not a projection, naming the flag', async () => {
    const inputs = await loadCatalogInputs({ projector: sample('endpoint.mjs') });
    expect(() =>
      inputs.refusalProjector?.({
        code: 'app_deprovisioned',
        message: 'm',
        fix: 'f',
        retry: 'never',
        handshake: 'intact',
      }),
    ).toThrow(/--projector .*not a projection/);
  });

  it('the shipped samples are spec-correct: each passes the catalog it demonstrates', async () => {
    const inputs = await loadCatalogInputs({
      projector: sample('project.mjs'),
      transportProjector: sample('endpoint.mjs'),
    });
    const project = inputs.refusalProjector;
    const projectEndpoint = inputs.transportRefusalProjector;
    if (project === undefined || projectEndpoint === undefined) throw new Error('samples not loaded');
    const envelope = runRefusalEnvelopeConformance(project);
    expect(envelope.failed).toEqual([]);
    expect(envelope.passed.length).toBe(6);
    const transport = runTransportRefusalConformance(projectEndpoint);
    expect(transport.failed).toEqual([]);
    expect(transport.passed.length).toBe(2);
  });

  it('main() hands the loaded inputs to the runner: one registry row graded from --registry exits 0', async () => {
    const code = await main([
      '--url',
      'ws://127.0.0.1:9/ws',
      '--auth',
      'bearer:x',
      '--timeout-ms',
      '10',
      '--only',
      'registry-completeness/surfaces-non-empty',
      '--registry',
      sample('registry.json'),
    ]);
    expect(code).toBe(0);
  });
});
