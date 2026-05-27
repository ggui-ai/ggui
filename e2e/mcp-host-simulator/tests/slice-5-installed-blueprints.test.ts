/**
 * Slice 5 (2026-05-18) — Unified Blueprint Availability e2e proof.
 *
 * Architectural claim being pinned: a marketplace-installed blueprint
 * with contract X makes a `ggui_handshake` against the same contract
 * resolve to `suggestion.origin: 'cache'` BEFORE the LLM-backed
 * negotiator runs. The bridge (Slice 5.2) fires inside
 * `matchBlueprint`'s ensureCached hook on the first lookup; the
 * matcher's Tier-1 exact-key probe then hits the freshly-registered
 * row (provenance: 'install', Slice 5.1).
 *
 * Pre-Slice-5, the same handshake would either fall through to LLM
 * synth (no cache hit) or, in the operator-registered case, hit a
 * row tagged `provenance: 'synth'` — installed blueprints were a
 * separate browsing surface that did NOT accelerate handshake.
 *
 * The handshake-level assertion is load-bearing because:
 *
 *   1. `origin: 'cache'` proves the matcher found the installed row
 *      via canonical-key equality (the only safe match strategy when
 *      a contract is supplied — see blueprint-matcher.ts §Slice 18e).
 *   2. The negotiator short-circuits on cache hit BEFORE invoking
 *      the LLM. Tests run without `ANTHROPIC_API_KEY` and prove the
 *      bypass works correctly.
 *   3. `blueprintMeta.contractHash` echoing back proves the same
 *      canonical hash the agent draft produces equals the bridge-
 *      written row's contractKey.
 *
 * No `ggui_render` follow-through is asserted here — that's covered
 * by `slice-16e-blueprint-registry.test.ts` which exercises the
 * same exact-key flow for synth-provenance rows. Slice 5 only
 * widens the cache-write origin; it doesn't change the consume side.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import {
  createInstalledBlueprintsProvider,
  type InstalledBlueprintCompileResult,
  type InstalledBlueprintEntry,
} from '@ggui-ai/mcp-server-handlers/session-mutations';
import {
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import {
  HostSimulator,
  bootOssServer,
  type OssFixture,
} from '../src/index.js';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';

const COUNTER_CONTRACT: DataContract = {
  contextSpec: {
    count: { schema: { type: 'number' }, default: 0 },
  },
  actionSpec: { increment: { label: 'Increment' } },
};

describe('host-simulator: Slice 5 installed-blueprints unification', () => {
  let fixture: OssFixture | null = null;
  let host: HostSimulator | null = null;
  const generatorCalls = { count: 0 };
  const compileCalls = { count: 0 };

  afterEach(async () => {
    if (host) {
      await host.close();
      host = null;
    }
    if (fixture) {
      await fixture.close();
      fixture = null;
    }
    generatorCalls.count = 0;
    compileCalls.count = 0;
  });

  async function boot(installed: ReadonlyArray<InstalledBlueprintEntry>): Promise<void> {
    // SAME embedder + vectorStore instances must pass through both the
    // matcher (via `vectors`/`embedding` on createGguiServer) AND the
    // bridge's `deps`. Otherwise the bridge writes to a vector store
    // the matcher never reads — silent drift, no Tier-1 hit.
    const embedding = new MockEmbeddingProvider();
    const vectorStore = new InMemoryVectorStore();

    const installedBlueprintsProvider = createInstalledBlueprintsProvider({
      installedBlueprints: () => installed,
      compile: async (
        _entry: InstalledBlueprintEntry,
      ): Promise<InstalledBlueprintCompileResult> => {
        compileCalls.count += 1;
        return {
          kind: 'ok',
          code: 'export default function I() { return null; }',
        };
      },
      deps: { embedding, vectorStore },
    });

    fixture = await bootOssServer({
      embedding,
      vectors: vectorStore,
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-haiku-4-5',
          tier: 'default',
          model: 'claude-haiku-4-5',
          generate: async () => {
            generatorCalls.count += 1;
            return {
              ok: true,
              response: {
                renderId: 'ignored',
                componentCode: 'unused-cold-gen',
                sourceCode: 'unused-cold-gen',
              },
              metadata: {
                provider: 'anthropic',
                model: 'claude-opus-4-7',
                inputTokens: 0,
                outputTokens: 0,
                latencyMs: 0,
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
        installedBlueprints: installedBlueprintsProvider,
      },
    });
    host = new HostSimulator({
      url: fixture.url,
      bearer: 'host-simulator-test',
    });
    await host.connect();
  }

  function counterEntry(): InstalledBlueprintEntry {
    return {
      id: 'vendor:counter:1.0.0',
      manifestPath:
        '/fake/.ggui/installed-blueprints/vendor__counter__1.0.0/ggui.ui.json',
      contract: COUNTER_CONTRACT,
      intent: 'A counter blueprint from @vendor/counter@1.0.0',
    };
  }

  it('handshake against an installed contract resolves to origin=cache without invoking the LLM negotiator', async () => {
    await boot([counterEntry()]);
    if (!host) throw new Error('host not booted');

    const handshake = await host.handshake({
      intent: 'a counter widget',
      blueprintDraft: {
        contract: COUNTER_CONTRACT as unknown as Record<string, unknown>,
      },
    });

    // Origin: 'cache' — load-bearing assertion. The negotiator's
    // exact-key probe found the installed row via canonical-key
    // equality and short-circuited the LLM call.
    expect(handshake.suggestion.origin).toBe('cache');
    expect(handshake.action).toBe('reuse');

    // ContractHash must equal the canonical key the bridge wrote.
    // If these drift, the matcher's hashing diverged from the
    // bridge's — the unification is structurally broken.
    expect(handshake.suggestion.blueprintMeta.contractHash).toBe(
      blueprintKey(COUNTER_CONTRACT),
    );
    expect(handshake.suggestion.blueprintMeta.codeHash).toBeTruthy();

    // The bridge compiled the installed blueprint exactly once.
    expect(compileCalls.count, 'installed blueprint must be compiled exactly once').toBe(1);
    // No cold-gen invocation — the handshake should never have
    // reached the generator path.
    expect(generatorCalls.count, 'no generator call must fire on cache hit').toBe(0);
  });

  it('idempotency: a second handshake hits the cache without re-compiling', async () => {
    await boot([counterEntry()]);
    if (!host) throw new Error('host not booted');

    const h1 = await host.handshake({
      intent: 'first counter',
      blueprintDraft: {
        contract: COUNTER_CONTRACT as unknown as Record<string, unknown>,
      },
    });
    expect(h1.suggestion.origin).toBe('cache');
    expect(compileCalls.count).toBe(1);

    const h2 = await host.handshake({
      intent: 'paraphrased counter request',
      blueprintDraft: {
        contract: COUNTER_CONTRACT as unknown as Record<string, unknown>,
      },
    });
    expect(h2.suggestion.origin).toBe('cache');
    // Per-scope idempotent — no second compile pass.
    expect(compileCalls.count, 'compile must not re-fire on ensured scope').toBe(1);
    // Same registered blueprint id — proves both handshakes hit the
    // same cache row.
    expect(h2.suggestion.blueprintMeta.blueprintId).toBe(
      h1.suggestion.blueprintMeta.blueprintId,
    );
  });

  it('zero installed blueprints: the bridge wires cleanly with an empty list', async () => {
    // Operator with no installs at all — provider should be a no-op
    // on every match. We exercise handshake to verify the empty
    // list doesn't crash. Origin won't be 'cache' (nothing's
    // installed) and the negotiator falls through to LLM (which
    // fails 401 without a real key in this fixture). We only assert
    // the no-op + no-compile path.
    await boot([]);
    if (!host) throw new Error('host not booted');

    // Don't drive a handshake — the LLM-401 case is unstable. Just
    // confirm the bridge construction didn't blow up at boot and
    // the server is reachable via tools/list.
    const tools = await host.listTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(compileCalls.count).toBe(0);
  });
});
