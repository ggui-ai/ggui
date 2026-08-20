// @vitest-environment node
//
// Isolation pins for the runtime render check (#592). Runs in a PLAIN
// NODE environment on purpose — the whole point is what happens when
// no DOM-owning test environment pre-installs `window`/`document`:
// the dispatcher must route to the isolated subprocess and the parent
// process's globals must never grow a `window` mid-check. The measured
// incident: 4 bench cells hard-failed on 2026-08-19 because a
// concurrently-open in-process check window made a provider SDK's
// browser sniff (`typeof window !== 'undefined' && window.document &&
// navigator`) fire at client construction.
import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import type { SandboxResult } from '@ggui-ai/sandbox';
import {
  mapSandboxResultToCheckResult,
  runRenderCheckViaWorker,
} from './render-check-host.js';
import { runRenderCheck } from './render-check.js';

/** Complete SandboxResult with per-test overrides — no type erasure. */
function sandboxResult(overrides: Partial<SandboxResult>): SandboxResult {
  return {
    outcome: 'exit',
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
    cwd: '/tmp',
    cwdOwnedBySandbox: true,
    nodeHeapMbApplied: true,
    errorMessage: '',
    ...overrides,
  };
}

const SIMPLE_COMPONENT = `
import { useAction } from '@ggui-ai/wire';

interface Props {
  title: string;
}

export default function Component(props: Props) {
  const save = useAction('save');
  return (
    <div>
      <h1>{props.title}</h1>
      <button onClick={() => save({ id: '1' })}>Save</button>
    </div>
  );
}
`;

const CONTRACT: DataContract = {
  propsSpec: {
    properties: { title: { schema: { type: 'string' }, required: true } },
  },
  actionSpec: { save: { label: 'Save' } },
};

/** The exact sniff the provider SDKs run at client construction. */
function sdkBrowserSniffFires(): boolean {
  const g = globalThis as Record<string, unknown>;
  return (
    typeof g['window'] !== 'undefined' &&
    typeof (g['window'] as Record<string, unknown> | undefined)?.['document'] !==
      'undefined' &&
    typeof g['navigator'] !== 'undefined'
  );
}

describe('runRenderCheck isolation (#592)', () => {
  it('never installs a window on the PARENT process while the check runs', async () => {
    expect(sdkBrowserSniffFires()).toBe(false);

    // Poll the sniff throughout the check's whole lifetime — this is
    // the TOCTOU window the bench cells lost. One positive sample is
    // a regression.
    let sniffedBrowser = false;
    const poller = setInterval(() => {
      if (sdkBrowserSniffFires()) sniffedBrowser = true;
    }, 5);

    try {
      const result = await runRenderCheck({
        sourceCode: SIMPLE_COMPONENT,
        mockupProps: { title: 'Hello' },
        contract: CONTRACT,
      });
      // The check itself must still WORK through the worker: real
      // render, real action wiring, verified end-to-end.
      expect(result.ok).toBe(true);
      expect(result.stats.actionsChecked).toBe(1);
      expect(result.issues.filter((i) => i.outcome === 'failed')).toHaveLength(0);
    } finally {
      clearInterval(poller);
    }

    expect(sniffedBrowser).toBe(false);
    expect(sdkBrowserSniffFires()).toBe(false);
  }, 60_000);

  it('reports component failures from inside the worker as issues, not throws', async () => {
    const result = await runRenderCheckViaWorker({
      sourceCode: `export default function Component() { throw new Error('boom at render'); }`,
      mockupProps: {},
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.outcome === 'failed')).toBe(true);
    expect(sdkBrowserSniffFires()).toBe(false);
  }, 60_000);
});

describe('mapSandboxResultToCheckResult', () => {
  const t0 = 0;

  it('maps timeout to a FAILED issue (component fault)', () => {
    const result = mapSandboxResultToCheckResult(
      sandboxResult({ outcome: 'timeout', exitCode: null }),
      t0,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.outcome).toBe('failed');
    expect(result.issues[0]?.reason).toContain('timed out');
  });

  it('maps spawn-error to an UNVERIFIED issue (harness fault)', () => {
    const result = mapSandboxResultToCheckResult(
      sandboxResult({ outcome: 'spawn-error', exitCode: null, errorMessage: 'ENOENT' }),
      t0,
    );
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.outcome).toBe('unverified');
    expect(result.issues[0]?.reason).toContain('ENOENT');
  });

  it('maps a non-zero exit to UNVERIFIED with the stderr tail', () => {
    const result = mapSandboxResultToCheckResult(
      sandboxResult({ exitCode: 1, stderr: 'worker: malformed input JSON — x' }),
      t0,
    );
    expect(result.issues[0]?.outcome).toBe('unverified');
    expect(result.issues[0]?.reason).toContain('malformed input JSON');
  });

  it('maps unparseable stdout to UNVERIFIED', () => {
    const result = mapSandboxResultToCheckResult(
      sandboxResult({ stdout: 'not json' }),
      t0,
    );
    expect(result.issues[0]?.outcome).toBe('unverified');
    expect(result.issues[0]?.reason).toContain('not valid JSON');
  });

  it('passes a clean verdict through verbatim', () => {
    const verdict = {
      ok: true,
      issues: [],
      stats: { actionsChecked: 2, streamsChecked: 1, renderMs: 42 },
    };
    const result = mapSandboxResultToCheckResult(
      sandboxResult({ stdout: JSON.stringify(verdict) }),
      t0,
    );
    expect(result).toEqual(verdict);
  });
});
