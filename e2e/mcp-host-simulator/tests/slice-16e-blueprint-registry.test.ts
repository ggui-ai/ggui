/**
 * Slice 16e empirical proof — blueprint-first runtime registry behavior
 * over the wire. Boots an OSS `createGguiServer` with a fake generator
 * + `resolveLlm` so the cache wires automatically, then drives four
 * `ggui_render` calls through `HostSimulator` to validate the three-tier
 * matcher's load-bearing claim:
 *
 *   - **Paraphrase resilience**: same canonical contract under a
 *     different intent prose still hits Tier 1. The original cache bug
 *     keyed on intent text — this test pins the new behavior so a
 *     regression to intent-keyed matching fails loudly.
 *   - **Registry isolation**: a structurally different contract misses
 *     and triggers a fresh cold gen.
 *   - **Generator gating**: the generator runs exactly once for the
 *     cold path and is short-circuited on every Tier 1 hit. If this
 *     flips, the wire isn't actually consulting the registry.
 *
 * The four cases mirror the plan-doc validation matrix for §16e and
 * are the empirical complement to `blueprint-matcher.test.ts` (which
 * runs the matcher in isolation against a mock embedder + stub LLM).
 *
 * The render output's reuse marker is the shared `RenderCacheMarker`
 * from `@ggui-ai/protocol` (Phase-1 reuse visibility) — no local mirror.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DataContract, RenderCacheMarker } from '@ggui-ai/protocol';
import {
  HostSimulator,
  bootOssServer,
  type OssFixture,
} from '../src/index.js';

const NOTEPAD_CONTRACT: DataContract = {
  contextSpec: {
    noteText: { schema: { type: 'string' }, default: '' },
    topic: {
      schema: { type: 'string', enum: ['Bug', 'Feature', 'Question'] },
      default: 'Bug',
    },
  },
};

const WEATHER_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      city: { schema: { type: 'string' }, required: true },
      temp: { schema: { type: 'number' }, required: true },
    },
  },
};

interface GguiSessionStructured {
  cache?: RenderCacheMarker;
}

describe('host-simulator: Slice 16e blueprint-first registry', () => {
  let fixture: OssFixture | null = null;
  let host: HostSimulator | null = null;
  const calls = { count: 0 };

  afterEach(async () => {
    if (host) {
      await host.close();
      host = null;
    }
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
    calls.count = 0;
  });

  async function boot(): Promise<void> {
    fixture = await bootOssServer({
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-haiku-4-5',
          tier: 'default',
          model: 'claude-haiku-4-5',
          generate: async (input) => {
            calls.count += 1;
            return {
              ok: true,
              response: {
                renderId: 'ignored',
                componentCode: `export default function C() { return <div>gen:${input.request.prompt}</div>; }`,
                sourceCode: `export default function C() { return <div>gen:${input.request.prompt}</div>; }`,
              },
              metadata: {
                provider: 'anthropic',
                model: 'claude-opus-4-7',
                inputTokens: 10,
                outputTokens: 20,
                latencyMs: 42,
                cacheHit: false,
                attempts: 1,
              },
            };
          },
        },
        resolveLlm: () => ({
          selection: { provider: 'anthropic', model: 'claude-opus-4-7' },
          providerKey: { provider: 'anthropic', key: 'test-key' },
        }),
        blueprints: {
          list: async () => [],
          get: async () => null,
        },
      },
    });
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();
  }

  async function renderOnce(args: {
    intent: string;
    contract?: DataContract;
    props?: Record<string, unknown>;
  }): Promise<GguiSessionStructured> {
    if (!host) throw new Error('host not booted');
    const flow = await host.openRender({
      intent: args.intent,
      ...(args.contract !== undefined
        ? {
            blueprintDraft: {
              contract: args.contract as unknown as Record<string, unknown>,
            },
          }
        : {}),
      ...(args.props !== undefined ? { props: args.props } : {}),
    });
    return flow.render.structuredContent as GguiSessionStructured;
  }

  it('paraphrase resilience: same contract under different intent prose hits Tier 1', async () => {
    await boot();

    // Case 1 — cold render with a contract → Tier 3 cold, generator runs.
    const first = await renderOnce({
      intent: 'live notepad for capturing thoughts',
      contract: NOTEPAD_CONTRACT,
    });
    expect(first.cache?.hit).toBe(false);
    expect(first.cache?.kind).toBe('cold');
    expect(first.cache?.llmCallsAvoided).toBe(0);
    expect(calls.count, 'cold render must invoke generator').toBe(1);

    // Case 2 — same intent + same contract → Tier 1 hit, generator
    // does NOT run again. Similarity is 1 because the contract-key is
    // an exact deterministic hash collision.
    const second = await renderOnce({
      intent: 'live notepad for capturing thoughts',
      contract: NOTEPAD_CONTRACT,
    });
    expect(second.cache?.hit).toBe(true);
    expect(second.cache?.kind).toBe('full-template');
    expect(second.cache?.similarity).toBe(1);
    expect(second.cache?.cachedBlueprintId).toBeTruthy();
    expect(second.cache?.llmCallsAvoided).toBe(1);
    expect(calls.count, 'exact-match re-render must short-circuit generator').toBe(1);

    // Case 3 — paraphrased intent + same contract → Tier 1 hit. This
    // is THE proof that the cache is keyed on canonical contract
    // structure, not intent text. If this flips to a Tier 3 cold,
    // the registry has regressed to intent-keyed matching.
    const third = await renderOnce({
      intent: 'a quick scratchpad widget so I can jot notes',
      contract: NOTEPAD_CONTRACT,
    });
    expect(third.cache?.hit, 'paraphrased intent + same contract MUST hit').toBe(true);
    expect(third.cache?.kind).toBe('full-template');
    expect(third.cache?.similarity).toBe(1);
    expect(third.cache?.cachedBlueprintId).toBe(second.cache?.cachedBlueprintId);
    expect(calls.count, 'paraphrase MUST NOT trigger a regen').toBe(1);
  });

  it('registry isolation: a different contract triggers a fresh cold gen', async () => {
    await boot();

    // Warm the registry with the notepad contract.
    await renderOnce({
      intent: 'live notepad',
      contract: NOTEPAD_CONTRACT,
    });
    expect(calls.count).toBe(1);

    // GguiSession a STRUCTURALLY different contract — even with prose that
    // sounds related, the contract-key is different so Tier 1 misses.
    // Tier 2 has only one candidate (notepad), and the mock embedder
    // path won't pull that on a wholly disparate context shape — so
    // the matcher falls through to Tier 3 cold and the generator runs.
    //
    // Weather contract uses propsSpec → must supply props on render or
    // the contract-violation check fails before the cache lookup.
    const weatherProps = { city: 'Tokyo', temp: 22 };
    const second = await renderOnce({
      intent: 'weather card for Tokyo',
      contract: WEATHER_CONTRACT,
      props: weatherProps,
    });
    expect(second.cache?.hit, 'different contract MUST miss').toBe(false);
    expect(second.cache?.kind).toBe('cold');
    expect(calls.count, 'cold gen must run for a new contract shape').toBe(2);

    // And on second render of the weather contract, Tier 1 hits — proving
    // each contract has its own bucket and registry isolation is bidirectional.
    const third = await renderOnce({
      intent: 'show me Tokyo weather',
      contract: WEATHER_CONTRACT,
      props: weatherProps,
    });
    expect(third.cache?.hit).toBe(true);
    expect(third.cache?.kind).toBe('full-template');
    expect(calls.count, 'second weather render must hit, no regen').toBe(2);
  });

  // §2.H "contract-less render isolation" was authored before the
  // three-step (D10) handshake locked. Today render REQUIRES a
  // handshake-sourced proposal (accept it as-is by omitting `override`,
  // or supply `override: {contract}` to STRICT-regen), so genuinely
  // contract-less renders cannot reach the registry — the relevant
  // isolation now lives at the handshake input layer and is covered by
  // the negotiator-side tests in @ggui-ai/negotiator.
  it.skip('§2.H: renders WITHOUT contract are not registered (no Tier 1 hits possible)', async () => {
    await boot();

    const first = await renderOnce({ intent: 'render a hello world card' });
    expect(first.cache?.hit).toBe(false);
    expect(first.cache?.kind).toBe('cold');
    expect(calls.count).toBe(1);

    const second = await renderOnce({ intent: 'render a hello world card' });
    expect(
      second.cache?.hit,
      'contract-less render MUST NOT be registered, so MUST NOT hit',
    ).toBe(false);
    expect(second.cache?.kind).toBe('cold');
    expect(calls.count, 'contract-less re-render must regen').toBe(2);
  });
});
