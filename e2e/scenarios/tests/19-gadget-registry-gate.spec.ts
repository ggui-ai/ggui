/**
 * Scenario 19 — gadget registry-membership gate (plugin slice
 * Commit 8d, hardened by Slice 1.1 closeout).
 *
 * What this proves end-to-end against the default ggui server:
 *
 *   1. `ggui_list_gadgets` surfaces the STDLIB seed (one
 *      `@ggui-ai/protocol` `@ggui-ai/gadgets` package descriptor
 *      shipping the 7 first-party hook exports).
 *   2. A `ggui_push` whose contract declares a package-keyed
 *      `clientCapabilities.gadgets` entry — `{ "@ggui-ai/gadgets":
 *      { useGeolocation: {} } }` — for a registered stdlib export
 *      succeeds: the `assertGadgetsRegistered` gate accepts the
 *      `(package, export)` reference and the descriptor lands on the
 *      stack item's `gadgetDescriptors` sidecar.
 *   3. A `ggui_push` whose contract references an UNREGISTERED export
 *      (e.g. `useDoorDashCheckout`) is REJECTED with
 *      `gadget_not_registered`. The error payload carries
 *      did-you-mean suggestions when a close stdlib match exists.
 *
 * Distinct from the Commit 3 unit tests in
 * `assert-gadgets.test.ts` — those exercise the validator
 * in isolation; this scenario exercises the wire path through
 * `ggui_push` so a regression at the seam (push.ts wiring,
 * appMetadataStore plumbing in server.ts) lights up here too.
 *
 * # Why every push uses `decision.kind: 'override'`
 *
 * The default ggui server has the LLM-backed negotiator wired (real
 * `ANTHROPIC_API_KEY` from `.env.local`). Sending `kind: 'accept'`
 * would let synth amend the contract and the gate would validate the
 * AMENDED shape, not the test's intent. `kind: 'override'` pins the
 * effective contract to the agent's draft so the gate runs against
 * the actual hook references the test declares. This is the same
 * shape an agent uses in production when it's authored a complete
 * contract and doesn't want synth to second-guess it.
 *
 * # Why `result.isError === true` over JSON-RPC `error`
 *
 * MCP tool throws bubble up as `tools/call` results with `isError:
 * true` and the message in `result.content[0].text` (per the MCP
 * spec). The JSON-RPC `error` envelope is reserved for transport-
 * level failures (malformed request, unknown method). Validator
 * throws like `GadgetNotRegisteredError` are tool-level errors
 * → `result.isError`.
 *
 * The leaflet-demo sample app + Playwright render-side smoke (the
 * "real Leaflet tile loads in a real iframe with CSP applied" path)
 * is intentionally deferred to a follow-up — it needs internet,
 * the bundle isn't hosted yet (registry.ggui.ai/leaflet@0.0.1/...
 * is a placeholder), and the wire-side gate is the load-bearing
 * surface this commit gates the slice on.
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

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;

// `ggui_list_gadgets` returns the per-app catalog as PACKAGE
// descriptors — `{ gadgets: GadgetDescriptor[] }`. Each descriptor is
// a package carrying an `exports[]` array; export names are read off
// the exports, not a flat top-level `hook` field.
interface ListGadgetsOut {
  gadgets: readonly GadgetDescriptor[];
}

interface NewSessionOut {
  sessionId: string;
}

interface HandshakeOut {
  handshakeId: string;
}

const SCENARIO_INTENT =
  'render a small status card — scenario 19 (gadget registry gate)';

async function newSessionAndHandshake(args: {
  contract: DataContract;
  idBase: string;
}): Promise<{ handshakeId: string; sessionId: string }> {
  const ns = unwrapStructured<NewSessionOut>(
    await callTool(MCP_URL, 'ggui_new_session', { seed: args.idBase }),
  );
  const hs = unwrapStructured<HandshakeOut>(
    await callTool(MCP_URL, 'ggui_handshake', {
      sessionId: ns.sessionId,
      intent: SCENARIO_INTENT,
      blueprintDraft: { contract: args.contract },
      // Hint synth to skip the rewrite path. Even with `forceCreate`
      // the cache fast-path can still fire, but `kind: 'override'` on
      // push pins the effective contract regardless of suggestion
      // origin so the gate validates the agent's draft directly.
      forceCreate: true,
    }),
  );
  return { handshakeId: hs.handshakeId, sessionId: ns.sessionId };
}

/**
 * Read the tool-level error message from a `tools/call` response. Push
 * validators throw → MCP wraps the throw as `result.isError: true`
 * with the message in `result.content[0].text`. Returns the message
 * string when present, or `null` when the response was a success.
 */
