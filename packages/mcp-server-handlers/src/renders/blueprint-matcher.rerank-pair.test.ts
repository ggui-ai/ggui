/**
 * ggui#1235 — the rerank judge is injected as a PAIR `{ judge, threshold }`:
 * a threshold never travels apart from the judge it was measured on. The
 * default pair is today's LLM judge at 0.5, byte for byte; a supplied pair
 * carries its own cut and `options.judgeThreshold` no longer applies to it;
 * a pair with threshold 0 declines only on `matchId: null` — the shape a
 * provider that resolves its own cut internally hands in.
 */
import { describe, expect, it } from 'vitest';
import type { LLMCaller, RerankJudge, ToolSchema } from '@ggui-ai/negotiator';
import { InMemoryBlueprintIndex, InMemoryVectorStore, MockEmbeddingProvider } from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { matchBlueprint } from './blueprint-matcher.js';
import { registerBlueprint } from './blueprint-registry.js';

const SCOPE = 'app-pair';
const NOTEPAD_CONTRACT: DataContract = {
  contextSpec: {
    noteText: { schema: { type: 'string' }, default: '' },
    topic: {
      schema: { type: 'string', enum: ['Bug', 'Feature', 'Question'] },
      default: 'Bug',
    },
  },
};
const NO_COSINE_GATE = { minCosineForRerank: -1 };

function makeRegistry() {
  return { embedding: new MockEmbeddingProvider(), vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
}

function stubLlm(ret: { matchId: string | null; confidence: number; reason: string }): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used');
    },
    async callStructured(_system: string, _user: string, _tool: ToolSchema): Promise<unknown> {
      return ret;
    },
  };
}

async function seeded() {
  const registry = makeRegistry();
  const registered = await registerBlueprint(registry, SCOPE, {
    kind: 'template',
    contract: NOTEPAD_CONTRACT,
    intent: 'notepad',
    componentCode: 'a',
    source: { kind: 'user' },
  });
  return { registry, id: registered.id };
}

describe('matchBlueprint — the rerank pair (ggui#1235)', () => {
  it('a supplied pair is honoured on its OWN scale: confidence 0.6 accepts under threshold 0.55 even though options.judgeThreshold says 0.9', async () => {
    const { registry, id } = await seeded();
    let calls = 0;
    const judge: RerankJudge = async (_q, candidates) => {
      calls++;
      return { matchId: candidates[0]!.id, confidence: 0.6, reason: 'own scale', latencyMs: 1, tokenCost: { input: 0, output: 0 } };
    };
    const result = await matchBlueprint(
      { registry, rerank: { judge, threshold: 0.55 } },
      SCOPE,
      { intent: 'a prose notepad ask' },
      { ...NO_COSINE_GATE, judgeThreshold: 0.9 },
    );
    expect(calls).toBe(1);
    expect(result.strategy).toBe('semantic');
    if (result.strategy === 'semantic') {
      expect(result.blueprint.id).toBe(id);
      expect(result.judgeConfidence).toBeCloseTo(0.6);
    }
  });

  it('the pair\'s threshold is the cut: 0.6 under threshold 0.7 is no-match-low-confidence', async () => {
    const { registry } = await seeded();
    const judge: RerankJudge = async (_q, candidates) => ({ matchId: candidates[0]!.id, confidence: 0.6, reason: 'own scale', latencyMs: 1, tokenCost: { input: 0, output: 0 } });
    const result = await matchBlueprint({ registry, rerank: { judge, threshold: 0.7 } }, SCOPE, { intent: 'a prose notepad ask' }, NO_COSINE_GATE);
    expect(result.strategy).toBe('no-match');
    expect(result.reason).toMatch(/no-match-low-confidence/);
  });

  it('a pair with threshold 0 declines ONLY on matchId: null — a provider that resolved its own cut', async () => {
    const { registry, id } = await seeded();
    const accepts: RerankJudge = async (_q, candidates) => ({ matchId: candidates[0]!.id, confidence: 0.01, latencyMs: 1, tokenCost: { input: 0, output: 0 } });
    const hit = await matchBlueprint({ registry, rerank: { judge: accepts, threshold: 0 } }, SCOPE, { intent: 'a prose notepad ask' }, NO_COSINE_GATE);
    expect(hit.strategy).toBe('semantic');
    if (hit.strategy === 'semantic') expect(hit.blueprint.id).toBe(id);
    const declines: RerankJudge = async () => ({ matchId: null, confidence: 0.99, latencyMs: 1, tokenCost: { input: 0, output: 0 } });
    const miss = await matchBlueprint({ registry, rerank: { judge: declines, threshold: 0 } }, SCOPE, { intent: 'a prose notepad ask' }, NO_COSINE_GATE);
    expect(miss.strategy).toBe('no-match');
    expect(miss.reason).toMatch(/judge declined/);
  });

  it('no pair: today\'s default — the LLM judge at options.judgeThreshold (default 0.5), unchanged', async () => {
    const { registry, id } = await seeded();
    const llm = stubLlm({ matchId: id, confidence: 0.55, reason: 'llm' });
    const hit = await matchBlueprint({ registry, llm }, SCOPE, { intent: 'a prose notepad ask' }, NO_COSINE_GATE);
    expect(hit.strategy).toBe('semantic');
    const miss = await matchBlueprint({ registry, llm }, SCOPE, { intent: 'a prose notepad ask' }, { ...NO_COSINE_GATE, judgeThreshold: 0.6 });
    expect(miss.strategy).toBe('no-match');
    expect(miss.reason).toMatch(/no-match-low-confidence/);
  });

  it('a pair wins over a bare llm when both are supplied; no llm and no pair is match-skip-no-llm', async () => {
    const { registry, id } = await seeded();
    let llmCalls = 0;
    const llm: LLMCaller = {
      async call() {
        throw new Error('unused');
      },
      async callStructured(): Promise<unknown> {
        llmCalls++;
        return { matchId: null, confidence: 0, reason: 'must not run' };
      },
    };
    const judge: RerankJudge = async (_q, candidates) => ({ matchId: candidates[0]!.id, confidence: 1, reason: 'pair', latencyMs: 1, tokenCost: { input: 0, output: 0 } });
    const hit = await matchBlueprint({ registry, llm, rerank: { judge, threshold: 0.5 } }, SCOPE, { intent: 'a prose notepad ask' }, NO_COSINE_GATE);
    expect(hit.strategy).toBe('semantic');
    if (hit.strategy === 'semantic') expect(hit.blueprint.id).toBe(id);
    expect(llmCalls).toBe(0);
    const skip = await matchBlueprint({ registry }, SCOPE, { intent: 'a prose notepad ask' }, NO_COSINE_GATE);
    expect(skip.strategy).toBe('no-match');
    expect(skip.reason).toMatch(/match-skip-no-llm/);
  });
});
