/**
 * Scenario 25 — component-gadget registry round-trip (GG.8 close).
 *
 * The GG.8 arc's headline capability: gadgets are no longer hook-only.
 * A gadget package may export a COMPONENT (a chart, a map, a
 * date-picker) the generated UI renders as JSX — `<LeafletMap … />` —
 * instead of a hook it calls. This scenario pins the component-gadget
 * wire path end-to-end through `ggui_render`, against the
 * `@ggui-samples/ggui-leaflet-demo` fixture server (port 6783).
 *
 * The demo's `ggui.json#app.gadgets` registers the
 * `@ggui-samples/gadget-leaflet` package — a single COMPONENT export,
 * `LeafletMap` (the GG.8.7 hook→component migration).
 *
 * What this proves:
 *
 *   1. `ggui_list_gadgets` surfaces the `@ggui-samples/gadget-leaflet`
 *      package descriptor with its `LeafletMap` component export.
 *   2. A `ggui_render` whose contract declares a package-keyed
 *      `clientCapabilities.gadgets` entry — `{ "@ggui-samples/gadget-leaflet":
 *      { LeafletMap: {} } }` — for that registered COMPONENT export
 *      succeeds: `assertGadgetsRegistered` resolves the
 *      `(package, export)` reference by identity, kind-agnostic. The
 *      export-name grammar (PascalCase) marks it a component; the gate
 *      never special-cases kind.
 *   3. A `ggui_render` referencing an UNREGISTERED component export is
 *      REJECTED with `gadget_not_registered` — the same gate, the same
 *      reject code as the hook path (scenario 19).
 *
 * Companion to scenario 19 (hook-gadget registry gate). Where 19 pins
 * the gate against the STDLIB hook catalog, this pins it against an
 * operator-registered COMPONENT package.
 *
 * Every render uses `override.contract` for the same reason scenario 19
 * does — it pins the effective contract to the agent's draft so the
 * gate validates the exact `(package, export)` references the test
 * declares, regardless of any synth/cache fast-path.
 *
 * No LLM, no internet, no extra infrastructure for the gate path.
 */
import { describe, expect, test } from 'vitest';
import {
  gadgetExportName,
  type DataContract,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const GGUI_LEAFLET_PORT = Number.parseInt(
  process.env.GGUI_LEAFLET_PORT ?? '6783',
  10,
);
const MCP_URL = `http://localhost:${GGUI_LEAFLET_PORT}/mcp`;

const LEAFLET_PACKAGE = '@ggui-samples/gadget-leaflet';

interface ListGadgetsOut {
  gadgets: readonly GadgetDescriptor[];
}

interface HandshakeOut {
  handshakeId: string;
}

const SCENARIO_INTENT =
  'render a small map preview — scenario 25 (component gadget round-trip)';

async function handshakeOnly(args: {
  contract: DataContract;
  idBase: string;
}): Promise<{ handshakeId: string }> {
  // `idBase` retained on the call shape so cross-run traces remain
  // distinguishable in LLM provider logs — handshake itself doesn't
  // read it post-Phase-B.
  void args.idBase;
  const hs = unwrapStructured<HandshakeOut>(
    await callTool(MCP_URL, 'ggui_handshake', {
      intent: SCENARIO_INTENT,
      blueprintDraft: { contract: args.contract },
      forceCreate: true,
    }),
  );
  return { handshakeId: hs.handshakeId };
}

/**
 * Read the tool-level error message from a `tools/call` response.
 * GguiSession validators throw → MCP wraps the throw as `result.isError: true`
 * with the message in `result.content[0].text`. Returns the message
 * string when present, or `null` when the response was a success.
 */
function readToolErrorMessage(resp: unknown): string | null {
  const r = (
    resp as {
      result?: { isError?: boolean; content?: ReadonlyArray<{ text?: string }> };
    }
  ).result;
  if (r?.isError !== true) return null;
  const text = r.content?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

describe('Scenario 25 — component-gadget registry round-trip', () => {
  test('ggui_list_gadgets surfaces the gadget-leaflet package with its LeafletMap component export', async () => {
    const out = unwrapStructured<ListGadgetsOut>(
      await callTool(MCP_URL, 'ggui_list_gadgets', {}),
    );
    const leaflet = out.gadgets.find((d) => d.package === LEAFLET_PACKAGE);
    expect(leaflet).toBeDefined();
    // The export is a COMPONENT — discriminated by field presence.
    const leafletExport = leaflet?.exports[0];
    expect(leafletExport).toBeDefined();
    expect(leafletExport && 'component' in leafletExport).toBe(true);
    expect(leaflet?.exports.map(gadgetExportName)).toContain('LeafletMap');
  });

  test('render with a registered component gadget succeeds (gate accepts the component ref)', async () => {
    const contract = {
      propsSpec: {
        description: 'scenario 25 — registered-component render',
        properties: {
          center: {
            schema: { type: 'array' },
            required: false,
            description: '[lat, lng] map center',
          },
        },
      },
      clientCapabilities: {
        gadgets: {
          [LEAFLET_PACKAGE]: { LeafletMap: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await handshakeOnly({
      contract,
      idBase: 'sc25-registered',
    });
    const renderResp = await callTool(MCP_URL, 'ggui_render', {
      handshakeId,
      props: {},
      override: { contract },
    });
    // Gate accepts a component-gadget reference → render completes.
    expect(readToolErrorMessage(renderResp)).toBeNull();
    const structured = (
      renderResp as { result?: { structuredContent?: { sessionId?: string } } }
    ).result?.structuredContent;
    expect(structured?.sessionId).toBeTypeOf('string');
  });

  test('render with an unregistered component export is rejected with the gate error', async () => {
    const contract = {
      propsSpec: {
        description: 'scenario 25 — unregistered-component render',
        properties: {
          center: { schema: { type: 'array' }, required: false },
        },
      },
      clientCapabilities: {
        gadgets: {
          // PascalCase name → component-grammar export; never
          // registered on this app → the registry gate rejects it.
          [LEAFLET_PACKAGE]: { MapboxGlobe: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await handshakeOnly({
      contract,
      idBase: 'sc25-unregistered',
    });
    const renderResp = await callTool(MCP_URL, 'ggui_render', {
      handshakeId,
      props: {},
      override: { contract },
    });
    const message = readToolErrorMessage(renderResp);
    expect(message).not.toBeNull();
    expect(message ?? '').toMatch(/gadget_not_registered/i);
    expect(message ?? '').toMatch(/MapboxGlobe/);
  });
});
