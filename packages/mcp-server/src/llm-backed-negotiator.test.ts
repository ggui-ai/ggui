/**
 * Tests for MVB-6 variant-selection surface in
 * `llm-backed-negotiator.ts`. Covers:
 *
 *   - `buildVariantSelectionUserMessage` — the LLM-facing prompt
 *     projection. Snapshot-style assertions on the projected JSON
 *     shape since it's load-bearing IP.
 *   - `parseVariantSelectionResponse` — shape validation +
 *     calibration assertions.
 *
 * The end-to-end `selectVariant` integration (with the LLM caller) is
 * exercised by the orchestration tests in
 * `@ggui-ai/mcp-server-core/variant-selector-with-llm.test.ts` via a
 * mock pick fn; the BYOK + provider wiring is tested by the existing
 * llm-backed-negotiator e2e flow.
 */
import type { Blueprint } from '@ggui-ai/protocol';
import type { VariantSelectionContext } from '@ggui-ai/mcp-server-core';
import { describe, expect, it } from 'vitest';
import {
  buildVariantSelectionUserMessage,
  parseVariantSelectionResponse,
  VARIANT_SELECTION_SYSTEM_PROMPT,
} from './llm-backed-negotiator.js';

function bp(overrides: Partial<Blueprint> & { blueprintId: string }): Blueprint {
  return {
    blueprintId: overrides.blueprintId,
    contractHash: overrides.contractHash ?? 'hash-1',
    appId: overrides.appId ?? 'app-1',
    codeS3Url: overrides.codeS3Url,
    codeHash: overrides.codeHash,
    source: overrides.source ?? {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    },
    validatorScore: overrides.validatorScore,
    variance: overrides.variance ?? {},
    isOperatorDefault: overrides.isOperatorDefault,
    createdAt: overrides.createdAt ?? '2026-05-12T00:00:00.000Z',
    createdBy: overrides.createdBy ?? 'agent',
    contract: overrides.contract ?? { propsSpec: { properties: {} } },
  };
}

describe('VARIANT_SELECTION_SYSTEM_PROMPT', () => {
  it('emphasizes calibration and the fallback contract', () => {
    expect(VARIANT_SELECTION_SYSTEM_PROMPT).toContain('Calibrate confidence honestly');
    expect(VARIANT_SELECTION_SYSTEM_PROMPT).toContain('source');
    expect(VARIANT_SELECTION_SYSTEM_PROMPT).toContain('isOperatorDefault');
    expect(VARIANT_SELECTION_SYSTEM_PROMPT).toContain('blueprintId');
    expect(VARIANT_SELECTION_SYSTEM_PROMPT).toContain('persona');
    expect(VARIANT_SELECTION_SYSTEM_PROMPT).toContain('aesthetic');
  });
});

describe('buildVariantSelectionUserMessage', () => {
  it('projects candidate fields the matcher needs', () => {
    const a = bp({
      blueprintId: 'a',
      source: {
        kind: 'llm',
        generator: 'ui-gen-default-haiku-4-5',
        model: 'claude-haiku-4-5',
      },
      validatorScore: 0.92,
      variance: { persona: 'minimalist', seedPrompt: 'clean form' },
    });
    const b = bp({
      blueprintId: 'b',
      source: { kind: 'user' },
      isOperatorDefault: true,
      variance: { persona: 'data-dense' },
    });
    const ctx: VariantSelectionContext = {
      contractHash: 'h1',
      intent: 'budget tracker',
      variance: { persona: 'minimalist' },
    };
    const message = buildVariantSelectionUserMessage([a, b], ctx);
    // Candidates section
    expect(message).toContain('CANDIDATES:');
    expect(message).toContain('"blueprintId": "a"');
    expect(message).toContain('"blueprintId": "b"');
    // Provenance union projected verbatim — llm arm with engine
    // fields, user arm bare.
    expect(message).toContain('"generator": "ui-gen-default-haiku-4-5"');
    expect(message).toContain('"model": "claude-haiku-4-5"');
    expect(message).toContain('"kind": "user"');
    expect(message).toContain('"validatorScore": 0.92');
    expect(message).toContain('"isOperatorDefault": true');
    expect(message).toContain('"persona": "minimalist"');
    expect(message).toContain('"persona": "data-dense"');
    expect(message).toContain('"seedPrompt": "clean form"');
    // Request section
    expect(message).toContain('REQUEST:');
    expect(message).toContain('"contractHash": "h1"');
    expect(message).toContain('"intent": "budget tracker"');
  });

  it('omits undefined optional fields from the projection (token efficiency)', () => {
    const a = bp({
      blueprintId: 'a',
      variance: { persona: 'minimalist' },
      // no validatorScore, no isOperatorDefault, no seedPrompt
    });
    const ctx: VariantSelectionContext = { contractHash: 'h1' };
    const message = buildVariantSelectionUserMessage([a], ctx);
    expect(message).not.toContain('"validatorScore"');
    expect(message).not.toContain('"isOperatorDefault"');
    expect(message).not.toContain('"seedPrompt"');
    expect(message).not.toContain('"aesthetic"');
    // intent absent → not projected on request side either
    expect(message).not.toContain('"intent"');
  });

  it('threads aesthetic on the request side when provided', () => {
    const a = bp({ blueprintId: 'a' });
    const ctx: VariantSelectionContext = {
      contractHash: 'h1',
      variance: { aesthetic: 'glassy' },
    };
    const message = buildVariantSelectionUserMessage([a], ctx);
    expect(message).toContain('"aesthetic": "glassy"');
  });
});

