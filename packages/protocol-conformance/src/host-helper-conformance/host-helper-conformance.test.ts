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
  amendInputSchema,
  consumeInputSchema,
  emitInputSchema,
  getRenderSourceInputSchema,
  getSessionInputSchema,
  runtimePullInputSchema,
  runtimeTelemetryInputSchema,
  reportRenderFailureInputSchema,
} from '@ggui-ai/protocol';
import { isGguiSubmitActionInput } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  MODEL_RESOURCE_FIXTURE,
  MODEL_TOOL_SET_FIXTURE,
  VIEW_BINDING_CASES,
  VIEW_BINDING_MOUNT,
  VIEW_MATERIAL_CANARIES,
  VIEW_MATERIAL_READ_FIXTURE,
  VIEW_MATERIAL_RESULT_FIXTURE,
  VIEW_SESSION_BOUND_CALLS,
  VIEW_MATERIAL_VISIBLE_MARKER,
  runHostHelperConformance,
  type MountedView,
  type ServedResourceDeclaration,
  type ToolResultFixture,
  type ViewRequestFixture,
  type HostHelperPort,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ServedToolDeclaration,
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

/**
 * M1 — the host's MODEL-facing tool set excludes app-only tools (ggui#1414).
 *
 * SEP-1865 assigns the visibility door to the host: a tool whose
 * `_meta.ui.visibility` lacks `'model'` MUST NOT be offered to the model.
 * The server cannot observe a violation (a view-issued and a model-issued
 * call are indistinguishable on the wire), so the kit grades the host's own
 * filter, implementation-as-callbacks: the host supplies the function it
 * uses to derive the model's tool list from a served `tools/list`, the kit
 * feeds the fixture catalog (model tools, seven app-only runtime tools) and
 * grades the result against the reference predicate.
 */
describe('M1 — model tool set excludes app-only tools (ggui#1414)', () => {
  const offerByVisibility = (served: readonly ServedToolDeclaration[]): readonly string[] =>
    served
      .filter((t) => t._meta?.ui?.visibility === undefined || t._meta.ui.visibility.includes('model'))
      .map((t) => t.name);

  it('is skipped, not failed, when the host supplies no filter', async () => {
    const report = await runHostHelperConformance(relayingPort());
    expect(report.cases.find((c) => c.id === 'M1-model-tool-set')?.outcome).toBe('skip');
    expect(report.tier).toBe('relaying');
  });

  it('passes a host whose filter withholds exactly the app-only tools and keeps the rest', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      modelToolSet: { offeredToModel: offerByVisibility },
    });
    expect(report.cases.find((c) => c.id === 'M1-model-tool-set')?.outcome).toBe('pass');
    expect(report.tier).toBe('relaying');
  });

  it('FAILS a host that offers every served tool, naming the app-only tools it leaked', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      modelToolSet: { offeredToModel: (served) => served.map((t) => t.name) },
    });
    const m1 = report.cases.find((c) => c.id === 'M1-model-tool-set');
    expect(m1?.outcome).toBe('fail');
    expect(m1?.detail).toContain('ggui_runtime_submit_action');
    expect(m1?.detail).toContain('ggui_runtime_refresh_ws_token');
    expect(report.tier).toBe('nonconforming');
    expect(report.failures).toContain('M1-model-tool-set');
  });

  it('FAILS a host that withholds a model tool, naming it — over-filtering is a dead card too', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      modelToolSet: {
        offeredToModel: (served) => offerByVisibility(served).filter((n) => n !== 'ggui_consume'),
      },
    });
    const m1 = report.cases.find((c) => c.id === 'M1-model-tool-set');
    expect(m1?.outcome).toBe('fail');
    expect(m1?.detail).toContain('ggui_consume');
  });

  it('FAILS a filter that offers names not on the served list, naming them — a list not derived from tools/list is a broken filter', async () => {
    const report = await runHostHelperConformance(relayingPort(), {
      modelToolSet: { offeredToModel: (served) => [...offerByVisibility(served), 'ggui_invented_tool'] },
    });
    const m1 = report.cases.find((c) => c.id === 'M1-model-tool-set');
    expect(m1?.outcome).toBe('fail');
    expect(m1?.detail).toContain('ggui_invented_tool');
  });

  it('the fixture is a served-equivalent shape: seven app-only runtime tools, the rest model-visible or unmarked', () => {
    const appOnly = MODEL_TOOL_SET_FIXTURE.filter((t) => t._meta?.ui?.visibility?.includes('model') === false);
    expect(appOnly.map((t) => t.name).sort()).toEqual([
      'ggui_runtime_declare_tool_catalog',
      'ggui_runtime_pull',
      'ggui_runtime_refresh_ws_token',
      'ggui_runtime_report_render_failure',
      'ggui_runtime_submit_action',
      'ggui_runtime_sync_context',
      'ggui_runtime_telemetry',
    ]);
    expect(MODEL_TOOL_SET_FIXTURE.some((t) => t._meta === undefined)).toBe(true);
    // Served fidelity: `ggui_handshake` carries no marker on the wire; the
    // explicit ['model'] entries are the two that stamp GGUI_RENDER_UI_META.
    expect(MODEL_TOOL_SET_FIXTURE.find((t) => t.name === 'ggui_handshake')?._meta).toBeUndefined();
    expect(MODEL_TOOL_SET_FIXTURE.filter((t) => t._meta?.ui?.visibility?.includes('model')).map((t) => t.name).sort()).toEqual(['ggui_render', 'ggui_update']);
  });
});

