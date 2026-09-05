import { renderInputEnvelopeSchema, renderInputRouteGuardSchema } from './render-input-envelope.js';
import { renderInputShape } from './mcp.js';
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps';
import { expectTypeOf } from 'vitest';
import {
  blueprintValidationResultSchema,
  mcpUiDisplayModeSchema,
  clientObservationsSchema,
  gguiGetSessionOutputSchema,
  gguiSearchBlueprintsOutputSchema,
  gguiSessionSummaryWireSchema,
  hostContextProjectionSchema,
  gguiListFeaturedBlueprintsOutputSchema,
} from './mcp.js';
/**
 * Zod round-trip tests for the canonical handshake / render / update
 * tool triad.
 *
 * Post-Phase-B (render-identity collapse) — Session vessel deleted;
 * `sessionId` is the single identity referenced across the wire. The
 * handshake input carries NO `sessionId` (handshake mints the render
 * server-side); `ggui_new_session` is gone (folded into handshake);
 * `ggui_push` renamed to `ggui_render`; render output keys by
 * `sessionId` (was `stackItemId`); update input keys by `sessionId`.
 *
 * MVB-5 (2026-05-12) — three-step handshake protocol. Pre-MVB-5
 * shapes (flat `contract?` + `hint?` on handshake input, `match` +
 * `plan` on handshake output, `contract?` + `contractHash?` triad on
 * push input) are DELETED per the no-backcompat policy. The new shape
 * threads `blueprintDraft` → `suggestion` → `decision`.
 */
import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  RUNTIME_PULL_MAX_LIMIT,
  gguiSessionEventSchema,
  handshakeInputSchema,
  handshakeOutputSchema,
  renderCacheMarkerSchema,
  renderErrorCodeSchema,
  renderInputSchema,
  renderOutcomeSchema,
  renderOutputSchema,
  renderRefusalSchema,
  resourceReadErrorCodeSchema,
  resourceReadErrorSchema,
  runtimePullEventsPageSchema,
  runtimePullHorizonSchema,
  runtimePullInputSchema,
  runtimePullOutputSchema,
  updateInputSchema,
  updateOutputSchema,
  amendInputSchema,
  amendOutputSchema,
} from './mcp';
import type {
  EventsResponse,
  GguiSessionEvent,
  ReplayHorizonPassedError,
} from '../types/ggui-session-event';

describe('renderCacheMarkerSchema', () => {
  it('round-trips a hit marker (full-template)', () => {
    const marker = {
      hit: true,
      similarity: 0.92,
      cachedBlueprintId: 'bp_abc',
      llmCallsAvoided: 1,
      kind: 'full-template' as const,
    };
    expect(renderCacheMarkerSchema.parse(marker)).toEqual(marker);
  });

  it('round-trips a cold marker (required fields only)', () => {
    const marker = { hit: false, llmCallsAvoided: 0 };
    expect(renderCacheMarkerSchema.parse(marker)).toEqual(marker);
  });

  it('round-trips the optional `reason` diagnostic when present', () => {
    const marker = {
      hit: true,
      similarity: 0.92,
      cachedBlueprintId: 'bp_abc',
      llmCallsAvoided: 1,
      kind: 'full-template' as const,
      reason: 'full-template: reused a stored interface for this contract',
    };
    expect(renderCacheMarkerSchema.parse(marker)).toEqual(marker);
  });

  it('parses with `reason` absent (the field is optional)', () => {
    const marker = { hit: false, llmCallsAvoided: 0, kind: 'cold' as const };
    const parsed = renderCacheMarkerSchema.parse(marker);
    expect(parsed.reason).toBeUndefined();
    expect(parsed).toEqual(marker);
  });

  it('requires `hit`', () => {
    expect(() => renderCacheMarkerSchema.parse({ llmCallsAvoided: 0 })).toThrow();
  });

  it('requires `llmCallsAvoided`', () => {
    expect(() => renderCacheMarkerSchema.parse({ hit: false })).toThrow();
  });

  it("rejects the dropped `composed` kind (D8)", () => {
    expect(() =>
      renderCacheMarkerSchema.parse({
        hit: true,
        llmCallsAvoided: 1,
        kind: 'composed',
      }),
    ).toThrow();
  });
});

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
          source: {
            kind: 'llm' as const,
            generator: 'ui-gen-default-haiku-4-5',
            model: 'claude-haiku-4-5',
          },
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
          source: {
            kind: 'llm' as const,
            generator: 'ui-gen-default-haiku-4-5',
            model: 'claude-haiku-4-5',
          },
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
            variance: {},
          },
        },
      }),
    ).toThrow();
  });
});

