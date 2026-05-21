/**
 * Zod round-trip tests for the canonical handshake / push / update
 * tool quartet.
 *
 * MVB-5 (2026-05-12) — three-step handshake protocol. Pre-MVB-5
 * shapes (flat `contract?` + `hint?` on handshake input, `match` +
 * `plan` on handshake output, `contract?` + `contractHash?` triad on
 * push input) are DELETED per the no-backcompat policy. The new shape
 * threads `blueprintDraft` → `suggestion` → `decision`.
 */
import { describe, it, expect } from 'vitest';
import {
  handshakeInputSchema,
  handshakeOutputSchema,
  pushInputSchema,
  pushOutputSchema,
  updateInputSchema,
  updateOutputSchema,
} from './mcp';

describe('ggui_handshake — MVB-5 three-step handshake', () => {
  it('accepts a minimal input — sessionId + intent + blueprintDraft (contract only)', () => {
    const parsed = handshakeInputSchema.parse({
      sessionId: 'sess_1',
      intent: 'show weather',
      blueprintDraft: { contract: {} },
    });
    expect(parsed.sessionId).toBe('sess_1');
    expect(parsed.intent).toBe('show weather');
    expect(parsed.blueprintDraft.contract).toBeDefined();
  });

  it('accepts a fully-populated draft (contract + variance + generator)', () => {
    const parsed = handshakeInputSchema.parse({
      sessionId: 'sess_1',
      intent: 'show inbox',
      blueprintDraft: {
        contract: { propsSpec: { properties: {} } },
        variance: {
          persona: 'minimalist',
          aesthetic: 'glassy',
          context: { domain: 'email' },
          seedPrompt: 'compact triage view',
        },
        generator: 'ui-gen-default-haiku-4-5',
      },
      forceCreate: false,
    });
    expect(parsed.intent).toBe('show inbox');
    expect(parsed.blueprintDraft.variance?.persona).toBe('minimalist');
    expect(parsed.blueprintDraft.generator).toBe('ui-gen-default-haiku-4-5');
  });

  it('rejects an input with an empty intent', () => {
    expect(() =>
      handshakeInputSchema.parse({
        sessionId: 'sess_1',
        intent: '',
        blueprintDraft: { contract: {} },
      }),
    ).toThrow();
  });

  it('rejects an input missing blueprintDraft', () => {
    expect(() =>
      handshakeInputSchema.parse({
        sessionId: 'sess_1',
        intent: 'show weather',
      }),
    ).toThrow();
  });

  it('round-trips an `origin: cache` handshake output', () => {
    const out = {
      handshakeId: 'hs_cache_1',
      action: 'reuse' as const,
      suggestion: {
        origin: 'cache' as const,
        rationale: 'contract-hash → score 1.00',
        blueprintMeta: {
          blueprintId: 'bp_existing_1',
          contractHash: 'hash_abc',
          codeHash: 'code_hash_abc',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
      },
    };
    expect(handshakeOutputSchema.parse(out)).toEqual(out);
  });

  it('round-trips an `origin: agent` handshake output (no codeHash; provisional id)', () => {
    const out = {
      handshakeId: 'hs_agent_1',
      action: 'create' as const,
      suggestion: {
        origin: 'agent' as const,
        rationale: 'novel-but-clean contract; gen pending against your draft',
        blueprintMeta: {
          blueprintId: 'bp_provisional_xyz',
          contractHash: 'hash_xyz',
          generator: 'ui-gen-default-haiku-4-5',
          variance: { persona: 'minimalist' },
        },
      },
    };
    expect(handshakeOutputSchema.parse(out)).toEqual(out);
    const parsed = handshakeOutputSchema.parse(out);
    expect(parsed.suggestion.blueprintMeta.codeHash).toBeUndefined();
  });

  it('round-trips an `origin: synth` handshake output with amendments', () => {
    const out = {
      handshakeId: 'hs_synth_1',
      action: 'create' as const,
      suggestion: {
        origin: 'synth' as const,
        rationale: 'synth amended contract: added missing submit action',
        blueprintMeta: {
          blueprintId: 'bp_provisional_synth',
          contractHash: 'hash_amended',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
        amendments: {
          contractDiff: [
            { op: 'add' as const, path: '/actionSpec/submit', value: { schema: {} } },
          ],
          reasoning: 'added required submit action so the form completion is observable',
        },
      },
    };
    expect(handshakeOutputSchema.parse(out)).toEqual(out);
  });

  it('surfaces validationFindings on cache hit', () => {
    const out = {
      handshakeId: 'hs_cache_warn',
      action: 'reuse' as const,
      suggestion: {
        origin: 'cache' as const,
        rationale: 'contract-hash, persona → score 0.92',
        blueprintMeta: {
          blueprintId: 'bp_1',
          contractHash: 'hash_1',
          codeHash: 'code_1',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
        validationFindings: [
          {
            code: 'CTR_REF_NEXT_STEP',
            severity: 'error' as const,
            path: 'actionSpec.submit.nextStep',
            message: 'unknown tool reference',
          },
        ],
      },
    };
    expect(handshakeOutputSchema.parse(out)).toEqual(out);
  });

  it('rejects suggestion missing blueprintMeta', () => {
    expect(() =>
      handshakeOutputSchema.parse({
        handshakeId: 'hs_1',
        action: 'create',
        reason: 'x',
        target: {},
        suggestion: {
          origin: 'agent',
          rationale: 'x',
          // blueprintMeta intentionally absent
        },
        contractHash: 'h',
      }),
    ).toThrow();
  });
});

describe('ggui_push — MVB-5 decision discriminator', () => {
  it('accepts decision: accept', () => {
    const parsed = pushInputSchema.parse({
      handshakeId: 'hs_abc',
      decision: { kind: 'accept' },
    });
    expect(parsed.handshakeId).toBe('hs_abc');
    expect(parsed.decision.kind).toBe('accept');
  });

  it('accepts decision: override with a fresh blueprintDraft', () => {
    const parsed = pushInputSchema.parse({
      handshakeId: 'hs_abc',
      decision: {
        kind: 'override',
        blueprintDraft: { contract: {}, variance: { persona: 'mobile-first' } },
      },
    });
    expect(parsed.decision.kind).toBe('override');
    if (parsed.decision.kind === 'override') {
      expect(parsed.decision.blueprintDraft.variance?.persona).toBe('mobile-first');
    }
  });

  it('accepts props alongside the decision', () => {
    const parsed = pushInputSchema.parse({
      handshakeId: 'hs_abc',
      decision: { kind: 'accept' },
      props: { city: 'Berlin' },
    });
    expect(parsed.props).toEqual({ city: 'Berlin' });
  });

  it('rejects a shape missing handshakeId', () => {
    expect(() =>
      pushInputSchema.parse({ decision: { kind: 'accept' } }),
    ).toThrow();
  });

  it('rejects a shape missing decision', () => {
    expect(() => pushInputSchema.parse({ handshakeId: 'hs_abc' })).toThrow();
  });

  it('rejects an override decision missing blueprintDraft', () => {
    expect(() =>
      pushInputSchema.parse({
        handshakeId: 'hs_abc',
        decision: { kind: 'override' },
      }),
    ).toThrow();
  });

  it('round-trips a push output', () => {
    const out = {
      stackItemId: 'item_1',
      url: 'https://render.ggui.ai/abc12345',
      action: 'create' as const,
    };
    expect(pushOutputSchema.parse(out)).toEqual(out);
  });
});

describe('ggui_update', () => {
  it('accepts kind:"replace" with full props', () => {
    const parsed = updateInputSchema.parse({
      stackItemId: 'item_1',
      kind: 'replace',
      props: { temp: 24, condition: 'cloudy' },
    });
    expect(parsed.kind).toBe('replace');
    if (parsed.kind === 'replace') {
      expect(parsed.props).toEqual({ temp: 24, condition: 'cloudy' });
    }
  });

  it('accepts kind:"merge" with a delta patch', () => {
    const parsed = updateInputSchema.parse({
      stackItemId: 'item_1',
      kind: 'merge',
      patch: { temp: 25 },
    });
    expect(parsed.kind).toBe('merge');
    if (parsed.kind === 'merge') {
      expect(parsed.patch).toEqual({ temp: 25 });
    }
  });

  it('accepts kind:"merge" with null values (RFC 7396 delete semantic)', () => {
    const parsed = updateInputSchema.parse({
      stackItemId: 'item_1',
      kind: 'merge',
      patch: { alert: null },
    });
    expect(parsed.kind).toBe('merge');
    if (parsed.kind === 'merge') {
      expect(parsed.patch).toEqual({ alert: null });
    }
  });

  it('rejects kind:"replace" without props', () => {
    expect(() =>
      updateInputSchema.parse({
        stackItemId: 'item_1',
        kind: 'replace',
      }),
    ).toThrow();
  });

  it('rejects kind:"merge" without patch', () => {
    expect(() =>
      updateInputSchema.parse({
        stackItemId: 'item_1',
        kind: 'merge',
      }),
    ).toThrow();
  });

  it('rejects missing kind', () => {
    expect(() =>
      updateInputSchema.parse({
        stackItemId: 'item_1',
        props: { temp: 24 },
      }),
    ).toThrow();
  });

  it('rejects unknown kind', () => {
    expect(() =>
      updateInputSchema.parse({
        stackItemId: 'item_1',
        kind: 'patch',
        patch: { temp: 24 },
      }),
    ).toThrow();
  });

  it('rejects missing stackItemId on either kind', () => {
    expect(() =>
      updateInputSchema.parse({ kind: 'replace', props: { temp: 24 } }),
    ).toThrow();
    expect(() =>
      updateInputSchema.parse({ kind: 'merge', patch: { temp: 24 } }),
    ).toThrow();
  });

  it('round-trips an update output', () => {
    const out = { stackItemId: 'item_1', updated: true };
    expect(updateOutputSchema.parse(out)).toEqual(out);
  });
});