/**
 * V1 (ggui#1415, SPEC §4.7): the host keeps view-delivered material out of
 * the model's context. The kit feeds the host's own context builder a render
 * result whose `_meta["ai.ggui/render"]` slice carries a unique marker in
 * every string value, and requires none of them (raw, or inside a base64 /
 * base64url run) in what the model sees, while the model still sees the
 * result's own model-visible marker.
 */
describe('V1 — view material withheld from the model (ggui#1415)', () => {
  const modelSeesResult = (r: ToolResultFixture): unknown => ({ structuredContent: r.structuredContent, content: r.content });
  const offerNonRender = (served: readonly ServedResourceDeclaration[]): readonly string[] =>
    served.map((r) => r.uri ?? r.uriTemplate ?? '').filter((u) => !u.startsWith('ui://ggui/render'));
  const grade = async (
    modelContextOf: (r: ToolResultFixture) => unknown,
    // `null` omits the resource list: the host offers the model no reads.
    resourcesOfferedToModel: ((served: readonly ServedResourceDeclaration[]) => readonly string[]) | null = offerNonRender,
    modelContextOfRead: (read: unknown) => unknown = () => undefined,
  ) =>
    (
      await runHostHelperConformance(relayingPort(), {
        modelContext: { modelContextOf, modelContextOfRead, ...(resourcesOfferedToModel !== null ? { resourcesOfferedToModel } : {}) },
      })
    ).cases.find((c) => c.id === 'V1-view-material-withheld');

  it('is skipped, not failed, when the host supplies no context rule', async () => {
    const report = await runHostHelperConformance(relayingPort());
    expect(report.cases.find((c) => c.id === 'V1-view-material-withheld')?.outcome).toBe('skip');
  });

  it('passes a host that shows the model the result but not its _meta', async () => {
    expect((await grade(modelSeesResult))?.outcome).toBe('pass');
  });

  it('FAILS a host that passes the whole result, _meta included, naming the leaked key', async () => {
    const v1 = await grade((r) => r);
    expect(v1?.outcome).toBe('fail');
    expect(v1?.detail).toContain('viewKey');
  });

  it('FAILS a host that leaks only the props, JSON-escaped: every value is marked, not only the key', async () => {
    const slice = VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'] as Record<string, unknown>;
    const v1 = await grade((r) => ({ ...modelSeesResult(r) as object, note: JSON.stringify({ props: slice['propsJson'] }) }));
    expect(v1?.outcome).toBe('fail');
    expect(v1?.detail).toContain('propsJson');
  });

  it('FAILS a host that serializes the slice into the text the model reads', async () => {
    const v1 = await grade((r) => ({ ...modelSeesResult(r) as object, note: JSON.stringify(r._meta) }));
    expect(v1?.outcome).toBe('fail');
  });

  it('FAILS a host that stuffs the slice in as a base64url blob', async () => {
    const blob = Buffer.from(JSON.stringify(VIEW_MATERIAL_RESULT_FIXTURE._meta), 'utf8').toString('base64url');
    const v1 = await grade((r) => ({ ...modelSeesResult(r) as object, attachment: `meta:${blob}` }));
    expect(v1?.outcome).toBe('fail');
    expect(v1?.detail).toMatch(/base64/);
  });

  it('FAILS a host that shows the model nothing: withholding the result is not withholding the view material', async () => {
    const v1 = await grade(() => ({}));
    expect(v1?.outcome).toBe('fail');
    expect(v1?.detail).toContain(VIEW_MATERIAL_VISIBLE_MARKER);
  });

  it('FAILS a host that offers the model a render read, and a list that hides every resource', async () => {
    const offersRender = await grade(modelSeesResult, (served) => served.map((r) => r.uri ?? r.uriTemplate ?? ''));
    expect(offersRender?.outcome).toBe('fail');
    expect(offersRender?.detail).toContain('ui://ggui/render');
    const hidesAll = await grade(modelSeesResult, () => []);
    expect(hidesAll?.outcome).toBe('fail');
  });

  it('passes a host that offers the model no resource reads at all (no resource list supplied)', async () => {
    const v1 = await grade(modelSeesResult, null);
    expect(v1?.outcome).toBe('pass');
    expect(v1?.detail).toContain('offers the model no resource reads');
  });

  it("FAILS a host that places a render read's body in the model's context", async () => {
    const v1 = await grade(modelSeesResult, offerNonRender, (read) => read);
    expect(v1?.outcome).toBe('fail');
    expect(v1?.detail).toContain('render read body');
  });

  it('FAILS a host that puts the slice in a URL query string, percent-encoded, even a value with no escape-free mark', async () => {
    const slice = VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'] as Record<string, unknown>;
    const whole = await grade((r) => ({ ...modelSeesResult(r) as object, link: `https://viewer.example.com/view?meta=${encodeURIComponent(JSON.stringify(r._meta))}` }));
    expect(whole?.outcome).toBe('fail');
    // `expiresAt` carries no mark, and its colons encode to %3A: only decoding finds it.
    const onlyExpiry = await grade((r) => ({ ...modelSeesResult(r) as object, link: `https://viewer.example.com/view?exp=${encodeURIComponent(String(slice['expiresAt']))}` }));
    expect(onlyExpiry?.outcome).toBe('fail');
    expect(onlyExpiry?.detail).toContain('percent-encoded');
    expect(onlyExpiry?.detail).toContain('expiresAt');
    // A stray % elsewhere in the same string does not hide it.
    const stray = await grade((r) => ({ ...modelSeesResult(r) as object, link: `100% sure: ?exp=${encodeURIComponent(String(slice['expiresAt']))}` }));
    expect(stray?.outcome).toBe('fail');
  });

  it('FAILS a host whose base64url blob follows a URL path, whatever its alignment', async () => {
    const blob = Buffer.from(JSON.stringify(VIEW_MATERIAL_RESULT_FIXTURE._meta), 'utf8').toString('base64url');
    for (const prefix of ['https://viewer.example.com/v/', 'https://viewer.example.com/vv/', 'x/', 'ab_']) {
      const v1 = await grade((r) => ({ ...modelSeesResult(r) as object, link: `${prefix}${blob}` }));
      expect(v1?.outcome, prefix).toBe('fail');
    }
  });

  it('FAILS a leak held in a Map, a Set, a Buffer or an object key', async () => {
    const slice = VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'] as Record<string, unknown>;
    const viewKey = String(slice['viewKey']);
    for (const carrier of [new Map([['k', viewKey]]), new Set([viewKey]), Buffer.from(viewKey), { [viewKey]: true }]) {
      const v1 = await grade((r) => ({ ...modelSeesResult(r) as object, extra: carrier }));
      expect(v1?.outcome, String(carrier)).toBe('fail');
    }
  });

  it('grades, rather than crashes, a correct host whose context is circular or built asynchronously', async () => {
    const circular = await grade((r) => {
      const ctx: Record<string, unknown> = { ...modelSeesResult(r) as object };
      ctx['self'] = ctx;
      return ctx;
    });
    expect(circular?.outcome).toBe('pass');
    const asynchronous = await grade(async (r) => modelSeesResult(r));
    expect(asynchronous?.outcome).toBe('pass');
  });

  it('passes a host that shows the model structuredContent only', async () => {
    expect((await grade((r) => ({ structuredContent: r.structuredContent })))?.outcome).toBe('pass');
  });

  it('reports a rule that throws as a fail, not a crash', async () => {
    const v1 = await grade(() => {
      throw new Error('boom');
    });
    expect(v1?.outcome).toBe('fail');
    expect(v1?.detail).toContain('threw: boom');
  });

  it('names only the field that leaked: no canary is a part of another', async () => {
    for (const a of VIEW_MATERIAL_CANARIES) for (const b of VIEW_MATERIAL_CANARIES) if (a !== b) expect(b.includes(a), `${a} in ${b}`).toBe(false);
    const slice = VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'] as Record<string, unknown>;
    const v1 = await grade((r) => ({ ...modelSeesResult(r) as object, token: `token ${String(slice['wsToken'])}` }));
    expect(v1?.detail).toContain('wsToken');
    expect(v1?.detail).not.toContain('wsUrl');
  });

  it("the read fixture is a render locator's shell with the slice inlined", () => {
    const text = VIEW_MATERIAL_READ_FIXTURE.contents[0]?.text ?? '';
    for (const canary of VIEW_MATERIAL_CANARIES) expect(text).toContain(canary);
  });

  it('the fixture canaries every string value of the slice, and the model-visible parts carry values of their own', () => {
    const slice = VIEW_MATERIAL_RESULT_FIXTURE._meta['ai.ggui/render'];
    expect(VIEW_MATERIAL_CANARIES.length).toBeGreaterThanOrEqual(6);
    const values = Object.values(slice as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
    expect(VIEW_MATERIAL_CANARIES.length).toBe(values.length);
    for (const value of values) expect(VIEW_MATERIAL_CANARIES.some((canary) => value.includes(canary)), value).toBe(true);
    const visible = JSON.stringify([VIEW_MATERIAL_RESULT_FIXTURE.structuredContent, VIEW_MATERIAL_RESULT_FIXTURE.content]);
    for (const canary of VIEW_MATERIAL_CANARIES) expect(visible).not.toContain(canary);
    expect(visible).toContain(VIEW_MATERIAL_VISIBLE_MARKER);
    expect(MODEL_RESOURCE_FIXTURE.some((r) => (r.uriTemplate ?? r.uri ?? '').startsWith('ui://ggui/render'))).toBe(true);
  });
});

/**
 * L1 (ggui#1415, SPEC §4.7): the host binds a view's calls and reads to its
 * own locator. The kit feeds the host's own relay decision a view mounted for
 * one session and requests for that session and for another one.
 */
describe('L1 — a view bound to its own locator (ggui#1415)', () => {
  const sessionOf = (request: ViewRequestFixture): string | undefined =>
    request.kind === 'resources/read'
      ? /^ui:\/\/ggui\/render\/([^/#]+)/.exec(request.uri)?.[1]
      : typeof request.arguments['sessionId'] === 'string'
        ? request.arguments['sessionId']
        : undefined;
  const bindToOwn = (mounted: MountedView, request: ViewRequestFixture): 'relay' | 'refuse' =>
    sessionOf(request) === mounted.sessionId ? 'relay' : 'refuse';
  const grade = async (decide: (m: MountedView, r: ViewRequestFixture) => 'relay' | 'refuse') =>
    (await runHostHelperConformance(relayingPort(), { viewBinding: { decide } })).cases.find((c) => c.id === 'L1-view-locator-binding');

  it('is skipped, not failed, when the host supplies no binding rule', async () => {
    const report = await runHostHelperConformance(relayingPort());
    expect(report.cases.find((c) => c.id === 'L1-view-locator-binding')?.outcome).toBe('skip');
  });

  it("passes a host that relays a view's own session and refuses another's", async () => {
    expect((await grade(bindToOwn))?.outcome).toBe('pass');
  });

  it("FAILS a host that relays a read of another view's locator", async () => {
    const l1 = await grade((m, r) => (r.kind === 'resources/read' ? 'relay' : bindToOwn(m, r)));
    expect(l1?.outcome).toBe('fail');
    expect(l1?.detail).toContain('resources/read');
  });

  it('FAILS a host that binds submit_action but relays pull for another session, the read-only call a host relays loosely', async () => {
    const l1 = await grade((m, r) => (r.kind === 'tools/call' && r.name === 'ggui_runtime_pull' ? 'relay' : bindToOwn(m, r)));
    expect(l1?.outcome).toBe('fail');
    expect(l1?.detail).toContain('ggui_runtime_pull');
  });

  it("FAILS a host that refuses everything: a view that can't reach its own session is a dead card", async () => {
    const l1 = await grade(() => 'refuse');
    expect(l1?.outcome).toBe('fail');
    expect(l1?.detail).toMatch(/refused its own/);
  });

  it("covers every locator form and every session-naming call a view may make, for its own session and another", () => {
    expect(VIEW_BINDING_MOUNT.locator.startsWith(`ui://ggui/render/${VIEW_BINDING_MOUNT.sessionId}/`)).toBe(true);
    const tools = [...new Set(VIEW_BINDING_CASES.flatMap((c) => (c.request.kind === 'tools/call' ? [c.request.name] : [])))].sort();
    expect(tools).toEqual([
      'ggui_amend',
      'ggui_consume',
      'ggui_emit',
      'ggui_get_render_source',
      'ggui_get_session',
      'ggui_runtime_pull',
      'ggui_runtime_report_render_failure',
      'ggui_runtime_submit_action',
      'ggui_runtime_sync_context',
      'ggui_runtime_telemetry',
    ]);
    const reads = VIEW_BINDING_CASES.filter((c) => c.request.kind === 'resources/read');
    expect(reads.map((c) => [c.request.kind === 'resources/read' ? c.request.uri : '', c.expect])).toEqual([
      ['ui://ggui/render/vmx-s1/bk-vmx1', 'relay'],
      ['ui://ggui/render/vmx-s1', 'relay'],
      ['ui://ggui/render/vmx-s1#2', 'relay'],
      ['ui://ggui/render/vmx-s2', 'refuse'],
      ['ui://ggui/render/vmx-s2/bk-vmx2', 'refuse'],
      ['ui://ggui/render/vmx-s2/bk-vmx2#1', 'refuse'],
    ]);
    expect(VIEW_BINDING_CASES.filter((c) => c.expect === 'relay').length).toBe(13);
    expect(VIEW_BINDING_CASES.filter((c) => c.expect === 'refuse').length).toBe(13);
  });

  it("each call's arguments are ones the tool's own input schema accepts, so a host that validates them does not refuse its own view", () => {
    const parsers: Record<string, (args: unknown) => boolean> = {
      ggui_runtime_submit_action: (a) => isGguiSubmitActionInput(a),
      ggui_runtime_pull: (a) => runtimePullInputSchema.safeParse(a).success,
      ggui_runtime_telemetry: (a) => runtimeTelemetryInputSchema.safeParse(a).success,
      ggui_runtime_report_render_failure: (a) => reportRenderFailureInputSchema.safeParse(a).success,
      ggui_consume: (a) => consumeInputSchema.safeParse(a).success,
      ggui_amend: (a) => amendInputSchema.safeParse(a).success,
      ggui_emit: (a) => emitInputSchema.safeParse(a).success,
      ggui_get_session: (a) => getSessionInputSchema.safeParse(a).success,
      ggui_get_render_source: (a) => getRenderSourceInputSchema.safeParse(a).success,
      // No exported schema; the handler's shape: a session and a snapshot object.
      ggui_runtime_sync_context: (a) => typeof a === 'object' && a !== null && 'sessionId' in a && 'snapshot' in a,
    };
    for (const call of VIEW_SESSION_BOUND_CALLS) {
      expect(parsers[call.name]?.(call.args(VIEW_BINDING_MOUNT.sessionId)), call.name).toBe(true);
    }
  });

  it("FAILS a host that binds only the runtime calls and relays ggui_consume for another session", async () => {
    const l1 = await grade((m, r) => (r.kind === 'tools/call' && !r.name.startsWith('ggui_runtime_') ? 'relay' : bindToOwn(m, r)));
    expect(l1?.outcome).toBe('fail');
    expect(l1?.detail).toContain('ggui_consume');
  });

  it('FAILS a host that binds only the one-segment locator and relays the other forms', async () => {
    const l1 = await grade((m, r) =>
      r.kind === 'resources/read' ? (/^ui:\/\/ggui\/render\/[^/#]+$/.test(r.uri) ? bindToOwn(m, r) : 'relay') : bindToOwn(m, r),
    );
    expect(l1?.outcome).toBe('fail');
    expect(l1?.detail).toContain('bk-vmx2');
  });

  it('reports a rule that throws as a fail, not a crash', async () => {
    const l1 = await grade(() => {
      throw new Error('boom');
    });
    expect(l1?.outcome).toBe('fail');
    expect(l1?.detail).toContain('ui://ggui/render/vmx-s2');
  });
});