describe('ggui_render — variance-aware override reshape', () => {
  it('accepts ACCEPT — {handshakeId, props} (no override)', () => {
    const parsed = renderInputSchema.parse({
      handshakeId: 'hs_abc',
      props: {},
    });
    expect(parsed.handshakeId).toBe('hs_abc');
    expect(parsed.override).toBeUndefined();
  });

  it('accepts override.variance re-aiming the variant axis', () => {
    const parsed = renderInputSchema.parse({
      handshakeId: 'hs_abc',
      props: {},
      override: { variance: { persona: 'mobile-first' } },
    });
    expect(parsed.override?.variance?.persona).toBe('mobile-first');
    expect(parsed.override?.contract).toBeUndefined();
  });

  it('accepts override.contract re-drafting the contract', () => {
    const parsed = renderInputSchema.parse({
      handshakeId: 'hs_abc',
      props: {},
      override: { contract: {} },
    });
    expect(parsed.override?.contract).toBeDefined();
  });

  it('accepts props alongside an override', () => {
    const parsed = renderInputSchema.parse({
      handshakeId: 'hs_abc',
      props: { city: 'Berlin' },
      override: { variance: { persona: 'mobile-first' } },
    });
    expect(parsed.props).toEqual({ city: 'Berlin' });
  });

  it('rejects a shape missing handshakeId', () => {
    expect(() => renderInputSchema.parse({ props: {} })).toThrow();
  });

  it('rejects a shape missing props', () => {
    expect(() =>
      renderInputSchema.parse({ handshakeId: 'hs_abc' }),
    ).toThrow();
  });

  it('rejects an empty override:{} — omit override to accept instead', () => {
    expect(() =>
      renderInputSchema.parse({
        handshakeId: 'hs_abc',
        props: {},
        override: {},
      }),
    ).toThrow();
  });

  it('rejects an output missing the required cache-reuse fields', () => {
    expect(() =>
      renderOutputSchema.parse({
        outcome: 'rendered',
        sessionId: 'render_1',
        resourceUri: 'ui://ggui/render/render_1',
        action: 'create',
      }),
    ).toThrow();
  });

  it('round-trips a render output with contractHash + blueprintId + variantKey + cache', () => {
    const out = {
      outcome: 'rendered' as const,
      sessionId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create' as const,
      contractHash: '1c00b3ab282a45f6',
      blueprintId: 'bp_550e8400-e29b-41d4-a716-446655440000',
      variantKey: 'v_default',
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' as const },
    };
    expect(renderOutputSchema.parse(out)).toEqual(out);
  });

  it('rejects an output missing the required blueprintId / variantKey fields', () => {
    expect(() =>
      renderOutputSchema.parse({
        outcome: 'rendered',
        sessionId: 'render_1',
        resourceUri: 'ui://ggui/render/render_1',
        action: 'create',
        contractHash: '1c00b3ab282a45f6',
        cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' },
      }),
    ).toThrow();
  });

  it('surfaces a cache.hit:true marker on output, with cachedBlueprintId === blueprintId', () => {
    const out = {
      outcome: 'rendered' as const,
      sessionId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'reuse' as const,
      contractHash: '1c00b3ab282a45f6',
      blueprintId: 'bp_abc',
      variantKey: 'v_default',
      cache: {
        hit: true,
        similarity: 1,
        cachedBlueprintId: 'bp_abc',
        llmCallsAvoided: 1,
        kind: 'full-template' as const,
      },
    };
    const parsed = renderOutputSchema.parse(out);
    // `cache` is optional at the schema level (absent on the refused
    // arm) and required by the refinement on this one — read it with
    // `?.` the way the sibling `error` assertions already do.
    expect(parsed.cache?.hit).toBe(true);
    expect(parsed.cache?.cachedBlueprintId).toBe('bp_abc');
    expect(parsed.cache?.cachedBlueprintId).toBe(parsed.blueprintId);
  });

  it('strips the post-R5-retired `url` field on parse (no clickable URL on the wire)', () => {
    const parsed = renderOutputSchema.parse({
      outcome: 'rendered',
      sessionId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create',
      contractHash: '1c00b3ab282a45f6',
      blueprintId: 'bp_xyz',
      variantKey: 'v_default',
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' },
      // Dead field — post-R5 the `/r/<shortCode>` route was deleted.
      // Defensive: a sender that hasn't migrated yet must not poison
      // the wire output with a hallucination-bait URL.
      url: 'https://stale-render.example.com/abc12345',
    } as unknown as Record<string, unknown>);
    expect(parsed).toEqual({
      outcome: 'rendered',
      sessionId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create',
      contractHash: '1c00b3ab282a45f6',
      blueprintId: 'bp_xyz',
      variantKey: 'v_default',
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' },
    });
    expect(Object.keys(parsed)).not.toContain('url');
  });

  it('rejects the retired `compose` action value on output', () => {
    expect(() =>
      renderOutputSchema.parse({
        outcome: 'rendered',
        sessionId: 'render_1',
        resourceUri: 'ui://ggui/render/render_1',
        action: 'compose',
      }),
    ).toThrow();
  });

  it('accepts an output WITHOUT resourceUri — present iff mountable (failure envelope omits it)', () => {
    const out = {
      outcome: 'failed' as const,
      sessionId: 'render_1',
      action: 'create' as const,
      contractHash: '1c00b3ab282a45f6',
      blueprintId: '',
      variantKey: 'v_default',
      cache: {
        hit: false,
        llmCallsAvoided: 0,
        kind: 'cold' as const,
        reason:
          'cold: generation failed — no interface was produced',
      },
      error: {
        code: 'PRODUCTION_FAILED' as const,
        message: 'provider 500',
      },
    };
    const parsed = renderOutputSchema.parse(out);
    expect(parsed.resourceUri).toBeUndefined();
    expect(parsed.error).toEqual({
      code: 'PRODUCTION_FAILED',
      message: 'provider 500',
    });
    expect(parsed.blueprintId).toBe('');
  });

  it('accepts every canonical error code on the failure envelope', () => {
    // Driven from the enum itself, so the fixture can never enumerate a
    // SUBSET again: a code added to `renderErrorCodeSchema` is exercised
    // here the moment it lands. (It previously listed four of the five,
    // silently leaving `GENERATION_QUEUE_OVERLOADED` ungraded.)
    expect(renderErrorCodeSchema.options.length).toBe(5);
    for (const code of renderErrorCodeSchema.options) {
      const parsed = renderOutputSchema.parse({
        outcome: 'failed',
        sessionId: 'render_1',
        action: 'create',
        contractHash: 'h',
        blueprintId: '',
        variantKey: 'v_default',
        cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' },
        error: { code, message: 'm' },
      });
      expect(parsed.error?.code).toBe(code);
    }
  });

  it('rejects a non-canonical error code — the enum is closed', () => {
    expect(() =>
      renderOutputSchema.parse({
        outcome: 'failed',
        sessionId: 'render_1',
        action: 'create',
        contractHash: 'h',
        blueprintId: '',
        variantKey: 'v_default',
        cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' },
        error: { code: 'SOMETHING_ELSE', message: 'm' },
      }),
    ).toThrow();
  });

  it('success outputs carry no error field and keep resourceUri', () => {
    const out = {
      outcome: 'rendered' as const,
      sessionId: 'render_1',
      resourceUri: 'ui://ggui/render/render_1',
      action: 'create' as const,
      contractHash: '1c00b3ab282a45f6',
      blueprintId: 'bp_x',
      variantKey: 'v_default',
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' as const },
    };
    const parsed = renderOutputSchema.parse(out);
    expect(parsed.error).toBeUndefined();
    expect(parsed.resourceUri).toBe('ui://ggui/render/render_1');
  });
});

