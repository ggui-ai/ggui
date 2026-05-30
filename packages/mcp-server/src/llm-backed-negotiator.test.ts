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
import { createHash } from 'node:crypto';
import type { Blueprint, DataContract } from '@ggui-ai/protocol';
import type { VariantSelectionContext } from '@ggui-ai/mcp-server-core';
import { describe, expect, it } from 'vitest';
import {
  buildCacheReuseResult,
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
    generator: overrides.generator ?? 'ui-gen-default-haiku-4-5',
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
      generator: 'ui-gen-default-haiku-4-5',
      validatorScore: 0.92,
      variance: { persona: 'minimalist', seedPrompt: 'clean form' },
    });
    const b = bp({
      blueprintId: 'b',
      generator: 'ui-gen-advanced-opus-4-7',
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
    expect(message).toContain('"generator": "ui-gen-default-haiku-4-5"');
    expect(message).toContain('"generator": "ui-gen-advanced-opus-4-7"');
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

describe('buildCacheReuseResult — atomic projection (exact-key + semantic share it)', () => {
  it('projects a matched blueprint into an ATOMIC origin:cache reuse', () => {
    const cachedContract: DataContract = {
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    };
    const code = 'export default () => null;';
    const result = buildCacheReuseResult(
      {
        id: 'template:abc123',
        contractKey: 'abc123',
        componentCode: code,
        contract: cachedContract,
      },
      'match-semantic: judge matched (confidence=0.90)',
    );

    expect(result.action).toBe('reuse');
    // Atomic: the served contract is the CACHED blueprint's own contract,
    // never the request's draft → contract + UI always agree.
    expect(result.effectiveContract).toBe(cachedContract);
    expect(result.suggestion.origin).toBe('cache');
    expect(result.suggestion.blueprintMeta.blueprintId).toBe('template:abc123');
    expect(result.suggestion.blueprintMeta.contractHash).toBe('abc123');
    expect(result.suggestion.blueprintMeta.codeHash).toBe(
      createHash('sha256').update(code).digest('hex'),
    );
    expect(result.reason).toMatch(/match-semantic/);
  });

  it('is deterministic — same blueprint + reason → identical result', () => {
    const bp = {
      id: 'template:x',
      contractKey: 'x',
      componentCode: 'a',
      contract: {} as DataContract,
    };
    expect(buildCacheReuseResult(bp, 'r')).toEqual(buildCacheReuseResult(bp, 'r'));
  });
});
