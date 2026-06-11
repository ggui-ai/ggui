import { describe, it, expect } from 'vitest';
import {
  blueprintMetaSchema,
  handshakeSuggestionSchema,
} from './handshake-suggestion.js';

const baseMeta = {
  contractHash: 'c0ffee00c0ffee00',
  variance: {},
};

describe('blueprintMetaSchema — optional blueprintId (D4)', () => {
  it('parses WITH a blueprintId (origin:cache stored UUID)', () => {
    const parsed = blueprintMetaSchema.parse({
      ...baseMeta,
      blueprintId: 'bp_11111111-1111-1111-1111-111111111111',
    });
    expect(parsed.blueprintId).toBe('bp_11111111-1111-1111-1111-111111111111');
  });

  it('parses WITHOUT a blueprintId (create — UUID minted at register-time)', () => {
    const parsed = blueprintMetaSchema.parse(baseMeta);
    expect(parsed.blueprintId).toBeUndefined();
  });
});

describe('blueprintMetaSchema — optional source (cache-only provenance)', () => {
  it('parses WITH a source (origin:cache — matched row provenance)', () => {
    const parsed = blueprintMetaSchema.parse({
      ...baseMeta,
      blueprintId: 'bp_11111111-1111-1111-1111-111111111111',
      source: {
        kind: 'llm',
        generator: 'ui-gen-default-haiku-4-5',
        model: 'claude-haiku-4-5',
      },
    });
    expect(parsed.source).toEqual({
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    });
  });

  it('parses WITHOUT a source (agent/synth — gen pending, no provenance)', () => {
    const parsed = blueprintMetaSchema.parse(baseMeta);
    expect(parsed.source).toBeUndefined();
  });

  it('rejects a malformed source (llm arm missing model)', () => {
    expect(() =>
      blueprintMetaSchema.parse({
        ...baseMeta,
        source: { kind: 'llm', generator: 'ui-gen-default-haiku-4-5' },
      }),
    ).toThrow();
  });
});

describe('handshakeSuggestionSchema — blueprintMeta.blueprintId optional', () => {
  it('parses a suggestion whose blueprintMeta omits blueprintId', () => {
    const parsed = handshakeSuggestionSchema.parse({
      origin: 'agent',
      rationale: 'fresh draft validated cleanly',
      blueprintMeta: baseMeta,
    });
    expect(parsed.blueprintMeta.blueprintId).toBeUndefined();
  });
});

describe('handshakeSuggestionSchema — proposedContractSummary (optional, D5)', () => {
  it('parses a suggestion WITH proposedContractSummary', () => {
    const parsed = handshakeSuggestionSchema.parse({
      origin: 'cache',
      rationale: 'reusing a similar cached contract',
      blueprintMeta: {
        ...baseMeta,
        blueprintId: 'bp_22222222-2222-2222-2222-222222222222',
      },
      proposedContractSummary: 'actions: submit; context: noteText',
    });
    expect(parsed.proposedContractSummary).toBe(
      'actions: submit; context: noteText',
    );
  });

  it('parses a suggestion WITHOUT proposedContractSummary (agent falls back to contractHash)', () => {
    const parsed = handshakeSuggestionSchema.parse({
      origin: 'agent',
      rationale: 'fresh draft validated cleanly',
      blueprintMeta: baseMeta,
    });
    expect(parsed.proposedContractSummary).toBeUndefined();
  });
});
