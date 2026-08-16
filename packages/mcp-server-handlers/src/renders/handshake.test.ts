/**
 * `ggui_handshake` handler tests — MVB-5 three-step handshake.
 *
 * Post-Phase-B (flatten-render-identity): handshake input no longer
 * carries `sessionId` — the paired `ggui_render` mints the render
 * server-side. Host conversation grouping (sibling renders within one
 * host chat) lives on the `_meta["ai.ggui/host-session"]` envelope,
 * not on the handshake input.
 *
 * Tests cover:
 *   - declaration shape (outputSchema fields match the new spec)
 *   - no-negotiator default produces `origin: 'agent'`
 *   - negotiator binding round-trips through the suggestion
 *   - record persistence + TTL
 *   - handshake input validation
 *   - blueprintMeta is always present (Option B from the plan)
 *   - alternatives carry through when negotiator supplies them
 */
import { describe, expect, it } from 'vitest';
import { InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import { z } from 'zod';
import {
  DATA_CONTRACT_MINIMAL_EXAMPLE,
  DATA_CONTRACT_SHAPE_RULE,
  handshakeInputSchema,
  type GguiLifecyclePayload,
} from '@ggui-ai/protocol';
import type { GguiLifecycleEmitter } from './lifecycle';
import type { AppMetadataStore } from '@ggui-ai/mcp-server-core';
import {
  resolveAppGadgets,
  STDLIB_GADGETS,
  type DataContract,
  type GadgetDescriptor,
  type HandshakeSuggestion,
  type Blueprint,
} from '@ggui-ai/protocol';
import {
  createGguiHandshakeHandler,
  consumeHandshakeRecord,
  handshakeRecordKey,
  HANDSHAKE_RECORD_TTL_SEC,
  DEFAULT_GENERATOR_SLUG,
  type HandshakeNegotiator,
  type HandshakeRecord,
} from './handshake';

const MINIMAL_DRAFT = {
  contract: {} as DataContract,
};

const minimalInput = (overrides: Record<string, unknown> = {}) => ({
  intent: 'show weather',
  blueprintDraft: MINIMAL_DRAFT,
  ...overrides,
});

describe('createGguiHandshakeHandler — MVB-5', () => {
  describe('declaration', () => {
    it('exposes the canonical tool name ggui_handshake', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      expect(handler.name).toBe('ggui_handshake');
    });

    // ggui#523 items 1+2 — the teaching surface an agent sees FIRST is the
    // published input schema. Pin what `tools/list` projects (the same
    // zod → JSON-Schema engine the MCP SDK uses) and what a strict-key
    // rejection says.
    it('publishes the DataContract shape rule + a valid example on the loose `contract` field (item 1)', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const json = z.toJSONSchema(z.object(handler.inputSchema), { io: 'input' });
      const draft = (json.properties as Record<string, { properties?: Record<string, unknown>; description?: string }>)['blueprintDraft']!;
      const contract = draft.properties!['contract'] as { type?: string; description?: string; examples?: unknown[] };
      // Loose at validation (any object) …
      expect(contract.type).toBe('object');
      // … but it TEACHES: the shared shape rule and a minimal example.
      expect(contract.description).toContain(DATA_CONTRACT_SHAPE_RULE);
      expect(contract.examples).toEqual([DATA_CONTRACT_MINIMAL_EXAMPLE]);
      // The draft field carries the protocol's own description (derived, not retyped).
      expect(draft.description).toBe(handshakeInputSchema.shape.blueprintDraft.description);
      // The variance keys carry the protocol's `.describe()` teaching (blueprintVarianceSchema, not a mirror).
      const variance = draft.properties!['variance'] as { properties?: Record<string, { description?: string }> };
      expect(variance.properties?.['persona']?.description).toMatch(/Design persona/);
      expect(variance.properties?.['context']?.description).toMatch(/NOT for per-user runtime data/);
    });

    it('a rejected `mood` names the legal variance set instead of a bare "Unrecognized key" (item 2)', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      // The SDK validates args against this zod BEFORE the handler runs;
      // its -32602 text is zod's issue message — so the message is the UX.
      const parsed = z.object(handler.inputSchema).safeParse({
        intent: 'x',
        blueprintDraft: { contract: {}, variance: { persona: 'p', mood: 'sad' } },
      });
      expect(parsed.success).toBe(false);
      const messages = parsed.success ? [] : parsed.error.issues.map((i) => i.message);
      expect(messages.join(' | ')).toMatch(/variance: unknown key\(s\) "mood" — variance is EXACTLY \{persona, aesthetic, context, seedPrompt\}/);
      expect(messages.join(' | ')).toMatch(/tonal intent in `aesthetic`/);
    });

    it('a stray draft key names the legal draft set and where `intent` lives (item 2)', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const parsed = z.object(handler.inputSchema).safeParse({
        intent: 'x',
        blueprintDraft: { contract: {}, intent: 'misplaced' },
      });
      expect(parsed.success).toBe(false);
      const text = parsed.success ? '' : parsed.error.issues.map((i) => i.message).join(' | ');
      expect(text).toMatch(/blueprintDraft: unknown key\(s\) "intent" — a draft is EXACTLY \{contract, variance, generator\}/);
      expect(text).toMatch(/`intent` is a top-level ggui_handshake field/);
    });

    it('declares the lean handshakeOutputSchema shape — {handshakeId, action, suggestion, nextStep?}', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const outKeys = Object.keys(handler.outputSchema).sort();
      // Post-2026-05-13 trim: reason/target/alternatives/contractHash/
      // serverCapabilities echo fields retired (render.ts set the bar;
      // handshake follows). These survive on the internal TS shape /
      // HandshakeRecord for telemetry + post-classify tracing — zod
      // strips them before structuredContent serialization.
      expect(outKeys).toEqual([
        'action',
        'handshakeId',
        'nextStep',
        'suggestion',
      ]);
    });
  });

  // P2-24: the negotiation-framing portion of the description was
  // rewritten to match Phase 2 behavior (server prioritizes proposing a
  // similar cached contract; ONE accept/override decision on ggui_render).
  // These ship via tools/list to every self-hoster's LLM, so they are
  // code-property asserted (key phrases) + OSS-purity grepped (no
  // platform/tier/credit/cost wording).
  describe('description (P2-24 negotiation framing)', () => {
    const description = () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      expect(typeof handler.description).toBe('string');
      return handler.description as string;
    };

    it('frames the server as prioritizing reuse of a similar contract', () => {
      const d = description();
      expect(d).toMatch(/priorit/i);
      expect(d).toMatch(/reus/i);
    });

    it('describes a PROPOSED contract with a short summary and origin set', () => {
      const d = description();
      expect(d).toMatch(/proposed/i);
      expect(d).toMatch(/proposedContractSummary/);
      expect(d).toMatch(/origin = cache .*\| agent .*\| synth/);
    });

    it('is FORGIVING — always conforming, accept rather than loop', () => {
      const d = description();
      expect(d).toMatch(/forgiving/i);
      expect(d).toMatch(/do NOT re-call ggui_handshake in a loop/);
    });

    it('teaches the variance-aware render dispositions (omit=accept / override.variance / override.contract)', () => {
      const d = description();
      // The DELETED `decision: {kind}` shape must be GONE — an LLM
      // following it hard-fails the new renderInputSchema.
      expect(d).not.toMatch(/decision: ?\{kind/);
      expect(d).not.toMatch(/blueprintDraft\}/);
      // omit `override` = ACCEPT the proposed contract (normal path).
      expect(d).toMatch(/OMIT `override` to ACCEPT the proposed contract/);
      // `override: {variance}` re-aims the variant, keeps the contract.
      expect(d).toMatch(/`override: \{variance\}`/);
      expect(d).toMatch(/keeps the agreed contract/);
      // `override: {contract}` is STRICT — must conform, no repair.
      expect(d).toMatch(/`override: \{contract\}`/);
      expect(d).toMatch(/STRICT/);
      expect(d).toMatch(/will not repair an override/);
      // props is REQUIRED on the render.
      expect(d).toMatch(/`props` is REQUIRED/);
    });

    it('flags VARIANCE_GAP alongside COVERAGE_GAP and defaults to accept', () => {
      const d = description();
      expect(d).toMatch(/VARIANCE_GAP/);
      // built-for-X-you-asked-Y framing + reuse-and-refine default.
      expect(d).toMatch(/built for X, you asked Y/);
      // The default-accept framing must follow the VARIANCE_GAP flag —
      // pin it so the clause can't drift to default-override.
      expect(d).toMatch(/VARIANCE_GAP[\s\S]{0,200}DEFAULT TO ACCEPT/i);
    });

    it('teaches the variance/data boundary (design signals vs per-user data)', () => {
      const d = description();
      // variance = design-shaping signals; per-user data → props/contextSpec.
      expect(d).toMatch(/VARIANCE is design-shaping signals only/);
      // The variance teaching must name EXACTLY the schema's four keys —
      // the old prose taught `mood`, which the strict schema rejects, and
      // an agent following it got an unhinted -32602 (the 2026-08-16
      // landing activation's handshake failures).
      expect(d).toMatch(/persona \/ aesthetic \/ context \/ seedPrompt/);
      expect(d).not.toMatch(/persona \/ aesthetic \/ mood/);
      expect(d).toMatch(/toolInfo/);
      expect(d).toMatch(/per-user runtime data belongs in `props` \/ contextSpec/);
    });

    it('keeps the CONTRACT SHAPE + PLACEMENT RULE blocks verbatim — the shape block IS the protocol\'s shared rule (ggui#523 item 1)', () => {
      const d = description();
      // One constant, quoted here and published as the loose `contract`
      // field's JSON-Schema description — the words cannot drift apart.
      expect(d).toContain(`CONTRACT SHAPE — ${DATA_CONTRACT_SHAPE_RULE}`);
      expect(DATA_CONTRACT_SHAPE_RULE).toContain(
        'EVERY entry under propsSpec.properties / actionSpec / streamSpec / contextSpec is a WRAPPER object whose JSON Schema sits in its `schema:` field',
      );
      expect(d).toContain(
        'PLACEMENT RULE: actionSpec = events that drive the agent\'s next turn; contextSpec = observable state. Test: needs next-turn reasoning? actionSpec. No? contextSpec.',
      );
    });

    it('is OSS-pure — no platform/tier/cloud/credit/cost semantics', () => {
      const d = description();
      for (const banned of [
        '@ggui-cloud',
        '@guuey',
        'platform',
        'tier',
        'credit',
        'billing',
        'savings',
      ]) {
        expect(d.toLowerCase()).not.toContain(banned.toLowerCase());
      }
    });
  });

  describe('no-negotiator default — origin: agent', () => {
    it("stamps an agent-origin suggestion with the agent's draft verbatim", async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.action).toBe('create');
      expect(out.reason).toMatch(/no-negotiator-bound/);
      expect(out.suggestion.origin).toBe('agent');
      expect(out.suggestion.blueprintMeta).toBeDefined();
      expect(out.suggestion.blueprintMeta.codeHash).toBeUndefined();
      // No provenance on agent origin — gen pending; the source is
      // minted at render-time registration (cache-only field).
      expect(out.suggestion.blueprintMeta.source).toBeUndefined();
    });

    it('carries proposedContractSummary and NO blueprintId (P2-18)', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      // proposedContractSummary projects the (empty) draft contract.
      expect(out.suggestion.proposedContractSummary).toBeTruthy();
      // No throwaway provisional id on the origin:'agent' default path —
      // the durable UUID is minted at render-time registration (D4).
      expect(out.suggestion.blueprintMeta.blueprintId).toBeUndefined();
    });

    it('returns a non-empty handshakeId', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.handshakeId).toBeTruthy();
      expect(typeof out.handshakeId).toBe('string');
    });

    it('returns a canonical contractHash of the draft', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.contractHash).toBeTruthy();
      expect(out.contractHash).toBe(out.suggestion.blueprintMeta.contractHash);
    });

    it('nextStep.example shows nested ARRAY ITEM + object shapes — the closed key set the render gate holds the agent to (ggui#523, live bench 2026-08-16)', async () => {
      // 5/8 first-attempt renders on dev failed with "Undeclared field
      // 'name' … Declared keys: [id, title, cards]" — the example used
      // to say `columns: []`, so the agent guessed the item shape.
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {
              propsSpec: {
                properties: {
                  columns: {
                    required: true,
                    schema: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' },
                          title: { type: 'string' },
                          cards: {
                            type: 'array',
                            items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } } },
                          },
                        },
                        required: ['id', 'title'],
                      },
                    },
                  },
                  status: { required: true, schema: { type: 'string', enum: ['idle', 'success'] } },
                },
              },
            },
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      const example = out.nextStep?.example ?? '';
      // One item, in the item's shape, all declared keys — nested arrays too.
      expect(example).toContain('"columns":[{"id":"","title":"","cards":[{"id":"","text":""}]}]');
      // Enum: the first legal value, never "".
      expect(example).toContain('"status":"idle"');
    });

    it('nextStep.example carries the REQUIRED props with example/default/type-shaped values (live agent finding, 2026-08-12)', async () => {
      // A bare `props:{}` example against a contract with required
      // props fails renderInputSchema when followed verbatim — the
      // example must name the required entries.
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {
              propsSpec: {
                properties: {
                  title: {
                    schema: { type: 'string' },
                    required: true,
                    example: 'Deploy Status',
                  },
                  count: { schema: { type: 'number' }, required: true },
                  optionalNote: { schema: { type: 'string' } },
                },
              },
            } as unknown as DataContract,
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      const example = out.nextStep?.example ?? '';
      // Declared example value wins; schema-typed placeholder fills in;
      // optional entries stay OUT of the copy-paste example.
      expect(example).toContain('"title":"Deploy Status"');
      expect(example).toContain('"count":0');
      expect(example).not.toContain('optionalNote');
    });

    it('nextStep.example stays a valid bare {} when the contract has no required props', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: { contract: {} as DataContract },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.nextStep?.example).toContain('"props":{}');
    });

    it('threads draft variance into the suggestion blueprintMeta', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {} as DataContract,
            variance: {
              persona: 'minimalist',
              context: { aesthetic: 'glassy' },
            },
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.suggestion.blueprintMeta.variance.persona).toBe('minimalist');
      expect(out.suggestion.blueprintMeta.variance.context).toEqual({
        aesthetic: 'glassy',
      });
    });

    it('accepts a registered draft.generator hint without a GENERATOR_UNKNOWN finding', async () => {
      // The dispatch hint stays on the INPUT (BlueprintDraft.generator)
      // and is validated against the deployment's `defaultGenerator`
      // dep. It is no longer echoed onto the suggestion — BlueprintMeta
      // carries provenance (`source`, cache-only), not dispatch.
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        defaultGenerator: 'custom-generator-slug',
      });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {} as DataContract,
            generator: 'custom-generator-slug',
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      const finding = out.suggestion.validationFindings?.find(
        (f) => f.code === 'GENERATOR_UNKNOWN',
      );
      expect(finding).toBeUndefined();
      // Agent origin ⇒ no provenance on the suggestion.
      expect(out.suggestion.blueprintMeta.source).toBeUndefined();
    });

    it('forgivingly drops an unknown draft.generator — default used + GENERATOR_UNKNOWN finding', async () => {
      // Forgiving handshake (af7d938b7): an unrecognized generator slug is
      // DROPPED (the server default is used) and surfaced as a warn
      // finding, rather than thrown — the handshake never hard-fails on a
      // fixable detail. (The STRICT render-override path keeps the throwing
      // assert.) The finding names the offending slug so the agent's
      // recovery is unambiguous (omit the field or pass a known one).
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {} as DataContract,
            generator: 'unregistered-slug',
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      // Did NOT throw — and surfaces a GENERATOR_UNKNOWN warn finding
      // naming the slug + the default that replaced it.
      const finding = out.suggestion.validationFindings?.find(
        (f) => f.code === 'GENERATOR_UNKNOWN',
      );
      expect(finding?.severity).toBe('warn');
      expect(finding?.message).toMatch(/unregistered-slug/);
      expect(finding?.message).toMatch(new RegExp(DEFAULT_GENERATOR_SLUG));
    });
  });

  // ggui#523 item 3 — the server never proposes `{}` on the agent's
  // behalf. With no negotiator bound, a dirty draft is reduced to its
  // conforming subset (origin synth, findings per drop) or DECLINED; a
  // declined handshake writes no record and offers no nextStep.
  describe('never `{}` — salvage or decline (no negotiator bound)', () => {
    it('proposes the conforming SUBSET of a partly-malformed draft, origin synth, PARTIAL summary', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {
              propsSpec: { properties: { title: { required: true, schema: { type: 'string' } } } },
              actionSpec: {
                ok: { label: 'Ok', schema: { type: 'object' } },
                bad: { type: 'object' }, // flat schema — refused, dropped
              },
            },
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.action).toBe('create');
      expect(out.suggestion.origin).toBe('synth');
      expect(out.suggestion.proposedContractSummary).toMatch(/^PARTIAL/);
      expect(out.suggestion.validationFindings?.some((f) => f.path.startsWith('actionSpec.bad'))).toBe(true);
      // The record carries the salvaged, NON-empty contract.
      const record = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(record).not.toBeNull();
      expect(Object.keys(record!.effectiveContract.actionSpec ?? {})).toEqual(['ok']);
      expect(record!.effectiveContract).not.toEqual({});
      // And a render is still on offer for the subset.
      expect(out.nextStep?.tool).toBe('ggui_render');
    });

    it('DECLINES a draft with nothing salvageable — no record, no nextStep, findings loud, lifecycle outcome declined', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const events: GguiLifecyclePayload[] = [];
      const lifecycleEmitter: GguiLifecycleEmitter = {
        emit: (_id, payload) => {
          events.push(payload);
        },
      };
      const handler = createGguiHandshakeHandler({ kvStore, lifecycleEmitter });
      const out = await handler.handler(
        minimalInput({ blueprintDraft: { contract: { propsSpec: 'not-an-object' } } }),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.action).toBe('declined');
      expect(out.nextStep).toBeUndefined();
      expect(out.suggestion.origin).toBe('agent');
      expect(out.suggestion.proposedContractSummary).toMatch(/^DECLINED/);
      expect(out.suggestion.validationFindings?.length ?? 0).toBeGreaterThan(0);
      expect(out.suggestion.validationFindings?.[0]?.severity).toBe('error');
      // Nothing to render against — no record was written.
      expect(await kvStore.get(handshakeRecordKey('app-1', out.handshakeId))).toBeNull();
      // Lifecycle: started, then completed with outcome 'declined', genExpected false.
      expect(events.map((e) => e.kind)).toEqual(['handshake_started', 'handshake_completed']);
      const completed = events[1];
      expect(completed?.kind === 'handshake_completed' ? completed.outcome : undefined).toBe('declined');
    });

    it("keeps an agent's own clean `{}` verbatim — the empty contract is the AGENT's choice, not the server's", async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(minimalInput(), { appId: 'app-1', requestId: 'r' });
      expect(out.action).toBe('create');
      expect(out.suggestion.origin).toBe('agent');
      const record = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(record!.effectiveContract).toEqual({});
    });
  });

  describe('persistence', () => {
    it('persists a HandshakeRecord under the (appId, handshakeId) key', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const raw = await kvStore.get(handshakeRecordKey('app-1', out.handshakeId));
      expect(raw).toBeTruthy();
      const record = JSON.parse(raw as string) as HandshakeRecord;
      expect(record.handshakeId).toBe(out.handshakeId);
      expect(record.appId).toBe('app-1');
      expect(record.input.intent).toBe('show weather');
      expect(record.suggestion.origin).toBe('agent');
      expect(record.effectiveContract).toBeDefined();
    });

    it('consumes the record on consumeHandshakeRecord', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const record = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(record).toBeTruthy();
      const second = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(second).toBeNull();
    });

    it('scopes records per (appId, handshakeId) — cross-tenant returns null', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const cross = await consumeHandshakeRecord(
        kvStore,
        'app-OTHER',
        out.handshakeId,
      );
      expect(cross).toBeNull();
    });
  });

  describe('negotiator binding', () => {
    it('propagates an `origin: cache` suggestion verbatim', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const cachedSuggestion: HandshakeSuggestion = {
        origin: 'cache',
        rationale: 'contract-hash → score 1.00',
        blueprintMeta: {
          blueprintId: 'bp_existing',
          contractHash: 'hash_cached',
          codeHash: 'code_hash_abc',
          source: {
            kind: 'llm',
            generator: 'ui-gen-default-haiku-4-5',
            model: 'claude-haiku-4-5',
          },
          variance: {},
        },
      };
      const cachedContract = {} as DataContract;
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'reuse',
          reason: 'cache hit',
          suggestion: cachedSuggestion,
          effectiveContract: cachedContract,
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.action).toBe('reuse');
      expect(out.suggestion).toEqual(cachedSuggestion);
      expect(out.suggestion.blueprintMeta.codeHash).toBe('code_hash_abc');
    });

    it('propagates an `origin: synth` suggestion with amendments', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const synthSuggestion: HandshakeSuggestion = {
        origin: 'synth',
        rationale: 'synth amended invalid draft',
        blueprintMeta: {
          blueprintId: 'bp_provisional',
          contractHash: 'hash_amended',
          variance: {},
        },
        amendments: {
          contractDiff: [
            { op: 'add', path: '/actionSpec/submit', value: { schema: {} } },
          ],
          reasoning: 'added required submit action',
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'create',
          reason: 'synth amended',
          suggestion: synthSuggestion,
          effectiveContract: {} as DataContract,
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.suggestion.origin).toBe('synth');
      expect(out.suggestion.amendments?.reasoning).toBe('added required submit action');
    });

    it('surfaces alternatives from the negotiator', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const alternative: Blueprint = {
        blueprintId: 'bp_alt',
        contractHash: 'hash_alt',
        appId: 'app-1',
        source: {
          kind: 'llm',
          generator: 'ui-gen-default-haiku-4-5',
          model: 'claude-haiku-4-5',
        },
        variance: { persona: 'data-dense' },
        createdAt: '2026-05-12T00:00:00.000Z',
        createdBy: 'agent',
        contract: {} as DataContract,
      };
      const suggestion: HandshakeSuggestion = {
        origin: 'agent',
        rationale: 'novel-but-clean',
        blueprintMeta: {
          blueprintId: 'bp_prim',
          contractHash: 'hash_prim',
          variance: {},
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'create',
          reason: 'novel draft',
          suggestion,
          effectiveContract: {} as DataContract,
          alternatives: [alternative],
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.alternatives).toEqual([alternative]);
    });

    it('propagates a target.sessionId routing hint from the negotiator', async () => {
      // Phase-B: routing hint collapsed from {sessionId, stackItemId}
      // to a single {sessionId?}. The negotiator MAY suggest reusing
      // an existing render (cache / update path).
      const kvStore = new InMemoryKeyValueStore();
      const suggestion: HandshakeSuggestion = {
        origin: 'cache',
        rationale: 'reuse existing render',
        blueprintMeta: {
          blueprintId: 'bp_existing',
          contractHash: 'hash_x',
          source: {
            kind: 'llm',
            generator: 'ui-gen-default-haiku-4-5',
            model: 'claude-haiku-4-5',
          },
          variance: {},
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'update',
          reason: 'update existing render in place',
          suggestion,
          effectiveContract: {} as DataContract,
          target: { sessionId: 'render-existing-123' },
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.target.sessionId).toBe('render-existing-123');
    });
  });

  describe('per-app gadget catalog (resolveAppGadgets parity)', () => {
    const DECLARED_ONLY: GadgetDescriptor[] = [
      {
        package: '@acme/x',
        version: '0.0.1',
        exports: [
          {
            hook: 'useCustom',
            description: 'Custom hook for the test',
            usage: 'Mounts the custom widget',
            example: { hook: 'useCustom' },
          },
        ],
      },
    ];

    /** Negotiator stub that captures the catalog the handler threads in. */
    const capturingNegotiator = () => {
      let captured: readonly GadgetDescriptor[] | undefined;
      const negotiator: HandshakeNegotiator = {
        decide: (input) => {
          captured = input.gadgets;
          return {
            action: 'create',
            reason: 'capture',
            suggestion: {
              origin: 'agent',
              rationale: 'capture',
              blueprintMeta: { contractHash: 'hash_cap', variance: {} },
            },
            effectiveContract: {} as DataContract,
          };
        },
      };
      return { negotiator, gadgets: () => captured };
    };

    it('applies the stdlib floor over a store returning DECLARED-ONLY gadgets — same resolution as render/list-gadgets', async () => {
      // Regression (2026-08-09 audit): the handshake used to compute
      // `app.gadgets ?? STDLIB_GADGETS` — declared gadgets REPLACED the
      // stdlib floor, so a store returning raw declared rows made the
      // negotiator see a DIFFERENT catalog than the render gate accepts
      // (render.ts / list-gadgets.ts resolve via `resolveAppGadgets`).
      // The bug was masked by stores that pre-floor on read (cloud DDB
      // `getApp`, OSS `InMemoryAppMetadataStore` via `composeApp`); this
      // stub returns the raw declared row a divergent store would.
      const appMetadataStore: AppMetadataStore = {
        get: async (appId) =>
          appId === 'app-1' ? { id: 'app-1', gadgets: DECLARED_ONLY } : null,
      };
      const { negotiator, gadgets } = capturingNegotiator();
      const handler = createGguiHandshakeHandler({
        kvStore: new InMemoryKeyValueStore(),
        negotiator,
        appMetadataStore,
      });
      await handler.handler(minimalInput(), { appId: 'app-1', requestId: 'r' });
      // Exactly what ggui_list_gadgets would serve for the same store row.
      expect(gadgets()).toEqual(resolveAppGadgets(DECLARED_ONLY));
      // Both the stdlib floor AND the declared package are present.
      expect((gadgets() ?? []).map((g) => g.package)).toEqual(
        expect.arrayContaining([STDLIB_GADGETS[0].package, '@acme/x']),
      );
    });

    it('serves exactly STDLIB_GADGETS for an unregistered app (store returns null)', async () => {
      const appMetadataStore: AppMetadataStore = { get: async () => null };
      const { negotiator, gadgets } = capturingNegotiator();
      const handler = createGguiHandshakeHandler({
        kvStore: new InMemoryKeyValueStore(),
        negotiator,
        appMetadataStore,
      });
      await handler.handler(minimalInput(), { appId: 'app-x', requestId: 'r' });
      // resolveAppGadgets(undefined) is the STDLIB_GADGETS reference —
      // same identity list-gadgets serves for the unregistered case.
      expect(gadgets()).toBe(STDLIB_GADGETS);
    });

    it('is idempotent over a pre-flooring store (cloud DDB read posture) — catalog unchanged by value', async () => {
      const preFloored = resolveAppGadgets(DECLARED_ONLY);
      const appMetadataStore: AppMetadataStore = {
        get: async () => ({ id: 'app-1', gadgets: preFloored }),
      };
      const { negotiator, gadgets } = capturingNegotiator();
      const handler = createGguiHandshakeHandler({
        kvStore: new InMemoryKeyValueStore(),
        negotiator,
        appMetadataStore,
      });
      await handler.handler(minimalInput(), { appId: 'app-1', requestId: 'r' });
      expect(gadgets()).toEqual(preFloored);
    });

    it('threads NO catalog when no appMetadataStore is bound', async () => {
      const { negotiator, gadgets } = capturingNegotiator();
      const handler = createGguiHandshakeHandler({
        kvStore: new InMemoryKeyValueStore(),
        negotiator,
      });
      await handler.handler(minimalInput(), { appId: 'app-1', requestId: 'r' });
      expect(gadgets()).toBeUndefined();
    });
  });

  describe('matchedBlueprint persistence (P2-17)', () => {
    const cacheReuseNegotiator = (): HandshakeNegotiator => ({
      decide: () => ({
        action: 'reuse',
        reason: 'cache hit',
        suggestion: {
          origin: 'cache',
          rationale: 'cache hit',
          blueprintMeta: {
            blueprintId: 'bp_11111111-1111-1111-1111-111111111111',
            contractHash: 'hash_cached',
            codeHash: 'code_hash_abc',
            source: {
              kind: 'llm',
              generator: 'ui-gen-default-haiku-4-5',
              model: 'claude-haiku-4-5',
            },
            variance: {},
          },
        },
        effectiveContract: {} as DataContract,
        matchedBlueprint: {
          id: 'bp_11111111-1111-1111-1111-111111111111',
          contractKey: 'hash_cached',
          variantKey: 'variant_default',
        },
      }),
    });

    it('persists matchedBlueprint on a cache-reuse handshake', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        negotiator: cacheReuseNegotiator(),
      });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const record = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(record?.matchedBlueprint).toEqual({
        id: 'bp_11111111-1111-1111-1111-111111111111',
        contractKey: 'hash_cached',
        variantKey: 'variant_default',
      });
    });

    it('omits matchedBlueprint on a create handshake (no-negotiator default)', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const record = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(record?.suggestion.origin).toBe('agent');
      expect(record?.matchedBlueprint).toBeUndefined();
    });
  });

  describe('input validation', () => {
    it('rejects an input missing blueprintDraft', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      await expect(
        handler.handler(
          { intent: 'hi' },
          { appId: 'app-1', requestId: 'r' },
        ),
      ).rejects.toThrow();
    });

    it('rejects an empty intent', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      await expect(
        handler.handler(
          minimalInput({ intent: '' }),
          { appId: 'app-1', requestId: 'r' },
        ),
      ).rejects.toThrow();
    });

    it('accepts an input WITHOUT sessionId (Phase B — sessionId removed from handshake input)', async () => {
      // Phase B: the handshake no longer carries a sessionId. The
      // paired ggui_render mints the render server-side; host
      // conversation grouping lives on `_meta["ai.ggui/host-session"]`.
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        { intent: 'hi', blueprintDraft: MINIMAL_DRAFT },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.handshakeId).toBeTruthy();
    });
  });

  describe('TTL', () => {
    it('writes a record with the default TTL (10 minutes)', async () => {
      expect(HANDSHAKE_RECORD_TTL_SEC).toBe(600);
    });
  });

  describe('serverCapabilities', () => {
    it('emits serverCapabilities when the resolver returns a value', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        serverCapabilities: () => ({
          streamWebSocket: { url: 'wss://example.com/ws' },
          streamWebSocketLocalTools: ['get_weather'],
        }),
      });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.serverCapabilities?.streamWebSocket?.url).toBe('wss://example.com/ws');
    });

    it('omits serverCapabilities when the resolver returns undefined', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        serverCapabilities: () => undefined,
      });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.serverCapabilities).toBeUndefined();
    });
  });

  // ============================================================
  // MVB-6 — telemetry signals on `handshake.decided`
  // ============================================================
  describe('MVB-6 telemetry', () => {
    it('emits handshake.decided with selection fields', async () => {
      const events: Array<{ name: string; attributes: Record<string, unknown> }> = [];
      const telemetrySink = {
        emit(event: {
          name: string;
          at: number;
          attributes?: Readonly<Record<string, string | number | boolean>>;
        }) {
          events.push({
            name: event.name,
            attributes: { ...(event.attributes ?? {}) },
          });
        },
      };
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore, telemetrySink });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe('handshake.decided');
      const attrs = events[0]!.attributes;
      expect(attrs['appId']).toBe('app-1');
      // Phase B: telemetry no longer carries sessionId (the handshake
      // input no longer accepts one; the paired ggui_render mints the
      // render later).
      expect(attrs['sessionId']).toBeUndefined();
      expect(attrs['handshakeId']).toBe(out.handshakeId);
      expect(attrs['action']).toBe('create');
      expect(attrs['origin']).toBe('agent');
      // D4 / P2-18: no blueprintId is minted on the origin:'agent' default
      // path (minted at render-time registration) — so neither the
      // suggestion nor the telemetry attribute carries one.
      expect(out.suggestion.blueprintMeta.blueprintId).toBeUndefined();
      expect(attrs['selectedBlueprintId']).toBeUndefined();
      expect(attrs['selectionReason']).toBeTruthy();
      // Agent origin ⇒ no provenance — the flat source keys are
      // absent (cache-only on BlueprintMeta).
      expect(attrs['sourceKind']).toBeUndefined();
      expect(attrs['sourceGenerator']).toBeUndefined();
      expect(attrs['sourceModel']).toBeUndefined();
      // No selectVariant ran ⇒ no confidence axis.
      expect(attrs['selectionConfidence']).toBeUndefined();
    });

    it('threads selectionConfidence when selectedReason carries a conf= suffix', async () => {
      const events: Array<{ attributes: Record<string, unknown> }> = [];
      const telemetrySink = {
        emit(event: {
          name: string;
          at: number;
          attributes?: Readonly<Record<string, string | number | boolean>>;
        }) {
          events.push({ attributes: { ...(event.attributes ?? {}) } });
        },
      };
      const cachedSuggestion: HandshakeSuggestion = {
        origin: 'cache',
        rationale: 'cache hit',
        blueprintMeta: {
          blueprintId: 'bp_picked',
          contractHash: 'hash_x',
          source: {
            kind: 'llm',
            generator: 'ui-gen-advanced-opus-4-7',
            model: 'claude-opus-4-7',
          },
          variance: { persona: 'minimalist' },
          // Confidence encoded onto selectedReason per the MVB-6
          // convention (BlueprintMeta doesn't carry confidence as
          // first-class so it round-trips through the reason string).
          selectedReason: 'persona match (data-dense) conf=0.87',
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'reuse',
          reason: 'cache hit',
          suggestion: cachedSuggestion,
          effectiveContract: {} as DataContract,
        }),
      };
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        negotiator,
        telemetrySink,
      });
      await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const attrs = events[0]!.attributes;
      expect(attrs['origin']).toBe('cache');
      expect(attrs['selectedBlueprintId']).toBe('bp_picked');
      expect(attrs['selectionReason']).toContain('persona match');
      expect(attrs['selectionConfidence']).toBe(0.87);
      // Cache origin ⇒ provenance flattened through the shared codec.
      expect(attrs['sourceKind']).toBe('llm');
      expect(attrs['sourceGenerator']).toBe('ui-gen-advanced-opus-4-7');
      expect(attrs['sourceModel']).toBe('claude-opus-4-7');
    });

    it('absent telemetrySink is a noop (no throw)', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      // Without telemetrySink the handler MUST still resolve.
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.handshakeId).toBeTruthy();
    });
  });
});