describe('ggui_update', () => {
  it('accepts kind:"replace" with full props', () => {
    const parsed = updateInputSchema.parse({
      sessionId: 'render_1',
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
      sessionId: 'render_1',
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
      sessionId: 'render_1',
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
        sessionId: 'render_1',
        kind: 'replace',
      }),
    ).toThrow();
  });

  it('rejects kind:"merge" without patch', () => {
    expect(() =>
      updateInputSchema.parse({
        sessionId: 'render_1',
        kind: 'merge',
      }),
    ).toThrow();
  });

  it('rejects missing kind', () => {
    expect(() =>
      updateInputSchema.parse({
        sessionId: 'render_1',
        props: { temp: 24 },
      }),
    ).toThrow();
  });

  it('rejects unknown kind', () => {
    expect(() =>
      updateInputSchema.parse({
        sessionId: 'render_1',
        kind: 'patch',
        patch: { temp: 24 },
      }),
    ).toThrow();
  });

  it('rejects missing sessionId on either kind', () => {
    expect(() =>
      updateInputSchema.parse({ kind: 'replace', props: { temp: 24 } }),
    ).toThrow();
    expect(() =>
      updateInputSchema.parse({ kind: 'merge', patch: { temp: 24 } }),
    ).toThrow();
  });

  it('round-trips an update output (epoch-pinned URI + head epoch, #483)', () => {
    const out = {
      sessionId: 'render_1',
      updated: true,
      // The NEW history record this update minted — epoch-pinned.
      resourceUri: 'ui://ggui/render/render_1#1',
      epoch: 1,
    };
    expect(updateOutputSchema.parse(out)).toEqual(out);
  });

  it('rejects an update output missing epoch (#483 — head epoch is mandatory)', () => {
    expect(() =>
      updateOutputSchema.parse({
        sessionId: 'render_1',
        updated: true,
        resourceUri: 'ui://ggui/render/render_1#1',
      }),
    ).toThrow();
  });

  it('round-trips an amend output (bare head URI, no epoch field)', () => {
    const out = {
      sessionId: 'render_1',
      updated: true,
      resourceUri: 'ui://ggui/render/render_1',
    };
    expect(amendOutputSchema.parse(out)).toEqual(out);
  });

  it('amend input mirrors update mutation grammar but rejects unknown keys', () => {
    expect(
      amendInputSchema.parse({
        sessionId: 'render_1',
        kind: 'merge',
        patch: { x: 1 },
      }).kind,
    ).toBe('merge');
    expect(() =>
      amendInputSchema.parse({
        sessionId: 'render_1',
        kind: 'replace',
        props: {},
        renderAsNew: true,
      }),
    ).toThrow();
  });

  it('rejects an update output missing resourceUri', () => {
    expect(() => updateOutputSchema.parse({ sessionId: 'render_1', updated: true })).toThrow();
  });
});

/**
 * LLM-visible metadata on the mutation output schemas (ggui#798).
 *
 * `.describe()` is not documentation — it ships as JSON-Schema
 * `description` in the tool declaration every agent reads from
 * `tools/list`. The schema attestation fields (ggui#560) are the two
 * that need it: an agent that cannot tell what `propsSchemaHash` is
 * cannot act on a mismatch.
 *
 * The handlers register these schemas' `.shape` directly, so THIS is
 * the only place the strings can live. A JSDoc comment above the field
 * is invisible to the wire; a description asserted here cannot be
 * dropped without failing.
 */
describe('mutation output schemas — LLM-visible field descriptions (#798)', () => {
  const HASH_DESCRIPTION =
    'sha256 (lowercase hex) over the RFC 8785 canonical form of the enforced props schema this mutation was validated against — the same schema the paired handshake disclosed. Present when the session declares a propsSpec. Equal to the handshake propsSchemaHash by the session-continuity guarantee; a mismatch means the contract changed under you.';
  const PROFILE_DESCRIPTION =
    "Grammar profile of the enforced props schema: 'grammar-safe' or 'full'. Present with propsSchemaHash; treat unrecognized values as 'full'.";

  it('updateOutputSchema describes the schema-attestation fields', () => {
    expect(updateOutputSchema.shape.propsSchemaHash.description).toBe(
      HASH_DESCRIPTION,
    );
    expect(updateOutputSchema.shape.propsSchemaProfile.description).toBe(
      PROFILE_DESCRIPTION,
    );
  });

  it('amendOutputSchema describes the schema-attestation fields', () => {
    expect(amendOutputSchema.shape.propsSchemaHash.description).toBe(
      HASH_DESCRIPTION,
    );
    expect(amendOutputSchema.shape.propsSchemaProfile.description).toBe(
      PROFILE_DESCRIPTION,
    );
  });
});

/**
 * Pre-generation refusal envelope (ggui#786) — the THIRD outcome.
 *
 * §7.1's failure envelope is for a generation that RAN and failed: the
 * error session IS committed, so `sessionId` / `contractHash` / `cache`
 * are live handles. A refusal fires before the HANDLER's own input
 * parse — no handshake read, no session committed, no spend — so the
 * identity fields are structurally ABSENT and `refusal` carries the
 * whole story. (It does not beat the SDK's shape check, which runs
 * first; the claim is nothing READ, not nothing validated.) The
 * `outcome` discriminant is what lets a reader tell the three apart
 * without guessing from which fields happen to be present.
 *
 * The identity fields go OPTIONAL at the schema level (the MCP spec's
 * `Tool.outputSchema` root must stay one object and the SDK registers
 * raw shapes, so a discriminated union cannot be the root) and the
 * presence rules ride a `superRefine`. That makes the NEGATIVE cases
 * the load-bearing ones: a rendered output missing `sessionId`, or a
 * refused output carrying one, must both still reject — otherwise
 * demoting the fields silently removed a guarantee every reader has.
 */
