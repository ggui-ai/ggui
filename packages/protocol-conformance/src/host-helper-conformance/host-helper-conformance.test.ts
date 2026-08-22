/**
 * Host-helper conformance catalog (ggui#600) — the kit half of the
 * #595/#596 RCA guarantees: a graded scorecard for HOST HELPERS (the
 * libraries that mount ggui views and answer the MCP-Apps bridge).
 *
 * The driver speaks at the JSON-RPC message level through a
 * `HostHelperPort` the implementer supplies — no DOM, no transport:
 * the same implementation-as-callbacks pattern as the props-schema
 * catalog. Reference fakes below pin the grading semantics:
 *
 *  - a RELAYING helper grades tier 'relaying' with H+R green;
 *  - an honest INITIALIZE-ONLY helper grades tier 'read-only' — a
 *    LEGAL grade, not a failure (the pre-trimly catch: assemblers read
 *    the tier instead of discovering it with a user's tap);
 *  - a SILENT-DROP helper fails refusal honesty (H3);
 *  - an advertises-but-refuses helper fails truthfulness (H2) — the
 *    guuey#596 shape had it been advertised.
 */
import { describe, expect, it } from 'vitest';
import {
  runHostHelperConformance,
  type HostHelperPort,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ThemeCoverageValidationResult,
} from './index.js';

const METHOD_NOT_SUPPORTED = -32601;

function initializeResult(capabilities: Record<string, unknown>) {
  return {
    protocolVersion: '2026-01-26',
    hostInfo: { name: 'fake-host', version: '0.0.0' },
    hostCapabilities: capabilities,
    hostContext: { locale: 'en-US' },
  };
}

function response(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: number | string,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Fully-conforming relaying helper. */
function relayingPort(): HostHelperPort {
  return {
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      if (req.method === 'ui/initialize') {
        return response(req.id, initializeResult({ serverTools: {} }));
      }
      if (req.method === 'tools/call') {
        // Round-trip fidelity: return the sink's envelope UNMODIFIED —
        // including a failure result envelope.
        const name = (req.params as { name?: string }).name;
        if (name === 'ggui_runtime_submit_action') {
          return response(req.id, {
            structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' },
          });
        }
        return response(req.id, { structuredContent: { ok: true } });
      }
      return errorResponse(
        req.id,
        METHOD_NOT_SUPPORTED,
        `method_not_supported: ${req.method} — this host answers ui/initialize, tools/call only`,
      );
    },
  };
}

/** Honest initialize-only helper (the guuey-kit pre-0.12.0 posture). */
function initializeOnlyPort(): HostHelperPort {
  return {
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      if (req.method === 'ui/initialize') {
        return response(req.id, initializeResult({}));
      }
      return errorResponse(
        req.id,
        METHOD_NOT_SUPPORTED,
        `method_not_supported: ${req.method} — this host answers ui/initialize only`,
      );
    },
  };
}

/** Dishonest: silently drops everything but initialize. */
function silentDropPort(): HostHelperPort {
  return {
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      if (req.method === 'ui/initialize') {
        return response(req.id, initializeResult({}));
      }
      return null; // dropped — the runtime is left guessing
    },
  };
}

/** Dishonest: advertises serverTools yet refuses tools/call. */
function advertisesButRefusesPort(): HostHelperPort {
  return {
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      if (req.method === 'ui/initialize') {
        return response(req.id, initializeResult({ serverTools: {} }));
      }
      return errorResponse(
        req.id,
        METHOD_NOT_SUPPORTED,
        `method_not_supported: ${req.method}`,
      );
    },
  };
}

