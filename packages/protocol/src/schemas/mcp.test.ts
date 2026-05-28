/**
 * Zod round-trip tests for the canonical handshake / render / update
 * tool triad.
 *
 * Post-Phase-B (render-identity collapse) — Session vessel deleted;
 * `renderId` is the single identity referenced across the wire. The
 * handshake input carries NO `sessionId` (handshake mints the render
 * server-side); `ggui_new_session` is gone (folded into handshake);
 * `ggui_push` renamed to `ggui_render`; render output keys by
 * `renderId` (was `stackItemId`); update input keys by `renderId`.
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
  renderInputSchema,
  renderOutputSchema,
  updateInputSchema,
  updateOutputSchema,
} from './mcp';

describe('ggui_handshake — MVB-5 three-step handshake', () => {
  it('accepts a minimal input — intent + blueprintDraft (contract only)', () => {
    const parsed = handshakeInputSchema.parse({
      intent: 'show weather',
      blueprintDraft: { contract: {} },
    });
    expect(parsed.intent).toBe('show weather');
    expect(parsed.blueprintDraft.contract).toBeDefined();
  });

  it('accepts a fully-populated draft (contract + variance + generator)', () => {
    const parsed = handshakeInputSchema.parse({
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
        intent: '',
        blueprintDraft: { contract: {} },
      }),
    ).toThrow();
  });

  it('rejects an input missing blueprintDraft', () => {
    expect(() =>
      handshakeInputSchema.parse({
        intent: 'show weather',
      }),
    ).toThrow();
  });

  it('rejects an input carrying a retired `sessionId` field', () => {
    // Post-Phase-B the handshake input is .strict() — `sessionId` is
    // not part of the shape and surfaces as an unknown-key reject.
    expect(() =>
      handshakeInputSchema.parse({
        sessionId: 'sess_legacy',
        intent: 'show weather',
        blueprintDraft: { contract: {} },
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

  it('rejects the retired `compose` action value', () => {
    // Post-Phase-B `'compose'` is not a legal action — there is no
    // stack of N to compose against.
    expect(() =>
      handshakeOutputSchema.parse({
        handshakeId: 'hs_1',
        action: 'compose',
        suggestion: {
          origin: 'agent',
          rationale: 'x',
          blueprintMeta: {
            blueprintId: 'bp_1',
            contractHash: 'h',
            generator: 'ui-gen-default-haiku-4-5',
            variance: {},
          },
        },
      }),
    ).toThrow();
  });
});

describe('ggui_render — MVB-5 decision discriminator', () => {
  it('accepts decision: accept', () => {
    const parsed = renderInputSchema.parse({
      handshakeId: 'hs_abc',
      decision: { kind: 'accept' },
    });
    expect(parsed.handshakeId).toBe('hs_abc');
    expect(parsed.decision.kind).toBe('accept');
  });

  it('accepts decision: override with a fresh blueprintDraft', () => {
    const parsed = renderInputSchema.parse({
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
    const parsed = renderInputSchema.parse({
      handshakeId: 'hs_abc',
      decision: { kind: 'accept' },
      props: { city: 'Berlin' },
    });
    expect(parsed.props).toEqual({ city: 'Berlin' });
  });

  it('rejects a shape missing handshakeId', () => {
    expect(() =>
      renderInputSchema.parse({ decision: { kind: 'accept' } }),
    ).toThrow();
  });

  it('rejects a shape missing decision', () => {
    expect(() => renderInputSchema.parse({ handshakeId: 'hs_abc' })).toThrow();
  });

  it('rejects an override decision missing blueprintDraft', () => {
    expect(() =>
      renderInputSchema.parse({
        handshakeId: 'hs_abc',
        decision: { kind: 'override' },
      }),
    ).toThrow();
  });

  it('round-trips a render output', () => {
    const out = {
      renderId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create' as const,
    };
    expect(renderOutputSchema.parse(out)).toEqual(out);
  });

  it('strips the post-R5-retired `url` field on parse (no clickable URL on the wire)', () => {
    const parsed = renderOutputSchema.parse({
      renderId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create',
      // Dead field — post-R5 the `/r/<shortCode>` route was deleted.
      // Defensive: a sender that hasn't migrated yet must not poison
      // the wire output with a hallucination-bait URL.
      url: 'https://stale-render.example.com/abc12345',
    } as unknown as Record<string, unknown>);
    expect(parsed).toEqual({
      renderId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create',
    });
    expect(Object.keys(parsed)).not.toContain('url');
  });

  it('rejects the retired `compose` action value on output', () => {
    expect(() =>
      renderOutputSchema.parse({
        renderId: 'render_1',
        resourceUri: 'ui://ggui/render/render_1',
        action: 'compose',
      }),
    ).toThrow();
  });
});

describe('ggui_update', () => {
  it('accepts kind:"replace" with full props', () => {
    const parsed = updateInputSchema.parse({
      renderId: 'render_1',
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
      renderId: 'render_1',
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
      renderId: 'render_1',
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
        renderId: 'render_1',
        kind: 'replace',
      }),
    ).toThrow();
  });

  it('rejects kind:"merge" without patch', () => {
    expect(() =>
      updateInputSchema.parse({
        renderId: 'render_1',
        kind: 'merge',
      }),
    ).toThrow();
  });

  it('rejects missing kind', () => {
    expect(() =>
      updateInputSchema.parse({
        renderId: 'render_1',
        props: { temp: 24 },
      }),
    ).toThrow();
  });

  it('rejects unknown kind', () => {
    expect(() =>
      updateInputSchema.parse({
        renderId: 'render_1',
        kind: 'patch',
        patch: { temp: 24 },
      }),
    ).toThrow();
  });

  it('rejects missing renderId on either kind', () => {
    expect(() =>
      updateInputSchema.parse({ kind: 'replace', props: { temp: 24 } }),
    ).toThrow();
    expect(() =>
      updateInputSchema.parse({ kind: 'merge', patch: { temp: 24 } }),
    ).toThrow();
  });

  it('round-trips an update output', () => {
    const out = { renderId: 'render_1', updated: true };
    expect(updateOutputSchema.parse(out)).toEqual(out);
  });
});