describe('renderOutcomeSchema — the three-outcome discriminant', () => {
  it('is the closed three-value set, in declaration order', () => {
    expect(renderOutcomeSchema.options).toEqual([
      'rendered',
      'failed',
      'refused',
    ]);
  });

  it('rejects a non-canonical outcome — the enum is closed', () => {
    // Accept-then-reject in one test: a missing schema would otherwise
    // make the reject half pass vacuously.
    expect(renderOutcomeSchema.parse('refused')).toBe('refused');
    expect(() => renderOutcomeSchema.parse('declined')).toThrow();
    expect(() => renderOutcomeSchema.parse('error')).toThrow();
  });
});

describe('renderRefusalSchema — the refusal envelope', () => {
  /** A fully-formed refusal, as a deployment's gate returns it. */
  const REFUSAL = {
    code: 'hard_cap_exceeded' as const,
    message: 'the configured render cap for this app was reached',
    fix: 'the cap resets at the start of the next period; no action restores it sooner',
    retry: 'next-period' as const,
    handshake: 'intact' as const,
  };

  it('round-trips a refusal (required fields only)', () => {
    expect(renderRefusalSchema.parse(REFUSAL)).toEqual(REFUSAL);
  });

  it('round-trips a refusal carrying the optional balanceCentsAtCheck', () => {
    const withBalance = {
      code: 'insufficient_credit' as const,
      message: 'the configured allowance for this app is exhausted',
      fix: 'top up the allowance for this app, then retry the same handshakeId',
      retry: 'after-fix' as const,
      handshake: 'intact' as const,
      balanceCentsAtCheck: 0,
    };
    expect(renderRefusalSchema.parse(withBalance)).toEqual(withBalance);
  });

  it('rejects a code that is not in the registry — z.enum closes the namespace', () => {
    // The ruling's defined failure mode: an unregistered code fails at
    // the transport, loudly (a bug, never a wire state). Accept-first so
    // an absent schema cannot make the reject half pass vacuously.
    expect(renderRefusalSchema.parse(REFUSAL)).toEqual(REFUSAL);
    expect(() =>
      renderRefusalSchema.parse({ ...REFUSAL, code: 'not_a_registered_code' }),
    ).toThrow();
  });

  it('rejects an owner-api-only code — those never reach a render wire', () => {
    expect(renderRefusalSchema.parse(REFUSAL)).toEqual(REFUSAL);
    expect(() =>
      renderRefusalSchema.parse({ ...REFUSAL, code: 'subscription_exists' }),
    ).toThrow();
    expect(() =>
      renderRefusalSchema.parse({ ...REFUSAL, code: 'checkout_unavailable' }),
    ).toThrow();
  });

  it("pins handshake to the literal 'intact' — a refusal consumes nothing", () => {
    expect(renderRefusalSchema.parse(REFUSAL)).toEqual(REFUSAL);
    expect(() =>
      renderRefusalSchema.parse({ ...REFUSAL, handshake: 'consumed' }),
    ).toThrow();
  });

  it('requires message and fix — the fix is addressed to the party that can act', () => {
    expect(renderRefusalSchema.parse(REFUSAL)).toEqual(REFUSAL);
    const { fix: _fix, ...noFix } = REFUSAL;
    expect(() => renderRefusalSchema.parse(noFix)).toThrow();
    const { message: _message, ...noMessage } = REFUSAL;
    expect(() => renderRefusalSchema.parse(noMessage)).toThrow();
  });
});

describe('renderOutputSchema — the refused outcome (#786)', () => {
  const REFUSAL = {
    code: 'hard_cap_exceeded' as const,
    message: 'the configured render cap for this app was reached',
    fix: 'the cap resets at the start of the next period',
    retry: 'next-period' as const,
    handshake: 'intact' as const,
  };

  it('accepts a refused output with NO identity fields', () => {
    const out = { outcome: 'refused' as const, refusal: REFUSAL };
    const parsed = renderOutputSchema.parse(out);
    expect(parsed).toEqual(out);
    expect(parsed.sessionId).toBeUndefined();
    expect(parsed.resourceUri).toBeUndefined();
    expect(parsed.action).toBeUndefined();
    expect(parsed.contractHash).toBeUndefined();
    expect(parsed.blueprintId).toBeUndefined();
    expect(parsed.variantKey).toBeUndefined();
    expect(parsed.cache).toBeUndefined();
    expect(parsed.error).toBeUndefined();
    expect(parsed.nextStep).toBeUndefined();
  });

  it('rejects a refused output that carries a sessionId — nothing was committed', () => {
    // Paired with the accept above so it can never pass vacuously: the
    // ONLY difference between the two literals is the stray sessionId.
    const refused = { outcome: 'refused' as const, refusal: REFUSAL };
    expect(renderOutputSchema.parse(refused)).toEqual(refused);
    expect(() =>
      renderOutputSchema.parse({ ...refused, sessionId: 'render_1' }),
    ).toThrow();
  });

  it('rejects a refused output whose refusal.code is unregistered', () => {
    const refused = { outcome: 'refused' as const, refusal: REFUSAL };
    expect(renderOutputSchema.parse(refused)).toEqual(refused);
    expect(() =>
      renderOutputSchema.parse({
        ...refused,
        refusal: { ...REFUSAL, code: 'not_a_registered_code' },
      }),
    ).toThrow();
  });

  it('rejects outcome:refused with no refusal object', () => {
    const refused = { outcome: 'refused' as const, refusal: REFUSAL };
    expect(renderOutputSchema.parse(refused)).toEqual(refused);
    expect(() => renderOutputSchema.parse({ outcome: 'refused' })).toThrow();
  });

  it('rejects a refused output carrying the §7.1 error marker — different outcome', () => {
    const refused = { outcome: 'refused' as const, refusal: REFUSAL };
    expect(renderOutputSchema.parse(refused)).toEqual(refused);
    expect(() =>
      renderOutputSchema.parse({
        ...refused,
        error: { code: 'VALIDATION_ERROR', message: 'm' },
      }),
    ).toThrow();
  });
});

