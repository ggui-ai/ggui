/**
 * Scenario 11 — handshake → push plumbing: `override` uses its
 * literal `blueprintDraft.contract`, NOT the stored effectiveContract.
 *
 * What this tests (plumbing, not content):
 *
 *   handshake({sessionId, intent, blueprintDraft: A})
 *     -> negotiator runs against draft A, stores effectiveContract_A
 *
 *   push({handshakeId, decision: {kind: 'accept'}})
 *     -> push.ts reads handshakeRecord.effectiveContract (== A or
 *        augmented(A)) and cold-gens against it
 *
 *   push({handshakeId, decision: {kind: 'override', blueprintDraft: B}})
 *     -> push.ts reads decision.blueprintDraft.contract (== literal B,
 *        ignoring the stored effectiveContract_A)
 *
 * The pass criterion: when A and B are DIFFERENT contract shapes,
 * accept's codeHash MUST NOT equal override's codeHash — they're
 * generating against structurally distinct contracts. If they match,
 * override is silently reading the stored effectiveContract (push.ts
 * bug).
 *
 * Why NOT compare accept-vs-override with the SAME draft (the prior
 * formulation): when the negotiator legitimately no-ops on a fully-
 * specified draft (no `clientCapabilities.libraries` to merge, no
 * synth-added boilerplate for a trivial intent), effectiveContract_A
 * IS the literal draft. Both pushes produce identical code, the
 * assertion fails, and the test conflates "negotiator no-op (correct)"
 * with "plumbing bug". Negotiator-augmentation-flow-through belongs in
 * unit tests where we can mock the negotiator deterministically.
 *
 * Different drafts (A vs B) make the plumbing observable WITHOUT
 * depending on stochastic LLM augmentation.
 *
 * Gated on `ANTHROPIC_API_KEY` because both pushes drive cold-gen
 * (different shapes → different cache keys → no warm hits).
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

interface PushOut {
  stackItemId: string;
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
 * Structurally different draft used by the `override` push. Adds a
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

function bootstrapUrlFromPushUrl(pushUrl: string | undefined): string {
  if (typeof pushUrl !== 'string') {
    throw new Error(`push output missing url: ${String(pushUrl)}`);
  }
  // Push URL shape: `<base>/r/<shortCode>?sig=...&exp=...`. Rewrite the
  // path to `/api/bootstrap/<shortCode>` but PRESERVE the signed query —
  // SEC-C.2rev's HMAC gate on /api/bootstrap rejects unsigned reads.
  const parsed = new URL(pushUrl);
  const codeMatch = /^\/r\/([^/]+)$/.exec(parsed.pathname);
  if (!codeMatch || typeof codeMatch[1] !== 'string') {
    throw new Error(`url has no /r/<shortCode>: ${pushUrl}`);
  }
  parsed.pathname = `/api/bootstrap/${codeMatch[1]}`;
  return parsed.toString();
}

async function fetchBootstrap(pushUrl: string | undefined): Promise<BootstrapJson> {
  const resp = await fetch(bootstrapUrlFromPushUrl(pushUrl));
  if (!resp.ok) {
    throw new Error(
      `bootstrap fetch ${resp.status}: ${await resp.text().catch(() => '<no body>')}`,
    );
  }
  return (await resp.json()) as BootstrapJson;
}

async function handshakeAndPush(opts: {
  seed: string;
  decision: 'accept' | 'override';
}): Promise<BootstrapJson> {
  const session = unwrapStructured<{ sessionId: string }>(
    await callTool(MCP_URL, 'ggui_new_session', { seed: opts.seed }),
  );
  const handshake = unwrapStructured<{ handshakeId: string }>(
    await callTool(MCP_URL, 'ggui_handshake', {
      sessionId: session.sessionId,
      intent:
        'a single text caption showing the user-supplied caption prop',
      blueprintDraft: { contract: HANDSHAKE_DRAFT_CONTRACT },
    }),
  );
  // Override pushes pass a STRUCTURALLY DIFFERENT draft (adds a second
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
  const out = unwrapStructured<PushOut>(
    await callTool(MCP_URL, 'ggui_push', {
      handshakeId: handshake.handshakeId,
      decision:
        opts.decision === 'accept'
          ? { kind: 'accept' }
          : {
              kind: 'override',
              blueprintDraft: { contract: OVERRIDE_DRAFT_CONTRACT },
            },
      props,
    }),
  );
  return fetchBootstrap(out.url);
}

describe.skipIf(!HAS_KEY)(
  'Scenario 11 — handshake → push reads effectiveContract',
  () => {
    test(
      'override uses its literal blueprintDraft.contract, not the stored effectiveContract',
      async () => {
        const accepted = await handshakeAndPush({
          seed: 'scenario-11-accept',
          decision: 'accept',
        });
        const overridden = await handshakeAndPush({
          seed: 'scenario-11-override',
          decision: 'override',
        });

        // Both must produce valid bootstraps.
        expect(typeof accepted.codeHash).toBe('string');
        expect(accepted.codeHash?.length).toBeGreaterThan(0);
        expect(typeof overridden.codeHash).toBe('string');
        expect(overridden.codeHash?.length).toBeGreaterThan(0);

        // Plumbing check: override generates against its OWN literal
        // draft (which adds a `subtitle` prop), NOT against the stored
        // effectiveContract (which only has `caption`). If push.ts had
        // a bug where override silently read the stored contract, the
        // generated code would miss `subtitle` and the two codeHashes
        // would collide. The structural difference between the two
        // drafts forces observably different generated code.
        expect(accepted.codeHash).not.toBe(overridden.codeHash);
      },
      // 90s × 2 cold-gens (one per push) + handshake LLM calls +
      // headroom. Both pushes cold-gen because their canonical
      // contracts differ structurally.
      240_000,
    );
  },
);