function readToolErrorMessage(resp: unknown): string | null {
  const r = (resp as { result?: { isError?: boolean; content?: ReadonlyArray<{ text?: string }> } }).result;
  if (r?.isError !== true) return null;
  const text = r.content?.[0]?.text;
  return typeof text === 'string' ? text : '';
}

describe('Scenario 19 — gadget registry-membership gate', () => {
  test('ggui_list_gadgets returns the stdlib seed', async () => {
    const out = unwrapStructured<ListGadgetsOut>(
      await callTool(MCP_URL, 'ggui_list_gadgets', {}),
    );
    // STDLIB ships as one `@ggui-ai/gadgets` package descriptor —
    // flatten its `exports[]` to the 7 first-party hook names.
    const exportNames = out.gadgets
      .flatMap((descriptor) => descriptor.exports.map(gadgetExportName))
      .sort();
    expect(exportNames).toEqual([
      'useCamera',
      'useClipboardPaste',
      'useClipboardWrite',
      'useFilePicker',
      'useGeolocation',
      'useMicrophone',
      'useNotifications',
    ]);
  });

  test('push with a registered hook succeeds (gate accepts stdlib reference)', async () => {
    const contract = {
      propsSpec: {
        description: 'scenario 19 — registered-hook push',
        properties: {
          location: {
            schema: { type: 'string' },
            required: false,
            description: 'last-known location string',
          },
        },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeolocation: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await newSessionAndHandshake({
      contract,
      idBase: 'sc19-registered',
    });
    const pushResp = await callTool(MCP_URL, 'ggui_push', {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract } },
    });
    // Gate accepts → push completes. No tool-level error envelope,
    // structuredContent carries the StackItemBootstrap shape.
    expect(readToolErrorMessage(pushResp)).toBeNull();
    const structured = (pushResp as { result?: { structuredContent?: { stackItemId?: string } } })
      .result?.structuredContent;
    expect(structured?.stackItemId).toBeTypeOf('string');
  });

  test('push with an unregistered hook is rejected with the gate error', async () => {
    const contract = {
      propsSpec: {
        description: 'scenario 19 — unregistered-hook push',
        properties: {
          status: {
            schema: { type: 'string' },
            required: false,
            description: 'order status',
          },
        },
      },
      clientCapabilities: {
        gadgets: {
          // Real registered package, fabricated export name — isolates
          // the failure to the export, not the package.
          '@ggui-ai/gadgets': { useDoorDashCheckout: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await newSessionAndHandshake({
      contract,
      idBase: 'sc19-unregistered',
    });
    const pushResp = await callTool(MCP_URL, 'ggui_push', {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract } },
    });
    const message = readToolErrorMessage(pushResp);
    expect(message).not.toBeNull();
    expect(message ?? '').toMatch(/gadget_not_registered/i);
    expect(message ?? '').toMatch(/useDoorDashCheckout/);
    // The default server's stdlib doesn't carry a close cousin to
    // `useDoorDashCheckout` (Levenshtein distance to every stdlib
    // hook is well above 3), so no "did you mean" hint should appear
    // — the error message lists the unregistered hook and points at
    // the registry seam without a misleading suggestion.
    expect(message ?? '').not.toMatch(/did you mean/i);
  });

  test('push with a typo of a registered hook surfaces the did-you-mean suggestion', async () => {
    // `useGeoLocation` (camelCase typo) is Levenshtein distance 1
    // from the registered `useGeolocation` — within the < 3 cutoff.
    const contract = {
      propsSpec: {
        description: 'scenario 19 — typo-of-registered-hook push',
        properties: {
          location: { schema: { type: 'string' }, required: false },
        },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-ai/gadgets': { useGeoLocation: {} },
        },
      },
    } satisfies DataContract;
    const { handshakeId } = await newSessionAndHandshake({
      contract,
      idBase: 'sc19-typo',
    });
    const pushResp = await callTool(MCP_URL, 'ggui_push', {
      handshakeId,
      decision: { kind: 'override', blueprintDraft: { contract } },
    });
    const message = readToolErrorMessage(pushResp);
    expect(message).not.toBeNull();
    expect(message ?? '').toMatch(/did you mean/i);
    expect(message ?? '').toMatch(/useGeolocation/);
  });
});