describe('parseVariantSelectionResponse', () => {
  it('round-trips a well-formed response', () => {
    const decoded = parseVariantSelectionResponse({
      blueprintId: 'bp-1',
      confidence: 0.85,
      reason: 'persona matches data-dense',
    });
    expect(decoded).toEqual({
      blueprintId: 'bp-1',
      confidence: 0.85,
      reason: 'persona matches data-dense',
    });
  });

  it('rejects null / non-object input', () => {
    expect(() => parseVariantSelectionResponse(null)).toThrow(
      /not an object/,
    );
    expect(() => parseVariantSelectionResponse('hello')).toThrow(
      /not an object/,
    );
  });

  it('rejects missing or non-string blueprintId', () => {
    expect(() =>
      parseVariantSelectionResponse({
        confidence: 0.9,
        reason: 'r',
      }),
    ).toThrow(/blueprintId/);
    expect(() =>
      parseVariantSelectionResponse({
        blueprintId: 42,
        confidence: 0.9,
        reason: 'r',
      }),
    ).toThrow(/blueprintId/);
    expect(() =>
      parseVariantSelectionResponse({
        blueprintId: '',
        confidence: 0.9,
        reason: 'r',
      }),
    ).toThrow(/blueprintId/);
  });

  it('rejects confidence out of [0, 1]', () => {
    expect(() =>
      parseVariantSelectionResponse({
        blueprintId: 'a',
        confidence: 1.5,
        reason: 'r',
      }),
    ).toThrow(/confidence/);
    expect(() =>
      parseVariantSelectionResponse({
        blueprintId: 'a',
        confidence: -0.1,
        reason: 'r',
      }),
    ).toThrow(/confidence/);
  });

  it('rejects non-finite confidence', () => {
    expect(() =>
      parseVariantSelectionResponse({
        blueprintId: 'a',
        confidence: NaN,
        reason: 'r',
      }),
    ).toThrow(/confidence/);
  });

  it('rejects missing reason', () => {
    expect(() =>
      parseVariantSelectionResponse({
        blueprintId: 'a',
        confidence: 0.9,
      }),
    ).toThrow(/reason/);
  });

  it('accepts edge-case confidences 0 and 1', () => {
    expect(
      parseVariantSelectionResponse({
        blueprintId: 'a',
        confidence: 0,
        reason: 'r',
      }).confidence,
    ).toBe(0);
    expect(
      parseVariantSelectionResponse({
        blueprintId: 'a',
        confidence: 1,
        reason: 'r',
      }).confidence,
    ).toBe(1);
  });
});

// `buildCacheReuseResult` moved into the shared handshake-decision core
// (`@ggui-ai/mcp-server-handlers` decide-handshake.ts); its atomic-
// projection tests live in that package's `decide-handshake.test.ts`.

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