describe('host-helper conformance — grading semantics (ggui#600)', () => {
  it('a relaying helper grades tier "relaying" with every H and R case passing', async () => {
    const report = await runHostHelperConformance(relayingPort());
    expect(report.tier).toBe('relaying');
    expect(report.failures).toEqual([]);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c.outcome]));
    expect(byId['H1-initialize-well-formed']).toBe('pass');
    expect(byId['H2-advertisement-truthful']).toBe('pass');
    expect(byId['H3-refusal-honest']).toBe('pass');
    expect(byId['H4-refusal-bounded']).toBe('pass');
    expect(byId['R1-relay-round-trip']).toBe('pass');
    expect(byId['R2-relay-advertised']).toBe('pass');
  });

  it('an honest initialize-only helper grades tier "read-only" — legal, not a failure', async () => {
    const report = await runHostHelperConformance(initializeOnlyPort());
    expect(report.tier).toBe('read-only');
    expect(report.failures).toEqual([]);
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c.outcome]));
    expect(byId['H3-refusal-honest']).toBe('pass');
    // Relay cases are skipped, not failed, on a declared read-only tier.
    expect(byId['R1-relay-round-trip']).toBe('skip');
  });

  it('a silent-drop helper FAILS refusal honesty (H3) and grades nonconforming', async () => {
    const report = await runHostHelperConformance(silentDropPort(), {
      // Keep the bounded-refusal probe fast in tests.
      refusalTimeoutMs: 50,
    });
    expect(report.tier).toBe('nonconforming');
    const h3 = report.cases.find((c) => c.id === 'H3-refusal-honest');
    expect(h3?.outcome).toBe('fail');
  });

  it('an advertises-but-refuses helper FAILS truthfulness (H2) — the latch-unreachable shape', async () => {
    const report = await runHostHelperConformance(advertisesButRefusesPort());
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('fail');
    expect(report.tier).toBe('nonconforming');
  });

  it('the scorecard names its catalog and every case id is unique', async () => {
    const report = await runHostHelperConformance(relayingPort());
    expect(report.catalog).toBe('host-helper-conformance');
    const ids = report.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('C-grades — zero ungoverned chrome (round-6 doctrine @6e15724a1)', () => {
  it('a containment-only chrome audit passes C1', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      chromeAudit: {
        slotStyles: { overflow: 'hidden', width: '100%', height: '100%' },
        emptySlotStyles: { overflow: 'hidden', minHeight: '120px' },
      },
    });
    const c1 = report.cases.find((c) => c.id === 'C1-containment-only');
    expect(c1?.outcome).toBe('pass');
    expect(report.tier).toBe('relaying');
  });

  it('the exact round-6 hardcoded chrome FAILS C1 naming every offending property', async () => {
    // The McpAppIframe regression, pinned at kit level: borderWidth 1,
    // borderColor #e5e5e5, borderRadius 8 on the mounted slot — chrome
    // no theme registration could reach, present in every #589 round.
    const report = await runHostHelperConformance(relayingPort(), {
      chromeAudit: {
        slotStyles: {
          overflow: 'hidden',
          borderWidth: '1',
          borderColor: '#e5e5e5',
          borderRadius: '8',
        },
        emptySlotStyles: { overflow: 'hidden' },
      },
    });
    const c1 = report.cases.find((c) => c.id === 'C1-containment-only');
    expect(c1?.outcome).toBe('fail');
    expect(c1?.detail).toContain('borderWidth');
    expect(c1?.detail).toContain('borderColor');
    expect(c1?.detail).toContain('borderRadius');
    expect(report.tier).toBe('nonconforming');
  });

  it('empty-slot chrome fails the same rule — the fallback slot is a mount surface too', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      chromeAudit: {
        slotStyles: { overflow: 'hidden' },
        emptySlotStyles: { overflow: 'hidden', backgroundColor: '#fafafa' },
      },
    });
    const c1 = report.cases.find((c) => c.id === 'C1-containment-only');
    expect(c1?.outcome).toBe('fail');
    expect(c1?.detail).toContain('emptySlot');
    expect(c1?.detail).toContain('backgroundColor');
  });

  it('no audit supplied → C cases skip as self-certification-pending, tier unaffected', async () => {
    const report = await runHostHelperConformance(initializeOnlyPort());
    const c1 = report.cases.find((c) => c.id === 'C1-containment-only');
    expect(c1?.outcome).toBe('skip');
    expect(report.tier).toBe('read-only');
  });
});

