/**
 * Scenario 20 — Slice 2 public env channel: render gate + bootstrap
 * projection.
 *
 * Companion to Scenario 19 (gadget registry gate). Where 19
 * pins the membership gate (`assertGadgetsRegistered`), this
 * scenario pins the env-channel gate (`assertPublicEnvSatisfied`) and
 * the union-filtered bootstrap projection (`derivePublicEnvProjection`).
 *
 * The bootstrap on a successful render lands on
 * `result._meta.ggui.bootstrap` per the MCP Apps spec. Tests against
 * the `@ggui-samples/ggui-mapbox-demo` fixture server (port 6784):
 *
 *   - `app.gadgets` registers `useMapbox` with
 *     `requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN']`.
 *   - `app.publicEnv.GGUI_PUBLIC_APP_MAPBOX_TOKEN` carries the
 *     placeholder `<set-me-before-running>` (committed). The render gate
 *     only checks key PRESENCE, not value validity — the placeholder
 *     is enough to exercise the channel; Mapbox's own SDK would
 *     surface "Invalid token" at first request in a real render. Tests
 *     assert the key is present in the projected bootstrap; the value
 *     is opaque to the gate.
 *
 * Browser-side rendering (real iframe + wrapper bundle execution) is
 * intentionally deferred to a later slice — the wrapper bundle isn't
 * hosted yet (`registry.ggui.ai/mapbox@0.0.1/...` is a placeholder),
 * and the gate is the load-bearing surface this slice gates.
 *
 * No LLM, no internet, no extra infrastructure for the gate path.
 */
