/**
 * Scenario 11 — handshake → render plumbing: `override.contract` uses
 * its literal contract, NOT the stored effectiveContract.
 *
 * What this tests (plumbing, not content):
 *
 *   handshake({intent, blueprintDraft: A})
 *     -> negotiator runs against draft A, stores effectiveContract_A
 *
 *   render({handshakeId, props})  // accept: override omitted
 *     -> render.ts reads handshakeRecord.effectiveContract (== A or
 *        augmented(A)) and cold-gens against it
 *
 *   render({handshakeId, props, override: {contract: B}})
 *     -> render.ts reads override.contract (== literal B, ignoring the
 *        stored effectiveContract_A) and STRICT cold-gens against it
 *
 * The pass criterion: when A and B are DIFFERENT contract shapes,
 * accept's codeHash MUST NOT equal override's codeHash — they're
 * generating against structurally distinct contracts. If they match,
 * override is silently reading the stored effectiveContract (render.ts
 * bug).
 *
 * Parametric over the model-provider axis. See provider-matrix.ts.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { PROVIDERS, REQUIRE_ALL, providerSkip } from '../fixtures/provider-matrix.js';

interface RenderOut {
  renderId: string;
  url?: string;
}

interface BootstrapJson {
  codeHash?: string;
  codeUrl?: string;
}

/**
 * Handshake-time contract (also what `accept` re-renders against).
 * Single `caption` prop.
 */
const HANDSHAKE_DRAFT_CONTRACT = {
  propsSpec: {
    description: 'caption props',
    properties: {
      caption: {
        schema: { type: 'string' },
        required: true,
        description: 'caption text',
      },
    },
  },
} as const;

/**
 * Structurally different draft used by the `override` render. Adds a
 * second required prop (`subtitle`) so the cold-gen MUST produce
 * different componentCode than the handshake draft's single-prop
 * render. If override silently reused the stored effectiveContract
 * (which mirrors HANDSHAKE_DRAFT_CONTRACT), the resulting code would
 * miss `subtitle` and the codeHashes would collide.
 */
const OVERRIDE_DRAFT_CONTRACT = {
  propsSpec: {
    description: 'caption + subtitle props',
    properties: {
      caption: {
        schema: { type: 'string' },
        required: true,
        description: 'caption text',
      },
      subtitle: {
        schema: { type: 'string' },
        required: true,
        description: 'subtitle text shown beneath the caption',
      },
    },
  },
} as const;

function bootstrapUrlFromRenderUrl(renderUrl: string | undefined): string {
  if (typeof renderUrl !== 'string') {
    throw new Error(`render output missing url: ${String(renderUrl)}`);
  }
  // Render URL shape: `<base>/r/<shortCode>?sig=...&exp=...`. Rewrite the
  // path to `/r/<shortCode>` but PRESERVE the signed query —
  // SEC-C.2rev's HMAC gate on /api/bootstrap rejects unsigned reads.
  const parsed = new URL(renderUrl);
  const codeMatch = /^\/r\/([^/]+)$/.exec(parsed.pathname);
  if (!codeMatch || typeof codeMatch[1] !== 'string') {
    throw new Error(`url has no /r/<shortCode>: ${renderUrl}`);
  }
  parsed.pathname = `/r/${codeMatch[1]}`;
  return parsed.toString();
}

async function fetchBootstrap(renderUrl: string | undefined): Promise<BootstrapJson> {
  const resp = await fetch(bootstrapUrlFromRenderUrl(renderUrl), {
    headers: { Accept: 'application/json' },
  });
  if (!resp.ok) {
    throw new Error(
      `bootstrap fetch ${resp.status}: ${await resp.text().catch(() => '<no body>')}`,
    );
  }
  // R4: content-negotiated `/r/<shortCode>` returns the slice envelope.
  // Flatten the render slice into the test's legacy shape.
  const envelope = (await resp.json()) as Record<string, unknown>;
  const renderSlice =
    (envelope['ai.ggui/render'] as Record<string, unknown> | undefined) ??
    {};
  return {
    codeHash: typeof renderSlice['codeHash'] === 'string' ? renderSlice['codeHash'] : undefined,
    codeUrl: typeof renderSlice['codeUrl'] === 'string' ? renderSlice['codeUrl'] : undefined,
  };
}