describe('T-grades — token coverage (ggui#600 grade class 4, #598 manifest)', () => {
  // The kit never imports the validator — the option carries it as a
  // callback (implementation-as-callbacks; the reference validate is
  // `@ggui-ai/design`'s `validateThemeCoverage` bound to the shipped
  // `consumed-tokens.manifest.json`). Fakes pin the grading semantics.
  const coveredResult: ThemeCoverageValidationResult = {
    covered: true,
    uncovered: { light: [], dark: [] },
    inheritMatched: ['--ggui-spacing-md', '--ggui-spacing-sm'],
    excluded: ['--ggui-flash-color'],
  };

  it('a covered registration passes T1 with inherit + exclusion counts in the detail', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      themeCoverage: {
        registration: { light: {}, dark: {} },
        validate: () => coveredResult,
      },
    });
    const t1 = report.cases.find((c) => c.id === 'T1-theme-coverage');
    expect(t1?.outcome).toBe('pass');
    expect(t1?.detail).toContain('2 inherit-matched');
    expect(t1?.detail).toContain('1 excluded');
    expect(report.tier).toBe('relaying');
    expect(report.failures).toEqual([]);
  });

  it('the kit hands the SUPPLIED registration to the callback, untouched', async () => {
    const registration = { light: { color: {} }, dark: { color: {} } };
    let seen: unknown;
    await runHostHelperConformance(relayingPort(), {
      themeCoverage: {
        registration,
        validate: (r) => {
          seen = r;
          return coveredResult;
        },
      },
    });
    expect(seen).toBe(registration);
  });

  it('an uncovered registration FAILS T1 naming the uncovered tokens per mode', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      themeCoverage: {
        registration: { light: {}, dark: {} },
        validate: () => ({
          covered: false,
          uncovered: {
            light: ['--ggui-color-surface'],
            dark: ['--ggui-color-onSurface', '--ggui-color-surface'],
          },
          inheritMatched: [],
          excluded: [],
        }),
      },
    });
    const t1 = report.cases.find((c) => c.id === 'T1-theme-coverage');
    expect(t1?.outcome).toBe('fail');
    expect(t1?.detail).toContain('light');
    expect(t1?.detail).toContain('dark');
    expect(t1?.detail).toContain('--ggui-color-surface');
    expect(t1?.detail).toContain('--ggui-color-onSurface');
    expect(report.tier).toBe('nonconforming');
    expect(report.failures).toContain('T1-theme-coverage');
  });

  it('T1 names at most the first 10 uncovered tokens per mode, then counts the rest', async () => {
    const light = Array.from(
      { length: 12 },
      (_, i) => `--ggui-probe-${String(i + 1).padStart(2, '0')}`,
    );
    const report = await runHostHelperConformance(relayingPort(), {
      themeCoverage: {
        registration: { light: {}, dark: {} },
        validate: () => ({
          covered: false,
          uncovered: { light, dark: [] },
          inheritMatched: [],
          excluded: [],
        }),
      },
    });
    const t1 = report.cases.find((c) => c.id === 'T1-theme-coverage');
    expect(t1?.outcome).toBe('fail');
    expect(t1?.detail).toContain('--ggui-probe-01');
    expect(t1?.detail).toContain('--ggui-probe-10');
    expect(t1?.detail).toContain('…2 more');
    expect(t1?.detail).not.toContain('--ggui-probe-11');
    expect(t1?.detail).not.toContain('--ggui-probe-12');
  });

  it('no theme registration supplied → T1 skips, tier unaffected', async () => {
    const report = await runHostHelperConformance(initializeOnlyPort());
    const t1 = report.cases.find((c) => c.id === 'T1-theme-coverage');
    expect(t1?.outcome).toBe('skip');
    expect(t1?.detail).toContain('no theme registration supplied');
    expect(report.tier).toBe('read-only');
  });
});
