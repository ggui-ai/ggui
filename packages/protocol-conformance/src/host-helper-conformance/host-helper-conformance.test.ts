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