describe('renderOutputSchema — outcome is required on every arm (#786)', () => {
  const SUCCESS = {
    sessionId: 'render_1',
    resourceUri: 'ui://ggui/render/render_1',
    action: 'create' as const,
    contractHash: '1c00b3ab282a45f6',
    blueprintId: 'bp_x',
    variantKey: 'v_default',
    cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' as const },
  };

  it("round-trips today's success shape once outcome:'rendered' is added", () => {
    const out = { outcome: 'rendered' as const, ...SUCCESS };
    expect(renderOutputSchema.parse(out)).toEqual(out);
  });

  it("rejects today's success shape WITHOUT outcome — the discriminant is mandatory", () => {
    // BREAKING, pre-launch, no shim: every render result carries an
    // outcome from this ruling on. The sibling fixtures in
    // `describe('ggui_render — variance-aware override reshape')` that
    // still omit it are updated in the GREEN slice.
    expect(() => renderOutputSchema.parse(SUCCESS)).toThrow();
  });

  it("rejects outcome:'rendered' missing an identity field", () => {
    // The whole point of the superRefine: demoting the six fields to
    // optional must NOT weaken the success arm.
    for (const missing of [
      'sessionId',
      'action',
      'contractHash',
      'blueprintId',
      'variantKey',
      'cache',
    ] as const) {
      const { [missing]: _dropped, ...rest } = SUCCESS;
      expect(() =>
        renderOutputSchema.parse({ outcome: 'rendered', ...rest }),
      ).toThrow();
    }
  });

  it("rejects outcome:'rendered' missing resourceUri — a rendered result is mountable", () => {
    // `resourceUri` is present IFF the render is mountable, and every
    // `rendered` outcome is. Paired accept/reject so the assertion cannot
    // pass vacuously: the only difference is the dropped field.
    const out = { outcome: 'rendered' as const, ...SUCCESS };
    expect(renderOutputSchema.parse(out)).toEqual(out);
    const { resourceUri: _dropped, ...noUri } = SUCCESS;
    expect(() =>
      renderOutputSchema.parse({ outcome: 'rendered', ...noUri }),
    ).toThrow();
  });

  it("rejects outcome:'failed' carrying resourceUri — a failed render is not mountable", () => {
    // The other half of the iff. A failed render commits an error
    // GguiSession but exposes NO mount affordance; advertising one points
    // a host at a render that does not exist.
    const failed = {
      outcome: 'failed' as const,
      sessionId: 'render_1',
      action: 'create' as const,
      contractHash: '1c00b3ab282a45f6',
      blueprintId: '',
      variantKey: 'v_default',
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' as const },
      error: { code: 'PRODUCTION_FAILED' as const, message: 'provider 500' },
    };
    expect(renderOutputSchema.parse(failed)).toEqual(failed);
    expect(() =>
      renderOutputSchema.parse({
        ...failed,
        resourceUri: 'ui://ggui/render/render_1',
      }),
    ).toThrow();
  });

  it("rejects outcome:'rendered' carrying a refusal", () => {
    expect(() =>
      renderOutputSchema.parse({
        outcome: 'rendered',
        ...SUCCESS,
        refusal: {
          code: 'hard_cap_exceeded',
          message: 'm',
          fix: 'f',
          retry: 'next-period',
          handshake: 'intact',
        },
      }),
    ).toThrow();
  });

  it("round-trips the §7.1 failure envelope as outcome:'failed'", () => {
    const out = {
      outcome: 'failed' as const,
      sessionId: 'render_1',
      action: 'create' as const,
      contractHash: '1c00b3ab282a45f6',
      blueprintId: '',
      variantKey: 'v_default',
      cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' as const },
      error: { code: 'PRODUCTION_FAILED' as const, message: 'provider 500' },
    };
    const parsed = renderOutputSchema.parse(out);
    expect(parsed).toEqual(out);
    // The committed session stays a live handle — that is the whole
    // difference from a refusal.
    expect(parsed.sessionId).toBe('render_1');
    expect(parsed.resourceUri).toBeUndefined();
  });

  it("rejects outcome:'failed' with no error marker", () => {
    expect(() =>
      renderOutputSchema.parse({
        outcome: 'failed',
        sessionId: 'render_1',
        action: 'create',
        contractHash: 'h',
        blueprintId: '',
        variantKey: 'v_default',
        cache: { hit: false, llmCallsAvoided: 0, kind: 'cold' },
      }),
    ).toThrow();
  });
});

