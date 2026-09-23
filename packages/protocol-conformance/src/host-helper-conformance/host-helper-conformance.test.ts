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

/**
 * A helper advertising `serverResources` (the MCP Apps capability
 * "host can proxy resource reads to the MCP server"), with its
 * `resources/read` answer injected per test. `serverTools` is not
 * advertised and `tools/call` is honestly refused, so the tools tier
 * stays `read-only` and every grade below is about the read door alone.
 */
function resourceReadingPort(
  answerRead: (req: JsonRpcRequest) => JsonRpcResponse | null,
  seen: JsonRpcRequest[] = [],
): HostHelperPort {
  return {
    async send(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
      seen.push(req);
      if (req.method === 'ui/initialize') {
        return response(req.id, initializeResult({ serverResources: {} }));
      }
      if (req.method === 'resources/read') return answerRead(req);
      return errorResponse(
        req.id,
        METHOD_NOT_SUPPORTED,
        `method_not_supported: ${req.method}`,
      );
    },
  };
}

function readUri(req: JsonRpcRequest): string {
  const params = req.params;
  if (typeof params !== 'object' || params === null || !('uri' in params)) {
    return '';
  }
  const { uri } = params;
  return typeof uri === 'string' ? uri : '';
}

describe('H2 — serverResources is answered by resources/read (ggui#1304)', () => {
  it('a helper that advertises serverResources and forwards the read passes H2', async () => {
    const report = await runHostHelperConformance(
      resourceReadingPort((req) =>
        response(req.id, {
          contents: [
            { uri: readUri(req), mimeType: 'text/html;profile=mcp-app', text: '<html></html>' },
          ],
        }),
      ),
    );
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('pass');
    expect(h2?.detail).toContain('resources/read');
    // The read door does not decide the tools tier.
    expect(report.tier).toBe('read-only');
    expect(report.failures).toEqual([]);
  });

  it("forwarding the server's own typed error is an answer, not a refusal", async () => {
    // The probe names a render that does not exist, so a relaying
    // helper legitimately hands back the server's classification.
    const report = await runHostHelperConformance(
      resourceReadingPort((req) => ({
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32002, message: 'Resource not found' },
      })),
    );
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('pass');
  });

  it('advertising serverResources and refusing resources/read FAILS H2, naming the method', async () => {
    const report = await runHostHelperConformance(
      resourceReadingPort((req) =>
        errorResponse(req.id, METHOD_NOT_SUPPORTED, 'method_not_supported'),
      ),
    );
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('fail');
    expect(h2?.detail).toContain('serverResources');
    expect(h2?.detail).toContain('resources/read');
    expect(report.tier).toBe('nonconforming');
  });

  it('advertising serverResources and dropping resources/read FAILS H2', async () => {
    const report = await runHostHelperConformance(
      resourceReadingPort(() => null),
      { refusalTimeoutMs: 50 },
    );
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('fail');
    expect(h2?.detail).toContain('resources/read');
  });

  it('answering the read with something other than a ReadResourceResult FAILS H2 — a re-shaped read breaks the door', async () => {
    const report = await runHostHelperConformance(
      resourceReadingPort((req) => response(req.id, { html: '<html></html>' })),
    );
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('fail');
    expect(h2?.detail).toContain('contents');
  });

  it('the probe reads a render locator, so a helper that forwards only ui://ggui/render/ reads still forwards it', async () => {
    const seen: JsonRpcRequest[] = [];
    await runHostHelperConformance(
      resourceReadingPort((req) => response(req.id, { contents: [] }), seen),
    );
    const reads = seen.filter((r) => r.method === 'resources/read');
    expect(reads).toHaveLength(1);
    expect(readUri(reads[0]!).startsWith('ui://ggui/render/')).toBe(true);
  });

  it('a helper that does not advertise serverResources is never sent resources/read and stays legal', async () => {
    const seen: JsonRpcRequest[] = [];
    const inner = relayingPort();
    const report = await runHostHelperConformance({
      async send(req) {
        seen.push(req);
        return inner.send(req);
      },
    });
    expect(seen.some((r) => r.method === 'resources/read')).toBe(false);
    expect(report.tier).toBe('relaying');
    expect(report.failures).toEqual([]);
  });

  it('with both capabilities advertised, one untruthful probe fails H2 even when the other answers', async () => {
    const report = await runHostHelperConformance({
      async send(req) {
        if (req.method === 'ui/initialize') {
          return response(
            req.id,
            initializeResult({ serverTools: {}, serverResources: {} }),
          );
        }
        if (req.method === 'tools/call') {
          return response(req.id, { structuredContent: { ok: true } });
        }
        return errorResponse(req.id, METHOD_NOT_SUPPORTED, `method_not_supported: ${req.method}`);
      },
    });
    const h2 = report.cases.find((c) => c.id === 'H2-advertisement-truthful');
    expect(h2?.outcome).toBe('fail');
    expect(h2?.detail).toContain('resources/read');
    expect(h2?.detail).not.toContain('tools/call was refused');
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

  it('an explicit NON-PAINTING border (none / 0) passes C1 — neutralizing UA defaults is containment, painting is chrome', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      chromeAudit: {
        slotStyles: { overflow: 'hidden', border: 'none' },
        emptySlotStyles: { border: '0' },
      },
    });
    const c1 = report.cases.find((c) => c.id === 'C1-containment-only');
    expect(c1?.outcome).toBe('pass');
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