// ============================================================
// extractSelectionConfidence pure-function tests
// ============================================================
describe('extractSelectionConfidence', () => {
  it('parses conf=<n> from a reason string', async () => {
    const { extractSelectionConfidence } = await import('./handshake');
    expect(extractSelectionConfidence('persona match conf=0.85')).toBe(0.85);
    expect(extractSelectionConfidence('conf=1 — perfect')).toBe(1);
    expect(extractSelectionConfidence('conf=0 — none')).toBe(0);
    expect(extractSelectionConfidence('conf=.5 — weak')).toBe(0.5);
  });

  it('returns undefined when no conf= present', async () => {
    const { extractSelectionConfidence } = await import('./handshake');
    expect(extractSelectionConfidence('persona match')).toBeUndefined();
    expect(extractSelectionConfidence(undefined)).toBeUndefined();
    expect(extractSelectionConfidence('')).toBeUndefined();
  });

  it('returns undefined on out-of-range values', async () => {
    const { extractSelectionConfidence } = await import('./handshake');
    // Matcher only accepts 0–1; "1.5" doesn't match because `1` is
    // followed by `.5` which the regex sees as 1.5 — that IS captured
    // (1.5) but rejected by the [0,1] gate. "2.0" doesn't match the
    // regex pattern.
    expect(extractSelectionConfidence('conf=1.5 — weird')).toBeUndefined();
  });
});