describe('renderErrorCodeSchema', () => {
  it('is the closed five-value set, in declaration order', () => {
    expect(renderErrorCodeSchema.options).toEqual([
      'PRODUCTION_FAILED',
      'VALIDATION_ERROR',
      'NO_PLATFORM_KEY',
      'NO_CREDENTIALS',
      'GENERATION_QUEUE_OVERLOADED',
    ]);
  });

  it('accepts each member', () => {
    for (const code of renderErrorCodeSchema.options) {
      expect(renderErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  // The two failure surfaces are neighbours in this file and in the
  // spec, which is exactly why they are pinned as disjoint: a
  // `ggui_render` tool call that ran and failed classifies here, a
  // `resources/read` that cannot return a mount classifies in
  // `resourceReadErrorCodeSchema`, and a code that validated on both
  // would make the classification meaningless to a host branching on
  // it. Spelled as literals rather than read off the sibling schema's
  // `.options` so the pin cannot be satisfied by both enums drifting
  // together.
  //
  // `safeParse` rather than `expect(...).toThrow()` on purpose: a
  // missing or renamed schema makes `.parse` throw a TypeError, which
  // `toThrow()` happily accepts — the rejection pin would pass while
  // proving nothing.
  it('rejects every resource-read code — the two surfaces are disjoint', () => {
    for (const code of [
      'NOT_FOUND',
      'BLUEPRINT_UNRESOLVABLE',
      'NOT_SUPPORTED',
      'NOT_MOUNTABLE',
    ]) {
      expect(renderErrorCodeSchema.safeParse(code).success).toBe(false);
    }
  });

  it('rejects a lowercase spelling — the wire form is UPPER_SNAKE', () => {
    expect(renderErrorCodeSchema.safeParse('production_failed').success).toBe(false);
  });
});

describe('resourceReadErrorCodeSchema', () => {
  it('is the closed four-value set, in declaration order', () => {
    expect(resourceReadErrorCodeSchema.options).toEqual([
      'NOT_FOUND',
      'BLUEPRINT_UNRESOLVABLE',
      'NOT_SUPPORTED',
      'NOT_MOUNTABLE',
    ]);
  });

  it('accepts each member', () => {
    for (const code of resourceReadErrorCodeSchema.options) {
      expect(resourceReadErrorCodeSchema.parse(code)).toBe(code);
    }
  });

  // `safeParse` rather than `expect(...).toThrow()` on purpose: a missing
  // or renamed schema makes `.parse` throw a TypeError, which `toThrow()`
  // happily accepts — the rejection pin would pass while proving nothing.
  it('rejects an unknown code — the enum is closed, not advisory', () => {
    // `contract_mismatch` was a candidate that got ruled out; if the enum
    // were ever loosened it is the shape most likely to slip back in.
    expect(resourceReadErrorCodeSchema.safeParse('CONTRACT_MISMATCH').success).toBe(false);
    expect(resourceReadErrorCodeSchema.safeParse('SOMETHING_ELSE').success).toBe(false);
  });

  it('rejects a lowercase spelling — the wire form is UPPER_SNAKE', () => {
    expect(resourceReadErrorCodeSchema.safeParse('not_found').success).toBe(false);
  });
});

describe('resourceReadErrorSchema', () => {
  it('round-trips a minimal failure', () => {
    const err = { code: 'NOT_FOUND' as const, message: 'Resource not found.' };
    expect(resourceReadErrorSchema.parse(err)).toEqual(err);
  });

  it('round-trips a failure carrying operator detail', () => {
    const err = {
      code: 'BLUEPRINT_UNRESOLVABLE' as const,
      message: 'The component behind this render is gone.',
      detail: 'blueprint bp_abc resolved, code body absent',
    };
    expect(resourceReadErrorSchema.parse(err)).toEqual(err);
  });

  it('requires code and message', () => {
    expect(resourceReadErrorSchema.safeParse({ message: 'no code' }).success).toBe(false);
    expect(resourceReadErrorSchema.safeParse({ code: 'NOT_FOUND' }).success).toBe(false);
  });

  it('rejects an out-of-enum code on the composed shape', () => {
    // A `ggui_render` tool-envelope code must not validate here — the two
    // failure surfaces are separate closed enums.
    expect(
      resourceReadErrorSchema.safeParse({ code: 'PRODUCTION_FAILED', message: 'wrong surface' })
        .success,
    ).toBe(false);
  });
});

describe('ggui_runtime_pull — bridge-pull rung schemas', () => {
  const EVENT = {
    seq: 1,
    type: 'ui.updated',
    timestamp: '2026-08-11T00:00:00.000Z',
    data: { props: { count: 1 } },
  };

  describe('runtimePullInputSchema', () => {
    it('accepts a minimal input — sessionId only (cursor + limit optional)', () => {
      const parsed = runtimePullInputSchema.parse({ sessionId: 'rnd_1' });
      expect(parsed).toEqual({ sessionId: 'rnd_1' });
      expect(parsed.sinceSequence).toBeUndefined();
      expect(parsed.limit).toBeUndefined();
    });

    it('round-trips a fully-populated input', () => {
      const input = { sessionId: 'rnd_1', sinceSequence: 12, limit: 50 };
      expect(runtimePullInputSchema.parse(input)).toEqual(input);
    });

    it('rejects an empty sessionId', () => {
      expect(runtimePullInputSchema.safeParse({ sessionId: '' }).success).toBe(false);
    });

    it('rejects a negative or fractional sinceSequence', () => {
      expect(
        runtimePullInputSchema.safeParse({ sessionId: 'rnd_1', sinceSequence: -1 }).success,
      ).toBe(false);
      expect(
        runtimePullInputSchema.safeParse({ sessionId: 'rnd_1', sinceSequence: 1.5 }).success,
      ).toBe(false);
    });

    it('rejects limit < 1 but accepts values above the clamp ceiling (clamped server-side, not rejected)', () => {
      expect(
        runtimePullInputSchema.safeParse({ sessionId: 'rnd_1', limit: 0 }).success,
      ).toBe(false);
      expect(
        runtimePullInputSchema.safeParse({
          sessionId: 'rnd_1',
          limit: RUNTIME_PULL_MAX_LIMIT + 400,
        }).success,
      ).toBe(true);
    });
  });

  describe('runtimePullOutputSchema — EventsResponse parity union', () => {
    it('round-trips a normal page arm (byte-parity with GET /api/sessions/:id/events)', () => {
      const page = { events: [EVENT], lastSequence: 1, hasMore: false };
      expect(runtimePullOutputSchema.parse(page)).toEqual(page);
    });

    it('round-trips an empty page (cursor advances via lastSequence alone)', () => {
      const page = { events: [], lastSequence: 7, hasMore: false };
      expect(runtimePullOutputSchema.parse(page)).toEqual(page);
    });

    it('round-trips the horizon arm as a NORMAL result, not an error shape', () => {
      const horizon = { reason: 'REPLAY_HORIZON_PASSED' as const, currentSequence: 9 };
      expect(runtimePullOutputSchema.parse(horizon)).toEqual(horizon);
    });

    it('page arm requires all three keys', () => {
      expect(
        runtimePullOutputSchema.safeParse({ events: [EVENT], lastSequence: 1 }).success,
      ).toBe(false);
      expect(
        runtimePullOutputSchema.safeParse({ events: [EVENT], hasMore: false }).success,
      ).toBe(false);
    });

    it('horizon arm requires currentSequence and the exact reason literal', () => {
      expect(
        runtimePullOutputSchema.safeParse({ reason: 'REPLAY_HORIZON_PASSED' }).success,
      ).toBe(false);
      expect(
        runtimePullOutputSchema.safeParse({
          reason: 'replay_horizon_passed',
          currentSequence: 9,
        }).success,
      ).toBe(false);
    });

    it('event rows enforce the ledger shape (seq >= 1, non-empty type)', () => {
      expect(
        runtimePullEventsPageSchema.safeParse({
          events: [{ ...EVENT, seq: 0 }],
          lastSequence: 1,
          hasMore: false,
        }).success,
      ).toBe(false);
      expect(
        runtimePullEventsPageSchema.safeParse({
          events: [{ ...EVENT, type: '' }],
          lastSequence: 1,
          hasMore: false,
        }).success,
      ).toBe(false);
    });

    it('accepts every valid EventsResponse / ReplayHorizonPassedError (parity with the canonical ledger types)', () => {
      // Compile-time direction 1: everything the /events route emits
      // (the canonical ledger types in types/ggui-session-event.ts)
      // must satisfy the schema-inferred INPUT types — the schema may
      // never reject a valid route body. Pinned at the event level
      // (the array level differs only by ReadonlyArray, which zod
      // accepts at runtime — covered by the parse below).
      const routeEvent: GguiSessionEvent = {
        seq: 3,
        type: 'user.submitted',
        timestamp: '2026-08-11T00:00:01.000Z',
        data: null,
      };
      const eventInput: z.input<typeof gguiSessionEventSchema> = routeEvent;
      const routeHorizon: ReplayHorizonPassedError = {
        reason: 'REPLAY_HORIZON_PASSED',
        currentSequence: 3,
      };
      const horizonInput: z.input<typeof runtimePullHorizonSchema> = routeHorizon;
      const routePage: EventsResponse = {
        events: [routeEvent],
        lastSequence: 3,
        hasMore: true,
      };
      expect(runtimePullOutputSchema.parse(routePage)).toEqual(routePage);
      expect(runtimePullOutputSchema.parse(horizonInput)).toEqual(routeHorizon);
      expect(gguiSessionEventSchema.parse(eventInput)).toEqual(routeEvent);
      // Compile-time direction 2: the horizon arm infers back to the
      // canonical error type (the page arm's `data: z.unknown()` infers
      // an optional key, so its reverse direction is pinned at runtime
      // by the round-trip cases above instead).
      const inferredHorizon: ReplayHorizonPassedError = runtimePullHorizonSchema.parse(routeHorizon);
      expect(inferredHorizon).toEqual(routeHorizon);
    });
  });
});

describe('tool output schemas — protocol owns every wire shape a handler registers (#817 part C)', () => {
  it('ggui_search_blueprints: the closed result row round-trips a registry hit and a degraded source', () => {
    const out = {
      results: [
        {
          id: 'bp_1', name: 'Todo list', description: 'd', category: 'productivity',
          props: [{ name: 'items', type: 'array', required: true, description: 'rows' }],
          callbacks: ['onToggle'], featured: false, relevance: 'match', score: 0.91,
          origin: 'registry', artifactId: '@acme/todo', version: '1.2.0',
          mcpTools: [{ server: 'acme', tool: 'todo_list' }], scopeVerification: 'verified',
        },
      ],
      total: 1, query: 'todo',
      degradedSources: [{ source: 'registry', reason: 'timeout' }],
    };
    expect(gguiSearchBlueprintsOutputSchema.parse(out)).toEqual(out);
    expect(Object.keys(gguiSearchBlueprintsOutputSchema.shape).sort()).toEqual(['degradedSources', 'query', 'results', 'total']);
  });

  it('ggui_protocol_validate_blueprint: the three-tier result round-trips, failedAt is a tier or null', () => {
    const out = {
      valid: false, failedAt: 'compile',
      errors: [{ tier: 'compile', code: 'TS2304', message: 'x', fix: 'import it' }],
      warnings: [{ tier: 'selfCheck', code: 'W1', message: 'y' }],
    };
    expect(blueprintValidationResultSchema.parse(out)).toEqual(out);
    expect(blueprintValidationResultSchema.parse({ valid: true, failedAt: null, errors: [], warnings: [] }).failedAt).toBeNull();
    expect(() => blueprintValidationResultSchema.parse({ ...out, failedAt: 'lint' })).toThrow();
  });

  it('ggui_consume: the host-context projection and its wrapper live on the protocol', () => {
    const hc = {
      availableDisplayModes: ['inline', 'fullscreen'], currentDisplayMode: 'inline',
      containerDimensions: { width: 320, maxWidth: 640, height: 200, maxHeight: 400 },
      platform: 'web', deviceCapabilities: { touch: false, hover: true }, locale: 'en-US', timeZone: 'Asia/Seoul',
    };
    expect(hostContextProjectionSchema.parse(hc)).toEqual(hc);
    expect(clientObservationsSchema.parse({ hostContext: hc })).toEqual({ hostContext: hc });
    expect(clientObservationsSchema.parse({})).toEqual({});
    expect(() => hostContextProjectionSchema.parse({ currentDisplayMode: 'popup' })).toThrow();
  });

  it('ggui_list_sessions: the summary is eight closed keys — an unknown key is STRIPPED, never passed through', () => {
    const summary = {
      sessionId: 'render_1', hostName: 'claude', hostSessionId: 'h1', createdAt: '2026-09-05T00:00:00Z',
      lastActivityAt: '2026-09-05T00:01:00Z', status: 'active', wsToken: 't', wsTokenExpiresAt: '2026-09-05T01:00:00Z',
    };
    expect(gguiSessionSummaryWireSchema.parse(summary)).toEqual(summary);
    expect(Object.keys(gguiSessionSummaryWireSchema.shape)).toHaveLength(8);
    expect(gguiSessionSummaryWireSchema.parse({ ...summary, extra: 1 })).toEqual(summary);
  });

  it('ggui_runtime_pull: the page arm is the EventsResponse — mutable events on the wire', () => {
    expect(Object.keys(runtimePullEventsPageSchema.shape).sort()).toEqual(['events', 'hasMore', 'lastSequence']);
  });

  it('ggui_get_session: the wire is the six-field projection, not the GguiSession union', () => {
    const out = { variant: 'render', id: 'render_1', appId: 'app_1', eventSequence: 3, createdAt: 1, lastActivityAt: 2, expiresAt: 3 };
    expect(gguiGetSessionOutputSchema.parse(out)).toEqual(out);
    // An MCP-Apps mount is a session too: the six base fields come from the
    // store row, never from the locator-only render — so the wire never
    // fails on that variant (the latent bug #817 part C surfaced).
    expect(gguiGetSessionOutputSchema.parse({ ...out, variant: 'mcpApps' }).variant).toBe('mcpApps');
    expect(() => gguiGetSessionOutputSchema.parse({ ...out, variant: 'iframe' })).toThrow();
    expect(Object.keys(gguiGetSessionOutputSchema.shape).sort()).toEqual(['appId', 'contextSnapshot', 'createdAt', 'eventSequence', 'expiresAt', 'id', 'lastActivityAt', 'variant']);
    // contextSpec's last-known values ride the wire when the render has them
    // (ggui_runtime_sync_context wrote them onto the row) — the read path a raw
    // MCP client was promised; absent otherwise, and never anything but an object.
    const withCtx = { ...out, contextSnapshot: { selectedDate: '2026-09-05', draft: { text: 'hi' } } };
    expect(gguiGetSessionOutputSchema.parse(withCtx)).toEqual(withCtx);
    expect(() => gguiGetSessionOutputSchema.parse({ ...out, contextSnapshot: 'nope' })).toThrow();
    expect(() => gguiGetSessionOutputSchema.parse({ ...out, eventSequence: -1 })).toThrow();
  });
});

describe('ggui_list_featured_blueprints — the provider row is its own wire statement (#817 part C, oss add)', () => {
  it('round-trips a BlueprintEntry row and is closed', () => {
    const out = { blueprints: [{ id: 'bp_1', name: 'Todo', description: 'd', source: { kind: "llm", generator: 'x', model: 'x' }, updatedAt: '2026-09-05T00:00:00Z', tags: ['a'] }], total: 1 };
    expect(gguiListFeaturedBlueprintsOutputSchema.parse(out)).toEqual(out);
    expect(Object.keys(gguiListFeaturedBlueprintsOutputSchema.shape).sort()).toEqual(['blueprints', 'total']);
    expect(gguiListFeaturedBlueprintsOutputSchema.parse({ ...out, extra: 1 })).toEqual(out);
  });
});

describe('mcpUiDisplayModeSchema — the wire enum is ext-apps\' McpUiDisplayMode', () => {
  it('is assignable to the host SDK type (compile-time; a widening upstream lands here as a type error)', () => {
    expectTypeOf<z.infer<typeof mcpUiDisplayModeSchema>>().toMatchTypeOf<McpUiDisplayMode>();
    expect(mcpUiDisplayModeSchema.options).toEqual(['inline', 'fullscreen', 'pip']);
  });
});

describe('renderInputEnvelopeSchema — infra.model is a model route in either wire form, or the handler input parse fails at infra.model (#818)', () => {
  const base = { handshakeId: 'hs_1', props: {} };
  const modelIssue = (value: unknown): boolean => {
    const r = renderInputEnvelopeSchema.safeParse(value);
    return !r.success && r.error.issues.some((i) => i.path.join('.') === 'infra.model');
  };
  it('accepts the canonical and LiteLLM forms (aliases resolve in both) and an absent model', () => {
    for (const model of ['anthropic:claude-haiku-4-5-20251001', 'anthropic/claude-haiku-4-5', 'anthropic:claude-haiku-4-5']) {
      expect(modelIssue({ ...base, infra: { model } }), model).toBe(false);
    }
    expect(modelIssue(base)).toBe(false);
    expect(modelIssue({ ...base, infra: {} })).toBe(false);
  });
  it('rejects a bare model id and a non-route at path infra.model — a contract error, never a policy refusal', () => {
    for (const model of ['claude-haiku-4-5', 'not a route', 'nope:']) {
      expect(modelIssue({ ...base, infra: { model } }), model).toBe(true);
    }
  });
  it('the registered shape stays parser-free — a browser bundle never validates a render input', () => {
    // The SDK validates this shape; the envelope (server-side) carries the grammar.
    expect(renderInputShape.infra.parse({ model: 'claude-haiku-4-5' })).toEqual({ model: 'claude-haiku-4-5' });
  });
});

describe('renderInputRouteGuardSchema — the pre-gate check is the route grammar and NOTHING else (#818 × #786)', () => {
  it('lets a syntactically empty input through — the gate must still see it (#786: a refusal is projected before the handler parse)', () => {
    expect(renderInputRouteGuardSchema.safeParse({}).success).toBe(true);
    expect(renderInputRouteGuardSchema.safeParse({ infra: {} }).success).toBe(true);
    expect(renderInputRouteGuardSchema.safeParse({ props: {}, infra: { model: 'anthropic/claude-haiku-4-5', extra: 1 } }).success).toBe(true);
  });
  it('stops a malformed route at path infra.model before the gate', () => {
    const r = renderInputRouteGuardSchema.safeParse({ infra: { model: 'claude-haiku-4-5' } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(['infra', 'model']);
  });
});
