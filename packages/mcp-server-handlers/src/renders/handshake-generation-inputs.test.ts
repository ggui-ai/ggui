/**
 * ggui#1321 — the generation a `ggui_render` would start, derived from the
 * stored handshake by pure functions the render itself calls. The pin that
 * matters is the last block: on a real render, the input the render hands
 * its generator IS `generationInputsForHandshake(...)` plus the render's
 * `sessionId`, so a caller that starts the generation early derives the
 * same input by construction.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryGguiSessionStore,
  InMemoryKeyValueStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { EmbeddingProvider, UiGenerateInput, UiGenerateResult } from '@ggui-ai/mcp-server-core';
import type { BlueprintVariance, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { createGguiRenderHandler } from './render.js';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import { GadgetNotRegisteredError } from './assert-gadgets.js';
import {
  appGadgetsForContract,
  generationInputsForHandshake,
  generatorInputForStory,
  storyForHandshake,
} from './handshake-generation-inputs.js';
import type { HandlerContext } from '../types.js';

const APP_ID = 'app-1321';
const CTX: HandlerContext = { appId: APP_ID, requestId: 'req-1321' };
const CONTRACT: DataContract = { propsSpec: { properties: {} } };
const OTHER_CONTRACT: DataContract = { propsSpec: { properties: { city: { schema: { type: 'string' } } } } };
const VARIANCE: BlueprintVariance = { persona: 'a busy traveller', aesthetic: 'calm' };
const BLUEPRINTS = { get: async () => null, list: async () => [] };

function record(handshakeId: string): HandshakeRecord {
  return {
    handshakeId,
    action: 'create',
    reason: 'test',
    input: { intent: 'a weather card for the next three days', blueprintDraft: { contract: CONTRACT } },
    target: {},
    suggestion: {
      origin: 'agent',
      rationale: 'test',
      blueprintMeta: { contractHash: blueprintKey(CONTRACT), variance: VARIANCE },
    },
    effectiveContract: CONTRACT,
    appId: APP_ID,
    createdAt: new Date().toISOString(),
  };
}

describe('storyForHandshake', () => {
  it('ACCEPT: the stored intent, the stored effective contract, the suggestion\'s variance', () => {
    expect(storyForHandshake(record('hs-a'))).toEqual({
      intent: 'a weather card for the next three days',
      contract: CONTRACT,
      variance: VARIANCE,
    });
  });

  it('an override replaces only what it carries', () => {
    const rec = record('hs-o');
    expect(storyForHandshake(rec, { contract: OTHER_CONTRACT })).toEqual({ intent: rec.input.intent, contract: OTHER_CONTRACT, variance: VARIANCE });
    expect(storyForHandshake(rec, { variance: { aesthetic: 'loud' } })).toEqual({ intent: rec.input.intent, contract: CONTRACT, variance: { aesthetic: 'loud' } });
  });
});

describe('generatorInputForStory', () => {
  it('carries no sessionId (the render mints it), and a story context only when it is a plain object', () => {
    const base = generatorInputForStory({ intent: 'x', contract: CONTRACT }, { blueprints: BLUEPRINTS });
    expect('sessionId' in base.request).toBe(false);
    expect(base.request).toEqual({ prompt: 'x' });
    expect(generatorInputForStory({ intent: 'x', context: { day: 1 } }, { blueprints: BLUEPRINTS }).request).toEqual({ prompt: 'x', context: { day: 1 } });
    expect(generatorInputForStory({ intent: 'x', context: ['not', 'an', 'object'] }, { blueprints: BLUEPRINTS }).request).toEqual({ prompt: 'x' });
  });
});

describe('appGadgetsForContract', () => {
  it('a contract that uses no gadget gets none', () => {
    expect(appGadgetsForContract(CONTRACT, null)).toEqual([]);
  });

  it("throws the render's own refusal for a gadget the App does not register", () => {
    const contract: DataContract = { clientCapabilities: { gadgets: { '@my-org/ggui-leaflet': { useLeafletMap: {} } } } };
    expect(() => appGadgetsForContract(contract, { gadgets: [] })).toThrow(GadgetNotRegisteredError);
  });
});

describe('ggui_render hands its generator exactly generationInputsForHandshake(...) plus its sessionId', () => {
  const embedding: EmbeddingProvider = { id: 'mock', dimensions: 4, embed: async () => [0, 0, 0, 0] };

  function harness() {
    const seen: Array<Omit<UiGenerateInput, 'llm' | 'providerKey'>> = [];
    const generator = async (input: Omit<UiGenerateInput, 'llm' | 'providerKey'>): Promise<UiGenerateResult> => {
      seen.push(input);
      return {
        ok: true,
        response: { sessionId: input.request.sessionId, componentCode: 'export default function C(){ return null; }' },
        metadata: { provider: 'anthropic', generator: 'ui-gen-fake', model: 'anthropic/fake', inputTokens: 0, outputTokens: 0, latencyMs: 0, cacheHit: false },
      };
    };
    const handshakeStore = new InMemoryKeyValueStore();
    const handler = createGguiRenderHandler({
      handshakeStore,
      renderStore: new InMemoryGguiSessionStore(),
      generation: {
        uiGenerator: { slug: 'ui-gen-fake', tier: 'default', model: 'anthropic/claude-haiku-4-5', generate: generator },
        resolveLlm: () => null,
        blueprints: BLUEPRINTS,
        cache: { embedding, vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() },
      },
      generator,
    });
    return { handler, handshakeStore, seen };
  }

  async function renderOnce(handshakeId: string, extra: Record<string, unknown>) {
    const h = harness();
    const rec = record(handshakeId);
    await h.handshakeStore.set(handshakeRecordKey(APP_ID, handshakeId), JSON.stringify(rec));
    await h.handler.handler({ handshakeId, props: {}, ...extra }, CTX);
    expect(h.seen).toHaveLength(1);
    return { rec, input: h.seen[0]! };
  }

  it('ACCEPT with no infra: the derived input, byte for byte, with the render\'s sessionId added', async () => {
    const { rec, input } = await renderOnce('hs-accept', {});
    const derived = generationInputsForHandshake(rec, { blueprints: BLUEPRINTS });
    expect(input).toEqual({ ...derived, request: { sessionId: input.request.sessionId, ...derived.request } });
    expect(JSON.stringify({ ...input, blueprints: undefined, request: { ...input.request, sessionId: undefined } })).toBe(
      JSON.stringify({ ...derived, blueprints: undefined, request: { sessionId: undefined, ...derived.request } }),
    );
  });

  it('a render that sends infra or an override derives with them — and differs from the accept-path derivation', async () => {
    const infra = { model: 'anthropic/claude-haiku-4-5' };
    const withInfra = await renderOnce('hs-infra', { infra });
    const derivedInfra = generationInputsForHandshake(withInfra.rec, { blueprints: BLUEPRINTS, infra });
    expect(withInfra.input).toEqual({ ...derivedInfra, request: { sessionId: withInfra.input.request.sessionId, ...derivedInfra.request } });
    expect(withInfra.input.infra).toEqual(infra);
    expect(generationInputsForHandshake(withInfra.rec, { blueprints: BLUEPRINTS }).infra).toBeUndefined();

    const override = { variance: { aesthetic: 'loud' } };
    const withOverride = await renderOnce('hs-override', { override });
    const derivedOverride = generationInputsForHandshake(withOverride.rec, { blueprints: BLUEPRINTS, override });
    expect(withOverride.input).toEqual({ ...derivedOverride, request: { sessionId: withOverride.input.request.sessionId, ...derivedOverride.request } });
    expect(withOverride.input.variance).toEqual({ aesthetic: 'loud' });
  });
});