async function handshakeAndRender(
  mcpUrl: string,
  opts: { seed: string; decision: 'accept' | 'override' },
): Promise<BootstrapJson> {
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(mcpUrl, 'ggui_handshake', {
      intent:
        'a single text caption showing the user-supplied caption prop',
      blueprintDraft: { contract: HANDSHAKE_DRAFT_CONTRACT },
    }),
  );
  // Override renders pass a STRUCTURALLY DIFFERENT draft (adds a second
  // required prop) so cold-gen produces observably different code than
  // accept's stored-effectiveContract render. Props payloads differ
  // per decision: accept's effectiveContract declares only `caption`;
  // override's draft declares `caption` + `subtitle`. propsSpec is
  // closed-shape — extras reject — so each path sends exactly the
  // keys its contract declares.
  const props =
    opts.decision === 'accept'
      ? { caption: 'Hello' }
      : { caption: 'Hello', subtitle: 'Caption subtitle' };
  // `seed` is preserved on the call shape so cross-run hash mismatches
  // remain traceable in the LLM provider's request log — render itself
  // doesn't read it post-Phase-B (the prior `ggui_new_session` seed sink
  // was deleted).
  void opts.seed;
  const out = unwrapStructured<RenderOut>(
    await callTool(mcpUrl, 'ggui_render', {
      handshakeId: handshake.handshakeId,
      props,
      // accept = omit `override` (reuse the stored effectiveContract);
      // override = pin our literal draft via `override.contract`.
      ...(opts.decision === 'override'
        ? { override: { contract: OVERRIDE_DRAFT_CONTRACT } }
        : {}),
    }),
  );
  return fetchBootstrap(out.url);
}

for (const provider of PROVIDERS) {
  const hasKey = !!process.env[provider.apiKey];
  describe.skipIf(providerSkip(provider))(
    `Scenario 11 [${provider.name}] — handshake → render reads effectiveContract`,
    () => {
      if (!hasKey) {
        test(`${provider.apiKey} missing (REQUIRE_ALL_PROVIDERS=${REQUIRE_ALL ? '1' : '0'})`, () => {
          throw new Error(
            `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1 but ${provider.apiKey} is not set — ` +
              `the ${provider.name} row cannot run.`,
          );
        });
        return;
      }
      const MCP_URL = provider.mcpUrl;

      test(
        'override uses its literal override.contract, not the stored effectiveContract',
        async () => {
          const accepted = await handshakeAndRender(MCP_URL, {
            seed: `scenario-11-accept-${provider.name}`,
            decision: 'accept',
          });
          const overridden = await handshakeAndRender(MCP_URL, {
            seed: `scenario-11-override-${provider.name}`,
            decision: 'override',
          });

          // Both must produce valid bootstraps.
          expect(typeof accepted.codeHash).toBe('string');
          expect(accepted.codeHash?.length).toBeGreaterThan(0);
          expect(typeof overridden.codeHash).toBe('string');
          expect(overridden.codeHash?.length).toBeGreaterThan(0);

          // Plumbing check: override generates against its OWN literal
          // draft (which adds a `subtitle` prop), NOT against the stored
          // effectiveContract (which only has `caption`). If render.ts had
          // a bug where override silently read the stored contract, the
          // generated code would miss `subtitle` and the two codeHashes
          // would collide.
          expect(accepted.codeHash).not.toBe(overridden.codeHash);
        },
        // 90s × 2 cold-gens (one per render) + handshake LLM calls +
        // headroom. Both renders cold-gen because their canonical
        // contracts differ structurally.
        240_000,
      );
    },
  );
}
