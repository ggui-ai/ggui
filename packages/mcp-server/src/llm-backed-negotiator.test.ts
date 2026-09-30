/**
 * Tests for `llm-backed-negotiator.ts`'s own seams. The handshake
 * decision spine is shared and tested in `@ggui-ai/mcp-server-handlers`
 * (`decide-handshake.test.ts`), including the atomic reuse projection.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryVectorStore, InMemoryBlueprintIndex } from '@ggui-ai/mcp-server-core/in-memory';
import type { BlueprintPool } from '@ggui-ai/mcp-server-handlers/renders';
import { assembleHandshakePools } from './llm-backed-negotiator.js';

const fakeEmbedding = { id: 'x', dimensions: 1, embed: async () => [0] };
const perApp = { embedding: fakeEmbedding, vectorStore: new InMemoryVectorStore(), index: new InMemoryBlueprintIndex() };
const seed: BlueprintPool = { registry: perApp, scope: 'shared', label: 'seed' };

describe('assembleHandshakePools', () => {
  it('puts the per-app pool first, then seed pools', () => {
    const pools = assembleHandshakePools({ cache: perApp, seedPools: [seed] });
    expect(pools).toHaveLength(2);
    expect(pools[0]?.scope).toBeUndefined(); // per-app pool (scope defaults to ctx.appId at match time)
    expect(pools[1]?.scope).toBe('shared');
  });

  it('returns only seed pools when no per-app cache is wired', () => {
    const pools = assembleHandshakePools({ seedPools: [seed] });
    expect(pools).toHaveLength(1);
    expect(pools[0]?.scope).toBe('shared');
  });

  it('returns an empty array when nothing is wired', () => {
    expect(assembleHandshakePools({})).toEqual([]);
  });
});