import { describe, expect, test } from 'vitest';
import {
  gadgetExportName,
  type DataContract,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const GGUI_MAPBOX_PORT = Number.parseInt(
  process.env.GGUI_MAPBOX_PORT ?? '6784',
  10,
);
const MCP_URL = `http://localhost:${GGUI_MAPBOX_PORT}/mcp`;

const GGUI_MAPBOX_MISSING_ENV_PORT = Number.parseInt(
  process.env.GGUI_MAPBOX_MISSING_ENV_PORT ?? '6785',
  10,
);
const MCP_URL_MISSING_ENV = `http://localhost:${GGUI_MAPBOX_MISSING_ENV_PORT}/mcp`;

// `ggui_list_gadgets` returns the per-app catalog as PACKAGE
// descriptors. `requires` is a package-level field; export names
// (`useMapbox`) live in the descriptor's `exports[]` array.
interface ListGadgetsOut {
  gadgets: readonly GadgetDescriptor[];
}

interface HandshakeOut {
  handshakeId: string;
}

const SCENARIO_INTENT =
  'render a small map preview — scenario 20 (public env channel gate)';

async function handshakeOnly(args: {
  contract: DataContract;
  idBase: string;
  mcpUrl?: string;
}): Promise<{ handshakeId: string }> {
  const mcpUrl = args.mcpUrl ?? MCP_URL;
  // `idBase` retained on the call shape so cross-run traces remain
  // distinguishable in LLM provider logs — handshake itself doesn't
  // read it post-Phase-B.
  void args.idBase;
  const hs = unwrapStructured<HandshakeOut>(
    await callTool(mcpUrl, 'ggui_handshake', {
      intent: SCENARIO_INTENT,
      blueprintDraft: { contract: args.contract },
      // Hint synth to skip the rewrite path so the gate validates the
      // agent's draft directly (cache + cohort fast-paths can still
      // fire but `kind: 'override'` on render pins effective contract).
      forceCreate: true,
    }),
  );
  return { handshakeId: hs.handshakeId };
}

function readToolErrorMessage(resp: {
  result?: { isError?: boolean; content?: ReadonlyArray<{ text?: string }> };
}): string | null {
  if (resp.result?.isError !== true) return null;
  return resp.result.content?.[0]?.text ?? '';
}

// Post-Phase-B: the render slice meta lives at
// `_meta["ai.ggui/render"]` (was `_meta.ggui.bootstrap` pre-rename).
// `McpAppAiGguiRenderMeta` carries `renderId`, `appId`, `gadgets`,
// `publicEnv`, and the rest of the iframe-mount payload directly.
function readBootstrap(resp: {
  result?: { _meta?: Record<string, unknown> };
}): McpAppAiGguiRenderMeta | undefined {
  const slice = resp.result?._meta?.[MCP_APP_AI_GGUI_RENDER_META_KEY];
  return slice as McpAppAiGguiRenderMeta | undefined;
}

describe('Scenario 20 — public env channel gate (ggui-mapbox-demo)', () => {
  test('ggui_list_gadgets returns the gadget-mapbox package with its requires array', async () => {
    const out = unwrapStructured<ListGadgetsOut>(
      await callTool(MCP_URL, 'ggui_list_gadgets', {}),
    );
    // The mapbox-demo's ggui.json#app.gadgets registers the
    // `@ggui-samples/gadget-mapbox` package (one `useMapbox` hook
    // export). The operator catalog REPLACES the STDLIB seed at
    // register-time (see `InMemoryAppMetadataStore.register` —
    // `input.gadgets ?? defaults ?? STDLIB`).
    const mapbox = out.gadgets.find(
      (d) => d.package === '@ggui-samples/gadget-mapbox',
    );
    expect(mapbox).toBeDefined();
    expect(mapbox?.exports.map(gadgetExportName)).toContain('useMapbox');
    // `requires` is a package-level field on the descriptor.
    expect(mapbox?.requires).toEqual(['GGUI_PUBLIC_APP_MAPBOX_TOKEN']);
  });

  test('render with satisfied requires succeeds + bootstrap carries projected publicEnv', async () => {
    // Contract uses useMapbox. The wrapper's `requires` is
    // GGUI_PUBLIC_APP_MAPBOX_TOKEN; the demo's App.publicEnv carries
    // that key (placeholder value). The gate accepts; the bootstrap
    // projection includes the key in the iframe envelope.
    const contract = {
      propsSpec: {
        description: 'scenario 20 — Mapbox happy path',
        properties: {
          center: { schema: { type: 'string' }, required: false },
        },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-mapbox': { useMapbox: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await handshakeOnly({
      contract,
      idBase: 'sc20-happy',
    });
    const renderResp = await callTool(MCP_URL, 'ggui_render', {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract } },
    });
    // Gate accepts.
    expect(readToolErrorMessage(renderResp)).toBeNull();
    const structured = (renderResp as {
      result?: { structuredContent?: { renderId?: string } };
    }).result?.structuredContent;
    expect(structured?.renderId).toBeTypeOf('string');
    // Bootstrap carries the projected publicEnv. Slice 2.2 — the
    // server filters App.publicEnv to the union of declared wrappers'
    // `requires`, so only the Mapbox token is forwarded (any other
    // operator-stamped keys would be omitted here).
    const bootstrap = readBootstrap(renderResp);
    expect(bootstrap).toBeDefined();
    expect(bootstrap?.publicEnv).toBeDefined();
    expect(Object.keys(bootstrap?.publicEnv ?? {})).toEqual([
      'GGUI_PUBLIC_APP_MAPBOX_TOKEN',
    ]);
    // Value passes through verbatim — gate only checks presence,
    // not validity. Placeholder is the deliberate stand-in for "real
    // token would go here"; the wrapper-side Mapbox SDK is what
    // ultimately consumes / rejects the value.
    expect(
      typeof bootstrap?.publicEnv?.['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
    ).toBe('string');
    // And the gadget catalog itself rides on the bootstrap (per-package
    // since GG.8.2), so the iframe runtime can dynamic-import the
    // operator's gadget package. `toContain` keeps the assertion
    // permissive if future slices project more.
    const bootstrapPackages = bootstrap?.gadgets?.map((g) => g.package);
    expect(bootstrapPackages).toContain('@ggui-samples/gadget-mapbox');
  });

  // Slice 2.1 — load-bearing assertion of the env gate. Mirrors the
  // happy path's contract exactly; the only difference is the fixture
  // server's `app.publicEnv` is absent (operator forgot to stamp the
  // required key). Gate fires `gadget_public_env_missing`.
  test('render against a server missing the required publicEnv key is rejected with gadget_public_env_missing', async () => {
    const contract = {
      propsSpec: {
        description: 'scenario 20 — Mapbox missing-env negative path',
        properties: {
          center: { schema: { type: 'string' }, required: false },
        },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-mapbox': { useMapbox: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await handshakeOnly({
      contract,
      idBase: 'sc20-missing-env',
      mcpUrl: MCP_URL_MISSING_ENV,
    });
    const renderResp = await callTool(MCP_URL_MISSING_ENV, 'ggui_render', {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract } },
    });
    const message = readToolErrorMessage(renderResp);
    expect(message).not.toBeNull();
    expect(message ?? '').toMatch(/gadget_public_env_missing/i);
    // Error names the missing key + the wrapper that required it, so
    // the operator's fix is unambiguous: "stamp this key on
    // App.publicEnv" rather than "look around your config."
    expect(message ?? '').toMatch(/GGUI_PUBLIC_APP_MAPBOX_TOKEN/);
    expect(message ?? '').toMatch(/useMapbox/);
    // Bootstrap is NOT emitted on rejection — no projection happens
    // because the gate stops the render before resultMeta runs.
    expect(readBootstrap(renderResp)).toBeUndefined();
  });

  test('render referencing an unregistered hook surfaces the registry gate (not the env gate)', async () => {
    // Defense-in-depth: the env gate runs ALONGSIDE the registry
    // gate, not in place of it. A contract using a hook that's not
    // in App.gadgets fails the registry check FIRST so the
    // operator gets the right diagnostic — "you forgot to register
    // the wrapper", not "you forgot to stamp the env."
    const contract = {
      propsSpec: {
        description: 'scenario 20 — unregistered hook (registry gate path)',
        properties: {
          status: { schema: { type: 'string' }, required: false },
        },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-mapbox': { useDoorDashCheckout: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await handshakeOnly({
      contract,
      idBase: 'sc20-unregistered',
    });
    const renderResp = await callTool(MCP_URL, 'ggui_render', {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract } },
    });
    const message = readToolErrorMessage(renderResp);
    expect(message).not.toBeNull();
    // Registry gate fires first — env gate never runs.
    expect(message ?? '').toMatch(/gadget_not_registered/i);
    expect(message ?? '').not.toMatch(/gadget_public_env_missing/i);
  });
});
